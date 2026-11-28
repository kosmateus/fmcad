import fs from "node:fs";
import { createRequire } from "node:module";
const load = createRequire(__filename);
interface Client {
  dir: string;
  auth: { clientId: string; clientToken: string };
  call(action: "queue-summary"): Promise<unknown>;
  dispose(): void;
}
void (async () => {
  const args = process.argv.slice(2),
    modes = [
      "--preflight-retirement",
      "--confirm-retirement",
      "--resume-evaluator",
      "--preflight-acceptance",
      "--confirm-acceptance",
      "--inspect-handoff",
    ];
  if (
    args.length !== 4 ||
    args[0] !== "--approval" ||
    !modes.includes(args[2] ?? "") ||
    args[3] !== "true"
  )
    throw new Error(
      "Use --approval FILE with exactly one --preflight-retirement / --confirm-retirement / --resume-evaluator / --preflight-acceptance / --confirm-acceptance / --inspect-handoff true; no root, client or test-port overrides",
    );
  const approval = fs.realpathSync(args[1]!);
  const { QueueClient } = load("../dist/src/queue-client.js") as {
    QueueClient: new (
      id: undefined,
      options: { existingCredentialsOnly: true },
    ) => Client;
  };
  const runtime = load(
    "../dist/src/dist/composition/queue-epoch-successor-retained.js",
  ) as {
    resumeRetainedSuccessor(
      client: Client,
      cfg: unknown,
      approval: string,
    ): Promise<unknown>;
    recoverRetainedSuccessor(
      client: Client,
      approval: string,
      apply: boolean,
    ): Promise<unknown>;
    acceptRetainedSuccessor(
      client: Client,
      approval: string,
      apply: boolean,
    ): Promise<unknown>;
    readRetainedHandoff(client: Client, approval: string): unknown;
  };
  const client = new QueueClient(undefined, { existingCredentialsOnly: true });
  try {
    const result =
      args[2] === "--inspect-handoff"
        ? runtime.readRetainedHandoff(client, approval)
        : args[2] === "--resume-evaluator"
          ? await runtime.resumeRetainedSuccessor(
              client,
              (
                load("../dist/src/config.js") as {
                  loadConfig(options: Record<string, unknown>): {
                    cfg: unknown;
                  };
                }
              ).loadConfig({}).cfg,
              approval,
            )
          : args[2]!.includes("acceptance")
            ? await runtime.acceptRetainedSuccessor(
                client,
                approval,
                args[2] === "--confirm-acceptance",
              )
            : await runtime.recoverRetainedSuccessor(
                client,
                approval,
                args[2] === "--confirm-retirement",
              );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.dispose();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
