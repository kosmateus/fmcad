import {
  assertText,
  object,
  number,
  text,
  list,
  quantity as q,
  output as out,
  hash,
  context,
  envelope,
  commonFields,
  type EngineeringRuntime,
} from "./common";

export function fit(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    ["terms", "minimum", "maximum", "statistics"],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...(["terms", "minimum", "maximum", "statistics"] as const),
  ]);
  const terms = list(data.terms, "terms");
  const ids = new Set<string>();
  const contributions = terms.map((t, i) => {
    c.tick();
    const sourceStart = c.sources.length;
    object(
      t,
      [
        "id",
        "sign",
        "nominal",
        "minus",
        "plus",
        "deflection",
        "thermal",
        "angle",
        "sigma",
      ],
      `terms[${i}]`,
      ["id", "sign"],
    );
    assertText(t.id, "term.id");
    if (ids.has(t.id)) throw new Error("Duplicate term id");
    ids.add(t.id);
    if (t.sign !== 1 && t.sign !== -1)
      throw new Error("term.sign must be +1 or -1");
    let nominal = q(t.nominal, "length", `${t.id}.nominal`, c);
    const minus = q(t.minus, "length", `${t.id}.minus`, c, 0),
      plus = q(t.plus, "length", `${t.id}.plus`, c, 0);
    let low = nominal === null || minus === null ? null : nominal - minus;
    let high = nominal === null || plus === null ? null : nominal + plus;
    if (t.deflection !== undefined) {
      object(t.deflection, ["nominal", "minimum", "maximum"], "deflection");
      const n = q(t.deflection.nominal, "length", "deflection.nominal", c),
        a = q(t.deflection.minimum, "length", "deflection.minimum", c),
        b = q(t.deflection.maximum, "length", "deflection.maximum", c);
      if (
        a !== null &&
        b !== null &&
        (a > b || (n !== null && (n < a || n > b)))
      )
        throw new Error("Invalid deflection interval");
      nominal = add(nominal, n);
      low = add(low, a);
      high = add(high, b);
    }
    if (t.thermal !== undefined) {
      object(
        t.thermal,
        ["alpha", "delta", "minimumDelta", "maximumDelta"],
        "thermal",
      );
      const alpha = q(t.thermal.alpha, "expansion", "thermal.alpha", c);
      const dt = q(t.thermal.delta, "temperatureDelta", "thermal.delta", c);
      const a = q(
          t.thermal.minimumDelta,
          "temperatureDelta",
          "thermal.minimumDelta",
          c,
        ),
        b = q(
          t.thermal.maximumDelta,
          "temperatureDelta",
          "thermal.maximumDelta",
          c,
        );
      if (
        a !== null &&
        b !== null &&
        (a > b || (dt !== null && (dt < a || dt > b)))
      )
        throw new Error("Invalid temperature interval");
      if (
        alpha === null ||
        dt === null ||
        a === null ||
        b === null ||
        low === null ||
        high === null ||
        nominal === null
      ) {
        nominal = low = high = null;
      } else {
        const factors: [number, number] = [1 + alpha * a, 1 + alpha * b];
        if (Math.min(...factors) <= 0)
          throw new Error("Thermal scale must remain positive");
        const corners = [
          low * factors[0]!,
          low * factors[1]!,
          high * factors[0]!,
          high * factors[1]!,
        ];
        nominal *= 1 + alpha * dt;
        low = Math.min(...corners);
        high = Math.max(...corners);
      }
    }
    if (t.angle !== undefined) {
      object(t.angle, ["nominal", "minus", "plus"], "angle");
      const n = q(t.angle.nominal, "angle", "angle.nominal", c, -1e6, 1e6),
        a = q(t.angle.minus, "angle", "angle.minus", c, 0, 1e6),
        b = q(t.angle.plus, "angle", "angle.plus", c, 0, 1e6);
      if (
        n === null ||
        a === null ||
        b === null ||
        nominal === null ||
        low === null ||
        high === null
      )
        nominal = low = high = null;
      else {
        const lo = n - a,
          hi = n + b;
        const values = [Math.sin(lo), Math.sin(hi)];
        if (hi - lo >= 2 * Math.PI) values.push(-1, 1);
        else {
          const first = Math.ceil((lo - Math.PI / 2) / Math.PI),
            last = Math.floor((hi - Math.PI / 2) / Math.PI);
          for (let k = first; k <= last; k++) {
            c.tick();
            values.push(k % 2 === 0 ? 1 : -1);
          }
        }
        const corners = values.flatMap((v) => [low! * v, high! * v]);
        nominal *= Math.sin(n);
        low = Math.min(...corners);
        high = Math.max(...corners);
      }
    }
    const sigma =
      t.sigma === undefined
        ? null
        : q(t.sigma, "length", `${t.id}.sigma`, c, 0);
    return {
      id: t.id,
      nominal: nominal === null ? null : nominal * t.sign,
      minimum:
        low === null || high === null ? null : t.sign === 1 ? low : -high,
      maximum:
        low === null || high === null ? null : t.sign === 1 ? high : -low,
      sign: t.sign,
      sigma,
      sources: c.sources.slice(sourceStart),
    };
  });
  const sum = (key: "nominal" | "minimum" | "maximum") =>
    contributions.some((t) => t[key]! === null)
      ? null
      : contributions.reduce((s, t) => s + t[key]!, 0);
  const nominal = sum("nominal"),
    low = sum("minimum"),
    high = sum("maximum");
  const minimum =
    data.minimum === undefined ? null : q(data.minimum, "length", "minimum", c);
  const maximum =
    data.maximum === undefined ? null : q(data.maximum, "length", "maximum", c);
  if (minimum !== null && maximum !== null && minimum > maximum)
    throw new Error("minimum exceeds maximum");
  let statistical = null;
  if (data.statistics !== undefined) {
    object(
      data.statistics,
      ["model", "coverage", "correlation", "assumptions"],
      "statistics",
      ["model", "coverage", "correlation", "assumptions"],
    );
    if (data.statistics.model !== "linear-normal")
      throw new Error("Only explicit linear-normal statistics are supported");
    list(data.statistics.assumptions, "statistical assumptions").forEach((x) =>
      text(x, "assumption"),
    );
    const coverage = number(
      data.statistics.coverage,
      "coverage",
      Number.MIN_VALUE,
      10,
    );
    const r = list(
      data.statistics.correlation,
      "correlation",
      terms.length,
      terms.length,
    ).map((row) =>
      list(row, "correlation row", terms.length, terms.length).map((x) =>
        number(x, "correlation", -1, 1),
      ),
    );
    // Semidefinite Cholesky, allowing perfectly correlated inputs.
    const l = r.map((row) => row.map(() => 0));
    for (let i = 0; i < r.length; i++)
      for (let j = 0; j <= i; j++) {
        c.tick();
        if (Math.abs(r[i]![j]! - r[j]![i]!) > 1e-12 || r[i]![i]! !== 1)
          throw new Error("Correlation must be symmetric with unit diagonal");
        let v = r[i]![j]!;
        for (let k = 0; k < j; k++) v -= l[i]![k]! * l[j]![k]!;
        if (i === j) {
          if (v < -1e-12)
            throw new Error("Correlation must be positive semidefinite");
          l[i]![j]! = Math.sqrt(Math.max(0, v));
        } else if (l[j]![j]! > 1e-12) l[i]![j]! = v / l[j]![j]!;
        else if (Math.abs(v) > 1e-12)
          throw new Error("Correlation must be positive semidefinite");
      }
    contributions.forEach((t) => {
      if (t.sigma === null) c.missing.push(`${t.id}.sigma`);
    });
    if (contributions.every((t) => t.sigma !== null) && nominal !== null) {
      let variance = 0;
      contributions.forEach((a, i) =>
        contributions.forEach((b, j) => {
          c.tick();
          variance +=
            number(a.sign, "sign") *
            number(b.sign, "sign") *
            a.sigma! *
            b.sigma! *
            r[i]![j]!;
        }),
      );
      const sigma = Math.sqrt(Math.max(0, variance));
      statistical = {
        model: "linear-normal",
        method: "correlated-linear-normal-covariance-v1",
        sigma: out(sigma, "m"),
        minimum: out(nominal - coverage * sigma, "m"),
        maximum: out(nominal + coverage * sigma, "m"),
        coverage,
        assumptions: data.statistics.assumptions,
        interpretation:
          "Input sigmas describe final projected contributions; this interval is not worst case.",
      };
    }
  }
  const sensitivityMethod = "one-at-a-time-worst-case-range-v1";
  const sensitivityComplete = contributions.every(
    (t) => t.nominal !== null && t.minimum !== null && t.maximum !== null,
  );
  const sensitivity = {
    status: sensitivityComplete ? "evaluated" : "unknown",
    method: sensitivityMethod,
    scope: "worst-case",
    rankedBy: "range",
    tieBreak: "id-ascending",
    ranking: sensitivityComplete
      ? (() => {
          let ranked = contributions.map((t) => {
            c.tick();
            return {
              id: t.id,
              minimumShift: t.minimum! - t.nominal!,
              maximumShift: t.maximum! - t.nominal!,
              range: t.maximum! - t.minimum!,
              sources: t.sources,
            };
          });
          for (let width = 1; width < ranked.length; width *= 2) {
            const sorted: typeof ranked = [];
            for (let start = 0; start < ranked.length; start += width * 2) {
              let left = start;
              let right = Math.min(start + width, ranked.length);
              const leftEnd = right;
              const rightEnd = Math.min(start + width * 2, ranked.length);
              while (left < leftEnd && right < rightEnd) {
                c.tick();
                const a = ranked[left]!;
                const b = ranked[right]!;
                if (
                  b.range > a.range ||
                  (b.range === a.range && b.id < a.id)
                )
                  sorted.push(ranked[right++]!);
                else sorted.push(ranked[left++]!);
              }
              while (left < leftEnd) sorted.push(ranked[left++]!);
              while (right < rightEnd) sorted.push(ranked[right++]!);
            }
            ranked = sorted;
          }
          const totalRange = ranked.reduce((sum, t) => sum + t.range, 0);
          let rank = 0;
          let previousRange: number | null = null;
          return ranked.map((t, i) => {
            if (i === 0 || t.range !== previousRange) rank = i + 1;
            previousRange = t.range;
            return {
              rank,
              id: t.id,
              minimumShift: out(t.minimumShift, "m"),
              maximumShift: out(t.maximumShift, "m"),
              range: out(t.range, "m"),
              rangeShare:
                totalRange === 0 ? null : out(t.range / totalRange, "1"),
              provenance: { sources: t.sources },
            };
          });
        })()
      : null,
    interpretation:
      "Each term is varied alone over its projected bounded interval. Ranking uses its full output range; source metadata is provenance, not propagated measurement uncertainty. This worst-case ranking is separate from the correlated statistical interval.",
  };
  c.limitations.push(
    "One-dimensional signed stack in the declared common datum/frame; angle uses length*sin(angle). No general 3D GD&T solver. WC treats bounded terms independently; correlations affect only the separate statistical model.",
  );
  const status =
    low === null || high === null
      ? "unknown"
      : minimum === null && maximum === null
        ? "notEvaluated"
        : (minimum !== null && low < minimum) ||
            (maximum !== null && high > maximum)
          ? "fail"
          : "pass";
  return envelope(
    "fit.stack",
    data,
    c,
    {
      nominal: out(nominal, "m"),
      minimum: out(low, "m"),
      maximum: out(high, "m"),
      contributions: contributions.map((t) => ({
        id: t.id,
        nominal: out(t.nominal, "m"),
        minimum: out(t.minimum, "m"),
        maximum: out(t.maximum, "m"),
      })),
      sensitivity,
      statistical,
    },
    status,
  );
}
function add(a: number | null, b: number | null) {
  return a === null || b === null ? null : a + b;
}

