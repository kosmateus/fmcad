const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDocumentMetadataReadAuthority: create,
  verifiedDocumentMetadataRead: verify,
} = require("../packages/core/dist/domain/document-metadata-read.js");
const witness = () => ({
  version: 1,
  requestHash: "a".repeat(64),
  generation: "owned-current-generation",
  rpcHash: "b".repeat(64),
  programHash: "c".repeat(64),
});
test("metadata authority is private and bound to one domain instance", () => {
  const domain = {}, cap = create(domain, witness);
  assert.deepEqual(verify(cap, domain), witness());
  for (const candidate of [undefined, {}, JSON.parse(JSON.stringify(cap))])
    assert.throws(() => verify(candidate, domain),
      { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
  assert.throws(() => verify(cap, {}),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
});
test("every use rechecks the compiler witness and returns an immutable copy", () => {
  const domain = {}, current = witness();
  const cap = create(domain, () => current);
  const first = verify(cap, domain);
  current.programHash = "d".repeat(64);
  assert.equal(first.programHash, "c".repeat(64));
  assert.ok(Object.isFrozen(first));
  assert.equal(verify(cap, domain).programHash, "d".repeat(64));
  current.requestHash = "invalid";
  assert.throws(() => verify(cap, domain),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
});
test("an async or malformed verifier cannot mint synchronous authority", () => {
  const domain = {};
  for (const callback of [
    async () => witness(),
    () => ({ ...witness(), readonly: true }),
    () => ({ ...witness(), generation: "" }),
    () => null,
  ]) {
    const cap = create(domain, callback);
    assert.throws(() => verify(cap, domain),
      { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
  }
});
