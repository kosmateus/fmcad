import { createRequire } from "node:module";
import type { OperationContract } from "@fmcad/core";
import type { CadPreparationPorts } from "../../packages/node-adapters/src/python/cad-script.js";

const runtimeRequire = createRequire(__filename);
const { planInspection } = runtimeRequire(
  "../core/application/inspection.js",
) as typeof import("../../packages/core/src/application/inspection.js");
const scripts = runtimeRequire(
  "../python/cad-script.js",
) as typeof import("../../packages/node-adapters/src/python/cad-script.js");
const catalog = runtimeRequire("../../catalog/index.js") as {
  validateCad: CadPreparationPorts["validate"];
  contracts: Readonly<Record<string, OperationContract>>;
};
const curve = runtimeRequire("../../curve.js") as {
  prepare: CadPreparationPorts["curve"];
};
const dataImport = runtimeRequire("../../data-import.js") as {
  prepare: CadPreparationPorts["dataImport"];
};
type CadScripts = ReturnType<typeof scripts.createCadScriptAdapter>;
const adapter: CadScripts = scripts.createCadScriptAdapter({
  validate: catalog.validateCad,
  inspection: (data) => ({
    ...planInspection(data, catalog.contracts, catalog.validateCad),
  }),
  curve: curve.prepare,
  dataImport: dataImport.prepare,
});
export const prepareCadScript: CadScripts["prepareCadScript"] =
  adapter.prepareCadScript;
export const buildCadScript: CadScripts["buildCadScript"] =
  adapter.buildCadScript;
export const { fusionPath, mapCadPaths } = scripts;
