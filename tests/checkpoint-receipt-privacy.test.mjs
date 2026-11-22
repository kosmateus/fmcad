import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const runtimeRequire = createRequire(import.meta.url);
const { sealFreshCheckpointReceipt } = runtimeRequire(
  "../src/document-checkpoint-receipt.js",
);

function fixture() {
  const directory = fs.mkdtempSync("/tmp/opencode/checkpoint-receipt-private-");
  fs.chmodSync(directory, 0o700);
  const jobId = "fresh-job",
    rpcId = "fresh-rpc";
  const parent = path.join(directory, "jobs", jobId);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(parent, `remote-${rpcId}.json`);
  const bytes = Buffer.from('{"terminal":true,"outcome":"succeeded"}\n');
  fs.writeFileSync(receiptPath, bytes, { mode: 0o644 });
  fs.chmodSync(receiptPath, 0o644);
  let authenticated = 0;
  const input = {
    directory,
    jobId,
    rpcId,
    receiptPath,
    authenticateOriginal(value) {
      assert.deepEqual(Buffer.from(value), bytes);
      authenticated++;
    },
  };
  return {
    directory,
    parent,
    receiptPath,
    bytes,
    input,
    authenticated: () => authenticated,
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("fresh Windows-style receipt becomes private without changing original inode or bytes", () => {
  const f = fixture();
  try {
    const before = fs.statSync(f.receiptPath);
    sealFreshCheckpointReceipt(f.input);
    const after = fs.statSync(f.receiptPath);
    assert.equal(after.mode & 0o7777, 0o600);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.deepEqual(fs.readFileSync(f.receiptPath), f.bytes);
    assert.equal(f.authenticated(), 1);
  } finally {
    f.close();
  }
});

for (const kind of [
  "foreign-path",
  "symlink",
  "hardlink",
  "writable",
  "public-parent",
  "changed-bytes",
  "changed-path",
  "async-verifier",
]) {
  test(`receipt sealing refuses ${kind} without publishing private evidence`, () => {
    const f = fixture();
    try {
      const other = path.join(f.parent, "other.json");
      if (kind === "foreign-path") f.input.receiptPath = other;
      if (kind === "symlink") {
        fs.renameSync(f.receiptPath, other);
        fs.symlinkSync(other, f.receiptPath);
      }
      if (kind === "hardlink") fs.linkSync(f.receiptPath, other);
      if (kind === "writable") fs.chmodSync(f.receiptPath, 0o666);
      if (kind === "public-parent") fs.chmodSync(f.parent, 0o755);
      if (kind === "changed-bytes")
        f.input.authenticateOriginal = () =>
          fs.appendFileSync(f.receiptPath, " ");
      if (kind === "changed-path")
        f.input.authenticateOriginal = () => {
          fs.renameSync(f.receiptPath, other);
          fs.writeFileSync(f.receiptPath, f.bytes, { mode: 0o644 });
        };
      if (kind === "async-verifier")
        f.input.authenticateOriginal = async () => {};
      assert.throws(() => sealFreshCheckpointReceipt(f.input), {
        code: "STORAGE_UNAVAILABLE",
      });
    } finally {
      f.close();
    }
  });
}

test("sealing closes every pinned descriptor after a reported close error", () => {
  const f = fixture();
  let closed = 0;
  try {
    assert.throws(
      () =>
        sealFreshCheckpointReceipt(f.input, {
          ...fs,
          closeSync(fd) {
            fs.closeSync(fd);
            closed++;
            if (closed === 1) throw Error("Injected close error");
          },
        }),
      { code: "STORAGE_UNAVAILABLE" },
    );
    assert.equal(closed, 4);
  } finally {
    f.close();
  }
});

test("sealing retains its original selector across verifier input mutation", () => {
  const f = fixture();
  f.input.authenticateOriginal = () => {
    f.input.receiptPath = path.join(f.directory, "foreign.json");
  };
  try {
    sealFreshCheckpointReceipt(f.input);
    assert.equal(fs.statSync(f.receiptPath).mode & 0o7777, 0o600);
    assert.equal(fs.existsSync(f.input.receiptPath), false);
  } finally {
    f.close();
  }
});

test("failed original authentication never changes the new receipt's mode", () => {
  const f = fixture();
  try {
    f.input.authenticateOriginal = () => {
      throw Error("Original binding refused");
    };
    assert.throws(() => sealFreshCheckpointReceipt(f.input));
    assert.equal(fs.statSync(f.receiptPath).mode & 0o7777, 0o644);
  } finally {
    f.close();
  }
});

for (const kind of [
  "ignored-chmod",
  "changed-after-chmod",
  "parent-replaced-after-chmod",
]) {
  test(`sealing refuses ${kind} at the final descriptor boundary`, () => {
    const f = fixture();
    try {
      assert.throws(
        () =>
          sealFreshCheckpointReceipt(f.input, {
            ...fs,
            fchmodSync(fd, mode) {
              if (kind === "ignored-chmod") return;
              fs.fchmodSync(fd, mode);
              if (kind === "changed-after-chmod")
                fs.appendFileSync(f.receiptPath, " ");
              if (kind === "parent-replaced-after-chmod") {
                fs.renameSync(f.parent, f.parent + "-old");
                fs.mkdirSync(f.parent, { mode: 0o700 });
                fs.writeFileSync(f.receiptPath, f.bytes, { mode: 0o600 });
              }
            },
          }),
        { code: "STORAGE_UNAVAILABLE" },
      );
    } finally {
      f.close();
    }
  });
}
