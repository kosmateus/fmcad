import {
  nativeParameterTestCapability,
  nativeParameterTestScenarios,
} from "./native-parameter-test-cases";
import {
  nativeRpcRecoveryScenarios,
  nativeRpcRecoveryCapability,
  prepareNativeRpcRecoveryBroker,
  type NativeRpcRecoveryPreparation,
} from "./native-rpc-recovery-cases";
import {
  nativeMcpStdioScenarios,
  nativeMcpStdioCapability,
} from "./native-mcp-stdio-cases";
import {
  nativeBackendAdapterScenarios,
  nativeBackendAdapterCapability,
} from "./native-backend-adapter-cases";
import {
  nativeStyleSaveScenarios,
  nativeStyleSaveCapability,
} from "./native-style-save-cases";
import {
  nativeLegacyScenarios,
  nativeLegacyCapability,
} from "./native-legacy-cases";
import {
  nativeMotionScenarios,
  nativeMotionCapability,
} from "./native-motion-cases";
import {
  nativeJointLimitsScenarios,
  nativeJointLimitsCapability,
} from "./native-joint-limits-cases";
import {
  nativeBatchReferenceScenarios,
  nativeBatchReferenceCapability,
} from "./native-batch-reference-cases";
import {
  nativeEngineeringScenarios,
  engineeringAnalyticDeclarationScenarios,
  nativeEngineeringCapability,
} from "./native-engineering-cases";
import {
  nativeThreadScenarios,
  nativeThreadCapability,
} from "./native-thread-cases";
import {
  nativeAnimationScenarios,
  nativeAnimationCapability,
} from "./native-animation-cases";
import {
  nativeDesignStylesScenarios,
  nativeDesignStylesCapability,
} from "./native-design-styles-cases";
import { nativePoseScenarios, nativePoseCapability } from "./native-pose-cases";
import {
  nativeSketchOperationsScenarios,
  nativeSketchOperationsCapability,
} from "./native-sketch-operations-cases";
import {
  nativeExtendedScenarios,
  nativeExtendedCapability,
} from "./native-extended-cases";
import {
  nativeImportScenarios,
  nativeImportCapability,
} from "./native-import-cases";
import {
  nativeFileExportScenarios,
  nativeFileExportsCapability,
} from "./native-file-export-cases";
import {
  nativeFeatureModesScenarios,
  nativeFeatureModesCapability,
} from "./native-feature-modes-cases";
import {
  nativeComponentHierarchyScenarios,
  nativeComponentHierarchyCapability,
} from "./native-component-hierarchy-cases";
import { nativeCadScenarios, nativeCadCapability } from "./native-cad-cases";
import { childCliScenarios } from "./child-cli-cases";
import {
  isolateScenarioConfiguration,
  writeChildScenarioConfig,
} from "./child-cli-config";
import {
  nativeThickenSlotPatternScenarios,
  nativeThickenSlotPatternCapability,
} from "./native-thicken-slot-pattern-cases";
import {
  nativeCameraProbeScenarios,
  nativeCameraProbeCapability,
} from "./native-camera-probe-cases";
import {
  nativeIntegrationScenarios,
  nativeIntegrationCapability,
} from "./native-integration-cases";
import { gmDeclarationScenarios } from "./gm-declaration-cases";
import { scenarioSummary } from "./report-summary";
import {
  retainedDeclarationScenarios,
  type DeclarationFamily,
} from "./retained-declaration-cases";
import { mechanicalDeclarationScenarios } from "./mechanical-declaration-cases";
import { engineeringDeclarationScenarios } from "./engineering-declaration-cases";
import { gearPairScenarios } from "./gear-pair-cases";
import { threadRecipeScenarios } from "./thread-recipe-cases";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  CheckedSimulatorBackend,
  PythonSimulator,
  simulatorCapabilities,
  simulatorEndpoint,
  simulatorFolder,
} from "./simulator";
import { QueueScenarioBackend } from "./queue-backend";
import { foundationScenarios, savedScenarios } from "./cases";
import { parameterScenarios } from "./parameter-cases";
import { documentScenarios } from "./document-cases";
import { cloudScenarios } from "./cloud-cases";
import { boxScenarios } from "./box-cases";
import {
  attributeScenarios,
  unsavedAttributeScenarios,
} from "./attribute-cases";
import { reopenScenarios, revisionScenarios } from "./reopen-cases";
import { transactionScenarios } from "./transaction-cases";
import {
  nativeSolidsCapability,
  nativeSolidsScenarios,
} from "./native-solids-cases";
import { styleAssignmentScenarios } from "./style-assignment-cases";
import { appearanceScenarios } from "./appearance-cases";
import { materialScenarios } from "./material-cases";
import { animationScenarios } from "./animation-cases";
import { poseScenarios } from "./pose-cases";
import { cameraScenarios } from "./camera-cases";
import { rectangleScenarios } from "./rectangle-cases";
import { sketchScenarios } from "./sketch-cases";
import { runScenarios, resumeCleanup, type Scenario } from "./runner";
import { concurrencyLimit, defaultConcurrency, sourceHash } from "./scheduling";
import type { FixtureFolder, Protocol, ScenarioBackend } from "./contracts";
import type { createBrokerTransport } from "../../packages/node-adapters/src/fusion-transport/broker";
import type {
  detectPlatform,
  toWindowsPath,
} from "../../packages/node-adapters/src/config-platform/platform";

