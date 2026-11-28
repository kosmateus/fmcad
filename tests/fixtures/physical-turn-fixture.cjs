"use strict";
const { createHash } = require("node:crypto");
// Independent synthetic authority: mirror the documented fork release encoding,
// not the broker's validation implementation. This never attests a live SDK.
module.exports = function releasedProof(binding) {
  const runtime = binding.physicalRuntime;
  const encoded = JSON.stringify({
    binding: {
      generation: {
        epoch: binding.generation.epoch,
        instance: binding.generation.instance,
      },
      grantDigest: binding.grantDigest,
      physicalRuntime: {
        birth: runtime.birth,
        build: runtime.build,
        pid: runtime.pid,
        source: runtime.source,
        version: runtime.version,
      },
      target: binding.target,
      turnId: binding.turnId,
      version: binding.version,
    },
    releasedBy: "dispatch-finally",
    state: "released",
  }).replace(
    /[\u007f-\uffff]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const evidenceDigest = createHash("sha256").update(encoded).digest("hex");
  return {
    state: "released",
    binding,
    evidenceDigest,
    physicalEvidenceReference: "fmcad-physical-turn:sha256:" + evidenceDigest,
  };
};