export function definition(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(
    data,
    [
      "id",
      "revision",
      "parts",
      "datums",
      "requirements",
      "representation",
      "nativeRefs",
    ],
    runtime,
  );
  object(data, [
    ...commonFields,
    ...([
      "id",
      "revision",
      "parts",
      "datums",
      "requirements",
      "representation",
      "nativeRefs",
    ] as const),
  ]);
  assertText(data.id, "id");
  assertText(data.revision, "revision");
  const parts = list(data.parts, "parts", 2).map((x) =>
    text(x, "part occurrence path"),
  );
  if (new Set(parts).size !== parts.length)
    throw new Error("parts must be unique occurrence paths");
  list(data.datums, "datums").forEach((x) => text(x, "datum"));
  if (
    data.representation !== "snapshot" &&
    data.representation !== "nativeReference"
  )
    throw new Error("representation must be snapshot or nativeReference");
  const requirements = list(data.requirements, "requirements").map((f) => {
    object(f, [...commonFields, "terms", "minimum", "maximum", "statistics"]);
    if (hash(f.identity) !== hash(data.identity) || f.frame !== data.frame)
      throw new Error("Requirement identity/frame mismatch");
    const r = fit(f, c.runtime);
    c.tick(r.work.completed);
    c.sources.push(...r.provenance.sources);
    c.missing.push(...r.warnings);
    return r;
  });
  const contract = {
    schemaVersion: 1,
    id: data.id,
    revision: data.revision,
    identity: data.identity,
    frame: data.frame,
    parts,
    datums: data.datums,
    requirements: data.requirements,
    representation: data.representation,
    nativeRefs: data.nativeRefs || null,
  };
  const result = {
    contract,
    fingerprint: hash(contract),
    checks: requirements,
    dependentParts: parts,
  };
  c.limitations.push(
    "Local immutable interface manifest. Native query/datum/reference resolution requires main-agent live handoff.",
  );
  const reply = envelope(
    "interface.define",
    data,
    c,
    result,
    data.representation === "nativeReference" ? "blocked" : "notEvaluated",
  );
  reply.affected = parts;
  return reply;
}
export function check(data: unknown, runtime?: EngineeringRuntime) {
  const c = context(data, ["definition", "previous"], runtime);
  object(data, [...commonFields, ...(["definition", "previous"] as const)]);
  const current = definition(data.definition, c.runtime);
  object(data.definition, [
    ...commonFields,
    "id",
    "revision",
    "parts",
    "datums",
    "requirements",
    "representation",
    "nativeRefs",
  ]);
  c.tick(current.work.completed);
  c.sources.push(...current.provenance.sources);
  c.missing.push(...current.warnings);
  if (
    hash(data.identity) !== hash(data.definition.identity) ||
    data.frame !== data.definition.frame
  )
    throw new Error("Interface identity/frame mismatch");
  let changed = false;
  let invalidatedParts: string[] = [];
  if (data.previous !== undefined) {
    object(data.previous, ["contract", "fingerprint"], "previous", [
      "contract",
      "fingerprint",
    ]);
    object(data.previous.contract, [
      "schemaVersion",
      "id",
      "revision",
      "identity",
      "frame",
      "parts",
      "datums",
      "requirements",
      "representation",
      "nativeRefs",
    ]);
    if (hash(data.previous.contract) !== data.previous.fingerprint)
      throw new Error("Invalid previous interface fingerprint");
    if (data.previous.contract.id !== data.definition.id)
      throw new Error("Previous interface ID mismatch");
    changed = data.previous.fingerprint !== current.result.fingerprint;
    if (changed)
      invalidatedParts = [
        ...new Set([
          ...list(data.previous.contract.parts, "previous.contract.parts").map(
            (x) => text(x, "part"),
          ),
          ...current.result.dependentParts,
        ]),
      ];
  }
  const checks = current.result.checks;
  let status =
    current.status === "blocked"
      ? "blocked"
      : checks.some((x) => x.status === "fail")
        ? "fail"
        : checks.every((x) => x.status === "pass")
          ? "pass"
          : "unknown";
  if (changed) status = "blocked";
  c.limitations.push(
    ...current.limitations,
    "Changed contracts invalidate evidence for all old and new mating occurrences. Rerun dependent part checks against the new fingerprint.",
  );
  const reply = envelope(
    "interface.check",
    data,
    c,
    {
      ...current.result,
      changed,
      invalidatedParts,
      reusePreviousEvidence: data.previous !== undefined && !changed,
      handoff:
        current.status === "blocked"
          ? "Resolve native interface refs in the identified live document and revision."
          : null,
    },
    status,
  );
  reply.affected = invalidatedParts;
  return reply;
}
