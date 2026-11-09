import type { CommandDescriptor } from "./library-commands";
import type { CommandManual } from "./library-help-manual";
import {
  createEngineeringCommand,
  type EngineeringMethod,
} from "./library-engineering";
import * as fit from "../../packages/core/src/domain/engineering/fit";
import * as hydraulic from "../../packages/core/src/domain/engineering/hydraulic";
import * as thermal from "../../packages/core/src/domain/engineering/thermal";
import * as mass from "../../packages/core/src/domain/engineering/mass";
import * as fluid from "../../packages/core/src/domain/engineering/fluid";
import { runEngineering } from "../../packages/core/src/application/engineering";

const methods: Record<string, EngineeringMethod & { summary: string }> = {
  "thermal contact-budget": {
    run: thermal.thermal,
    fields:
      "heatLoads[{id,power}], ambient, contacts[{id,model,contactPresent,resistance?|area?,thickness?,conductivity?,compression?,gap?,allowableCompression?,interfaceResistance?}], ambientPath?:{model,resistance?|coefficient?,area?}, maximumTemperature?",
    summary:
      "Evaluate a series thermal contact stack, compression bounds, ambient path, temperatures and sensitivity.",
  },
  "mass system": {
    run: mass.system,
    fields:
      "items[{id,count?,mass?|density?,volume?,massOverride?,referenceExclusion?,ownedContents?,cg?:{x,y,z},inertia?:{ixx,iyy,izz,ixy,ixz,iyz},placement?:{x,y,z},rotation?:{roll,pitch,yaw}}], aboutPoint?:{x,y,z}, maximumMass?",
    summary:
      "Aggregate a mass system ledger with CG and inertia (Steiner), principal moments/axes, ownership and completeness.",
  },
  "load axis": {
    run: mass.loadAxis,
    fields:
      "items[mass-system items], axis:{pivot:{x,y,z},direction:{x,y,z}}, gravity:{direction,magnitude}, accelerations?:[{id,direction,magnitude}], angularAccelerations?:[{id,angularAcceleration}], angularSpeed?, externalLoads?:[{id,force:{magnitude,direction},at:{x,y,z}}], friction, efficiency?, availableTorque?",
    summary:
      "Evaluate gravitational, acceleration, dynamic and external torques about a declared axis with friction and efficiency.",
  },
  "stability check": {
    run: mass.stability,
    fields:
      "items[mass-system items], supportPolygon:[{x,y,z}], gravity:{direction,magnitude}, accelerations?:[{id,direction,magnitude}], minimumMargin?",
    summary:
      "Check the tip-over margin of the aggregated CG against a declared support polygon under declared loads.",
  },
  "measure fill-volume": {
    run: fluid.fillVolume,
    fields:
      "cavity:{type:box,length,width,height}, level, density, gravity:{direction}, displacers?:[{id,length,width,height,position:{x,y,z},rotation?}], closure:{closedDomain,errors?}, minimumVolume?, maximumVolume?",
    summary:
      "Evaluate gross/net/displaced-union liquid volume with unioned displacers, liquid CG/inertia and closure evidence.",
  },
  "fluid level-curve": {
    run: fluid.levelCurve,
    fields:
      "cavity, density, gravity:{direction}, displacers?, closure:{closedDomain,errors?}, levels:[...], criteria?:[{id,level,kind:minimum|maximum,volume}]",
    summary:
      "Build a monotonic level-to-volume curve and evaluate MIN/MAX level criteria.",
  },
  "drain check": {
    run: fluid.drainCheck,
    fields:
      "cavity, gravity:{direction}, density, outlet:{position:{x,y,z},diameter}, drainLevel, maximumResidual?, pockets?:[{id,volume,drains,position?}]",
    summary:
      "Geometric drain check: outlet reachability, residual pool and declared pocket volumes against a residual limit.",
  },
  "cleaning access": {
    run: fluid.cleaningAccess,
    fields:
      "cavity, gravity:{direction}, tool:{type:brush|nozzle|wipe,length,diameter}, accesses:[{id,at:{x,y,z},direction,depth,openingDiameter}], pockets?:[{id,depth,openingDiameter,at}], slopes?:[{id,angle,direction}], maximumSlope?",
    summary:
      "Check declared tool/brush reach and fit against pocket openings and slope reports; geometry does not certify hygiene.",
  },
  "hydraulic network": {
    run: hydraulic.network,
    fields:
      "nodes[{id,kind,externalFlow,pressure?}], lines[{id,from,to,kind,flow,diameter,length,deadVolume,lossCoefficient,frictionModel,darcyFactor?,crackingPressure?,gain?}], density, viscosity?, atmosphere?, flowTolerance, pressureTolerance",
    summary:
      "Evaluate a directed prescribed-flow network: continuity, pressure budgets, relief return and dead volumes.",
  },
  "engineering valve": {
    run: hydraulic.valve,
    fields:
      "seatDiameter, preload, rate, lift, friction, flow, density, dischargeCoefficient, flowArea, availablePressure?",
    summary:
      "Separate valve cracking, holding force and specified-lift orifice pressure requirements.",
  },
  "engineering spring-piston": {
    run: hydraulic.piston,
    fields:
      "bore, stroke, preload, rate, initialCompression, friction, backPressure:{reference,value}, atmosphere?, deadVolume",
    summary:
      "Calculate linear spring-piston displacement, force, work and quasi-static pressure.",
  },
  "float evaluate": {
    run: hydraulic.floating,
    fields:
      "density, gravity, mass, magnetMass, displacedVolume, waterplaneArea, height, guideFriction, level, lowerStop, upperStop",
    summary:
      "Evaluate Archimedes buoyancy and guided prismatic-float equilibrium bounds.",
  },
  "fit stack": {
    run: fit.fit,
    fields:
      "terms[{id,sign,nominal,minus,plus,deflection?,thermal?,angle?,sigma?}], minimum?, maximum?, statistics?",
    summary:
      "Signed 1D worst-case fit stack with asymmetric tolerances and one-at-a-time-worst-case-range-v1 ranking with source provenance; correlated linear-normal statistics remain separate.",
  },
  "interface define": {
    run: fit.definition,
    fields:
      "id, revision, parts[occurrence paths], datums[names], requirements[fit-stack inputs], representation:snapshot|nativeReference, nativeRefs?",
    summary:
      "Define an immutable local mating-interface contract and its dependency fingerprint.",
  },
  "interface check": {
    run: fit.check,
    fields:
      "definition:interface-define input, previous?:{contract,fingerprint}",
    summary:
      "Check a local interface; contract changes invalidate all mating-part evidence.",
  },
};