interface Options {
  backend: "fusion" | "simulator";
  profile: "broker" | "component";
  protocol: Protocol;
  concurrency: number;
  owners: number;
  run: boolean;
  suite:
    | "foundation"
    | "saved"
    | "parameters"
    | "documents"
    | "cloud"
    | "boxes"
    | "attributes"
    | "transactions"
    | "native-solids"
    | "native-cad"
    | "native-component-hierarchy"
    | "native-feature-modes"
    | "native-file-exports"
    | "native-pose"
    | "native-design-styles"
    | "native-animation"
    | "native-thread"
    | "native-engineering"
    | "native-batch-reference"
    | "native-joint-limits"
    | "native-motion"
    | "native-legacy"
    | "native-style-save"
    | "native-backend-adapter"
    | "native-mcp-stdio"
    | "native-rpc-recovery"
    | "native-definitions"
    | "native-attributes"
    | "native-parameter-test"
    | "native-import"
    | "native-extended"
    | "native-sketch-operations"
    | "native-integration"
    | "native-thicken-slot-pattern"
    | "native-camera-probe"
    | "gear-pair"
    | "engineering-declarations"
    | "mechanical-declarations"
    | "child-cli"
    | "retained-engineering"
    | "retained-gm-contracts"
    | `retained-${DeclarationFamily}`
    | "thread-recipes"
    | "style-assignments"
    | "appearances"
    | "materials"
    | "animation"
    | "poses"
    | "camera"
    | "rectangles"
    | "revisions"
    | "reopen"
    | "sketches"
    | "all";
  folder?: FixtureFolder;
  cleanup?: string;
}
export function parse(argv: string[]): Options {
  let backend: Options["backend"] = "simulator",
    profile: Options["profile"] = "broker",
    protocol: Protocol = "mcp";
  let concurrency: number | undefined,
    owners = 10,
    run = false;
  let cleanup: string | undefined;
  let suite: Options["suite"] = "all";
  let projectId: string | undefined, folderId: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag || seen.has(flag))
      throw new Error("Invalid/duplicate scenario option: " + flag);
    seen.add(flag);
    if (flag === "--run") {
      run = true;
      continue;
    }
    const value = argv[++index];
    if (flag === "--backend" && (value === "fusion" || value === "simulator"))
      backend = value;
    else if (
      flag === "--profile" &&
      (value === "broker" || value === "component")
    )
      profile = value;
    else if (flag === "--protocol" && (value === "mcp" || value === "addin"))
      protocol = value;
    else if (
      flag === "--suite" &&
      (value === "foundation" ||
        value === "saved" ||
        value === "parameters" ||
        value === "documents" ||
        value === "cloud" ||
        value === "boxes" ||
        value === "attributes" ||
        value === "transactions" ||
        value === "native-solids" ||
        value === "native-cad" ||
        value === "native-component-hierarchy" ||
        value === "native-feature-modes" ||
        value === "native-file-exports" ||
        value === "native-pose" ||
        value === "native-design-styles" ||
        value === "native-animation" ||
        value === "native-thread" ||
        value === "native-engineering" ||
        value === "native-batch-reference" ||
        value === "native-joint-limits" ||
        value === "native-motion" ||
        value === "native-legacy" ||
        value === "native-style-save" ||
        value === "native-backend-adapter" ||
        value === "native-mcp-stdio" ||
        value === "native-rpc-recovery" ||
        value === "native-definitions" ||
        value === "native-attributes" ||
        value === "native-parameter-test" ||
        value === "native-import" ||
        value === "native-extended" ||
        value === "native-sketch-operations" ||
        value === "native-integration" ||
        value === "native-thicken-slot-pattern" ||
        value === "native-camera-probe" ||
        value === "gear-pair" ||
        value === "engineering-declarations" ||
        value === "mechanical-declarations" ||
        value === "child-cli" ||
        value === "retained-engineering" ||
        value === "retained-gm-contracts" ||
        value === "retained-thread" ||
        value === "retained-seal" ||
        value === "retained-fasteners" ||
        value === "retained-mechanism" ||
        value === "retained-pose" ||
        value === "retained-interference" ||
        value === "retained-containment" ||
        value === "thread-recipes" ||
        value === "style-assignments" ||
        value === "appearances" ||
        value === "materials" ||
        value === "animation" ||
        value === "poses" ||
        value === "camera" ||
        value === "rectangles" ||
        value === "revisions" ||
        value === "reopen" ||
        value === "sketches" ||
        value === "all")
    )
      suite = value;
    else if (flag === "--project-id" && value && !value.startsWith("--"))
      projectId = value;
    else if (flag === "--folder-id" && value && !value.startsWith("--"))
      folderId = value;
    else if (flag === "--cleanup" && value && !value.startsWith("--"))
      cleanup = path.resolve(value);
    else if (
      (flag === "--concurrency" || flag === "--owners") &&
      value &&
      /^[1-9][0-9]*$/.test(value)
    ) {
      const number = concurrencyLimit(Number(value));
      if (flag === "--concurrency") concurrency = number;
      else owners = number;
    } else
      throw new Error("Invalid scenario option/value: " + flag + " " + value);
  }
  if (backend === "fusion" && (!run || profile !== "broker"))
    throw new Error(
      "Live Fusion requires --run and the broker profile; no direct fallback",
    );
  if (cleanup && backend !== "fusion")
    throw new Error(
      "Process-restart cleanup requires the original live Fusion backend; a new simulator is a different instance",
    );
  if (Boolean(projectId) !== Boolean(folderId))
    throw new Error("Provide both --project-id and --folder-id");
  if (
    backend === "fusion" &&
    ![
      "native-pose",
      "native-design-styles",
      "native-animation",
      "native-thread",
      "native-engineering",
      "native-batch-reference",
      "native-joint-limits",
      "native-motion",
      "native-legacy",
      "retained-engineering",
      "native-style-save",
      "native-backend-adapter",
      "native-mcp-stdio",
      "native-rpc-recovery",
      "native-definitions",
      "native-attributes",
      "native-import",
      "native-extended",
      "native-sketch-operations",
      "foundation",
      "native-thicken-slot-pattern",
      "native-camera-probe",
      "native-cad",
      "native-component-hierarchy",
      "native-feature-modes",
      "native-file-exports",
    ].includes(suite) &&
    !cleanup &&
    (!projectId || !folderId)
  )
    throw new Error(
      "Saved Fusion scenarios require an explicitly configured --project-id and --folder-id",
    );
  return {
    backend,
    profile,
    protocol,
    owners,
    run,
    suite,
    ...(projectId && folderId
      ? { folder: { projectId, folderId } }
      : backend === "simulator"
        ? { folder: simulatorFolder }
        : {}),
    concurrency: concurrency ?? defaultConcurrency(backend),
    ...(cleanup ? { cleanup } : {}),
  };
}
/** Existing fixed case sets must honor the requested independent owner copies. */
export function scenarioCopies(
  cases: readonly Scenario[],
  copies: number,
): Scenario[] {
  concurrencyLimit(copies);
  return Array.from({ length: copies }, (_, index) =>
    cases.map((entry) => ({
      ...entry,
      id: index === 0 ? entry.id : entry.id + "-owner-" + index,
    })),
  ).flat();
}
export function scenariosFor(
  options: Pick<Options, "suite" | "owners" | "folder">,
  context: { rpcRecovery?: NativeRpcRecoveryPreparation } = {},
): Scenario[] {
  return [
    ...(options.suite === "retained-engineering" || options.suite === "all"
      ? engineeringAnalyticDeclarationScenarios(options.owners)
      : []),
    ...(options.suite === "native-sketch-operations"
      ? nativeSketchOperationsScenarios(options.owners)
      : []),
    ...(options.suite === "native-extended"
      ? nativeExtendedScenarios(options.owners)
      : []),
    ...(options.suite === "native-pose"
      ? nativePoseScenarios(options.owners)
      : []),
    ...(options.suite === "native-design-styles"
      ? nativeDesignStylesScenarios(options.owners)
      : []),
    ...(options.suite === "native-animation"
      ? nativeAnimationScenarios(options.owners)
      : []),
    ...(options.suite === "native-thread"
      ? nativeThreadScenarios(options.owners)
      : []),
    ...(options.suite === "native-engineering"
      ? nativeEngineeringScenarios(options.owners)
      : []),
    ...(options.suite === "native-batch-reference"
      ? nativeBatchReferenceScenarios(options.owners)
      : []),
    ...(options.suite === "native-joint-limits"
      ? nativeJointLimitsScenarios(options.owners)
      : []),
    ...(options.suite === "native-motion"
      ? nativeMotionScenarios(options.owners)
      : []),
    ...(options.suite === "native-legacy"
      ? nativeLegacyScenarios(options.owners)
      : []),
    ...(options.suite === "native-style-save"
      ? nativeStyleSaveScenarios(options.owners)
      : []),
    ...(options.suite === "native-backend-adapter"
      ? nativeBackendAdapterScenarios(options.owners)
      : []),
    ...(options.suite === "native-mcp-stdio"
      ? nativeMcpStdioScenarios(options.owners)
      : []),
    ...(options.suite === "native-rpc-recovery"
      ? nativeRpcRecoveryScenarios(options.owners, context.rpcRecovery)
      : []),
    ...(options.suite === "native-definitions"
      ? transactionScenarios(undefined, options.owners)
      : []),
    ...(options.suite === "native-attributes"
      ? unsavedAttributeScenarios(options.owners)
      : []),
    ...(options.suite === "native-parameter-test" && options.folder
      ? nativeParameterTestScenarios(options.folder, options.owners)
      : []),
    ...(options.suite === "native-import"
      ? nativeImportScenarios(options.owners)
      : []),
    ...(options.suite === "native-file-exports"
      ? nativeFileExportScenarios(options.owners)
      : []),
    ...(options.suite === "native-feature-modes"
      ? nativeFeatureModesScenarios(options.owners)
      : []),
    ...(options.suite === "native-component-hierarchy"
      ? nativeComponentHierarchyScenarios(options.owners)
      : []),
    ...(options.suite === "native-cad"
      ? nativeCadScenarios(options.owners)
      : []),
    ...(options.suite === "native-camera-probe"
      ? nativeCameraProbeScenarios(options.owners)
      : []),
    ...(options.suite === "native-thicken-slot-pattern"
      ? nativeThickenSlotPatternScenarios(options.owners)
      : []),
    ...(options.suite === "foundation" || options.suite === "all"
      ? foundationScenarios(options.owners)
      : []),
    ...((options.suite === "saved" || options.suite === "all") && options.folder
      ? savedScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "parameters" || options.suite === "all") &&
    options.folder
      ? scenarioCopies(parameterScenarios(options.folder), options.owners)
      : []),
    ...((options.suite === "documents" || options.suite === "all") &&
    options.folder
      ? scenarioCopies(documentScenarios(options.folder), options.owners)
      : []),
    ...((options.suite === "cloud" || options.suite === "all") && options.folder
      ? scenarioCopies(cloudScenarios(options.folder), options.owners)
      : []),
    ...((options.suite === "boxes" || options.suite === "all") && options.folder
      ? scenarioCopies(boxScenarios(options.folder), options.owners)
      : []),
    ...((options.suite === "attributes" || options.suite === "all") &&
    options.folder
      ? [
          ...attributeScenarios(options.folder, options.owners),
          ...unsavedAttributeScenarios(options.owners),
        ]
      : []),
    ...((options.suite === "transactions" || options.suite === "all") &&
    options.folder
      ? [
          ...transactionScenarios(options.folder, options.owners),
          ...transactionScenarios(undefined, options.owners),
        ]
      : []),
    ...((options.suite === "child-cli" || options.suite === "all") &&
    options.folder
      ? childCliScenarios(options.folder, options.owners)
      : []),
    ...(options.suite === "native-integration" && options.folder
      ? nativeIntegrationScenarios(options.folder, options.owners)
      : []),
    ...(options.suite === "native-solids" && options.folder
      ? [
          ...nativeSolidsScenarios(options.folder, options.owners),
          ...nativeSolidsScenarios(undefined, options.owners),
        ]
      : []),
    ...((options.suite === "retained-gm-contracts" ||
      options.suite === "all") &&
    options.folder
      ? gmDeclarationScenarios(options.folder, options.owners)
      : []),
    ...(
      [
        "thread",
        "seal",
        "fasteners",
        "mechanism",
        "pose",
        "interference",
        "containment",
      ] as const
    ).flatMap((family) =>
      (options.suite === "retained-" + family || options.suite === "all") &&
      options.folder
        ? retainedDeclarationScenarios(options.folder, family, options.owners)
        : [],
    ),
    ...((options.suite === "mechanical-declarations" ||
      options.suite === "all") &&
    options.folder
      ? mechanicalDeclarationScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "engineering-declarations" ||
      options.suite === "all") &&
    options.folder
      ? engineeringDeclarationScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "gear-pair" || options.suite === "all") &&
    options.folder
      ? gearPairScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "thread-recipes" || options.suite === "all") &&
    options.folder
      ? threadRecipeScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "style-assignments" || options.suite === "all") &&
    options.folder
      ? styleAssignmentScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "appearances" || options.suite === "all") &&
    options.folder
      ? appearanceScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "materials" || options.suite === "all") &&
    options.folder
      ? materialScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "animation" || options.suite === "all") &&
    options.folder
      ? animationScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "poses" || options.suite === "all") && options.folder
      ? poseScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "camera" || options.suite === "all") &&
    options.folder
      ? cameraScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "rectangles" || options.suite === "all") &&
    options.folder
      ? rectangleScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "revisions" || options.suite === "all") &&
    options.folder
      ? revisionScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "reopen" || options.suite === "all") &&
    options.folder
      ? reopenScenarios(options.folder, options.owners)
      : []),
    ...((options.suite === "sketches" || options.suite === "all") &&
    options.folder
      ? sketchScenarios(options.folder, options.owners)
      : []),
  ];
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parse(argv);
  const root = path.resolve(__dirname, "../../..");
  const output = path.join(root, ".test-artifacts/scenarios");
  const temporary = path.join(output, "checker");
  fs.mkdirSync(temporary, { recursive: true });
  const load = createRequire(path.join(root, "package.json"));
  let model: PythonSimulator | undefined;
  let endpoint: Awaited<ReturnType<typeof simulatorEndpoint>> | undefined;
  let broker: { close(): Promise<void> } | undefined;
  let backend: ScenarioBackend;
  let queue: QueueScenarioBackend | undefined;
  let rpcRecovery: NativeRpcRecoveryPreparation | undefined;
  const originalEnvironment = new Map<string, string | undefined>();
  const hashSources = (): string =>
    sourceHash({
      tests: path.join(root, "tests"),
      runtime: path.join(root, "runtime/python/fmcad"),
      assets: path.join(root, "assets"),
    });
  const sourceBefore = hashSources();
  try {
    if (options.backend === "fusion") {
      const { cfg } = (
        load("./src/config") as {
          loadConfig(options: { routing: "queue" }): {
            cfg: Record<string, unknown>;
          };
        }
      ).loadConfig({ routing: "queue" });
      if (cfg["backend"] !== options.protocol)
        throw new Error(
          "Configured broker backend differs from --protocol; no broker was started or changed",
        );
      if (options.suite === "native-rpc-recovery" && !options.cleanup)
        rpcRecovery = await prepareNativeRpcRecoveryBroker(root, cfg);
      const platform = load("./src/dist/config-platform") as {
        toWindowsPath: typeof toWindowsPath;
        detectPlatform: typeof detectPlatform;
      };
      queue = new QueueScenarioBackend(
        "fusion",
        options.protocol,
        new Set([
          ...simulatorCapabilities,
          "original-user-view",
          "original-user-view-absolute-camera",
          nativeSolidsCapability,
          nativeParameterTestCapability,
          nativeCadCapability,
          nativeComponentHierarchyCapability,
          ...(options.protocol === "addin"
            ? [nativeFeatureModesCapability]
            : []),
          nativeFileExportsCapability,
          nativePoseCapability,
          nativeDesignStylesCapability,
          nativeAnimationCapability,
          nativeThreadCapability,
          nativeEngineeringCapability,
          nativeBatchReferenceCapability,
          ...(options.protocol === "addin"
            ? [nativeJointLimitsCapability]
            : []),
          nativeMotionCapability,
          nativeLegacyCapability,
          ...(options.protocol === "addin" ? [nativeStyleSaveCapability] : []),
          ...(options.protocol === "addin"
            ? [nativeBackendAdapterCapability]
            : []),
          ...(options.protocol === "addin" ? [nativeMcpStdioCapability] : []),
          ...(options.protocol === "addin"
            ? [nativeRpcRecoveryCapability]
            : []),
          nativeImportCapability,
          nativeExtendedCapability,
          nativeSketchOperationsCapability,
          nativeIntegrationCapability,
          nativeThickenSlotPatternCapability,
          nativeCameraProbeCapability,
        ]),
        root,
        rpcRecovery?.config ?? cfg,
        (file) => platform.toWindowsPath(file, platform.detectPlatform()),
      );
      backend = queue;
    } else if (options.profile === "component") {
      model = new PythonSimulator(root);
      backend = new CheckedSimulatorBackend(
        model,
        options.protocol,
        root,
        temporary,
      );
    } else {
      // Real process identity is a prerequisite, not a test condition to stub away.
      const identity = load("./src/queue-instance") as {
        processBirth(): string;
      };
      identity.processBirth();
      const state = path.join(
        path.dirname(root),
        ".scenario-state",
        randomUUID().slice(0, 8),
      );
      for (const [key, value] of Object.entries({
        XDG_STATE_HOME: state,
        XDG_CONFIG_HOME: state + "-config",
        XDG_CACHE_HOME: state + "-cache",
      })) {
        originalEnvironment.set(key, process.env[key]);
        process.env[key] = value;
        fs.mkdirSync(value, { recursive: true, mode: 0o700 });
      }
      for (const [key, value] of isolateScenarioConfiguration(process.env))
        originalEnvironment.set(key, value);
      model = new PythonSimulator(root);
      endpoint = await simulatorEndpoint(model);
      const configFile = writeChildScenarioConfig(state + "-config", {
        backend: options.protocol,
        routing: "queue",
        queue: { autoStart: false },
        backends: {
          [options.protocol]: { url: endpoint.url, timeoutMs: 60000 },
        },
      });
      process.env["FMCAD_CONFIG"] = configFile;
      const { cfg } = (
        load("./src/config") as {
          loadConfig(): {
            cfg: Record<string, unknown> & { url: string };
          };
        }
      ).loadConfig();
      const transport = load("./src/dist/fusion-transport/broker") as {
        createBrokerTransport: typeof createBrokerTransport;
      };
      const module = load("./src/queue-broker") as {
        serve(
          config: typeof cfg,
          options: {
            confirmOwnership: true;
            createBackend(): ReturnType<typeof createBrokerTransport>;
            nativePath(file: string): string;
          },
        ): Promise<{ close(): Promise<void> }>;
      };
      broker = await module.serve(cfg, {
        confirmOwnership: true,
        nativePath: (file) => file,
        createBackend: () =>
          transport.createBrokerTransport(cfg, {
            version: "test",
            requestTimeout: () => 180000,
            bridgeSource: () =>
              fs.readFileSync(
                path.join(root, "assets/cad/identity.py"),
                "utf8",
              ) +
              "\n" +
              fs.readFileSync(
                path.join(root, "assets/addin-bridge.py"),
                "utf8",
              ),
          }),
      });
      queue = new QueueScenarioBackend(
        "simulator",
        options.protocol,
        simulatorCapabilities,
        root,
        cfg,
        (file) => file,
      );
      backend = queue;
    }
    if (options.cleanup) {
      const report = await resumeCleanup(backend, options.cleanup);
      console.log(
        JSON.stringify(
          {
            cleanup: report.cleanup,
            ...scenarioSummary(report),
            scenarioStatus: report.status,
            report: options.cleanup,
          },
          null,
          2,
        ),
      );
      return report.cleanup === "complete" ? 0 : 1;
    }
    const cancellation = new AbortController();
    const cancel = (): void =>
      cancellation.abort(
        new Error("Scenario run interrupted; waiting for settled cleanup"),
      );
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let reports;
    try {
      reports = await runScenarios(
        backend,
        scenariosFor(options, rpcRecovery ? { rpcRecovery } : {}),
        output,
        options.concurrency,
        cancellation.signal,
      );
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    const sourceAfter = hashSources();
    const passed =
      sourceBefore === sourceAfter &&
      reports.every((report) => report.status === "passed");
    console.log(
      JSON.stringify(
        {
          ...options,
          qualification: backend.qualification,
          sourceBefore,
          sourceAfter,
          status: passed ? "passed" : "failed",
          reports: reports.map((report) => ({
            id: report.owner.scenarioId,
            status: report.status,
            cleanup: report.cleanup,
            ...scenarioSummary(report),
            report: path.join(report.directory, "report.json"),
          })),
        },
        null,
        2,
      ),
    );
    return passed ? 0 : 1;
  } finally {
    queue?.close();
    await rpcRecovery?.closeOwned();
    try {
      await broker?.close();
    } finally {
      try {
        await endpoint?.close();
      } finally {
        await model?.close();
      }
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}
if (require.main === module)
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
