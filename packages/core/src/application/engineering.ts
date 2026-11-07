import * as fit from "../domain/engineering/fit";
import * as fluid from "../domain/engineering/fluid";
import * as hydraulic from "../domain/engineering/hydraulic";
import * as mass from "../domain/engineering/mass";
import * as thermal from "../domain/engineering/thermal";
import type { EngineeringRuntime } from "../domain/engineering/common";

export const engineeringOperations = {
  "thermal.contact-budget": thermal.thermal,
  "mass.system": mass.system,
  "load.axis": mass.loadAxis,
  "stability.check": mass.stability,
  "measure.fill-volume": fluid.fillVolume,
  "fluid.level-curve": fluid.levelCurve,
  "drain.check": fluid.drainCheck,
  "cleaning.access": fluid.cleaningAccess,
  "hydraulic.network": hydraulic.network,
  "engineering.valve": hydraulic.valve,
  "engineering.spring-piston": hydraulic.piston,
  "float.evaluate": hydraulic.floating,
  "fit.stack": fit.fit,
  "interface.define": fit.definition,
  "interface.check": fit.check,
} as const;

export function runEngineering(
  operation: string,
  data: unknown,
  runtime?: EngineeringRuntime,
) {
  if (!Object.hasOwn(engineeringOperations, operation))
    throw new Error(`Unknown local engineering operation: ${operation}`);
  return engineeringOperations[operation as keyof typeof engineeringOperations](
    data,
    runtime,
  );
}
