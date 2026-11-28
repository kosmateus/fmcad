/** One camera continuation. Source selection considers only the observed attribute bytes. */
const core = "assets/cad/core.py";
const values = "runtime/python/fmcad/domain/values.py";
const entity = "runtime/python/fmcad/adapters/fusion/entity.py";
const alias = "runtime/python/fmcad/adapters/fusion/camera_alias.py";
const fusion = "runtime/python/fmcad/adapters/fusion/values.py";
type Data = Record<string, unknown>;
const record = (v: unknown): v is Data =>
  v != null && typeof v === "object" && !Array.isArray(v);
const only = (v: Data, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const reservedRoot = (v: unknown) =>
  v === "root" ||
  (record(v) &&
    v["name"] === "root" &&
    only(v, ["name", "kind"]) &&
    (v["kind"] === undefined || v["kind"] === "component"));

function parseShape(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Python's json.loads accepts these three additional numeric literals.
    // They are truthy numbers for routing; Fusion still decodes the original.
    try {
      return JSON.parse(
        raw.replace(/"(?:\\.|[^"\\])*"|-?Infinity|NaN/g, (s) =>
          s.startsWith('"') ? s : "1",
        ),
      );
    } catch {
      return null;
    }
  }
}

/** Inspect reference slots (not arbitrary metadata or token display names). */
function queries(ref: unknown, result: Data[]): void {
  if (!record(ref)) return;
  if ("query" in ref) {
    const q = record(ref["query"]) ? ref["query"] : {};
    result.push(q);
    const scope = record(q["scope"]) ? q["scope"] : q;
    for (const k of ["component", "occurrence", "body", "feature"])
      queries(scope[k], result);
    if (record(q["frame"]))
      for (const k of ["component", "occurrence", "sketch"])
        queries(q["frame"][k], result);
    if (
      record(q["filters"]) &&
      record(q["filters"]["adjacency"]) &&
      Array.isArray(q["filters"]["adjacency"]["refs"])
    )
      for (const item of q["filters"]["adjacency"]["refs"])
        queries(item, result);
  } else {
    queries(ref["component"], result);
    queries(ref["occurrence"], result);
    if (ref["kind"] === "profile" || ref["kind"] == null)
      queries(ref["sketch"], result);
  }
}

function callback(ref: unknown, query: boolean): string {
  if (!record(ref) && typeof ref !== "string") return "_camera_alias_invalid";
  if (reservedRoot(ref)) return "_camera_alias_root";
  if (typeof ref === "string")
    return ref ? "_camera_alias_name" : "_camera_alias_basic";
  if (query) return "_camera_alias_query";
  if (only(ref, ["name"]) && typeof ref["name"] === "string" && ref["name"])
    return "_camera_alias_name";
  if (
    (ref["kind"] === "component" || ref["kind"] === "occurrence") &&
    typeof ref["name"] === "string" &&
    ref["name"] &&
    only(ref, ["name", "kind", "component"]) &&
    (ref["component"] == null || reservedRoot(ref["component"]))
  )
    return "_camera_alias_typed_name";
  if (typeof ref["token"] === "string" && ref["token"]) {
    if (only(ref, ["token", "kind", "name", "path"]))
      return ref["path"] == null
        ? "_camera_alias_token"
        : "_camera_alias_token_path";
    if (
      ref["kind"] === "occurrence" &&
      typeof ref["path"] === "string" &&
      record(ref["component"]) &&
      only(ref, ["token", "kind", "name", "path", "component"]) &&
      (reservedRoot(ref["component"]) ||
        (ref["component"]["kind"] === "component" &&
          typeof ref["component"]["token"] === "string" &&
          ref["component"]["token"] &&
          only(ref["component"], ["token", "name", "kind"])))
    )
      return "_camera_alias_occurrence_ref";
  }
  return "_camera_alias_basic";
}

interface Source {
  readonly filename: string;
  readonly symbol: string;
  readonly id: string;
  readonly guard?: string;
  readonly importName?: string;
}

