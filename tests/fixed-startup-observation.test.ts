import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  createQueueInstance,
  type ProbeOptions,
  type ProbeClient,
  type ProbeReceiptObservation,
  type FusionIdentity,
} from "../packages/node-adapters/src/execution/queue-instance";
import * as platform from "../packages/node-adapters/src/config-platform";
import { createPythonChecker } from "../packages/node-adapters/src/python/checker";
import { createPythonRpcAdmission } from "../packages/node-adapters/src/python/admission";

const qi = createQueueInstance(path.resolve("src/queue-instance.js"), {
  ...platform,
  resolveRuntimePaths: (options) => ({
    ...platform.resolveRuntimePaths(options), runtime: path.resolve("runtime/python"),
  }),
});
const load = createRequire(path.resolve("tests/fixture-loader.cjs"));
export const { runStartupProbe } = load("./fixtures/startup-observation-runner.cjs") as {
  runStartupProbe(script: string, scenario?: string, reference?: string): {
    failed: boolean; text: string; stderr: string;
    report: { events: string[]; reference: { audit?: unknown; refused?: string } | null };
  };
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(scenario = "valid", extra: Partial<ProbeOptions> = {}) {
  const directory = fs.mkdtempSync("/tmp/opencode/fixed-startup-probe-");
  const receipt = path.join(directory, "startup.receipt.json");
  let sends = 0, prepares = 0;
  let execution: ReturnType<typeof runStartupProbe> | undefined;
  let captured: { identity: FusionIdentity; receipt?: ProbeReceiptObservation } | undefined;
  let transform: ((value: ReturnType<typeof runStartupProbe>) => void) | undefined;
  const client: ProbeClient = {
    server: { timeoutMs: 30000 },
    async prepareCallTool(args, tool, manifest) {
      prepares++;
      assert.equal(tool, "fusion_mcp_execute");
      assert.equal(args.object.readOnly, true);
      assert.ok(manifest);
      return Object.assign(async () => {
        sends++;
        execution = runStartupProbe(args.object.script, scenario,
          process.env["FMCAD_NATIVE_STARTUP_AUDIT_REFERENCE"]);
        transform?.(execution);
        return execution;
      }, { fence() {} });
    },
    async callTool() { assert.fail("Audited probe must use existing prepared/certified path"); },
  };
  const options: ProbeOptions = {
    startupAudit: true,
    receiptPath: receipt, binding: { stage: "startup", rpcId: "owned", buildHash: "b".repeat(64) },
    mapPath: (file) => file, requireIdle: false,
    onObservation(identity, original) { captured = {
      identity, ...(original ? { receipt: original } : {}),
    }; }, ...extra,
  };
  return { directory, receipt, client, options,
    run: () => qi.probe(client, options),
    execution: () => execution, captured: () => captured,
    counts: () => ({ sends, prepares }),
    changeWire(value: NonNullable<typeof transform>) { transform = value; },
  };
}

test("fixed startup audit uses actual generated receipt, preserves raw manifest and matches native17", async () => {
  const f = fixture();
  const identity = await f.run();
  assert.ok(identity.startupAudit);
  assert.equal(identity.startupAudit?.scripts.countBefore, 2);
  assert.equal(identity.startupAudit.scripts.countAfter, 2);
  assert.equal(identity.startupAudit.scripts.items.length, 2);
  assert.equal(identity.startupAudit.scripts.items[1]?.isRunOnStartup, null);
  assert.equal(identity.startupAudit.scripts.items[1]?.isVisible, false);
  const raw = fs.readFileSync(f.receipt);
  assert.equal(f.captured()?.receipt?.sha256, sha(raw));
  assert.deepEqual(f.captured()?.receipt?.bytes, Uint8Array.from(raw));
  const receipt = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(receipt.probeObservation.identity, identity);
  assert.equal(receipt.terminal, true);
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(f.execution()?.report.events.filter(name => name === "isRunOnStartup").length, 1);
  if (process.env["FMCAD_NATIVE_STARTUP_AUDIT_REFERENCE"])
    assert.deepEqual(identity.startupAudit, f.execution()?.report.reference?.audit);
  assert.deepEqual(f.counts(), { sends: 1, prepares: 1 });
  assert.equal(f.client.server.timeoutMs, 30000);
});

test("default readiness never reads API preferences or ScriptCollection", async () => {
  const f = fixture();
  delete f.options.startupAudit;
  const result = await f.run();
  assert.equal(result.startupAudit, undefined);
  assert.deepEqual(f.execution()?.report.events, []);
  assert.equal(f.captured()?.receipt, undefined);
});

test("genuine empty SDK collection is captured, never synthesized on failure", async () => {
  const f = fixture("empty");
  const result = await f.run();
  assert.deepEqual(result.startupAudit?.scripts, { countBefore: 0, countAfter: 0, items: [] });
});

test("exact item/manifest budgets remain inclusive and never truncate the collection", async () => {
  const full = await fixture("max-count").run();
  assert.equal(full.startupAudit?.scripts.items.length, 1024);
  assert.equal(full.startupAudit?.scripts.items[1023]?.index, 1023);
  const exact = await fixture("manifest-exact").run();
  assert.equal(Buffer.byteLength(exact.startupAudit!.scripts.items[0]!.manifest.content, "utf8"), 256 * 1024);
});

test("wrong SDK types, unsupported getters, counts, enums, strict manifests and budgets refuse original observation", async (t) => {
  for (const scenario of [
    "unsupported-sdk", "scripts-null", "parent-null", "parent-change", "folder-null",
    "folder-relative", "getter-failure", "unknown-enum", "enum-missing", "enum-bool",
    "boolean-int", "running-null", "startup-null", "visible-missing",
    "count-null", "count-bool", "count-negative", "count-budget", "count-change", "item-null",
    "manifest-null", "manifest-empty", "manifest-number", "manifest-bad",
    "manifest-duplicate", "manifest-nonfinite", "manifest-overflow", "manifest-array",
    "manifest-budget", "audit-budget",
  ]) await t.test(scenario, async () => {
    const f = fixture(scenario);
    await assert.rejects(f.run(), { code: "INSTANCE_UNAVAILABLE" });
    assert.equal(f.captured(), undefined);
    const receipt = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
    assert.equal(receipt.outcome, "failed");
    assert.equal(receipt.probeObservation, undefined);
    if (process.env["FMCAD_NATIVE_STARTUP_AUDIT_REFERENCE"])
      assert.ok(f.execution()?.report.reference?.refused, "Native17 must also refuse, not produce a permissive fallback");
  });
});

test("startup audit requires bound original receipt and prepared call; caller flags are not provenance", async () => {
  const f = fixture();
  await assert.rejects(qi.probe(f.client, { startupAudit: true }));
  await assert.rejects(qi.probe({ ...f.client, prepareCallTool: undefined } as unknown as ProbeClient, f.options));
  assert.deepEqual(f.counts(), { sends: 0, prepares: 0 });
});

test("wrong expected process rejects before any startup SDK getters", async () => {
  const f = fixture("valid", { binding: {
    stage: "startup", auditExpectedProcess: { pid: 992, birth: "foreign:2" },
  } });
  await assert.rejects(f.run());
  assert.deepEqual(f.execution()?.report.events, []);
  assert.equal(f.captured(), undefined);
});

test("changed source/native fence and foreign wire cannot publish data or rewrite original receipt", async () => {
  const f = fixture();
  let changed = false;
  f.options.assertCurrent = () => { if (changed) throw Error("source/native changed"); };
  f.changeWire(() => { changed = true; });
  await assert.rejects(f.run(), /source\/native changed/);
  assert.equal(f.captured(), undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt, "utf8")).outcome, "succeeded");
  const foreign = fixture();
  foreign.changeWire((output) => {
    const original = JSON.parse(fs.readFileSync(foreign.receipt, "utf8"));
    output.text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify({
      ...original.probeObservation.identity, startupAudit: undefined,
    });
  });
  await assert.rejects(foreign.run(), /conflicts with the bound receipt/);
  assert.equal(foreign.captured(), undefined);
});

