import { QueueDomain } from "./queue";
import type {
  QueueDetails,
  QueueDomainOptions,
  QueueSnapshot,
} from "./queue-model";

export type QueueAction =
  | { type: "recover" }
  | { type: "submit"; request: unknown }
  | { type: "next" }
  | { type: "readyTurn"; id: string }
  | { type: "releaseTurn"; id: string; remainingMs: number }
  | {
      type: "finish" | "finishLocal" | "markDispatch";
      id: string;
      details: QueueDetails;
    }
  | { type: "resolve"; id: string; details: unknown }
  | { type: "blockLocal"; id: string; reason: unknown }
  | { type: "cancel"; id: string; clientId: string }
  | { type: "release"; sequenceId: string; clientId: string }
  | { type: "pause"; paused: boolean; requestId?: string }
  | { type: "advanceInstanceEpoch"; transitionId: string };

/** Pure replayable policy evaluation, not SDK replay. IDs/hash/time are explicit inputs.
 * The broker uses the indexed QueueDomain directly to keep idle ticks O(waiters).
 */
export function transitionQueue(
  snapshot: QueueSnapshot,
  action: QueueAction,
  input: Omit<
    QueueDomainOptions,
    "snapshot" | "commit" | "recover" | "now" | "newId"
  > & {
    time: number;
    ids: readonly string[];
  },
): {
  state: QueueSnapshot;
  result: unknown;
  effects: { type: "persist"; snapshot: QueueSnapshot }[];
} {
  const effects: { type: "persist"; snapshot: QueueSnapshot }[] = [];
  let index = 0;
  const queue = new QueueDomain({
    ...input,
    snapshot,
    now: () => input.time,
    newId: () => {
      const id = input.ids[index++];
      if (id === undefined)
        throw new Error("An explicit ID is required for this transition");
      return id;
    },
    recover: action.type === "recover",
    commit: (next) => effects.push({ type: "persist", snapshot: next }),
  });
  let result: unknown;
  switch (action.type) {
    case "recover":
      result = queue.summary();
      break;
    case "submit":
      result = queue.submit(action.request);
      break;
    case "next":
      result = queue.next();
      break;
    case "readyTurn":
      result = queue.readyTurn(action.id);
      break;
    case "releaseTurn":
      result = queue.releaseTurn(action.id, action.remainingMs);
      break;
    case "finish":
      result = queue.finish(action.id, action.details);
      break;
    case "finishLocal":
      result = queue.finishLocal(action.id, action.details);
      break;
    case "markDispatch":
      result = queue.markDispatch(action.id, action.details);
      break;
    case "resolve":
      result = queue.resolve(action.id, action.details);
      break;
    case "blockLocal":
      result = queue.blockLocal(action.id, action.reason);
      break;
    case "cancel":
      result = queue.cancel(action.id, action.clientId);
      break;
    case "release":
      result = queue.release(action.sequenceId, action.clientId);
      break;
    case "pause":
      result = queue.pause(action.paused, action.requestId);
      break;
    case "advanceInstanceEpoch":
      result = queue.advanceInstanceEpoch(action.transitionId);
      break;
  }
  return { state: queue.data, result, effects };
}
