import * as fs from "node:fs";
import path from "node:path";

export const queueRuntimeModules = [
  "atomic-runtime-abi",
  "queue-settled-epoch-evidence",
  "queue-audit-facts-capture",
  "fusion-reset",
  "queue-document",
  "queue-phased",
  "queue-state",
  "queue-audit-response-proof",
  "queue-atomic-migration-stop",
  "queue-atomic-audit-upgrade",
  "queue-atomic-migration-worker",
  "queue-epoch-runtime-worker",
  "queue-epoch-successor-worker",

  "queue-epoch-prerequisite",
  "queue-atomic-control",
  "queue-atomic-migration",
  "queue-atomic-migration-files",
  "queue-atomic-recovery-audit",
  "queue-atomic-wire",
  "queue-native-fixture-grant",
  "queue-scratch-qualification",
  "queue-console-admin",
  "queue-response-migration",
  "queue-closed-epoch-successor",
  "atomic-observation-binding",
  "queue-epoch-runtime-upgrade",

  "queue-broker",
  "queue-broker-modules",
  "composition/queue-broker",
  "queue-backend-transition",
  "queue-client",
  "queue-closed-epoch-proof",
  "queue-isolated-epoch",
  "queue-scratch-control",
  "queue-admission",
  "queue-fixed-fixture-admission",
  "queue-instance-liveness",
  "queue-epoch-lineage",
] as const;

/** Publish compiler output, never a handwritten compatibility implementation. */
export function stageQueueRuntime(root: string): void {
  const source = path.join(root, "dist/library-build/src");
  const outputs = [path.join(root, "src"), path.join(root, "dist/src")];
  // Validate all inputs first so a missing compile does not partially stage.
  function artifact(name: string, extension: string) {
    const filename = name + extension;
    const file = path.join(source, filename);
    if (!fs.statSync(file).isFile())
      throw new Error("Missing emitted queue module: " + file);
    const emitted = fs.readFileSync(file);
    const fromSource =
      path.posix.relative(path.posix.dirname(name), ".") || ".";
    const toWorkspace = fromSource === "." ? ".." : `${fromSource}/..`;
    // Declarations must resolve without workspace packages. JS stays exact.
    const bytes =
      extension === ".d.ts"
        ? Buffer.from(
            emitted
              .toString("utf8")
              .replaceAll(
                `${toWorkspace}/packages/core/src`,
                `${fromSource}/dist/core`,
              )
              .replaceAll(
                `${toWorkspace}/packages/node-adapters/src/python`,
                `${fromSource}/dist/python`,
              )
              .replaceAll(
                `${toWorkspace}/packages/node-adapters/src`,
                `${fromSource}/dist/node-adapters`,
              )
              .replaceAll(
                `${toWorkspace}/packages/node-adapters/dist`,
                `${fromSource}/dist/node-adapters`,
              ),
          )
        : emitted;
    return { filename, bytes };
  }
  const artifacts = queueRuntimeModules.flatMap((name) =>
    [".js", ".d.ts"].map((extension) => artifact(name, extension)),
  );
  // The broker's public declaration references its private DTO declarations.
  artifacts.push(artifact("queue-broker-ports", ".d.ts"));
  for (const target of outputs) {
    fs.mkdirSync(target, { recursive: true });
    for (const artifact of artifacts) {
      const destination = path.join(target, artifact.filename);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, artifact.bytes);
    }
  }
}

export function stageQueueTestFixtures(root: string): void {
  const workspaceNames = [
    "atomic-audit-upgrade.cjs",
    "epoch-audit.cjs",
    "fake-wsl-platform.cjs",
    "fake-wsl-preload.cjs",
  ];
  const workspaceArtifacts = workspaceNames.map((filename) => ({
    filename,
    bytes: fs.readFileSync(path.join(root, "tests/fixtures", filename)),
  }));
  const names = [
    "closed-scratch-artifacts.cjs",
    "closed-epoch-successor.cjs",
    "historical-module.cjs",
  ];
  const artifacts = names.map((filename) => ({
    filename,
    bytes: fs.readFileSync(path.join(root, "dist/tests/fixtures", filename)),
  }));
  const compiledTarget = path.join(root, "dist/tests/fixtures");
  fs.mkdirSync(compiledTarget, { recursive: true });
  for (const artifact of workspaceArtifacts)
    fs.writeFileSync(
      path.join(compiledTarget, artifact.filename),
      artifact.bytes,
    );
  const target = path.join(root, "tests/fixtures");
  fs.mkdirSync(target, { recursive: true });
  for (const artifact of artifacts)
    fs.writeFileSync(path.join(target, artifact.filename), artifact.bytes);
}

if (require.main === module) {
  const root = path.resolve(__dirname, "../../..");
  if (process.argv.length === 3 && process.argv[2] === "--tests")
    stageQueueTestFixtures(root);
  else {
    if (process.argv.length !== 2)
      throw new Error("stage-queue-runtime accepts only --tests");
    stageQueueRuntime(root);
  }
}
