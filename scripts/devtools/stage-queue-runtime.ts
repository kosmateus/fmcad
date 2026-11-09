import * as fs from "node:fs";
import path from "node:path";

const modules = [
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
  "atomic-observation-binding",
  "queue-epoch-runtime-upgrade",

  "queue-broker",
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
  const artifacts = modules.flatMap((name) =>
    [".js", ".d.ts"].map((extension) => {
      const filename = name + extension;
      const file = path.join(source, filename);
      if (!fs.statSync(file).isFile())
        throw new Error("Missing emitted queue module: " + file);
      const emitted = fs.readFileSync(file);
      // Admission declarations must resolve inside an installed runtime, where
      // the source workspace packages are absent. Executable bytes stay exact.
      const bytes =
        extension === ".d.ts"
          ? Buffer.from(
              emitted
                .toString("utf8")
                .replaceAll("../packages/core/src", "./dist/core")
                .replaceAll(
                  "../packages/node-adapters/src/python",
                  "./dist/python",
                )
                .replaceAll(
                  "../packages/node-adapters/src",
                  "./dist/node-adapters",
                ),
            )
          : emitted;
      return { filename, bytes };
    }),
  );
  // The broker's public declaration references its private DTO declarations.
  artifacts.push({
    filename: "queue-broker-ports.d.ts",
    bytes: fs.readFileSync(path.join(source, "queue-broker-ports.d.ts")),
  });
  for (const target of outputs) {
    fs.mkdirSync(target, { recursive: true });
    for (const artifact of artifacts)
      fs.writeFileSync(path.join(target, artifact.filename), artifact.bytes);
  }
}

export function stageQueueTestFixtures(root: string): void {
  const names = [
    "closed-scratch-artifacts.cjs",
    "closed-epoch-successor.cjs",
    "historical-module.cjs",
  ];
  const artifacts = names.map((filename) => ({
    filename,
    bytes: fs.readFileSync(path.join(root, "dist/tests/fixtures", filename)),
  }));
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
