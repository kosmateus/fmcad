"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { main } = require("../src/cli");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-run-out-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "trusted.py");
  await fs.writeFile(
    script,
    'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  );
  return { dir, script };
}
function harness(output = { text: "OK" }, execute) {
  const calls = [];
  let stdout = "",
    stderr = "";
  const h = {
    calls,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    deps: {
      stdout: {
        write(text) {
          stdout += text;
        },
      },
      stderr: {
        write(text) {
          stderr += text;
        },
      },
      setExitCode() {},
      loadConfig() {
        return { cfg: { backend: "mcp", queue: { autoStart: false } } };
      },
      createFmcad() {
        return {
          async start() {},
          async dispose() {},
          async execute(payload, options) {
            calls.push({ payload, options });
            const value = execute ? await execute(payload, options) : output;
            if (!value || typeof value !== "object")
              throw Error("invalid fake receipt");
            let failed = value.failed === true;
            let rawStderr = value.stderr ?? "";
            if (!failed && payload.kind === "run" && payload.output?.path) {
              try {
                const formatted = require("../src/run").formatRunOutput(
                  value.text ?? "",
                  payload.output.format,
                  payload.output.pretty,
                );
                await require("../src/publish").publishComplete(
                  payload.output.path,
                  formatted,
                );
              } catch (error) {
                failed = true;
                rawStderr += `ERROR Run output was not confirmed published: ${error.message}. Script may have mutated Fusion; inspect before another run. No automatic retry.\n`;
              }
            }
            return {
              version: 1,
              requestId: options.requestId,
              jobId: "cli-test-job",
              state: value.state ?? (failed ? "failed" : "succeeded"),
              result: null,
              output: { stdout: value.text ?? "", stderr: rawStderr },
              outcome: {
                version: 1,
                requestId: null,
                jobId: null,
                acceptance: "accepted",
                executionOutcome: failed ? "failed" : "succeeded",
                mayHaveMutated: null,
                validation: {
                  status: "not_checked",
                  source: null,
                  artifactId: null,
                  measurements: {},
                },
                code: null,
              },
            };
          },
        };
      },
    },
  };
  return h;
}
const command = (script, ...args) => ["run", script, ...args];

test("output parser rejects missing values and invalid combinations before script/config/admission", async (t) => {
  const { script } = await fixture(t);
  for (const flags of [
    ["--out"],
    ["--out", ""],
    ["--out-format"],
    ["--pretty"],
    ["--out-format", "text"],
    ["--out-format", "json"],
    ["--pretty", "false"],
    ["--out", "result", "--out-format", "yaml"],
    ["--out", "result", "--pretty", "true"],
    ["--out", "result", "--out-format", "text", "--pretty", "false"],
    ["--out", "result", "--out-format", "json", "--pretty", "yes"],
    ["--out", "result", "--out-format", "json", "--pretty", "TRUE"],
    ["--list", "--out", "result"],
    ["-l", "--out-format", "json"],
    ["--list", "--pretty", "true"],
  ]) {
    const h = harness();
    assert.equal(
      await main(command(script, ...flags), h.deps),
      1,
      flags.join(" "),
    );
    assert.deepEqual(h.calls, []);
    assert.match(h.stderr, /ERROR/);
  }
});

test("publish path checks precede service start or execute", async (t) => {
  const { dir, script } = await fixture(t);
  const original = path.join(dir, "original");
  await fs.writeFile(original, "untouched");
  await fs.symlink(path.join(dir, "missing"), path.join(dir, "dangling"));
  await fs.symlink(original, path.join(dir, "symlink"));
  await fs.link(original, path.join(dir, "hardlink"));
  for (const target of [
    original,
    dir,
    path.join(dir, "dangling"),
    path.join(dir, "symlink"),
    path.join(dir, "hardlink"),
    path.join(dir, "missing", "out"),
    path.join(original, "out"),
  ]) {
    const h = harness();
    assert.equal(await main(command(script, "--out", target), h.deps), 1);
    assert.deepEqual(h.calls, []);
  }
  assert.equal(await fs.readFile(original, "utf8"), "untouched");
  assert.equal(
    (await fs.lstat(path.join(dir, "dangling"))).isSymbolicLink(),
    true,
  );
});