// Direct global dependencies, not whole source files. Context method calls
// recurse through the private, per-invocation context rather than module imports.
const needs: Readonly<Record<string, string>> = {
  _camera_alias_name:
    "json _cad_cast _camera_component_candidates _camera_alias_target _camera_add_alias_match _cad_unique",
  _camera_alias_typed_name:
    "json _cad_cast _CAD_ORIGINS _cad_items _CAD_ALIAS_GROUP _camera_alias_target _cad_kind _cad_unique",
  _camera_alias_target: "_cad_cast _CameraAliasRequired",
  _camera_alias_token: "json _cad_cast _cad_kind _cad_unique",
  _camera_alias_token_path: "json _cad_cast _cad_kind _cad_items _cad_unique",
  _camera_alias_occurrence_ref:
    "json _cad_cast _cad_kind _cad_items _cad_owner _cad_unique",
  _camera_alias_invalid: "json",
  _camera_alias_basic: "json _cad_cast _camera_alias_resolve_value",
  _camera_alias_query:
    "json _cad_cast _camera_alias_resolve_value _entity_resolve_reference",
  _camera_alias_resolve_value:
    "_cad_cast _CAD_ORIGINS _camera_alias_complex_name",
  _camera_alias_complex_name:
    "_cad_cast _CAD_ALIAS_GROUP _cad_kind _cad_owner _cad_unique _camera_alias_target _cad_context_entities _cad_context_proxy",
  _cad_direction: "direction",
  direction: "_value_math cast",
  _cad_json: "fusion_json",
  fusion_json: "json_value cast",
  json_value: "_value_math _value_enum cast",
  _cad_geometry: "_cad_cast _cad_direction _cad_type _cad_xyz",
  _cad_parameter_info: "_CAD_PARAM_GROUP _cad_cast json",
  _cad_context_entities: "_cad_cast",
  _cad_context_proxy: "_cad_cast",
  _cad_context_scope: "_cad_cast",
  _entity_attribute_filters: "_cad_cast _cad_fields _entity_json_object",
  _entity_attribute_occurrence_context: "_entity_json_object",
  _entity_attribute_owner: "_cad_cast _cad_type",
  _entity_attribute_reasons: "_cad_cast _entity_attribute_owner",
  _entity_bounds: "_entity_json_object _entity_vector",
  _entity_candidates:
    "_cad_cast _cad_context_entities _cad_context_proxy _cad_context_scope _cad_fields _cad_items _cad_kind _cad_owner _entity_json_object adsk",
  _entity_describe:
    "_cad_cast _cad_context_proxy _cad_direction _cad_fields _cad_json _cad_kind _cad_owner _cad_type _cad_xyz _entity_bounds _entity_frame _entity_geometry _entity_json_object _entity_vector _entity_xyz adsk",
  _entity_filters:
    "_ENTITY_TYPES _cad_cast _cad_direction _cad_fields _cad_xyz _entity_attribute_filters _entity_interval _entity_json_object math",
  _entity_frame:
    "_ENTITY_IDENTITY _cad_cast _entity_frame_target _entity_inverse _entity_multiply _entity_owner_matrix",
  _entity_frame_target:
    "_CAD_FRAME_GROUP _ENTITY_IDENTITY _cad_cast _cad_context_scope _cad_fields _cad_owner _entity_json_object _entity_matrix _entity_sketch_model_point json",
  _entity_geometry: "_cad_cast _entity_json_object _entity_vector math",
  _entity_interval: "_cad_fields _entity_json_object",
  _entity_inverse: "_ENTITY_IDENTITY _cad_cast",
  _entity_json_object: "_cad_cast",
  _entity_matrix: "_cad_cast math",
  _entity_neighbors: "_cad_cast _cad_items _cad_kind adsk",
  _entity_occurrence_matrix:
    "_ENTITY_IDENTITY _cad_items _cad_unique _entity_matrix",
  _entity_owner_matrix:
    "_ENTITY_IDENTITY _cad_cast _cad_items _cad_unique _entity_occurrence_matrix",
  _entity_quantity: "_cad_fields _entity_json_object math",
  _entity_query:
    "_CAD_KINDS _ENTITY_QUERY_FIELDS _cad_cast _cad_direction _cad_fields _entity_attribute_occurrence_context _entity_attribute_predicates _entity_bounds _entity_candidates _entity_describe _entity_filters _entity_frame_target _entity_geometry _entity_in _entity_interval _entity_json_object _entity_reasons _entity_stats adsk json",
  _entity_reasons:
    "_ENTITY_TYPES _cad_cast _cad_context_proxy _cad_direction _entity_attribute_reasons _entity_bounds _entity_describe _entity_geometry _entity_in _entity_neighbors _entity_quantity math",
  _entity_resolve_reference:
    "_cad_cast _cad_fields _cad_unique _entity_json_object _entity_query json",
  _entity_sketch_model_point: "_cad_xyz adsk",
  _entity_stats: "_entity_geometry _entity_quantity",
  _entity_vector: "math",
};

