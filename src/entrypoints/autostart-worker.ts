import { createRequire } from "node:module";
import path from "node:path";
import type { FmcadConfiguration } from "../api";
import type { BrokerCompositionOptions } from "./broker.js";

const runtimeRequire = createRequire(__filename);
const runtimeModules = {
  queueConnection: runtimeRequire("../../queue-connection.js") as {
    queueDirectory(): string;
  },
  queueInstance: runtimeRequire("../../queue-instance.js") as {
    readJson(file: string): unknown;
    durable(file: string, value: unknown, exclusive?: boolean): void;
    processBirth(pid: number): string;
  },
  queueAutostart: runtimeRequire("../../queue-autostart.js") as {
    releaseStart(directory: string, nonce: string): void;
    startupResult(
      directory: string,
      nonce: string,
      result: Record<string, unknown>,
    ): void;
  },
  diagnostics: runtimeRequire("../../diagnostics.js") as {
    redactDiagnostic(
      message: string,
      config: Partial<FmcadConfiguration>,
    ): string;
  },
  broker: runtimeRequire("./broker.js") as {
    serveBroker(
      config: FmcadConfiguration,
      options: BrokerCompositionOptions,
    ): Promise<{ buildHash: string; close(): Promise<void> }>;
  },
};

type AutostartConfiguration = FmcadConfiguration & {
  queue: FmcadConfiguration["queue"] & { startPaused?: boolean };
};

function errorDetails(error: unknown): { code?: string; message: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    return {
      ...(code === undefined ? {} : { code }),
      message: error.message,
    };
  }
  return { message: String(error) };
}

/** Authenticated child process that claims and starts the shared broker. */
export async function main(): Promise<void> {
  const nonce = process.argv[2];
  if (typeof nonce !== "string" || !/^[a-f0-9-]{36}$/.test(nonce))
    throw new Error("Invalid autostart nonce");
  const directory = runtimeModules.queueConnection.queueDirectory();
  const lockFile = path.join(directory, "autostart.lock");
  if (
    (runtimeModules.queueInstance.readJson(lockFile) as { nonce?: string })
      .nonce !== nonce
  )
    throw new Error("Startup claim changed");

  let text = "";
  let config: Partial<FmcadConfiguration> = {};
  try {
    runtimeModules.queueInstance.durable(
      path.join(directory, "autostart", nonce + ".process.json"),
      {
        nonce,
        pid: process.pid,
        birth: runtimeModules.queueInstance.processBirth(process.pid),
      },
      true,
    );
    if (
      (runtimeModules.queueInstance.readJson(lockFile) as { nonce?: string })
        .nonce !== nonce
    )
      throw new Error("Startup claim changed before daemon ownership");
    for await (const chunk of process.stdin) {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > 1024 * 1024)
        throw new Error("Startup configuration exceeds 1 MiB");
    }
    const parsed = JSON.parse(text) as AutostartConfiguration;
    config = parsed;
    if (parsed.routing !== "queue" || parsed.queue?.autoStart === false)
      throw new Error("Automatic queue ownership was not enabled");
    const handle = await runtimeModules.broker.serveBroker(parsed, {
      confirmOwnership: true,
      autoReconcile: parsed.queue?.autoRecover !== false,
      startPaused: parsed.queue?.startPaused === true,
      ...(process.env["FMCAD_FUSION_RESET_NONCE"] === undefined
        ? {}
        : { fusionResetNonce: process.env["FMCAD_FUSION_RESET_NONCE"] }),
    });
    runtimeModules.queueAutostart.startupResult(directory, nonce, {
      state: "ready",
      pid: process.pid,
      buildHash: handle.buildHash,
    });
    runtimeModules.queueAutostart.releaseStart(directory, nonce);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        handle
          .close()
          .catch((error: unknown) =>
            process.stderr.write(
              "Broker retained: " +
                runtimeModules.diagnostics.redactDiagnostic(
                  errorDetails(error).message,
                  config,
                ) +
                "\n",
            ),
          );
      });
    }
  } catch (error) {
    const details = errorDetails(error);
    const message = runtimeModules.diagnostics.redactDiagnostic(
      details.message,
      config,
    );
    runtimeModules.queueAutostart.startupResult(directory, nonce, {
      state: "failed",
      code: details.code || "BROKER_START_FAILED",
      message,
    });
    runtimeModules.queueAutostart.releaseStart(directory, nonce);
    process.stderr.write("Broker startup failed: " + message + "\n");
    process.exitCode = 1;
  }
}