test("even matching receipt/wire cannot claim strict manifest success for duplicate keys or nonfinite floats", async () => {
  for (const content of ['{"x":1,"x":2}', '{"x":1e999}']) {
    const f = fixture();
    f.changeWire((output) => {
      const receipt = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
      receipt.probeObservation.identity.startupAudit.scripts.items[0].manifest = {
        content, sha256: sha(Buffer.from(content, "utf8")), parseStatus: "json-object",
      };
      fs.writeFileSync(f.receipt, JSON.stringify(receipt));
      output.text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(receipt.probeObservation.identity);
    });
    await assert.rejects(f.run(), /audit is missing or malformed/);
    assert.equal(f.captured(), undefined);
  }
});

test("matching JSON qualification flags outside the closed fixed identity are refused", async () => {
  const f = fixture();
  f.changeWire((output) => {
    const receipt = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
    receipt.probeObservation.identity.allStartupOff = true;
    fs.writeFileSync(f.receipt, JSON.stringify(receipt));
    output.text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(receipt.probeObservation.identity);
  });
  await assert.rejects(f.run(), /audit is missing or malformed/);
  assert.equal(f.captured(), undefined);
});

test("opt-in startup probe passes actual Windows SDK offline certification and final-wire fence without sending", async (t) => {
  const runtime = path.resolve("runtime/python");
  const typing = process.env["FMCAD_STARTUP_TEST_TYPING_ROOT"] || path.join(runtime, "typing");
  const admission = createPythonRpcAdmission({ runtime, checker: createPythonChecker({
    typingRoot: typing, definitionsRoot: typing,
    pythonPlatform: "Windows",
  }) });
  const f = fixture();
  let checks = 0;
  const prepared = await qi.prepareProbe({
    server: { timeoutMs: 15000 },
    async callTool() { assert.fail("No SDK/transport in offline checker"); },
    async prepareCallTool(args, tool) {
      const message = { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: tool, arguments: args } };
      const certificate = await admission.check(message).catch((error: unknown) => {
        t.diagnostic(JSON.stringify((error as { pythonCheck?: unknown }).pythonCheck));
        throw error;
      });
      assert.equal(certificate.report?.status, "passed");
      certificate.fence(message);
      const changed = structuredClone(message);
      changed.params.arguments.object.script += "\n# foreign wire";
      assert.throws(() => certificate.fence(changed), "A checked source must not authorize changed wire bytes");
      const flags = structuredClone(message);
      flags.params.arguments.object.readOnly = false;
      assert.throws(() => certificate.fence(flags), "Caller readOnly flags cannot stand in for the original certificate");
      checks++;
      return Object.assign(async () => { assert.fail("No send"); },
        { fence: () => certificate.fence(message) });
    },
  }, f.options);
  prepared.fence();
  assert.equal(checks, 1);
  assert.equal(fs.existsSync(f.receipt), false);
});
