import * as fs from "node:fs";
import path from "node:path";

export const scenarioConfigEnvironment = [
  "FMCAD_CONFIG",
  "FMCAD_BACKEND",
  "FMCAD_URL",
  "FMCAD_ENDPOINT",
  "FMCAD_HEADERS",
  "FMCAD_TIMEOUT_MS",
  "FMCAD_TIMEOUT",
  "FMCAD_TOOL",
  "FMCAD_TRANSPORT",
  "FMCAD_CURL_PATH",
  "FMCAD_PROTOCOL_VERSION",
  "FMCAD_ROUTING",
  "FMCAD_QUEUE_STARTUP_TIMEOUT_MS",
  "FMCAD_QUEUE_WAIT_TIMEOUT_MS",
  "FMCAD_QUEUE_PREPARATION_CONCURRENCY",
  "FMCAD_QUEUE_AUTO_START",
  "FMCAD_QUEUE_AUTO_RECOVER",
  "FMCAD_QUEUE_CLIENT",
  "FMCAD_CONTROL_CENTER_PORT",
] as const;

export function writeChildScenarioConfig(
  configHome: string,
  config: Record<string, unknown>,
): string {
  const directory = path.join(configHome, "fmcad");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "config.json");
  fs.writeFileSync(filename, JSON.stringify(config, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return filename;
}

export function isolateScenarioConfiguration(
  environment: NodeJS.ProcessEnv,
): Map<string, string | undefined> {
  const original = new Map<string, string | undefined>();
  for (const key of scenarioConfigEnvironment) {
    original.set(key, environment[key]);
    delete environment[key];
  }
  return original;
}
