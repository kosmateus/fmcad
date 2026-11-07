import {
  createInvocationContext,
  createObservationScope,
  type EventSink,
  type Presence,
} from "@fmcad/core";

const invocation = createInvocationContext({
  clientId: "mcp:transport",
  requestId: "request:one",
  jobId: "job:one",
  projectId: "project:one",
  documentId: "document:one",
  sessionId: "host-session:one",
  turnId: "turn:one",
  instanceId: "instance:one",
  source: "mcp",
});

const events: EventSink = {
  async publish(event) {
    void event.invocation.requestId;
  },
};
const presence: Presence = {
  async heartbeat(context, atMs) {
    void context.instanceId;
    void atMs;
  },
  async dispose(context, atMs) {
    void context.clientId;
    void atMs;
  },
};
const scope = createObservationScope({
  invocation,
  events,
  presence,
  clock: { nowMs: () => 1 },
});
void scope;

const wrongIdentity: typeof invocation = {
  ...invocation,
  // @ts-expect-error transport client and host session identities are distinct and branded
  sessionId: invocation.clientId,
};
void wrongIdentity;

// @ts-expect-error host source is a closed protocol union
createInvocationContext({ instanceId: "instance", source: "unknown-host" });