export function planCameraAlias(
  raw: string,
  observed: readonly { name: string; raw: string }[] = [],
) {
  const queryShapes: Data[] = [];
  const callbacks = new Set<string>();
  function route(text: string) {
    const shape = parseShape(text),
      found: Data[] = [];
    queries(shape, found);
    queryShapes.push(...found);
    const symbol = callback(shape, found.length > 0);
    callbacks.add(symbol);
    return symbol;
  }
  const resolverSymbol = route(raw);
  const seen = new Set<string>();
  const aliasBindings = observed.map(({ name, raw: text }) => {
    if (seen.has(name)) throw new Error("Duplicate camera alias observation");
    seen.add(name);
    return { name, raw: text, resolverSymbol: route(text) };
  });
  const query = callbacks.has("_camera_alias_query");
  const basic = callbacks.has("_camera_alias_basic") || query;
  const names =
    callbacks.has("_camera_alias_name") ||
    callbacks.has("_camera_alias_typed_name") ||
    basic;
  const references: Source[] = [],
    typingReferences: Source[] = [];
  const definitions: {
    symbol: string;
    sourceId: string;
    dependencies: { symbol: string }[];
  }[] = [];
  function source(
    filename: string,
    symbol: string,
    options: { onlyType?: boolean; importName?: string; guard?: string } = {},
  ) {
    const { onlyType, ...ref } = options;
    const id = `camera.alias.${symbol}`;
    (onlyType ? typingReferences : references).push({
      id,
      filename,
      symbol,
      ...ref,
    });
    if (!onlyType) {
      definitions.push({ symbol, sourceId: id, dependencies: [] });
    }
  }
  for (const symbol of callbacks) source(alias, symbol);
  if (names) {
    source(alias, "_CameraAliasRequired");
    source(alias, "_camera_alias_target");
  }
  if ([...callbacks].some((s) => s !== "_camera_alias_root"))
    source(core, "json", { importName: "json" });
  const contextMembers: string[] = [];
  if (basic) {
    source(alias, "_camera_alias_resolve_value");
    source(alias, "_camera_alias_complex_name");
    source(entity, "_cad_context_entities");
    source(entity, "_cad_context_proxy");
    for (const s of ["_entities", "_proxy", "_cad_resolve_basic_reference"])
      contextMembers.push(s);
    source(core, "_cad_overload", {
      importName: "typing.overload",
      onlyType: true,
    });
    source(core, "_CadBasicReferenceResolver", {
      onlyType: true,
      guard: "TYPE_CHECKING",
    });
    source(core, "_cad_require_result");
  }
  if (query) {
    contextMembers.push(
      "_scope",
      "resolve",
      "ref",
      "describe",
      "_expression",
      "length",
      "angle",
      "point",
    );
    source(core, "math", { importName: "math" });
    source(core, "re", { importName: "re" });
    source(values, "Iterable", {
      importName: "collections.abc.Iterable",
      onlyType: true,
    });
    for (const symbol of [
      "_CAD_PARAM_GROUP",
      "_CAD_UNITLESS",
      "_cad_geometry",
      "_cad_parameter_info",
    ])
      source(core, symbol);
    source(values, "_cad_fields");
    source(values, "_value_math", { importName: "math" });
    source(values, "_value_enum", { importName: "enum" });
    source(values, "cast", { importName: "typing.cast" });
    source(values, "direction");
    source(values, "json_value");
    source(fusion, "fusion_json");
    source(alias, "_cad_direction");
    source(alias, "_cad_json");
    source(entity, "_EntityNotRequired", {
      onlyType: true,
      importName: "typing.NotRequired",
      guard: "_CAD_TYPE_CHECKING",
    });
    for (const s of [
      "_EntityBox",
      "_EntityQuantity",
      "_EntityGeometry",
      "_EntityAttributePredicate",
      "_EntityLevel",
      "_EntityAdjacency",
      "_EntityNormalizedFilters",
    ])
      source(entity, s, { onlyType: true, guard: "_CAD_TYPE_CHECKING" });
    // These helpers are the canonical resolver's query path, excluding public
    // entity operation handlers. Branch-specific functions below are checked
    // offline but erased from the wire unless a known query can call them.
    for (const s of [
      "_ENTITY_QUERY_FIELDS",
      "_ENTITY_IDENTITY",
      "_entity_resolve_reference",
      "_entity_query",
      "_entity_interval",
      "_entity_filters",
      "_entity_attribute_occurrence_context",
      "_entity_attribute_predicates",
      "_entity_in",
      "_entity_candidates",
      "_entity_describe",
      "_entity_reasons",
      "_entity_stats",
      "_entity_json_object",
      "_entity_bounds",
      "_entity_vector",
      "_entity_geometry",
      "_entity_quantity",
      "_entity_frame",
      "_entity_xyz",
      "_cad_context_scope",
    ])
      source(entity, s);
    const filters = queryShapes.flatMap((q) => {
      const f = record(q["filters"]) ? q["filters"] : {};
      return [
        f,
        record(f["adjacency"]) && record(f["adjacency"]["filters"])
          ? f["adjacency"]["filters"]
          : {},
      ];
    });
    const has = (field: string) => filters.some((f) => field in f);
    const descriptor = queryShapes.some(
      (q) =>
        ![undefined, "component", "root", "context"].includes(
          q["frame"] as string | undefined,
        ),
    );
    const rootFrame = queryShapes.some((q) => q["frame"] !== "component");
    const sketch = queryShapes.some(
      (q) => record(q["frame"]) && "sketch" in q["frame"],
    );
    for (const [symbol, needed] of [
      ["_entity_attribute_filters", has("attributes")],
      ["_entity_attribute_reasons", has("attributes")],
      ["_entity_attribute_owner", has("attributes")],
      ["_entity_neighbors", has("adjacency")],
      ["_ENTITY_TYPES", has("geometry")],
      ["_entity_sketch_model_point", sketch],
      ["_entity_frame_target", descriptor],
      ["_entity_inverse", descriptor],
      ["_entity_multiply", descriptor],
      ["_entity_matrix", rootFrame],
      ["_entity_owner_matrix", rootFrame],
      ["_entity_occurrence_matrix", rootFrame],
    ] as const)
      source(entity, symbol, { onlyType: !needed });
    source(core, "_CAD_FRAME_GROUP", {
      onlyType: !queryShapes.some(
        (q) => record(q["frame"]) && "datum" in q["frame"],
      ),
    });
  }
  const erased = new Set(typingReferences.map((r) => r.symbol));
  const required = new Set<string>();
  for (const entry of definitions) {
    for (const dependency of needs[entry.symbol]?.split(" ") ?? []) {
      if (!erased.has(dependency)) {
        entry.dependencies.push({ symbol: dependency });
        required.add(dependency);
      }
    }
  }
  // Remaining roots are callable entrypoints and dependencies accessed by
  // selected canonical context methods.
  const roots = definitions
    .map((d) => d.symbol)
    .filter((s) => !required.has(s));
  return {
    resolverSymbol,
    aliasBindings,
    contextMembers,
    definitions,
    roots,
    references,
    typingReferences,
    conditions: {},
  };
}
