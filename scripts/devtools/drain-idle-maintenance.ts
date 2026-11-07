import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeRequire, isRecord } from "./runtime.js";

interface QueueClient {
  register(): Promise<unknown>;
  call(action: string, values?: Record<string, unknown>): Promise<unknown>;
}

interface QueueClientModule {
  QueueClient: new (clientId: string) => QueueClient;
}

interface QueueInstanceModule {
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string): unknown;
}

interface QueueConnectionModule {
  queueDirectory(): string;
}

interface InstallerModule {
  assertQuiescent(value: unknown): void;
}

const { QueueClient } = runtimeRequire(
  "../../src/queue-client.js",
) as QueueClientModule;
const { queueDirectory } = runtimeRequire(
  "../../src/queue-connection.js",
) as QueueConnectionModule;
const { durable, readJson } = runtimeRequire(
  "../../src/queue-instance.js",
) as QueueInstanceModule;
const { assertQuiescent } = runtimeRequire(
  "./install-queue-phases.js",
) as InstallerModule;

export interface DrainOptions {
  client: QueueClient;
  directory: string;
  createId?: () => string;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function drainIdleMaintenance(
  options: DrainOptions,
): Promise<Record<string, unknown>> {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const wait =
    options.wait ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const client = options.client;
  await client.register();
  const before = asRecord(await client.call("status"));
  assertQuiescent(before);
  const savedState = readJson(path.join(options.directory, "queue-state.json"));
  const originalControlRequestIds =
    isRecord(savedState) && isRecord(savedState.controlRequests)
      ? Object.keys(savedState.controlRequests)
      : [];
  const control = asRecord(await client.call("control-status"));
  assert.equal(control.activeOperations, 0);
  const pauseId = createId();
  await client.call("pause", {
    control: {
      requestId: pauseId,
      instanceId: control.instanceId,
      expectedGeneration: control.generation,
    },
  });
  const paused = asRecord(await client.call("status"));
  assertQuiescent(paused);
  assert.equal(paused.paused, true);
  await client.call("stop");
  const marker = path.join(options.directory, "broker.lock");
  for (let index = 0; index < 300 && fs.existsSync(marker); index++)
    await wait(20);
  assert.equal(fs.existsSync(marker), false);
  const file = path.join(
    options.directory,
    `idle-maintenance-${createId()}.json`,
  );
  const report = {
    at: now().toISOString(),
    previousBuildHash: before.buildHash,
    originallyPaused: before.paused,
    operatorPauseId: pauseId,
    originalControlRequestIds,
    brokerStopped: true,
    nativeCalls: 0,
    scope:
      "Explicit user-authorized maintenance of an idle broker; no model operations",
  };
  durable(file, report, true);
  return { reportFile: file, ...report };
}

export function main(args: string[]): Promise<void> {
  void args;
  const client = new QueueClient("fmcad-recovery-isolation-20261020");
  return drainIdleMaintenance({ client, directory: queueDirectory() })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Queue returned an invalid status record");
  return value;
}
