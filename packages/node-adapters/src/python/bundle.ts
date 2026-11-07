import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { preparePythonArtifact } from "./artifact.js";
import { assemblyBundleManifest } from "./assembly-manifest.js";
import { withGeometryModules } from "./geometry-manifest.js";
import { documentIoCadManifest } from "./document-io-manifest.js";
import { withBrepBaselineModules } from "./brep-baseline-manifest.js";
import { withRegionalGeometryModules } from "./regional-geometry-manifest.js";
import { withSectionWitnessModules } from "./section-witness-manifest.js";
import { withSelectionRules } from "./selection-rules-manifest.js";
import { withSemanticModelState } from "./semantic-model-state-manifest.js";
import { withMeasuredFasteners } from "./measured-fasteners-manifest.js";
import { withNativeDrive } from "./native-drive-manifest.js";
import { withSketchGeometryProofModules } from "./sketch-geometry-proof-manifest.js";
import type { SourceInput } from "./artifact.js";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact.js";

export interface BundleModule {
  readonly id: string;
  readonly path: string;
  readonly dependencies: readonly string[];
  readonly compatibilityPath?: string;
  readonly owner?: string;
}

// Explicit inventory, not a directory-order loader. Cross-module references in
// function bodies share the retained cad-v1 namespace; these dependencies encode
// initialization/registration order, including deliberate legacy transfers.
const families = [
  "animation",
  "animation2",
  "appearance",
  "assembly",
  "atomic",
  "attributes",
  "cam",
  "checking",
  "containment",
  "curve",
  "data_import",
  "datum",
  "definitions",
  "dfm",
  "document",
  "document_snapshot",
  "entity",
  "explode",
  "externalization",
  "fastener",
  "feature",
  "fpc_pcb",
  "gear",
  "helpers",
  "identity",
  "interference",
  "io",
  "marking",
  "measure",
  "mechanism",
  "model",
  "optics",
  "pose",
  "presentation",
  "reference",
  "references",
  "route3d",
  "seal",
  "sequence",
  "shapes",
  "sheetmetal",
  "simulation",
  "sketch",
  "sketch_plan",
  "spring",
  "surface",
  "texture",
  "thread",
] as const;
const initialization: Readonly<Record<string, readonly string[]>> = {
  sketch: ["model"],
};
export function pythonStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const cadBundleBaseManifest: readonly BundleModule[] =
  withSketchGeometryProofModules(
    withRegionalGeometryModules(
      withBrepBaselineModules(
        documentIoCadManifest(
        withGeometryModules([
          {
            id: "values",
            path: "runtime/python/fmcad/domain/values.py",
            dependencies: [],
          },
          {
            id: "fusion-values",
            path: "runtime/python/fmcad/adapters/fusion/values.py",
            dependencies: ["values"],
          },
          {
            id: "core",
            path: "assets/cad/core.py",
            dependencies: ["values", "fusion-values"],
          },
          {
            id: "inspection-domain",
            path: "runtime/python/fmcad/domain/inspection.py",
            dependencies: [],
          },
          {
            id: "inspection",
            path: "runtime/python/fmcad/adapters/fusion/inspection.py",
            dependencies: ["core", "inspection-domain"],
            owner: "inspection",
          },
          ...families.flatMap((id) => {
            const migrated = assemblyBundleManifest.filter(
              (unit) => unit.id === id || unit.id.startsWith(`${id}-`),
            );
            return migrated.length
              ? migrated
              : [
                  {
                    id,
                    path: `assets/cad/${id}.py`,
                    dependencies: ["core", ...(initialization[id] ?? [])],
                  },
                ];
          }),
        ]),
        ),
      ),
    ),
  );

export const cadBundleManifest: readonly BundleModule[] = Object.freeze(
  withMeasuredFasteners(
    withNativeDrive(
      withSemanticModelState(
        withSelectionRules(
          withSectionWitnessModules(cadBundleBaseManifest),
        ),
      ),
    ),
  ).flatMap((item) => item.id === "atomic" ? [item, {
    id: "atomic-status",
    path: "runtime/python/fmcad/adapters/fusion/atomic_status.py",
    dependencies: [],
  }, {
    id: "atomic-status-dispatch",
    path: "runtime/python/fmcad/adapters/fusion/atomic_status_dispatch.py",
    dependencies: ["atomic", "atomic-status"],
  }] : [item]).map((item) =>
    Object.freeze({ ...item, dependencies: Object.freeze(item.dependencies) }),
  ),
);

