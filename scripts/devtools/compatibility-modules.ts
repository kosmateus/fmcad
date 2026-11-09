/** Existing literal CommonJS compatibility paths; no business logic lives here. */
export const compatibilityModules = [
  {
    publicPath: "src/addin-bridge.js",
    target: "./dist/composition/library-addin-bridge",
    emittedPath: "dist/library-build/src/composition/library-addin-bridge.js",
  },
  {
    publicPath: "src/addin-client.js",
    target: "./dist/composition/library-addin-client",
    emittedPath: "dist/library-build/src/composition/library-addin-client.js",
  },
  {
    publicPath: "src/backends.js",
    target: "./dist/composition/library-backends",
    emittedPath: "dist/library-build/src/composition/library-backends.js",
  },
  {
    publicPath: "src/batch-atomic.js",
    target: "./dist/composition/batch-atomic",
    emittedPath: "dist/library-build/src/composition/batch-atomic.js",
  },
  {
    publicPath: "src/batch.js",
    target: "./dist/composition/batch",
    emittedPath: "dist/library-build/src/composition/batch.js",
  },
  {
    publicPath: "src/broker-manual.js",
    target: "./dist/composition/library-broker-manual",
    emittedPath: "dist/library-build/src/composition/library-broker-manual.js",
  },
  {
    publicPath: "src/cad-input.js",
    target: "./dist/composition/library-cad-input",
    emittedPath: "dist/library-build/src/composition/library-cad-input.js",
  },
  {
    publicPath: "src/cad-service.js",
    target: "./dist/composition/cad-service",
    emittedPath: "dist/library-build/src/composition/cad-service.js",
  },
  {
    publicPath: "src/cad.js",
    target: "./dist/composition/cad-execution",
    emittedPath: "dist/library-build/src/composition/cad-execution.js",
  },
  {
    publicPath: "src/cam.js",
    target: "./dist/core/application/modeling/cam.js",
    emittedPath: "packages/core/dist/application/modeling/cam.js",
  },
  {
    publicPath: "src/catalog/brep-baseline-internal.js",
    target: "../dist/core/application/modeling/brep-baseline-internal",
    emittedPath:
      "packages/core/dist/application/modeling/brep-baseline-internal.js",
  },
  {
    publicPath: "src/catalog/brep-baseline.js",
    target: "../dist/core/application/modeling/brep-baseline-policy",
    emittedPath:
      "packages/core/dist/application/modeling/brep-baseline-policy.js",
  },
  {
    publicPath: "src/catalog/execute.js",
    target: "../dist/composition/catalog-execution",
    emittedPath: "dist/library-build/src/composition/catalog-execution.js",
  },
  {
    publicPath: "src/catalog/index.js",
    target: "../dist/composition/library-catalog-registry",
    emittedPath:
      "dist/library-build/src/composition/library-catalog-registry.js",
  },
  {
    publicPath: "src/catalog/native-drive.js",
    target: "../dist/core/application/modeling/native-drive-policy",
    emittedPath:
      "packages/core/dist/application/modeling/native-drive-policy.js",
  },
  {
    publicPath: "src/catalog/regional-geometry.js",
    target: "../dist/core/application/modeling/regional-geometry-policy",
    emittedPath:
      "packages/core/dist/application/modeling/regional-geometry-policy.js",
  },
  {
    publicPath: "src/catalog/section-witness.js",
    target: "../dist/core/application/modeling/section-witness-policy",
    emittedPath:
      "packages/core/dist/application/modeling/section-witness-policy.js",
  },
  {
    publicPath: "src/catalog/selection-rules-internal.js",
    target: "../dist/core/application/modeling/selection-rules-internal",
    emittedPath:
      "packages/core/dist/application/modeling/selection-rules-internal.js",
  },
  {
    publicPath: "src/catalog/selection-rules.js",
    target: "../dist/core/application/modeling/selection-rules-policy",
    emittedPath:
      "packages/core/dist/application/modeling/selection-rules-policy.js",
  },
  {
    publicPath: "src/catalog/semantic-model-state.js",
    target: "../dist/core/application/modeling/semantic-model-state-policy",
    emittedPath:
      "packages/core/dist/application/modeling/semantic-model-state-policy.js",
  },
  {
    publicPath: "src/cli.js",
    target: "./dist/entrypoints/cli",
    emittedPath: "dist/library-build/src/entrypoints/cli.js",
  },
  {
    publicPath: "src/client.js",
    target: "./dist/composition/library-client.js",
    emittedPath: "dist/library-build/src/composition/library-client.js",
  },
  {
    publicPath: "src/commands.js",
    target: "./dist/composition/library-commands",
    emittedPath: "dist/library-build/src/composition/library-commands.js",
  },
  {
    publicPath: "src/composition/execution-request.js",
    target: "../dist/composition/execution-request",
    emittedPath: "dist/library-build/src/composition/execution-request.js",
  },
  {
    publicPath: "src/composition/execution-worker.js",
    target: "../dist/composition/execution-worker.js",
    emittedPath: "dist/library-build/src/composition/execution-worker.js",
  },
  {
    publicPath: "src/composition/stage-dependencies.js",
    target: "../dist/composition/stage-dependencies",
    emittedPath: "dist/library-build/src/composition/stage-dependencies.js",
  },
  {
    publicPath: "src/console-data.js",
    target: "./dist/composition/library-console-data",
    emittedPath: "dist/library-build/src/composition/library-console-data.js",
  },
  {
    publicPath: "src/console-labels.js",
    target: "./dist/composition/library-console-labels",
    emittedPath: "dist/library-build/src/composition/library-console-labels.js",
  },
  {
    publicPath: "src/console-locks.js",
    target: "./dist/node-adapters/control-center/locks",
    emittedPath: "packages/node-adapters/dist/control-center/locks.js",
  },
  {
    publicPath: "src/console-project.js",
    target: "./dist/composition/library-console-project",
    emittedPath:
      "dist/library-build/src/composition/library-console-project.js",
  },
  {
    publicPath: "src/console-services.js",
    target: "./dist/composition/library-console-services",
    emittedPath:
      "dist/library-build/src/composition/library-console-services.js",
  },
  {
    publicPath: "src/console-source.js",
    target: "./dist/composition/library-console-source",
    emittedPath: "dist/library-build/src/composition/library-console-source.js",
  },
  {
    publicPath: "src/console-system-data.js",
    target: "./dist/node-adapters/console/system-data",
    emittedPath: "packages/node-adapters/dist/console/system-data.js",
  },
  {
    publicPath: "src/console.js",
    target: "./dist/composition/library-console",
    emittedPath: "dist/library-build/src/composition/library-console.js",
  },
  {
    publicPath: "src/datum.js",
    target: "./dist/core/application/modeling/datum.js",
    emittedPath: "packages/core/dist/application/modeling/datum.js",
  },
  {
    publicPath: "src/document-publication.js",
    target: "./dist/composition/document-publication",
    emittedPath: "dist/library-build/src/composition/document-publication.js",
  },
  {
    publicPath: "src/document-stages.js",
    target: "./dist/composition/document-stages.js",
    emittedPath: "dist/library-build/src/composition/document-stages.js",
  },
  {
    publicPath: "src/engineering-common.js",
    target: "./dist/core/domain/engineering/common",
    emittedPath: "packages/core/dist/domain/engineering/common.js",
  },
  {
    publicPath: "src/engineering-fit.js",
    target: "./dist/core/domain/engineering/fit",
    emittedPath: "packages/core/dist/domain/engineering/fit.js",
  },
  {
    publicPath: "src/engineering-fluid.js",
    target: "./dist/core/domain/engineering/fluid",
    emittedPath: "packages/core/dist/domain/engineering/fluid.js",
  },
  {
    publicPath: "src/engineering-hydraulic.js",
    target: "./dist/core/domain/engineering/hydraulic",
    emittedPath: "packages/core/dist/domain/engineering/hydraulic.js",
  },
  {
    publicPath: "src/engineering-local.js",
    target: "./dist/composition/library-engineering-local-registration",
    emittedPath:
      "dist/library-build/src/composition/library-engineering-local-registration.js",
  },
  {
    publicPath: "src/engineering-mass.js",
    target: "./dist/core/domain/engineering/mass",
    emittedPath: "packages/core/dist/domain/engineering/mass.js",
  },
  {
    publicPath: "src/engineering-thermal.js",
    target: "./dist/core/domain/engineering/thermal",
    emittedPath: "packages/core/dist/domain/engineering/thermal.js",
  },
  {
    publicPath: "src/entity-query.js",
    target: "./dist/core/application/modeling/entity-query.js",
    emittedPath: "packages/core/dist/application/modeling/entity-query.js",
  },
  {
    publicPath: "src/fastener.js",
    target: "./dist/core/application/modeling/fastener.js",
    emittedPath: "packages/core/dist/application/modeling/fastener.js",
  },
  {
    publicPath: "src/feature-rework.js",
    target: "./dist/core/application/modeling/feature-rework.js",
    emittedPath: "packages/core/dist/application/modeling/feature-rework.js",
  },
  {
    publicPath: "src/help-details.js",
    target: "./dist/composition/library-help-details",
    emittedPath: "dist/library-build/src/composition/library-help-details.js",
  },
  {
    publicPath: "src/help-format.js",
    target: "./dist/composition/library-help-format",
    emittedPath: "dist/library-build/src/composition/library-help-format.js",
  },
  {
    publicPath: "src/help-guide.js",
    target: "./dist/composition/library-help-guide",
    emittedPath: "dist/library-build/src/composition/library-help-guide.js",
  },
  {
    publicPath: "src/help-manual.js",
    target: "./dist/composition/library-help-manual",
    emittedPath: "dist/library-build/src/composition/library-help-manual.js",
  },
  {
    publicPath: "src/help-pl.js",
    target: "./dist/composition/library-help-pl",
    emittedPath: "dist/library-build/src/composition/library-help-pl.js",
  },
  {
    publicPath: "src/help.js",
    target: "./dist/composition/library-help",
    emittedPath: "dist/library-build/src/composition/library-help.js",
  },
  {
    publicPath: "src/i18n.js",
    target: "./dist/composition/library-i18n",
    emittedPath: "dist/library-build/src/composition/library-i18n.js",
  },
  {
    publicPath: "src/image-boundaries.js",
    target: "./dist/composition/library-image-boundaries-registration",
    emittedPath:
      "dist/library-build/src/composition/library-image-boundaries-registration.js",
  },
  {
    publicPath: "src/image-optimize.js",
    target: "./dist/composition/library-image-optimize-registration",
    emittedPath:
      "dist/library-build/src/composition/library-image-optimize-registration.js",
  },
  {
    publicPath: "src/image-trace.js",
    target: "./dist/composition/library-image-trace-registration",
    emittedPath:
      "dist/library-build/src/composition/library-image-trace-registration.js",
  },
  {
    publicPath: "src/invocation.js",
    target: "./dist/node-adapters/execution/invocation",
    emittedPath: "packages/node-adapters/dist/execution/invocation.js",
  },
  {
    publicPath: "src/legacy-manual.js",
    target: "./dist/composition/library-legacy-manual",
    emittedPath: "dist/library-build/src/composition/library-legacy-manual.js",
  },
  {
    publicPath: "src/mcp-stdio-compat.js",
    target: "./dist/composition/library-mcp-compat",
    emittedPath: "dist/library-build/src/composition/library-mcp-compat.js",
  },
  {
    publicPath: "src/ops.js",
    target: "./dist/python/legacy-operations",
    emittedPath: "packages/node-adapters/dist/python/legacy-operations.js",
  },
  {
    publicPath: "src/outcome.js",
    target: "./dist/core",
    emittedPath: "packages/core/dist/index.js",
  },
  {
    publicPath: "src/pause-budget.js",
    target: "./dist/node-adapters/execution/pause-budget.js",
    emittedPath: "packages/node-adapters/dist/execution/pause-budget.js",
  },
  {
    publicPath: "src/publish.js",
    target: "./dist/node-adapters/persistence/publish",
    emittedPath: "packages/node-adapters/dist/persistence/publish.js",
  },
  {
    publicPath: "src/queue-gate.js",
    target: "./dist/node-adapters/execution/gate",
    emittedPath: "packages/node-adapters/dist/execution/gate.js",
  },
  {
    publicPath: "src/queue-response-files.js",
    target: "./dist/node-adapters/persistence/owned-results",
    emittedPath: "packages/node-adapters/dist/persistence/owned-results.js",
  },
  {
    publicPath: "src/queue-saved-audit-path.js",
    target: "./dist/node-adapters/persistence/saved-audit-path",
    emittedPath: "packages/node-adapters/dist/persistence/saved-audit-path.js",
  },
  {
    publicPath: "src/reference.js",
    target: "./dist/composition/library-reference-registration",
    emittedPath:
      "dist/library-build/src/composition/library-reference-registration.js",
  },
  {
    publicPath: "src/request-timeout.js",
    target: "./dist/node-adapters/execution/request-timeout.js",
    emittedPath: "packages/node-adapters/dist/execution/request-timeout.js",
  },
  {
    publicPath: "src/review.js",
    target: "./dist/composition/library-review-registration",
    emittedPath:
      "dist/library-build/src/composition/library-review-registration.js",
  },
  {
    publicPath: "src/run.js",
    target: "./dist/composition/run",
    emittedPath: "dist/library-build/src/composition/run.js",
  },
  {
    publicPath: "src/seal.js",
    target: "./dist/core/application/modeling/seal.js",
    emittedPath: "packages/core/dist/application/modeling/seal.js",
  },
  {
    publicPath: "src/shot.js",
    target: "./dist/composition/library-shot",
    emittedPath: "dist/library-build/src/composition/library-shot.js",
  },
  {
    publicPath: "src/sketch.js",
    target: "./dist/core/application/modeling/sketch.js",
    emittedPath: "packages/core/dist/application/modeling/sketch.js",
  },
  {
    publicPath: "src/spring.js",
    target: "./dist/core/application/modeling/spring.js",
    emittedPath: "packages/core/dist/application/modeling/spring.js",
  },
  {
    publicPath: "src/surface.js",
    target: "./dist/core/application/modeling/surface.js",
    emittedPath: "packages/core/dist/application/modeling/surface.js",
  },
  {
    publicPath: "src/thread.js",
    target: "./dist/core/application/modeling/thread.js",
    emittedPath: "packages/core/dist/application/modeling/thread.js",
  },
  {
    publicPath: "src/ui.js",
    target: "./dist/composition/library-ui-command",
    emittedPath: "dist/library-build/src/composition/library-ui-command.js",
  },
] as const;
