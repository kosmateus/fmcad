import { createRequire } from "node:module";
import {
  DEFAULT_ADDIN_SETTINGS,
  resolveFmcadConfiguration,
  decodeAcceptedServiceConfiguration,
} from "../../packages/core/src/domain/config";
const load = createRequire(__filename);
const platform = load(
  "../config-platform/index.js",
) as typeof import("../../packages/node-adapters/src/config-platform/index.js");

export const DEFAULTS = { ...DEFAULT_ADDIN_SETTINGS };
export function loadConfig(options: unknown = {}) {
  const sources = platform.readConfigSources(options);
  return { path: sources.path, cfg: resolveFmcadConfiguration(sources) };
}
export function initConfig(options: unknown = {}) {
  const plan = platform.prepareConfigInit(options);
  if (plan.imported) {
    resolveFmcadConfiguration({
      adapter: {},
      environment: {},
      file: plan.config,
      platformDefaults: {},
      acceptedService: null,
    });
  }
  return platform.writeConfigInitPlan(plan);
}
export function defaultConfigPath(): string {
  return platform.defaultConfigPath();
}
export function acceptedServiceConfigurationPath(): string {
  return platform.acceptedServiceConfigurationPath();
}
export function writeAcceptedServiceConfiguration(input: unknown): void {
  const accepted = decodeAcceptedServiceConfiguration(input);
  if (!accepted) throw new Error("accepted service configuration is required");
  platform.writeAcceptedServiceConfiguration(accepted);
}