export function orderBundle(
  manifest: readonly BundleModule[],
  roots: readonly string[],
): readonly BundleModule[] {
  const modules = new Map<string, BundleModule>();
  const paths = new Set<string>();
  for (const item of manifest) {
    if (
      !item.id ||
      modules.has(item.id) ||
      paths.has(item.path) ||
      !/^(assets\/cad|runtime\/python)\/[\w/.-]+\.py$/.test(item.path) ||
      item.path.includes("..") ||
      (item.compatibilityPath !== undefined &&
        !/^assets\/cad\/[\w-]+\.py$/.test(item.compatibilityPath)) ||
      (item.owner !== undefined && !/^[\w-]+$/.test(item.owner))
    ) {
      throw new Error("Invalid or duplicate Python bundle module: " + item.id);
    }
    modules.set(item.id, item);
    paths.add(item.path);
  }
  const ordered: BundleModule[] = [];
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    const item = modules.get(id);
    if (!item) throw new Error("Incomplete Python bundle manifest: " + id);
    if (active.has(id))
      throw new Error("Cyclic Python bundle dependency: " + id);
    if (done.has(id)) return;
    active.add(id);
    item.dependencies.forEach(visit);
    active.delete(id);
    done.add(id);
    ordered.push(item);
  };
  // Validate even unused modules so a broken manifest fails before SDK admission.
  for (const item of manifest) visit(item.id);
  done.clear();
  ordered.length = 0;
  roots.forEach(visit);
  return ordered;
}

function preparedCore(
  source: string,
  profile: "full" | "document-status",
): string {
  // Retained standalone assets support old offline fixtures. Actual bundles use
  // the extracted implementations, never a second copy/executor.
  for (const [name, replacement] of [
    ["_cad_json", "fusion_json"],
    ["_cad_fields", "fields"],
    ["_cad_direction", "direction"],
  ]) {
    const pattern = new RegExp(
      `^def ${name}\\([^]*?(?=^def |^class |^@|$(?![^]))`,
      "m",
    );
    if (!pattern.test(source))
      throw new Error("Missing Python compatibility function: " + name);
    source = source.replace(pattern, `${name} = ${replacement}\n\n\n`);
  }
  if (!source.includes("CAD_HANDLERS = {}"))
    throw new Error("Missing Python registry boundary");
  source = source.replace(
    "CAD_HANDLERS = {}",
    "CAD_HANDLERS = HandlerRegistry([('shapes', 'spring', 'shape.helix'), ('model', 'thread', 'model.thread')])\nCAD_HANDLERS.owner = 'core'",
  );
  if (profile === "document-status") {
    const attributeReads: readonly (readonly [string, string])[] = [
      [
        "alias = _cad_cast('adsk.core.Attribute | None', self.root.attributes.itemByName(_CAD_ALIAS_GROUP, name))",
        'alias = _cad_cast("_CadAttributes", self.root.attributes).itemByName(_CAD_ALIAS_GROUP, name)',
      ],
      [
        "old = _cad_cast('adsk.core.Attribute | None', ctx.root.attributes.itemByName(_CAD_ALIAS_GROUP, alias))",
        'old = _cad_cast("_CadAttributes", ctx.root.attributes).itemByName(_CAD_ALIAS_GROUP, alias)',
      ],
    ];
    for (const [original, typed] of attributeReads) {
      if (source.split(original).length !== 2)
        throw new Error("Missing light-profile attribute contract boundary");
      source = source.replace(original, typed);
    }
    source += `

if _CAD_TYPE_CHECKING:
    def _entity_resolve_reference(ctx: "CadContext", ref: "JsonObject",
                                  kind: str | None = None) -> "adsk.core.Base": ...

    def _entity_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonRecord": ...

    def _entity_find(ctx: "CadContext", data: "JsonObject") -> "JsonRecord": ...

    def _datum_frame(ctx: "CadContext", data: "JsonObject") -> "JsonObject": ...

    def _datum_existing(ctx: "CadContext", data: "JsonObject",
                        mode: str) -> "JsonObject": ...
`;
  }
  return source;
}

