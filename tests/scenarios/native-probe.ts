import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ScenarioSession } from "./runner";
import type { Execution } from "./contracts";
import { record } from "./contracts";
import { program } from "./programs";

const load = createRequire(path.join(process.cwd(), "package.json"));
const { buildCadScript } = load(
  "./src/cad.js",
) as typeof import("../../src/composition/cad");

export interface NativeMethodEvidence {
  operation: string;
  status: "invoked" | "pass" | "blocked" | "expected-rejection";
  result?: Record<string, unknown>;
  assertions?: string[];
}
export interface NativeAssertionEvidence {
  operation: string;
  label: string;
  actual: unknown;
  expected: unknown;
  tolerance: number;
  status: "pass" | "fail";
}
export function containsUnsettled(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (
    row["status"] === "unknown" ||
    row["executionOutcome"] === "unknown" ||
    row["completed"] === false ||
    ["started", "running", "pending"].includes(String(row["status"]))
  )
    return true;
  return Object.values(value).some(containsUnsettled);
}

/** Common native readback adapter on the existing request, ownership and cleanup lifecycle. */
export class NativeProbe {
  #sequence = 0;
  readonly methods: NativeMethodEvidence[] = [];
  readonly assertions: NativeAssertionEvidence[] = [];
  readonly observations: { phase: string; result: unknown }[] = [];
  constructor(
    readonly session: ScenarioSession,
    readonly suite: string,
    readonly marker: string,
    readonly runtimePrelude = "",
  ) {}
  get name(): string {
    return this.session.document.name;
  }
  get directory(): string {
    return this.session.backend.fusionPath(this.session.directory);
  }
  get uncertain(): boolean {
    return this.session.uncertain;
  }
  persist(): void {
    fs.writeFileSync(
      path.join(this.session.directory, this.suite + "-evidence.json"),
      JSON.stringify(
        {
          owner: this.session.report.owner,
          document: this.session.document,
          scenarioReport: "report.json",
          methods: this.methods,
          assertions: this.assertions,
          observations: this.observations,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  async guard(): Promise<void> {
    await this.session.verifyOwnedUnsaved(
      `observe-${this.suite}-guard-${this.#sequence++}`,
    );
  }
  async script<T = Record<string, unknown>>(
    body: string | ((requestId: string) => string),
    readOnly = true,
  ): Promise<T> {
    await this.guard();
    const phase = `${this.suite}-probe-${this.#sequence++}`;
    // Preserve the original native assertion bodies and marker while placing
    // their result inside ScenarioSession's exact owned-document envelope.
    // Fixture paths move from the shared OS temp directory to this private run.
    const source = (body: string): string => {
      const scoped = body.replaceAll(
        "tempfile.gettempdir()",
        JSON.stringify(this.directory),
      );
      return (
        this.runtimePrelude +
        "\n" +
        program(`import adsk.core, adsk.fusion, json, os, tempfile, struct, zlib, hashlib, math, builtins
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(this.session.document.creationId)} and d.name == ${JSON.stringify(this.name)}]
assert len(matches) == 1 and app.activeDocument == matches[0] and not matches[0].isSaved and matches[0].dataFile is None, 'Owned active unsaved fixture guard failed'
def print(*values, **options):
    if len(values) == 1 and isinstance(values[0], str) and values[0].startswith(${JSON.stringify(this.marker)}):
        value = json.loads(values[0][${this.marker.length}:])
        builtins.print('FMCAD_SCENARIO ' + json.dumps(dict(creationId=${JSON.stringify(this.session.document.creationId)}, result=value)))
    else:
        builtins.print(*values, **options)
${scoped}`)
      );
    };
    if (readOnly && typeof body !== "string")
      throw new Error(
        "Receipt source factories require a mutating native request",
      );
    const script =
      typeof body === "string"
        ? source(body)
        : (requestId: string) => source(body(requestId));
    const output =
      typeof script === "string" && readOnly
        ? await this.session.observe("observe-" + phase, script)
        : await this.session.execute(
            phase,
            script,
            this.session.document,
            undefined,
            false,
          );
    const result = output["result"];
    assert.notEqual(
      result,
      undefined,
      "Native readback envelope must contain its JSON result",
    );
    this.observations.push({ phase, result });
    this.persist();
    if (containsUnsettled(result))
      this.session.deferCleanup(
        "Native readback is unknown/pending; retain owned fixture and inspect original request without replay",
      );
    return result as T;
  }
  /** Retained production compiled request for dictionary component refs and native profiling. */
  async compiled<T extends object = Record<string, unknown>>(
    operation: string,
    data: Record<string, unknown> = {},
    component: string | Record<string, unknown> = "root",
    instrumentation: (source: string) => string = (source) => source,
    observationsPrefix = "MOTION_OBSERVATIONS ",
  ): Promise<T> {
    await this.guard();
    const phase = `${this.suite}-compiled-${this.#sequence++}`;
    const original = buildCadScript(operation, data, {
      doc: this.name,
      docId: this.session.document.creationId,
      component,
    });
    const source =
      "DOC_NAME = None\n" +
      instrumentation(original) +
      `
import builtins
_native_case_run = run
_native_case_results, _native_case_observations = [], []
def print(*values, **options):
    if len(values) == 1 and isinstance(values[0], str) and values[0].startswith('FMCAD_RESULT '):
        _native_case_results.append(json.loads(values[0][len('FMCAD_RESULT '):]))
    elif len(values) == 1 and isinstance(values[0], str) and values[0].startswith(${JSON.stringify(observationsPrefix)}):
        _native_case_observations.append(json.loads(values[0][${observationsPrefix.length}:]))
    else:
        builtins.print(*values, **options)
def run(context):
    app = adsk.core.Application.get()
    matches = [d for d in app.documents if d.creationId == ${JSON.stringify(this.session.document.creationId)} and d.name == ${JSON.stringify(this.name)}]
    assert len(matches) == 1 and app.activeDocument == matches[0] and not matches[0].isSaved and matches[0].dataFile is None, 'Owned active unsaved fixture guard failed'
    assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command open'
    error, error_type = None, None
    try:
        _native_case_run(context)
    except BaseException as exc:
        error, error_type = str(exc), type(exc).__name__
    builtins.print('FMCAD_SCENARIO ' + json.dumps(dict(creationId=${JSON.stringify(this.session.document.creationId)}, results=_native_case_results, observations=_native_case_observations, error=error, errorType=error_type), allow_nan=False))
`;
    const value = await this.session.execute(
      phase,
      source,
      this.session.document,
      undefined,
      false,
    );
    this.observations.push({ phase, result: value });
    this.persist();
    if (containsUnsettled(value))
      this.session.deferCleanup(
        "Compiled native request contains an unsettled result; inspect original receipt without replay",
      );
    if (value["errorType"] === "JSONDecodeError")
      this.session.deferCleanup(
        "Malformed native production result; retain the original request and fixture",
      );
    if (value["error"] !== null) throw new Error(String(value["error"]));
    const results = value["results"];
    if (!Array.isArray(results) || results.length !== 1)
      this.session.deferCleanup(
        "Missing or ambiguous production CAD result; inspect the original receipt without replay",
      );
    let output: Record<string, unknown>, result: Record<string, unknown>;
    try {
      output = record(results[0]);
      assert.equal(output["operation"], operation);
      assert.equal(output["document"], this.name);
      result = record(output["result"]);
      assert.ok(Object.keys(result).length);
    } catch (error) {
      this.session.deferCleanup(
        "Invalid or foreign native production result: " + String(error),
      );
    }
    this.methods.push({ operation, status: "invoked", result });
    this.persist();
    return output as T;
  }
  async invoke(
    operation: string,
    data: Record<string, unknown> = {},
    component = "root",
  ): Promise<{ output: Record<string, unknown>; execution: Execution }> {
    await this.guard();
    const output = await this.session.cad(
      `cad-${this.suite}-${this.#sequence++}`,
      operation,
      data,
      { component },
    );
    const execution = this.session.report.requests.at(-1)?.result;
    assert.ok(
      execution,
      "The public command must retain its original execution receipt",
    );
    if (containsUnsettled(output))
      this.session.deferCleanup(
        "Native command returned unknown/pending; no replay or automatic cleanup",
      );
    return { output, execution };
  }
  async cad<T extends object = Record<string, unknown>>(
    operation: string,
    data: Record<string, unknown> = {},
    allowBlocked = false,
    component = "root",
  ): Promise<T> {
    const { output, execution } = await this.invoke(operation, data, component);
    const result = record(output["result"]);
    const blocked =
      allowBlocked &&
      output["success"] === false &&
      result["status"] === "blocked";
    assert.equal(
      execution.state,
      blocked ? "failed" : "succeeded",
      JSON.stringify(output),
    );
    assert.equal(output["success"], !blocked, JSON.stringify(output));
    assert.equal(output["operation"], operation);
    assert.equal(output["document"], this.name);
    assert.ok(
      Object.keys(result).length,
      operation + " returned an empty result object",
    );
    this.methods.push({
      operation,
      status: blocked ? "blocked" : "invoked",
      result,
    });
    this.persist();
    return result as T;
  }
  async rejected(
    operation: string,
    data: Record<string, unknown>,
    pattern: RegExp,
  ): Promise<void> {
    try {
      const { output, execution } = await this.invoke(operation, data);
      assert.equal(
        execution.state,
        "failed",
        operation + " unexpectedly accepted",
      );
      assert.equal(output["success"], false);
      assert.match(JSON.stringify(output), pattern);
    } catch (error) {
      if (this.uncertain) throw error;
      assert.match(
        error instanceof Error ? error.message : String(error),
        pattern,
      );
    }
    this.methods.push({ operation, status: "expected-rejection" });
    this.persist();
  }
  check(
    operation: string,
    label: string,
    actual: unknown,
    expected: unknown,
    tolerance = 0,
  ): void {
    const passed = tolerance
      ? typeof actual === "number" &&
        Number.isFinite(actual) &&
        typeof expected === "number" &&
        Math.abs(actual - expected) <= tolerance
      : actual === expected;
    this.assertions.push({
      operation,
      label,
      actual,
      expected,
      tolerance,
      status: passed ? "pass" : "fail",
    });
    const method = this.methods.findLast(
      (item) =>
        item.operation === operation &&
        ["invoked", "blocked"].includes(item.status),
    );
    if (method) method.assertions = [...(method.assertions ?? []), label];
    this.persist();
    assert.ok(
      passed,
      label + ": " + JSON.stringify({ actual, expected, tolerance }),
    );
  }
  validated(operation: string, all = false): void {
    const methods = this.methods.filter(
      (item) => item.operation === operation && item.status === "invoked",
    );
    assert.ok(
      methods.length,
      operation + " has no native invocation to validate",
    );
    for (const method of all ? methods : [methods.at(-1)!])
      method.status = "pass";
    this.persist();
  }
}
