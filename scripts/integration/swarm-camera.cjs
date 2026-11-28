"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { executeCad, prepareCadScript } = require("../../src/cad");
const { pythonArtifactManifest } = require("../../src/python");
const {
  registeredCameraForAddin,
  reconstructCamera,
} = require("../../src/dist/python/camera-save-payload");
const root = resolve(__dirname, "../..");

function context(document, component) {
  if (
    !document ||
    typeof document.name !== "string" ||
    !document.name.trim() ||
    typeof document.creationId !== "string" ||
    !/^(?!-)\S+$/.test(document.creationId) ||
    (document.fileId !== undefined &&
      (typeof document.fileId !== "string" ||
        !/^(?!-)\S+$/.test(document.fileId))) ||
    (document.version !== undefined &&
      (!document.fileId ||
        !Number.isSafeInteger(document.version) ||
        document.version < 1)) ||
    Object.keys(document).some(
      (k) => !["name", "creationId", "fileId", "version"].includes(k),
    )
  )
    throw new Error("Expected an exact swarm document pin");
  if (
    component !== undefined &&
    (typeof component !== "string" || !component.trim())
  )
    throw new Error("Expected a nonempty component selector");
  return {
    doc: document.name,
    docId: document.creationId,
    ...(document.fileId && { docFileId: document.fileId }),
    ...(component && { component }),
  };
}

function requestFor(document, script, manifest) {
  const adapted = registeredCameraForAddin(root, script, manifest);
  if (!adapted) throw new Error("Expected a registered camera.save artifact");
  const { typed } = reconstructCamera(root, pythonArtifactManifest(adapted));
  // Raw swarm admission checks the caller without fmcad's checker sidecar.
  return {
    requestId: randomUUID(),
    document: { ...document },
    code: typed.trimEnd() + "\nrun()\n",
  };
}

function prepareCamera(document, component) {
  const artifact = prepareCadScript(
    "camera.save",
    {},
    context(document, component),
  );
  return requestFor(
    document,
    artifact.script,
    pythonArtifactManifest(artifact),
  );
}

async function runCamera(document, component, dispatch) {
  document = Object.freeze({ ...document });
  const output = await executeCad(
    {
      async callTool({ object }, _tool, manifest) {
        const request = requestFor(document, object.script, manifest);
        const expected = createHash("sha256")
          .update(request.code)
          .digest("hex");
        const job = await dispatch(request);
        if (
          job.requestId !== request.requestId ||
          job.sourceHash !== expected ||
          job.state !== "succeeded" ||
          typeof job.result?.stdout !== "string"
        )
          throw new Error(
            `No matching terminal success for ${request.requestId}: ${job.state}; do not resubmit`,
          );
        return { text: job.result.stdout };
      },
    },
    "camera.save",
    {},
    context(document, component),
  );
  const state = output.result?.state;
  if (
    !output.success ||
    output.operation !== "camera.save" ||
    state?.document?.name !== document.name ||
    state.document.creationId !== document.creationId ||
    (document.fileId !== undefined &&
      state.document.dataFileId !== document.fileId) ||
    state.units !== "cm" ||
    !["eye", "target", "up"].every(
      (key) =>
        Array.isArray(state[key]) &&
        state[key].length === 3 &&
        state[key].every(Number.isFinite),
    ) ||
    !(state.cameraType === "OrthographicCameraType"
      ? Array.isArray(state.extents) &&
        state.extents.length === 2 &&
        state.extents.every((v) => Number.isFinite(v) && v > 0)
      : [
          "PerspectiveCameraType",
          "PerspectiveWithOrthoFacesCameraType",
        ].includes(state.cameraType) &&
        Number.isFinite(state.perspectiveAngle) &&
        state.perspectiveAngle > 0 &&
        state.perspectiveAngle < Math.PI)
  )
    throw new Error("Missing or mismatched camera snapshot");
  return output;
}

const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });

async function main([mode, pinFile, output, ...rest]) {
  if (
    !["prepare", "run"].includes(mode) ||
    !pinFile ||
    !output ||
    rest.length > 1
  )
    throw new Error(
      "Usage: swarm-camera.cjs prepare PIN.json REQUEST.json [component] | run PIN.json NEW_EVIDENCE_DIR [component]",
    );
  const document = JSON.parse(readFileSync(pinFile, "utf8"));
  if (mode === "prepare") return save(output, prepareCamera(document, rest[0]));
  mkdirSync(output, { mode: 0o700 }); // New, private directory; keep original requests after failures.
  const directoryArgs =
    process.env.SWARM_DIRECTORY === undefined
      ? []
      : ["--directory", process.env.SWARM_DIRECTORY];
  const cli = (...args) =>
    JSON.parse(
      execFileSync(
        process.env.SWARM_CLI || "fs-cli",
        [...args, ...directoryArgs],
        {
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        },
      ),
    );
  const result = await runCamera(document, rest[0], async (request) => {
    const file = join(output, request.requestId + ".json");
    save(file, request);
    const first = cli("execute", file);
    let job = first;
    const deadline = Date.now() + 180000;
    while (["preparing", "queued", "running", "sending"].includes(job.state)) {
      if (job.requestId !== request.requestId || Date.now() >= deadline)
        throw new Error(
          `Inspect original request ${request.requestId}; do not resubmit`,
        );
      await delay(250);
      job = cli("get", request.requestId);
      if (job.id !== first.id) throw new Error("Swarm job identity changed");
    }
    save(join(output, request.requestId + ".result.json"), job);
    return job;
  });
  save(join(output, "camera-result.json"), result);
  console.log(JSON.stringify(result));
}

module.exports = { prepareCamera, runCamera };
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