// Cache only immutable transformed source units. Every call still validates the
// complete inventory/graph and reads + hashes current sources and build bytes.
// Artifact/context hashing and checker/admission remain downstream, unchanged.
const unitCache = new Map<string, readonly SourceInput[]>();
function sourceHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function loaderLayers(source: string, variable: string): readonly string[] {
  const match = source.match(
    new RegExp(`for ${variable} in \\(([^)]*)\\):`),
  );
  if (!match?.[1])
    throw new Error("Missing compatibility loader layer list");
  const layers = [...match[1].matchAll(/'([^']+)'/g)].map((item) => {
    if (!item[1]) throw new Error("Invalid compatibility loader layer list");
    return item[1];
  });
  if (!layers.length || new Set(layers).size !== layers.length)
    throw new Error("Invalid compatibility loader layer list");
  return layers;
}

function compatibilityDependencies(
  item: BundleModule,
  manifest: ReadonlyMap<string, BundleModule>,
  prepared: ReadonlyMap<string, SourceInput>,
): ReadonlyMap<string, SourceInput> {
  const ids = new Set<string>();
  const visit = (id: string): void => {
    if (ids.has(id)) return;
    const dependency = manifest.get(id);
    if (!dependency)
      throw new Error("Incomplete compatibility loader dependency: " + id);
    dependency.dependencies.forEach(visit);
    ids.add(id);
  };
  item.dependencies.forEach(visit);
  return new Map(
    [...ids].map((id) => {
      const unit = prepared.get(id);
      if (!unit)
        throw new Error(
          "Compatibility dependency was not prepared before " + item.id + ": " + id,
        );
      return [id, unit];
    }),
  );
}

function compatibilityTemplate(
  family: string,
  runtimeName: string,
  layers: readonly string[],
  geometry: boolean,
): string {
  if (geometry)
    return [
      '"""Offline compatibility facade; bundles initialize explicit geometry units first.',
      "",
      "No handler implementation lives here. Set _FMCAD_GEOMETRY_ROOT when executing",
      "this legacy source outside a checkout; installed Fusion bundles never read files.",
      '"""',
      `if '${family}' not in globals().get('_FMCAD_GEOMETRY_LOADED', ()):`,
      "    from pathlib import Path as _geometry_Path",
      "    _geometry_candidates = [globals().get('_FMCAD_GEOMETRY_ROOT'), globals().get('__file__'), _geometry_Path.cwd()]",
      "    _geometry_root = None",
      "    for _geometry_candidate in _geometry_candidates:",
      "        if _geometry_candidate is None:",
      "            continue",
      "        _geometry_candidate = _geometry_Path(_geometry_candidate).resolve()",
      "        for _geometry_parent in (_geometry_candidate, *_geometry_candidate.parents):",
      `            if (_geometry_parent / 'runtime/python/fmcad/domain/${runtimeName}').is_file():`,
      "                _geometry_root = _geometry_parent",
      "                break",
      "        if _geometry_root is not None:",
      "            break",
      "    if _geometry_root is None:",
      "        raise RuntimeError('Geometry compatibility source requires the runtime checkout or explicit bundled units')",
      `    for _geometry_layer in (${layers.map((layer) => `'${layer}'`).join(", ")}):`,
      `        _geometry_source = _geometry_root / ('runtime/python/fmcad/' + _geometry_layer + '/${runtimeName}')`,
      "        exec(compile(_geometry_source.read_text(encoding='utf8'), str(_geometry_source), 'exec'), globals())",
      "",
    ].join("\n");
  return [
    '"""Compatibility loader for standalone offline fixtures.',
    "",
    "Prepared bundles load the manifest-declared runtime units first; this guard is",
    "then a no-op. There is only one implementation of each handler and helper.",
    '"""',
    `if not globals().get('_fmcad_${family}_runtime_loaded', False):`,
    "    from pathlib import Path as _fmcad_compat_path",
    "    _fmcad_compat_root = _fmcad_compat_path.cwd()",
    `    for _fmcad_compat_layer in (${layers.map((layer) => `'${layer}'`).join(", ")}):`,
    "        _fmcad_compat_file = (_fmcad_compat_root / 'runtime/python/fmcad' /",
    `                              _fmcad_compat_layer / '${runtimeName}')`,
    "        exec(compile(_fmcad_compat_file.read_text(), str(_fmcad_compat_file), 'exec'), globals())",
    "",
  ].join("\n");
}

