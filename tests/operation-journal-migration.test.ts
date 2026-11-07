import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Journal =
  typeof import("../packages/node-adapters/src/persistence/operation-journal.js");
const current = load(
  "./src/dist/node-adapters/persistence/operation-journal.js",
) as Journal;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const versions: [string, Journal][] = [
  [
    "pre-refactor",
    historical(
      "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
      "src/batch-atomic.js",
    ) as Journal,
  ],
  [
    "before extraction",
    historical(
      "e92a0ee0133c8dccd93fe9157044668cbfcbd33c",
      "src/batch-atomic.js",
    ) as Journal,
  ],
  ["typed adapter", current],
];
const binding = {
  operation: "document.save.once",
  requestId: "request-A",
  target: { creationId: "owned-A", fileId: "file-A", version: 4 },
};

async function fixture(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "operation-journal-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("journal extraction preserves complete bytes, order, binding and opaque owner results", async (t) => {
  t.mock.method(
    Date.prototype,
    "toISOString",
    () => "2026-01-02T03:04:05.000Z",
  );
  const snapshots: { records: unknown[]; bytes: string[] }[] = [];
  for (const [, api] of versions) {
    const directory = await fixture(t);
    const values = [
      {
        operation: "document.save.once",
        state: "accepted",
        result: { status: "accepted", changed: true },
      },
      {
        operation: "document.save.once",
        state: "complete",
        result: {
          status: "complete",
          resultingVersion: 5,
          cloudComplete: true,
        },
      },
      {
        event: "owner-specific",
        result: { extra: [null, false, "Zażółć 🧪"] },
        sequence: 999,
        binding: { foreign: true },
        at: "untrusted",
      },
    ];
    const records = [];
    for (const [sequence, value] of values.entries()) {
      const record = await api.writeOperationRecord(
        directory,
        binding,
        sequence,
        value,
      );
      assert.equal(record.sequence, sequence);
      assert.deepEqual(record.binding, binding);
      assert.equal(record.at, "2026-01-02T03:04:05.000Z");
      records.push(record);
    }
    await fs.writeFile(path.join(directory, "run.lock"), "owner");
    await fs.writeFile(
      path.join(directory, "notes.json"),
      "not a numbered receipt",
    );
    const restored = await api.readOperationJournal(directory, {
      target: binding.target,
      requestId: binding.requestId,
      operation: binding.operation,
    });
    assert.deepEqual(restored, records);
    snapshots.push({
      records,
      bytes: await Promise.all(
        [0, 1, 2].map((n) =>
          fs.readFile(
            path.join(directory, String(n).padStart(8, "0") + ".json"),
            "utf8",
          ),
        ),
      ),
    });
  }
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.deepEqual(snapshots[2], snapshots[0]);
});

for (const [label, api] of versions) {
  test(`${label}: missing journal differs from unreadable evidence`, async (t) => {
    const directory = await fixture(t);
    assert.deepEqual(
      await api.readOperationJournal(path.join(directory, "absent"), binding),
      [],
    );
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const io = { ...fs };
    t.mock.method(io, "readdir", async () => {
      throw error;
    });
    await assert.rejects(
      api.readOperationJournal(directory, binding, io),
      (caught) => caught === error,
    );
  });

  test(`${label}: gaps, changed identities and corrupt records never become receipts`, async (t) => {
    for (const [name, value, expected] of [
      ["00000001.json", { sequence: 1, binding }, /sequence gap/],
      ["00000000.json", { sequence: 1, binding }, /identity mismatch/],
      [
        "00000000.json",
        { sequence: 0, binding: { ...binding, requestId: "foreign-B" } },
        /identity mismatch/,
      ],
      [
        "00000000.json",
        {
          sequence: 0,
          binding: {
            ...binding,
            target: { ...binding.target, fileId: "foreign-B" },
          },
        },
        /identity mismatch/,
      ],
    ] as const) {
      const directory = await fixture(t);
      await fs.writeFile(path.join(directory, name), JSON.stringify(value));
      await assert.rejects(
        api.readOperationJournal(directory, binding),
        expected,
      );
    }
    const directory = await fixture(t);
    await fs.writeFile(path.join(directory, "00000000.json"), "{");
    await assert.rejects(
      api.readOperationJournal(directory, binding),
      SyntaxError,
    );
  });

  test(`${label}: concurrent writers cannot replace an existing receipt`, async (t) => {
    const directory = await fixture(t);
    const outcomes = await Promise.allSettled(
      ["A", "B"].map((writer) =>
        api.writeOperationRecord(directory, binding, 0, { result: { writer } }),
      ),
    );
    const winner = outcomes.find((result) => result.status === "fulfilled");
    assert.ok(winner?.status === "fulfilled");
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.deepEqual(await api.readOperationJournal(directory, binding), [
      winner.value,
    ]);
    assert.deepEqual(await fs.readdir(directory), ["00000000.json"]);
    const bytes = await fs.readFile(path.join(directory, "00000000.json"));
    await assert.rejects(
      api.writeOperationRecord(directory, binding, 0, {
        result: { writer: "replacement" },
      }),
      { code: "EEXIST" },
    );
    assert.deepEqual(
      await fs.readFile(path.join(directory, "00000000.json")),
      bytes,
    );
  });

  test(`${label}: publication failure preserves uncertainty and cleans temporary files`, async (t) => {
    for (const phase of ["link", "directory-sync"] as const) {
      const directory = await fixture(t);
      const io = { ...fs };
      const failure = new Error(phase + " failure");
      if (phase === "link") {
        t.mock.method(io, "link", async () => {
          throw failure;
        });
      } else {
        t.mock.method(
          io,
          "open",
          async (...args: Parameters<typeof fs.open>) => {
            const handle = await fs.open(...args);
            if (args[0] === directory)
              t.mock.method(handle, "sync", async () => {
                throw failure;
              });
            return handle;
          },
        );
      }
      await assert.rejects(
        api.writeOperationRecord(
          directory,
          binding,
          0,
          { result: { status: "accepted" } },
          io,
        ),
        (caught) => caught === failure,
      );
      assert.deepEqual(
        await fs.readdir(directory),
        phase === "link" ? [] : ["00000000.json"],
      );
      const records = await api.readOperationJournal(directory, binding);
      assert.equal(records.length, phase === "link" ? 0 : 1);
      if (phase === "directory-sync") {
        // Publication may have happened: a retry must not overwrite this evidence.
        await assert.rejects(
          api.writeOperationRecord(directory, binding, 0, {
            result: { status: "replayed" },
          }),
          { code: "EEXIST" },
        );
      }
    }
  });
}
