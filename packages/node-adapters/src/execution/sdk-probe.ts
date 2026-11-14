import { sdkProbeEvidence } from "@fmcad/core";
import type {
  WorkerRequest,
  WorkerSdkProbeRequest,
  WorkerSdkProbeTarget,
  WorkerSdkProbePort,
  PreparedPythonArtifact,
} from "@fmcad/core";
import { prepareCadBundle } from "../python/bundle";
import { pythonLiteral, verifyPythonArtifact } from "../python/artifact";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

/** This factory is internal to the capability-worker composition. Its only
 * executor is the job-token IPC backend, never a public physical transport. */
export function createWorkerSdkProbe(options: {
  request: WorkerRequest;
  backend: unknown;
  prepare(
    request: WorkerSdkProbeRequest,
    target: WorkerSdkProbeTarget,
  ): PreparedPythonArtifact;
  execute(artifact: PreparedPythonArtifact): Promise<unknown>;
}): WorkerSdkProbePort {
  const payload = record(options.request.payload);
  const invocation =
    payload?.["kind"] === "cad-command"
      ? record(payload["invocation"])
      : payload;
  const data = record(invocation?.["data"]);
  const target = {
    capabilityId: data?.["capabilityId"],
    operation: invocation?.["operation"],
    doc: invocation?.["doc"],
    docId: invocation?.["docId"],
    docFileId: invocation?.["docFileId"],
  };
  const backend = options.backend;
  return Object.freeze({
    boundary: "fmcad-broker" as const,
    kind: "sdk-probe" as const,
    async probe(input: WorkerSdkProbeRequest) {
      if (
        target.operation !== "capabilities.probe" ||
        typeof target.doc !== "string" ||
        !target.doc ||
        (!identity(target.docId) && !identity(target.docFileId))
      )
        fail(
          "INVALID_PROBE_TARGET",
          "SDK probe requires its own pinned capabilities.probe job",
        );
      if (
        !["mcp", "addin"].includes(String(backend)) ||
        input?.backend !== backend ||
        input.capabilityId !== target.capabilityId ||
        !/^[a-z][a-z0-9_.-]{0,127}$/.test(input.capabilityId)
      ) {
        fail(
          "INVALID_PROBE_TARGET",
          "SDK probe differs from the accepted capability/backend",
        );
      }
      if (
        !input.documentIdentity ||
        input.documentIdentity.docId !== target.docId ||
        input.documentIdentity.docFileId !== target.docFileId
      ) {
        fail(
          "DOCUMENT_CHANGED",
          "SDK probe document pins differ from the accepted job",
        );
      }
      // Snapshot before the first await; caller mutation cannot change the wire.
      const request: WorkerSdkProbeRequest = {
        capabilityId: input.capabilityId,
        backend: input.backend,
        documentIdentity: { ...input.documentIdentity },
      };
      const pinned: WorkerSdkProbeTarget = {
        capabilityId: request.capabilityId,
        doc: target.doc,
        ...(identity(target.docId) ? { docId: target.docId } : {}),
        ...(identity(target.docFileId) ? { docFileId: target.docFileId } : {}),
      };
      const artifact = options.prepare(request, pinned);
      verifyPythonArtifact(artifact);
      const reply = record(await options.execute(artifact));
      if (reply?.["failed"] !== false || typeof reply["text"] !== "string")
        fail(
          "SDK_PROBE_FAILED",
          "Broker SDK probe did not return validated output",
        );
      const lines = reply["text"]
        .split(/\r?\n/)
        .filter((line) => line.startsWith("FMCAD_SDK_PROBE "));
      if (lines.length !== 1)
        fail(
          "SDK_PROBE_FAILED",
          "SDK probe output must contain exactly one evidence marker",
        );
      let observation;
      try {
        observation = record(
          JSON.parse(lines[0]!.slice("FMCAD_SDK_PROBE ".length)) as unknown,
        );
      } catch {
        fail("SDK_PROBE_FAILED", "SDK probe returned malformed evidence");
      }
      if (
        !observation ||
        observation["capabilityId"] !== request.capabilityId ||
        typeof observation["registered"] !== "boolean" ||
        typeof observation["build"] !== "string" ||
        !observation["build"] ||
        (pinned.docId !== undefined && observation["docId"] !== pinned.docId) ||
        (pinned.docFileId !== undefined &&
          observation["docFileId"] !== pinned.docFileId)
      ) {
        fail(
          "SDK_PROBE_FAILED",
          "SDK probe evidence is unbound to the accepted build/document/capability",
        );
      }
      return sdkProbeEvidence(
        request,
        observation["registered"],
        observation["build"],
      );
    },
  });
}

/** Actual read-only Fusion observation, not an execution of the target handler. */
export function prepareSdkProbe(
  root: string,
  request: WorkerSdkProbeRequest,
  target: WorkerSdkProbeTarget,
): PreparedPythonArtifact {
  const wrapper = `
def run(_context: object) -> None:
    import adsk.core, json
    app = adsk.core.Application.get()
    doc = _document_target(app, ${pythonLiteral(target.doc)})
    _document_assert_identity(doc, ${pythonLiteral(target.docId ?? null)}, ${pythonLiteral(target.docFileId ?? null)})
    file, file_error = _document_data_file(doc)
    observation = dict(capabilityId=${pythonLiteral(request.capabilityId)},
        registered=${pythonLiteral(request.capabilityId)} in CAD_HANDLERS,
        build=str(app.version), docId=str(doc.creationId), docFileId=str(file.id) if file else None)
    print('FMCAD_SDK_PROBE ' + json.dumps(observation, ensure_ascii=True, allow_nan=False))
`;
  return prepareCadBundle(root, wrapper, { request, context: target });
}
