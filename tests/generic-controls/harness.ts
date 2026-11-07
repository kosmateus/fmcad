((): void => {
  type Strategy = "individual" | "bundled";

  interface FixtureCase {
    id: string;
    identity: string;
    variant: "good" | "bad";
    measurements: Record<string, unknown>;
    expected: { status: "pass" | "fail"; failedChecks: string[] };
  }

  interface Fixture {
    schemaVersion: 1;
    fixtureId: string;
    family: string;
    identity: string;
    control: Record<string, unknown>;
    readPaths: string[];
    cases: FixtureCase[];
  }

  interface Check {
    id: string;
    actual: unknown;
    pass: boolean;
    limit: unknown;
  }

  interface ControlResult {
    schemaVersion: 1;
    source: "offline-fake";
    fixtureId: string;
    caseId: string;
    identity: string;
    family: string;
    status: "pass" | "fail";
    checks: Check[];
    failedChecks: string[];
    coverage: {
      requestedReadPaths: string[];
      observedReadPaths: string[];
      complete: boolean;
    };
  }

  interface OfflineMetrics {
    rpcCount: number;
    requestBytes: number;
  }

  interface TimedSample {
    elapsedMs: number;
    cad: OfflineFakeCad;
    result: ControlResult;
  }

  interface FirstCallMeasurement {
    firstCallMs: number;
    result: ControlResult;
  }

  interface StrategyMeasurement {
    firstCallMs: number;
    warmMedianMs: number;
    warmP95Ms: number;
    fakeRpcCount: number;
    fakeRequestBytes: number;
    pythonPayloadBytes: number;
    pythonGlueLoc: number;
    pythonCallerSource: string;
    resultBytes: number;
    resultSha256: string;
    result: ControlResult;
  }

  interface CaseReport {
    fixtureId: string;
    family: string;
    caseId: string;
    variant: "good" | "bad";
    identity: string;
    expected: FixtureCase["expected"];
    equivalentResult: true;
    individual: StrategyMeasurement;
    bundled: StrategyMeasurement;
    budget: {
      maxFakeRpcCount: number;
      maxPythonPayloadBytes: number;
      maxResultBytes: number;
      maxFirstCallMs: number;
      maxWarmP95Ms: number;
      passed: boolean;
    };
  }

  interface BenchmarkReport {
    schemaVersion: 1;
    qualification: "offline-fake-only";
    nativeFusionExecuted: false;
    iterations: number;
    elapsedMs: number;
    elapsedBudgetMs: number;
    elapsedBudgetPassed: boolean;
    budgets: typeof BUDGET;
    cases: CaseReport[];
  }

  const crypto = process.getBuiltinModule(
    "node:crypto",
  ) as typeof import("node:crypto");
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const path = process.getBuiltinModule(
    "node:path",
  ) as typeof import("node:path");
  const entryPath = process.argv[1];
  if (entryPath === undefined)
    throw new Error("Harness entrypoint path is missing");
  const fixtureDir = path.join(
    path.dirname(path.resolve(entryPath)),
    "..",
    "fixtures",
    "generic-controls",
  );
  const fixtureFiles = [
    "enclosure.json",
    "shaft-socket.json",
    "branched-channel.json",
    "arc-sketch.json",
    "gear-pair.json",
  ];

  // Candidate caller snippets, not public fmcad operations or Fusion transport.
  const pythonCallers: Record<Strategy, string> = {
    individual: [
      "def inspect(fake_rpc, read_paths, family, evaluate):",
      "    values = {}",
      "    for read_path in read_paths:",
      '        values[read_path] = fake_rpc({"operation": "fixture.read", "path": read_path})',
      "    return evaluate(family, values)",
    ].join("\n"),
    bundled: [
      "def inspect(fake_rpc, read_paths, family, evaluate):",
      '    values = fake_rpc({"operation": "fixture.read", "paths": read_paths})',
      "    return evaluate(family, values)",
    ].join("\n"),
  };

  const BUDGET = Object.freeze({
    maxBundledFakeRpcCount: 1,
    maxPythonPayloadBytes: 1024,
    maxResultBytes: 4096,
    maxFirstCallMs: 2000,
    maxWarmP95Ms: 250,
  });

  function object(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  function number(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number`);
    }
    return value;
  }

  function readPath(value: unknown, dottedPath: string): unknown {
    let current = value;
    for (const part of dottedPath.split(".")) {
      const record = object(current, dottedPath);
      if (!Object.hasOwn(record, part)) {
        throw new Error(`Missing fixture measurement: ${dottedPath}`);
      }
      current = record[part];
    }
    return current;
  }

  class OfflineFakeCad implements OfflineMetrics {
    readonly measurements: Record<string, unknown>;
    rpcCount = 0;
    requestBytes = 0;

    constructor(measurements: Record<string, unknown>) {
      this.measurements = measurements;
    }

    readOne(readPathName: string): unknown {
      this.rpcCount += 1;
      this.requestBytes += Buffer.byteLength(
        JSON.stringify({ operation: "fixture.read", path: readPathName }),
      );
      return readPath(this.measurements, readPathName);
    }

    readMany(readPaths: string[]): Record<string, unknown> {
      this.rpcCount += 1;
      this.requestBytes += Buffer.byteLength(
        JSON.stringify({ operation: "fixture.read", paths: readPaths }),
      );
      return Object.fromEntries(
        readPaths.map((name) => [name, readPath(this.measurements, name)]),
      );
    }
  }

  function valueMap(
    readPaths: string[],
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      readPaths.map((name) => [
        name,
        Object.hasOwn(values, name) ? values[name] : readPath(values, name),
      ]),
    );
  }

  function resultCheck(
    id: string,
    actual: unknown,
    pass: boolean,
    limit: unknown,
  ): Check {
    return { id, actual, pass, limit };
  }

  function evaluate(
    fixture: Fixture,
    caseData: FixtureCase,
    values: Record<string, unknown>,
  ): ControlResult {
    const checks: Check[] = [];
    const measured = valueMap(fixture.readPaths, values);
    const control = fixture.control;

    if (fixture.family === "enclosure") {
      const wall = number(measured["wallThicknessMm"], "wallThicknessMm");
      checks.push(
        resultCheck(
          "minimum-wall",
          wall,
          wall >= number(control["minimumWallMm"], "minimumWallMm"),
          {
            minimum: control["minimumWallMm"],
            unit: "mm",
          },
        ),
      );
      checks.push(
        resultCheck(
          "seam-connected",
          measured["seamConnected"],
          measured["seamConnected"] === true,
          {
            required: true,
          },
        ),
      );
    } else if (fixture.family === "shaftSocket") {
      const clearance =
        number(measured["socketBoreDiameterMm"], "socketBoreDiameterMm") -
        number(measured["shaftDiameterMm"], "shaftDiameterMm");
      const minimum = number(
        control["minimumDiametralClearanceMm"],
        "minimumDiametralClearanceMm",
      );
      const maximum = number(
        control["maximumDiametralClearanceMm"],
        "maximumDiametralClearanceMm",
      );
      checks.push(
        resultCheck(
          "diametral-clearance",
          clearance,
          clearance >= minimum && clearance <= maximum,
          {
            minimum,
            maximum,
            unit: "mm",
          },
        ),
      );
      const engagement = number(measured["engagementMm"], "engagementMm");
      const minimumEngagement = number(
        control["minimumEngagementMm"],
        "minimumEngagementMm",
      );
      checks.push(
        resultCheck(
          "minimum-engagement",
          engagement,
          engagement >= minimumEngagement,
          { minimum: minimumEngagement, unit: "mm" },
        ),
      );
    } else if (fixture.family === "branchedChannel") {
      const branches = Object.keys(
        object(caseData.measurements["branches"], "branches"),
      );
      const minimumClearance = number(
        control["minimumClearanceMm"],
        "minimumClearanceMm",
      );
      for (const branch of branches) {
        const connected = measured[`branches.${branch}.connected`];
        const clearance = number(
          measured[`branches.${branch}.minimumClearanceMm`],
          `${branch}.minimumClearanceMm`,
        );
        checks.push(
          resultCheck(`${branch}-connected`, connected, connected === true, {
            required: true,
          }),
        );
        checks.push(
          resultCheck(
            `${branch}-minimum-clearance`,
            clearance,
            clearance >= minimumClearance,
            { minimum: minimumClearance, unit: "mm" },
          ),
        );
      }
    } else if (fixture.family === "arcSketch") {
      const center = measured["centerMm"];
      if (!Array.isArray(center) || center.length !== 2) {
        throw new Error("centerMm must contain exactly two coordinates");
      }
      const expectedCenter = control["expectedCenterMm"];
      if (!Array.isArray(expectedCenter) || expectedCenter.length !== 2) {
        throw new Error(
          "expectedCenterMm must contain exactly two coordinates",
        );
      }
      const centerError = Math.hypot(
        number(center[0], "centerMm[0]") -
          number(expectedCenter[0], "expectedCenterMm[0]"),
        number(center[1], "centerMm[1]") -
          number(expectedCenter[1], "expectedCenterMm[1]"),
      );
      const centerTolerance = number(
        control["centerToleranceMm"],
        "centerToleranceMm",
      );
      checks.push(
        resultCheck("arc-center", centerError, centerError <= centerTolerance, {
          expected: expectedCenter,
          tolerance: centerTolerance,
          unit: "mm",
        }),
      );
      const radius = number(measured["radiusMm"], "radiusMm");
      const expectedRadius = number(
        control["expectedRadiusMm"],
        "expectedRadiusMm",
      );
      const radiusTolerance = number(
        control["radiusToleranceMm"],
        "radiusToleranceMm",
      );
      checks.push(
        resultCheck(
          "arc-radius",
          radius,
          Math.abs(radius - expectedRadius) <= radiusTolerance,
          {
            expected: expectedRadius,
            tolerance: radiusTolerance,
            unit: "mm",
          },
        ),
      );
    } else if (fixture.family === "gearPair") {
      const moduleA = number(measured["gearA.moduleMm"], "gearA.moduleMm");
      const moduleB = number(measured["gearB.moduleMm"], "gearB.moduleMm");
      const teethA = number(measured["gearA.teeth"], "gearA.teeth");
      const teethB = number(measured["gearB.teeth"], "gearB.teeth");
      const expectedCenter = (moduleA * (teethA + teethB)) / 2;
      checks.push(
        resultCheck("gear-module", [moduleA, moduleB], moduleA === moduleB, {
          equal: true,
          unit: "mm",
        }),
      );
      const centerDistance = number(
        measured["centerDistanceMm"],
        "centerDistanceMm",
      );
      const centerTolerance = number(
        control["centerDistanceToleranceMm"],
        "centerDistanceToleranceMm",
      );
      checks.push(
        resultCheck(
          "gear-center-distance",
          centerDistance,
          Math.abs(centerDistance - expectedCenter) <= centerTolerance,
          { expected: expectedCenter, tolerance: centerTolerance, unit: "mm" },
        ),
      );
    } else {
      throw new Error(
        `Unsupported generic control fixture family: ${fixture.family}`,
      );
    }

    const failedChecks = checks
      .filter((check) => !check.pass)
      .map((check) => check.id);
    return {
      schemaVersion: 1,
      source: "offline-fake",
      fixtureId: fixture.fixtureId,
      caseId: caseData.id,
      identity: caseData.identity,
      family: fixture.family,
      status: failedChecks.length ? "fail" : "pass",
      checks,
      failedChecks,
      coverage: {
        requestedReadPaths: fixture.readPaths,
        observedReadPaths: Object.keys(measured),
        complete: Object.keys(measured).length === fixture.readPaths.length,
      },
    };
  }

  function runIndividual(
    fixture: Fixture,
    caseData: FixtureCase,
    cad: OfflineFakeCad,
  ): ControlResult {
    const values: Record<string, unknown> = {};
    for (const name of fixture.readPaths) values[name] = cad.readOne(name);
    return evaluate(fixture, caseData, values);
  }

  function runBundled(
    fixture: Fixture,
    caseData: FixtureCase,
    cad: OfflineFakeCad,
  ): ControlResult {
    const flattened = cad.readMany(fixture.readPaths);
    const values: Record<string, unknown> = {};
    for (const name of fixture.readPaths) {
      const pathParts = name.split(".");
      let cursor = values;
      for (let index = 0; index < pathParts.length - 1; index += 1) {
        const part = pathParts[index];
        if (part === undefined) throw new Error("Invalid dotted read path");
        const next = cursor[part];
        if (next === null || typeof next !== "object" || Array.isArray(next)) {
          const nested: Record<string, unknown> = {};
          cursor[part] = nested;
          cursor = nested;
        } else {
          cursor = next as Record<string, unknown>;
        }
      }
      const leaf = pathParts[pathParts.length - 1];
      if (leaf === undefined) throw new Error("Invalid dotted read path");
      cursor[leaf] = flattened[name];
    }
    return evaluate(fixture, caseData, values);
  }

  function pythonLoc(source: string): number {
    return source
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#")).length;
  }

  function percentile95(samples: number[]): number {
    const ordered = [...samples].sort((left, right) => left - right);
    return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
  }

  function median(samples: number[]): number {
    const ordered = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const middleValue = ordered[middle];
    if (middleValue === undefined)
      throw new Error("Cannot calculate an empty median");
    if (ordered.length % 2) return middleValue;
    const lowerValue = ordered[middle - 1];
    if (lowerValue === undefined) throw new Error("Median sample is missing");
    return (lowerValue + middleValue) / 2;
  }

  function elapsedMs(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  function firstCallMeasurement(
    strategy: Strategy,
    fixturePath: string,
    caseId: string,
  ): FirstCallMeasurement {
    const run = strategy === "individual" ? runIndividual : runBundled;
    const coldStart = process.hrtime.bigint();
    const coldFixture = JSON.parse(
      fs.readFileSync(fixturePath, "utf8"),
    ) as Fixture;
    const coldCase = coldFixture.cases.find((row) => row.id === caseId);
    if (coldCase === undefined)
      throw new Error(`Missing case in fixture: ${caseId}`);
    const coldCad = new OfflineFakeCad(coldCase.measurements);
    const coldResult = run(coldFixture, coldCase, coldCad);
    return { firstCallMs: elapsedMs(coldStart), result: coldResult };
  }

  function warmSample(
    fixture: Fixture,
    caseData: FixtureCase,
    strategy: Strategy,
  ): TimedSample {
    const cad = new OfflineFakeCad(caseData.measurements);
    const run = strategy === "individual" ? runIndividual : runBundled;
    const start = process.hrtime.bigint();
    const result = run(fixture, caseData, cad);
    return { elapsedMs: elapsedMs(start), cad, result };
  }

  function summarizeStrategy(
    strategy: Strategy,
    first: FirstCallMeasurement,
    warmSamples: TimedSample[],
  ): StrategyMeasurement {
    const sample = warmSamples[warmSamples.length - 1];
    if (sample === undefined) throw new Error("Warm measurement is empty");
    const jsonResult = JSON.stringify(sample.result);
    const pythonCallerSource = pythonCallers[strategy];
    const sampleTimes = warmSamples.map((row) => row.elapsedMs);
    return {
      firstCallMs: Number(first.firstCallMs.toFixed(6)),
      warmMedianMs: Number(median(sampleTimes).toFixed(6)),
      warmP95Ms: Number(percentile95(sampleTimes).toFixed(6)),
      fakeRpcCount: sample.cad.rpcCount,
      fakeRequestBytes: sample.cad.requestBytes,
      pythonPayloadBytes: Buffer.byteLength(pythonCallerSource, "utf8"),
      pythonGlueLoc: pythonLoc(pythonCallerSource),
      pythonCallerSource,
      resultBytes: Buffer.byteLength(jsonResult, "utf8"),
      resultSha256: crypto
        .createHash("sha256")
        .update(jsonResult)
        .digest("hex"),
      result: sample.result,
    };
  }

  function measureStrategies(
    fixture: Fixture,
    caseData: FixtureCase,
    fixturePath: string,
    iterations: number,
  ): {
    individual: StrategyMeasurement;
    bundled: StrategyMeasurement;
    firstCalls: Record<Strategy, FirstCallMeasurement>;
  } {
    const firstCalls: Record<Strategy, FirstCallMeasurement> = {
      individual: firstCallMeasurement("individual", fixturePath, caseData.id),
      bundled: firstCallMeasurement("bundled", fixturePath, caseData.id),
    };
    const warmSamples: Record<Strategy, TimedSample[]> = {
      individual: [],
      bundled: [],
    };
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const order: Strategy[] =
        iteration % 2 ? ["bundled", "individual"] : ["individual", "bundled"];
      for (const strategy of order) {
        warmSamples[strategy].push(warmSample(fixture, caseData, strategy));
      }
    }
    return {
      individual: summarizeStrategy(
        "individual",
        firstCalls.individual,
        warmSamples.individual,
      ),
      bundled: summarizeStrategy(
        "bundled",
        firstCalls.bundled,
        warmSamples.bundled,
      ),
      firstCalls,
    };
  }

  function loadFixtures(): Array<{ fixturePath: string; fixture: Fixture }> {
    return fixtureFiles.map((file) => {
      const fixturePath = path.join(fixtureDir, file);
      const fixture = JSON.parse(
        fs.readFileSync(fixturePath, "utf8"),
      ) as Fixture;
      return { fixturePath, fixture };
    });
  }

  function runBenchmark(
    options: { iterations?: number } = {},
  ): BenchmarkReport {
    const iterations = options.iterations ?? 100;
    if (!Number.isInteger(iterations) || iterations < 10 || iterations > 5000) {
      throw new Error("iterations must be an integer from 10 through 5000");
    }

    const started = process.hrtime.bigint();
    const cases: CaseReport[] = [];
    for (const { fixturePath, fixture } of loadFixtures()) {
      for (const caseData of fixture.cases) {
        const measured = measureStrategies(
          fixture,
          caseData,
          fixturePath,
          iterations,
        );
        const { individual, bundled } = measured;
        if (
          JSON.stringify(individual.result) !== JSON.stringify(bundled.result)
        ) {
          throw new Error(
            `Equivalent fake control results differ: ${fixture.fixtureId}/${caseData.id}`,
          );
        }
        if (
          JSON.stringify(measured.firstCalls.individual.result) !==
            JSON.stringify(individual.result) ||
          JSON.stringify(measured.firstCalls.bundled.result) !==
            JSON.stringify(bundled.result)
        ) {
          throw new Error(
            `Cold and warm fake control results differ: ${fixture.fixtureId}/${caseData.id}`,
          );
        }
        if (
          bundled.result.status !== caseData.expected.status ||
          JSON.stringify(bundled.result.failedChecks) !==
            JSON.stringify(caseData.expected.failedChecks)
        ) {
          throw new Error(
            `Expected result mismatch: ${fixture.fixtureId}/${caseData.id}`,
          );
        }

        cases.push({
          fixtureId: fixture.fixtureId,
          family: fixture.family,
          caseId: caseData.id,
          variant: caseData.variant,
          identity: caseData.identity,
          expected: caseData.expected,
          equivalentResult: true,
          individual,
          bundled,
          budget: {
            maxFakeRpcCount: BUDGET.maxBundledFakeRpcCount,
            maxPythonPayloadBytes: BUDGET.maxPythonPayloadBytes,
            maxResultBytes: BUDGET.maxResultBytes,
            maxFirstCallMs: BUDGET.maxFirstCallMs,
            maxWarmP95Ms: BUDGET.maxWarmP95Ms,
            passed:
              bundled.fakeRpcCount <= BUDGET.maxBundledFakeRpcCount &&
              bundled.pythonPayloadBytes <= BUDGET.maxPythonPayloadBytes &&
              bundled.resultBytes <= BUDGET.maxResultBytes &&
              bundled.firstCallMs <= BUDGET.maxFirstCallMs &&
              bundled.warmP95Ms <= BUDGET.maxWarmP95Ms,
          },
        });
      }
    }

    const elapsed = elapsedMs(started);
    return {
      schemaVersion: 1,
      qualification: "offline-fake-only",
      nativeFusionExecuted: false,
      iterations,
      elapsedMs: Number(elapsed.toFixed(3)),
      elapsedBudgetMs: 30000,
      elapsedBudgetPassed: elapsed <= 30000,
      budgets: BUDGET,
      cases,
    };
  }

  function main(argv: string[]): void {
    let iterations = 100;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === "--iterations") {
        iterations = Number(argv[index + 1]);
        index += 1;
      } else if (argv[index] === "--help") {
        process.stdout.write(
          "Usage: node --experimental-strip-types tests/generic-controls/harness.ts [--iterations 10..5000]\n",
        );
        return;
      } else {
        throw new Error(`Unknown argument: ${argv[index]}`);
      }
    }
    const report = runBenchmark({ iterations });
    if (
      !report.elapsedBudgetPassed ||
      report.cases.some((row) => !row.budget.passed)
    ) {
      throw new Error(
        "Generic-controls offline benchmark exceeded a declared budget",
      );
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
})();