/**
 * Public assets keep their standalone path-based fallback. The canonical bundle
 * already contains every referenced runtime source as a declared dependency, so
 * prepare a fail-closed marker guard instead of a second dynamic executor.
 */
function preparedCompatibilityLoader(
  item: BundleModule,
  source: string,
  manifest: ReadonlyMap<string, BundleModule>,
  prepared: ReadonlyMap<string, SourceInput>,
): string {
  const hasExec = /\bexec\s*\(/.test(source);
  const hasCompile = /\bcompile\s*\(/.test(source);
  if (!hasExec && !hasCompile) return source;
  if (!hasExec || !hasCompile || item.path !== `assets/cad/${item.id}.py`)
    throw new Error("Unsupported dynamic compatibility source: " + item.path);

  const normalized = source.replace(/\r\n/g, "\n");
  const geometry = normalized.startsWith(
    '"""Offline compatibility facade; bundles initialize explicit geometry units first.',
  );
  const assembly = normalized.startsWith(
    '"""Compatibility loader for standalone offline fixtures.',
  );
  if (geometry === assembly)
    throw new Error("Unknown compatibility loader form: " + item.path);

  const runtimeName = geometry ? `geometry_${item.id}.py` : `${item.id}.py`;
  const variable = geometry ? "_geometry_layer" : "_fmcad_compat_layer";
  const layers = loaderLayers(normalized, variable);
  const dependencies = compatibilityDependencies(item, manifest, prepared);
  const dependencyIds = new Set(dependencies.keys());
  const dependencyFilenames = new Set(
    ["domain", "application", "adapters/fusion"].map(
      (layer) => `runtime/python/fmcad/${layer}/${runtimeName}`,
    ),
  );
  const resolved = [...prepared.values()].filter(
    (unit) =>
      dependencyIds.has(unit.id) && dependencyFilenames.has(unit.filename),
  );
  const manifestLayers = resolved.map((unit) =>
    unit.filename.slice("runtime/python/fmcad/".length, -runtimeName.length - 1),
  );
  if (
    JSON.stringify(layers) !== JSON.stringify(manifestLayers) ||
    !layers.length ||
    layers.length !== new Set(layers).size
  )
    throw new Error("Incomplete compatibility loader sources: " + item.id);

  const expectedSource = compatibilityTemplate(
    item.id,
    runtimeName,
    layers,
    geometry,
  );
  if (normalized !== expectedSource) {
    const actualLines = normalized.split("\n");
    const expectedLines = expectedSource.split("\n");
    const mismatch = actualLines.findIndex(
      (line, index) => line !== expectedLines[index],
    );
    throw new Error(
      `Unrecognized compatibility loader source: ${item.path} (line ${mismatch + 1})`,
    );
  }

  if (geometry) {
    const application = resolved.find((unit) =>
      unit.filename.endsWith(`/application/${runtimeName}`),
    );
    if (
      !application?.source.includes(
        `, '${item.id}'))`,
      ) &&
      !application?.source.includes(
        `_FMCAD_GEOMETRY_LOADED = (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), '${item.id}')`,
      )
    )
      throw new Error(
        `Compatibility geometry marker is not set by its prepared application: ${item.id}`,
      );
  } else {
    const adapter = resolved.find((unit) =>
      unit.filename.endsWith(`/adapters/fusion/${runtimeName}`),
    );
    if (
      !adapter?.source.includes(
        `_fmcad_${item.id}_runtime_loaded = True`,
      )
    )
      throw new Error(
        `Compatibility runtime marker is not set by its prepared adapter: ${item.id}`,
      );
  }

  const dependencyHashes = resolved
    .map(
      (unit) =>
        `${unit.id}:${unit.filename}:${sourceHash(unit.source)}`,
    )
    .join(", ");
  const provenance = `# Prepared compatibility boundary; original-sha256=${sourceHash(source)}\n# Resolved manifest source units: ${dependencyHashes}\n`;
  const guard = geometry
    ? `if '${item.id}' not in globals().get('_FMCAD_GEOMETRY_LOADED', ()):\n    raise RuntimeError('Prepared geometry runtime units are missing: ${item.id}')\n`
    : `if not globals().get('_fmcad_${item.id}_runtime_loaded', False):\n    raise RuntimeError('Prepared runtime units are missing: ${item.id}')\n`;
  return provenance + guard;
}

export function cadBundleUnits(
  root: string,
  profile: "full" | "document-status" = "full",
  manifest: readonly BundleModule[] = cadBundleManifest,
): readonly SourceInput[] {
  const assetRoot = join(root, "assets/cad");
  const inventory = readdirSync(assetRoot)
    .filter((name) => name.endsWith(".py"))
    .sort();
  const declared = manifest
    .map((item) => item.compatibilityPath ?? item.path)
    .filter((path) => path.startsWith("assets/cad/"))
    .map((path) => path.slice("assets/cad/".length))
    .sort();
  if (JSON.stringify(inventory) !== JSON.stringify(declared))
    throw new Error("Incomplete Python bundle inventory");
  const roots =
    profile === "document-status"
      ? ["core", "identity", "document_snapshot"]
      : manifest.map((item) => item.id);
  const ordered = orderBundle(manifest, roots);
  const sources = ordered.map((item) =>
    readFileSync(join(root, item.path), "utf8"),
  );
  const buildPath = join(root, "runtime-build.json");
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        root,
        profile,
        manifest,
        build: existsSync(buildPath) ? readFileSync(buildPath, "utf8") : null,
        sources,
      }),
    )
    .digest("hex");
  const cached = unitCache.get(key);
  if (cached) return cached;
  const modules = new Map(manifest.map((item) => [item.id, item]));
  const prepared = new Map<string, SourceInput>();
  const units = Object.freeze(
    ordered.map((item, index) => {
      let source = sources[index]!;
      // These new runtime units are text checkouts, not bytecode blobs. Use
      // canonical LF in their prepared source so Windows autocrlf does not
      // change unit/wire hashes. The cache key above still binds raw bytes.
      if (item.id === "inspection-domain" || item.id === "inspection")
        source = source.replace(/\r\n?/g, "\n");
      if (item.id === "core") source = preparedCore(source, profile);
      else if (item.path.startsWith("assets/cad/"))
        source = preparedCompatibilityLoader(item, source, modules, prepared);
      if (
        item.id !== "core" &&
        (item.owner || item.path.startsWith("assets/cad/"))
      )
        source =
          `CAD_HANDLERS.owner = ${pythonStringLiteral(item.owner ?? item.id)}\n` +
          source;
      const unit = Object.freeze({
        id: item.id,
        filename: item.path,
        source,
        role: "runtime" as const,
      });
      prepared.set(item.id, unit);
      return unit;
    }),
  );
  if (unitCache.size >= 4) unitCache.delete(unitCache.keys().next().value!);
  unitCache.set(key, units);
  return units;
}

export function prepareCadBundle(
  root: string,
  wrapper: string,
  metadata: { readonly context?: unknown; readonly request?: unknown } = {},
  profile: "full" | "document-status" = "full",
  embedded: readonly SourceInput[] = [],
): PreparedPythonArtifact {
  return preparePythonArtifact(
    [
      ...cadBundleUnits(root, profile),
      ...embedded,
      {
        id: "wrapper",
        filename: "<fmcad-wrapper>",
        source: wrapper,
        role: "wrapper",
      },
    ],
    metadata,
  );
}