test("stdout and stderr retain exact UTF-8 bytes; text publication does not normalize", async (t) => {
  const { dir, script } = await fixture(t);
  let index = 0;
  for (const text of [
    "",
    "not JSON",
    "Zażółć 🧩\r\n\t  \n",
    "private-token\u0000no final newline",
  ]) {
    for (const format of [[], ["--out-format", "text"]]) {
      const target = path.join(dir, `out-${index++}`);
      const rawStderr = "diagnostic private-token\n";
      const h = harness({ text, stderr: rawStderr });
      assert.equal(
        await main(command(script, "--out", target, ...format), h.deps),
        0,
        h.stderr,
      );
      assert.deepEqual(await fs.readFile(target), Buffer.from(text, "utf8"));
      assert.equal(h.stdout, text);
      assert.ok(h.stderr.includes(rawStderr));
      assert.equal(h.calls.length, 1);
    }
    const h = harness({ text });
    assert.equal(await main(command(script), h.deps), 0);
    assert.equal(h.stdout, text);
    assert.equal(h.calls.length, 1);
  }
});

test("JSON output publishes whole values or one supported marker without altering terminal stream", async (t) => {
  const { dir, script } = await fixture(t);
  let index = 0;
  for (const value of [
    null,
    false,
    0,
    1.25,
    "Zażółć 🧩 private-token",
    [],
    { nested: [true, null, "ż"] },
    "FMCAD_RESULT {}",
  ]) {
    for (const text of [
      JSON.stringify(value),
      `diagnostic\nFMCAD_RESULT ${JSON.stringify(value)}\nDONE`,
    ]) {
      for (const pretty of [undefined, "true", "false"]) {
        const target = path.join(dir, `out-${index++}`);
        const h = harness({ text });
        const flags = pretty === undefined ? [] : ["--pretty", pretty];
        assert.equal(
          await main(
            command(script, "--out", target, "--out-format", "json", ...flags),
            h.deps,
          ),
          0,
          h.stderr,
        );
        assert.equal(
          await fs.readFile(target, "utf8"),
          JSON.stringify(value, null, pretty === "true" ? 2 : 0) + "\n",
        );
        assert.equal(h.stdout, text);
      }
    }
  }
});

test("malformed or ambiguous JSON refuses publication after one execute and preserves original output", async (t) => {
  const { dir, script } = await fixture(t);
  let index = 0;
  for (const text of [
    "",
    "not JSON",
    "{bad}",
    "{}\n{}",
    "diagnostic\n{}",
    "FMCAD_RESULT",
    "FMCAD_RESULT {} trailing",
    "FMCAD_RESULT {}\nFMCAD_RESULT {}",
    'FMCAD_RESULT {\n"a":1\n}',
  ]) {
    const target = path.join(dir, `out-${index++}`);
    const h = harness({ text });
    assert.equal(
      await main(
        command(script, "--out", target, "--out-format", "json"),
        h.deps,
      ),
      1,
      text,
    );
    assert.equal(h.stdout, text);
    assert.match(h.stderr, /JSON output/);
    assert.match(h.stderr, /may have mutated.*No automatic retry/);
    assert.equal(h.calls.length, 1);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  }
  assert.deepEqual(await fs.readdir(dir), ["trusted.py"]);
});

test("failed execution retains raw output, never publishes or retries; publication collision is not overwritten", async (t) => {
  const { dir, script } = await fixture(t);
  for (const format of ["text", "json"]) {
    const target = path.join(dir, format);
    const text = '{"success":true,"message":"private-token"}';
    const h = harness({
      text,
      stderr: "legacy suppressed stderr",
      failed: true,
    });
    assert.equal(
      await main(
        command(script, "--out", target, "--out-format", format),
        h.deps,
      ),
      1,
    );
    assert.equal(h.stdout, text);
    assert.ok(h.stderr.includes("legacy suppressed stderr"));
    assert.equal(h.calls.length, 1);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  }
  const target = path.join(dir, "racing-output");
  const collision = harness(null, async () => {
    await fs.writeFile(target, "racing writer", { flag: "wx" });
    return { text: "script completed" };
  });
  assert.equal(await main(command(script, "--out", target), collision.deps), 1);
  assert.equal(collision.stdout, "script completed");
  assert.match(collision.stderr, /may have mutated.*No automatic retry/);
  assert.equal(collision.calls.length, 1);
  assert.equal(await fs.readFile(target, "utf8"), "racing writer");
});
