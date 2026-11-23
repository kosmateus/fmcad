const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocumentCreationAuthority: create, verifiedDocumentCreation: verify } =
  require("../packages/core/dist/domain/document-creation.js");
const witness = () => ({ version: 1, requestHash: "a".repeat(64), generation: "current",
  rpcHash: "b".repeat(64), programHash: "c".repeat(64) });
test("creation authority is domain-private, synchronous, and never reconstructed from its JSON marker", () => {
  const domain = {}, marker = witness(), cap = create(domain, () => marker);
  assert.deepEqual(verify(cap, domain), marker);
  for (const fake of [undefined, {}, JSON.parse(JSON.stringify(cap))])
    assert.throws(() => verify(fake, domain), { code: "DOCUMENT_CREATION_UNPROVEN" });
  assert.throws(() => verify(cap, {}), { code: "DOCUMENT_CREATION_UNPROVEN" });
  const frozen = verify(cap, domain);
  marker.rpcHash = "d".repeat(64);
  assert.equal(frozen.rpcHash, "b".repeat(64));
  assert.ok(Object.isFrozen(frozen));
  assert.equal(verify(cap, domain).rpcHash, "d".repeat(64));
  for (const callback of [async () => witness(), () => ({ ...witness(), readOnly: true }),
    () => ({ ...witness(), generation: "" }), () => null])
    assert.throws(() => verify(create(domain, callback), domain), { code: "DOCUMENT_CREATION_UNPROVEN" });
});
