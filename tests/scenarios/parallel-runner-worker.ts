import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runScenarios, type Scenario } from "./runner";
import type { Execution, ScenarioBackend, ScriptRequest } from "./contracts";
import { marker } from "./programs";
import { scenarioArtifactRoot } from "./artifact-root";

interface SharedState {
  active: string | null;
  documents: {
    creationId: string;
    name: string;
    saved: false;
    modified: boolean;
    fileId: null;
  }[];
}

const sourceRoot = textEnv("PARALLEL_SOURCE_ROOT"),
  root = scenarioArtifactRoot(sourceRoot, "fusion"),
  stateFile = textEnv("PARALLEL_STATE"),
  readyRoot = textEnv("PARALLEL_READY_ROOT"),
  releaseFile = textEnv("PARALLEL_RELEASE_FILE"),
  tag = textEnv("PARALLEL_TAG"),
  peer = textEnv("PARALLEL_PEER");

function textEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing " + name);
  return value;
}

if (path.resolve(process.cwd()) !== path.resolve(sourceRoot))
  throw new Error("Worker cwd does not match its independent source root");
if (path.resolve(root) === path.resolve(sourceRoot))
  throw new Error("Scenario artifacts must be separate from the source root");

function readState(): SharedState {
  return JSON.parse(fs.readFileSync(stateFile, "utf8")) as SharedState;
}

async function updateState(
  update: (state: SharedState) => void,
): Promise<void> {
  const lock = stateFile + ".lock";
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    const state = readState();
    update(state);
    const temporary = stateFile + ".new-" + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  } finally {
    fs.unlinkSync(lock);
  }
}

function execution(request: ScriptRequest, stdout: string): Execution {
  return {
    requestId: request.requestId,
    state: "succeeded",
    sdkSettled: true,
    mayHaveMutated: true,
    stdout,
    exitCode: 0,
    brokerReceipt: {
      requestId: request.requestId,
      clientId: request.owner.clientId,
      jobId: randomUUID(),
      state: "succeeded",
      operationResult: null,
    },
  };
}

const backend: ScenarioBackend = {
  identity: "independent-process-fixture-test:v1",
  mode: "simulator",
  qualification: "broker",
  protocol: "mcp",
  capabilities: new Set(["documents"]),
  fusionPath: (filename) => filename,
  async execute(request) {
    if (request.owner.scenarioId === "coordinator")
      return execution(request, marker + JSON.stringify(readState()) + "\n");

    if (request.source.includes("identity: dict[str, object]")) {
      const creationId = randomUUID(),
        name =
          "FMCAD_SCENARIO_" +
          request.owner.runId +
          "_" +
          request.owner.scenarioId,
        identity = {
          creationId,
          name,
          activeCreationId: creationId,
          requestId: request.requestId,
          clientId: request.owner.clientId,
        };
      await updateState((state) => {
        state.documents.push({
          creationId,
          name,
          saved: false,
          modified: false,
          fileId: null,
        });
        state.active = creationId;
      });
      fs.writeFileSync(
        path.join(request.directory, "creation.json"),
        JSON.stringify(identity),
        { flag: "wx", mode: 0o600 },
      );
      return execution(request, marker + JSON.stringify(identity) + "\n");
    }

    if (request.source.includes("createFusionArchiveExportOptions")) {
      fs.writeFileSync(path.join(request.directory, "fixture.f3d"), "fixture");
      return execution(
        request,
        marker +
          JSON.stringify({
            creationId: request.target?.creationId,
            exported: true,
          }) +
          "\n",
      );
    }

    if (request.source.includes("doc.close(False)")) {
      const creationId = request.target?.creationId;
      if (!creationId) throw new Error("Cleanup request has no target");
      await updateState((state) => {
        state.documents = state.documents.filter(
          (document) => document.creationId !== creationId,
        );
        if (state.active === creationId)
          state.active = state.documents[0]?.creationId ?? null;
      });
      return execution(
        request,
        marker + JSON.stringify({ creationId, closed: true }) + "\n",
      );
    }

    if (request.source.includes("sum(d.name ==")) {
      const state = readState(),
        literal = /creationId == ("(?:[^"\\\\]|\\\\.)*")/u.exec(
          request.source,
        )?.[1],
        creationId =
          request.target?.creationId ??
          (literal ? (JSON.parse(literal) as string) : undefined);
      const owned = state.documents.find(
        (document) => document.creationId === creationId,
      );
      if (!owned) throw new Error("Owned fixture disappeared");
      return execution(
        request,
        marker +
          JSON.stringify({
            creationId,
            active: state.active,
            documents: state.documents,
          }) +
          "\n",
      );
    }

    return execution(request, marker + JSON.stringify({}) + "\n");
  },
};

const scenario: Scenario = {
  id: tag,
  scope: "exclusive-instance",
  requires: ["documents"],
  async run(session) {
    fs.writeFileSync(
      path.join(readyRoot, tag),
      JSON.stringify({ creationId: session.document.creationId }),
      { flag: "wx", mode: 0o600 },
    );
    process.send?.({ type: "ready", tag });
    while (!fs.existsSync(path.join(readyRoot, peer)))
      await new Promise((resolve) => setTimeout(resolve, 5));
    while (!fs.existsSync(releaseFile))
      await new Promise((resolve) => setTimeout(resolve, 5));
    await session.verifyOwnedUnsaved("observe-cross-process-owned-fixture");
    process.send?.({ type: "observed", tag });
    while (!fs.existsSync(releaseFile + "-" + tag))
      await new Promise((resolve) => setTimeout(resolve, 5));
  },
};

void runScenarios(backend, [scenario], root, 1)
  .then((reports) => {
    process.send?.({
      type: "done",
      tag,
      status: reports[0]?.status,
      cleanup: reports[0]?.cleanup,
      error: reports[0]?.error,
      cleanupError: reports[0]?.cleanupError,
      sourceRoot: process.cwd(),
      artifactRoot: root,
      runId: reports[0]?.owner.runId,
      owner: reports[0]?.owner,
      document: reports[0]?.document,
      directory: reports[0]?.directory,
      pid: process.pid,
    });
  })
  .catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.stack : String(error)) + "\n",
    );
    process.exitCode = 1;
  });
