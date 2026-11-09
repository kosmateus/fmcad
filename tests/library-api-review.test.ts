import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ReviewInvocation,
  ReviewServiceOptions,
  ReviewRunPorts,
  ReviewRequest,
} from "../src/api";
import type { PreparedPythonArtifact } from "@fmcad/core";
const { createReviewServices, CompatibilityError } = createRequire(__filename)(
  path.join(process.cwd(), "dist/src/dist/api"),
) as typeof import("../src/api");
test("public review factory delegates typed prepared-artifact work to the shared use case without CLI or physical constructors", async () => {
  const calls: [string, ...unknown[]][] = [];
  const request: ReviewRequest = {
    doc: "Model",
    docId: "creation",
    docFileId: null,
    out: "/explicit/local-output",
    fusionOut: "C:\\mapped\\output",
    width: 1600,
    height: 1200,
    requestId: "review-request",
  };
  const artifact: PreparedPythonArtifact = Object.freeze({
    version: 1,
    runtimeVersion: "cad-v1",
    units: [],
    context: null,
    request: null,
    sourceMap: [],
    bytes: Array.from(Buffer.from("prepared-review")),
    artifactHash: "test-artifact",
    script: "prepared-review",
    sha256: "test-artifact",
  });
  const ports: ReviewRunPorts = {
    preparation: {
      prepare(value) {
        calls.push(["prepare", value]);
        return artifact;
      },
    },
    artifacts: {
      async claim(directory) {
        calls.push(["claim", directory]);
      },
      async writeExclusive(directory, name, content) {
        calls.push([
          "write",
          name,
          JSON.parse(
            typeof content === "string"
              ? content
              : Buffer.from(content).toString("utf8"),
          ) as unknown,
        ]);
      },
      async readText() {
        throw Error("Rejected capture has no backend report");
      },
      async readImage() {
        throw Error("Rejected capture has no images");
      },
    },
    execution: {
      async execute(turn) {
        calls.push(["execute", turn]);
        assert.equal(turn.artifact, artifact);
        assert.equal(turn.readOnly, false);
        assert.deepEqual(turn.context, {
          doc: "Model",
          docId: "creation",
          docFileId: null,
        });
        return { notStarted: true, uiGuard: { notStarted: true } };
      },
    },
    sha256() {
      throw Error("Rejected capture has no image hashing");
    },
  };
  assert.throws(
    () =>
      createReviewServices({
        version: 99,
        ports,
      } as unknown as ReviewServiceOptions),
    CompatibilityError,
  );
  const services = createReviewServices({ version: 1, ports });
  assert.equal(calls.length, 0, "factory must not prepare/claim/execute");
  await assert.rejects(
    services.execute({
      version: 99,
      kind: "review",
      request,
    } as unknown as ReviewInvocation),
    CompatibilityError,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    services.execute({
      version: 1,
      kind: "review",
      request: { ...request, docId: null },
    }),
    /doc-id/,
  );
  assert.equal(calls.length, 0, "shared validation precedes preparation/claim");
  const result = await services.execute({
    version: 1,
    kind: "review",
    request,
  });
  assert.equal(result.code, 1);
  assert.equal(result.transport, "rejected");
  assert.equal(result.cadAcceptance, "not-evaluated");
  assert.equal(result.manifestWritten, true);
  assert.equal(calls.filter(([name]) => name === "execute").length, 1);
  assert.deepEqual(
    calls.filter(([name]) => name === "write").map(([, name]) => name),
    ["request.json", "manifest.json"],
  );
  await services.dispose();
  await assert.rejects(
    services.execute({ version: 1, kind: "review", request }),
    /disposed/,
  );
});