// Batch/definition leaf operations use dot-form names (e.g. "mass.system") that map
// onto the two-word CLI keys above. These are read-only, pure local computations.
const localOperations = Object.fromEntries(
  Object.keys(methods).map((key) => [key.replaceAll(" ", "."), key]),
);

// Run a local computation by dot-form operation name and return its schemaVersion-1
// envelope. This is the batch-composable entry point (no document/backend involved).
function run(
  operation: Parameters<typeof runEngineering>[0],
  data: Parameters<typeof runEngineering>[1],
  runtime?: Parameters<typeof runEngineering>[2],
): ReturnType<typeof runEngineering> {
  return runEngineering(operation, data, runtime);
}
const base = {
  schemaVersion: 1,
  identity: { model: "analytic-fixture", revision: "1" },
  frame: "datum:A",
  assumptions: ["One-dimensional stack; explicit tolerance bounds."],
};
const example = {
  ...base,
  terms: [
    { id: "gap", sign: 1, nominal: "5 mm", minus: "0.4 mm", plus: "0.2 mm" },
  ],
  minimum: "4 mm",
};
const descriptors: Record<string, CommandDescriptor> = Object.fromEntries(
  Object.entries(methods).map(([key, method]) => [
    key,
    {
      usage: `${key} (--file <input.json> | --data <JSON>) [--json] [--out <new.json>] [--schema]`,
      desc: `${method.summary} Local calculation: no document/backend required.`,
      example: `fmcad ${key} --file ${key.replaceAll(" ", "-")}.json --json`,
      extra:
        `Version 1 fields: schemaVersion:1, identity:{model,revision}, frame, assumptions:[nonempty strings], budget?:{maxEvaluations,timeMs}; ${method.fields}\n` +
        "Exactly one --file or --data. --schema alone prints the owned input contract. Paths resolve relative to cwd. --out atomically publishes complete JSON without replacing files.\n" +
        "Quantities: unit-bearing strings or {value,status:CONFIRMED|ESTIMATED|OPEN,source,uncertainty?:{minus,plus}}. Unqualified strings are ESTIMATED; absent uncertainty is not zero. Missing physical data gives unknown; unknown/fail/blocked exit 1.\n" +
        "All inputs are strict: unknown fields, nonfinite numbers, incompatible units and exceeded budgets fail before publication. See docs/LOCAL_PIPELINES.md for local pipeline and fit sensitivity details.\n" +
        `Fit example: ${JSON.stringify(example)}`,
    },
  ]),
);

const manuals: Record<string, CommandManual> = Object.fromEntries(
  Object.entries(descriptors).map(([key, descriptor]) => [
    key,
    {
      sections: [
        { title: "Local Return Contract", text: descriptor.desc },
        {
          title: "Source And Schema Contract",
          text: "Version 1 envelope: schemaVersion:1, identity:{model,revision}, frame, assumptions:[nonempty strings], budget?:{maxEvaluations,timeMs}. Quantities are unit-bearing strings or {value,status,source,uncertainty}. Missing physical data yields unknown, never a zero default; unknown/fail/blocked exit 1. Read docs/LOCAL_PIPELINES.md for local pipeline and fit sensitivity details.",
        },
      ],
      examples: [
        {
          label: key + " local request",
          requires:
            "Local JSON input via --file or --data; no Fusion document, backend or configuration required.",
          argv: [
            ...key.split(" "),
            "--file",
            key.replaceAll(" ", "-") + ".json",
            "--json",
          ],
          output:
            "Unchanged versioned local envelope; inspect result.status and provenance. No document mutation.",
        },
      ],
      audit: {
        sources: ["src/engineering-local.js", "docs/ENGINEERING_LOCAL.md"],
        verified: [
          "local dispatch without configuration or backend",
          "strict flags, unknown-field and nonfinite-number rejection",
          "unit-bearing quantity parsing and unknown/fail/blocked statuses",
          "batch-composable local operation routing",
        ],
        tests: [
          "tests/engineering-thermal.test.ts",
          "tests/engineering-mass.test.ts",
          "tests/engineering-fluid.test.ts",
          "tests/engineering-hydraulic.test.ts",
          "tests/engineering-fit.test.ts",
          "tests/batch-local.test.js",
        ],
        gaps: [],
        bugs: [
          "Local calculations are analytic fixtures; they do not read live Fusion geometry or certify CFD/FEA/manufacturing behavior.",
        ],
      },
    },
  ]),
);

const execute = createEngineeringCommand(methods);
export { methods, descriptors, execute, localOperations, run, manuals };
