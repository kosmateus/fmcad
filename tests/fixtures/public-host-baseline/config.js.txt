const platform = require('./dist/config-platform/index.js');
const domain = require('./dist/core/domain/config.js');

const DEFAULTS = { ...domain.DEFAULT_ADDIN_SETTINGS };

function loadConfig(options = {}) {
  const sources = platform.readConfigSources(options);
  return { path: sources.path, cfg: domain.resolveFmcadConfiguration(sources) };
}

function initConfig(options = {}) {
  const plan = platform.prepareConfigInit(options);
  if (plan.imported) {
    domain.resolveFmcadConfiguration({
      adapter: {},
      environment: {},
      file: plan.config,
      platformDefaults: {},
      acceptedService: null,
    });
  }
  return platform.writeConfigInitPlan(plan);
}

function defaultConfigPath() {
  return platform.defaultConfigPath();
}

function writeAcceptedServiceConfiguration(input) {
  const accepted = domain.decodeAcceptedServiceConfiguration(input);
  if (!accepted) throw new Error('accepted service configuration is required');
  return platform.writeAcceptedServiceConfiguration(accepted);
}

module.exports = {
  loadConfig,
  initConfig,
  defaultConfigPath,
  acceptedServiceConfigurationPath: platform.acceptedServiceConfigurationPath,
  writeAcceptedServiceConfiguration,
  DEFAULTS,
  resolveRuntimePaths: options => platform.resolveRuntimePaths({ anchor: __filename, ...options }),
};
