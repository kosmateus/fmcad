import { createRequire } from "node:module";
import type { CurveCsvPort } from "../../packages/node-adapters/src/python/curve-source";

const load = createRequire(__filename);
const policy = load(
  "../core/application/modeling/curve.js",
) as typeof import("../../packages/core/src/application/modeling/curve");
const { createCurveSource } = load(
  "../python/curve-source.js",
) as typeof import("../../packages/node-adapters/src/python/curve-source");
const { csv } = load("../../data-import") as { csv: CurveCsvPort };

export const { descriptors, validate, quantity } = policy;
export const prepare = policy.createCurvePreparation(createCurveSource(csv));
