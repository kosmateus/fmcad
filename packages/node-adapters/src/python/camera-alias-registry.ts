/** One camera continuation. Source selection considers only the observed attribute bytes. */
const core = "assets/cad/core.py";
const values = "runtime/python/fmcad/domain/values.py";
const entity = "runtime/python/fmcad/adapters/fusion/entity.py";
const alias = "runtime/python/fmcad/adapters/fusion/camera_alias.py";
const boundRoot =
  "runtime/python/fmcad/adapters/fusion/camera_bound_root_query.py";
const fusion = "runtime/python/fmcad/adapters/fusion/values.py";
const rootScope = "runtime/python/fmcad/adapters/fusion/camera_query_root.py";
const parameterCollection =
  "runtime/python/fmcad/adapters/fusion/camera_query_parameters.py";
const occurrences =
  "runtime/python/fmcad/adapters/fusion/camera_query_occurrences.py";
const instances =
  "runtime/python/fmcad/adapters/fusion/camera_query_instances.py";
const collections =
  "runtime/python/fmcad/adapters/fusion/camera_query_collections.py";
const collectionKinds = [
  "component",
  "parameter",
  "body",
  "sketch",
  "feature",
  "plane",
  "axis",
  "point",
  "face",
  "edge",
  "vertex",
  "profile",
] as const;
type Data = Record<string, unknown>;
const record = (v: unknown): v is Data =>
  v != null && typeof v === "object" && !Array.isArray(v);
const truthy = (v: unknown) =>
  Array.isArray(v)
    ? v.length > 0
    : record(v)
      ? Object.keys(v).length > 0
      : Boolean(v);
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

/** These are the only places the query implementation resolves a reference.
 * An explicit component root is already established by the pinned constructor. */
function fixedQuery(q: Data): boolean {
  const fixedScope = (s: Data) =>
    s["occurrence"] == null &&
    (s["component"] == null || reservedRoot(s["component"]));
  const scope = record(q["scope"]) ? q["scope"] : {};
  const frame = record(q["frame"]) ? q["frame"] : {};
  const filters = record(q["filters"]) ? q["filters"] : {};
  const adjacent = record(filters["adjacency"]) ? filters["adjacency"] : {};
  return (
    fixedScope(q) &&
    fixedScope(scope) &&
    fixedScope(frame) &&
    !("body" in scope || "feature" in scope || "sketch" in frame) &&
    !(Array.isArray(adjacent["refs"]) && adjacent["refs"].length > 0)
  );
}

function fixedCandidateSource(q: Data, kind: unknown): string {
  const scope = q["scope"];
  if (
    q["instances"] === true ||
    ("scope" in q &&
      (!record(scope) ||
        !only(scope, ["component", "occurrence"]) ||
        "component" in q ||
        "occurrence" in q))
  )
    return instances;
  if (kind === "occurrence") return occurrences;
  if (
    kind === "component" &&
    ("component" in q ||
      "occurrence" in q ||
      (record(scope) && ("component" in scope || "occurrence" in scope)))
  )
    return rootScope;
  return collections;
}

const candidateDependencies: Record<string, string> = {
  [rootScope]: "",
  [occurrences]: "_cad_cast _cad_items _cad_dedup",
  [collections]: "_cad_cast _cad_dedup _cad_context_entities",
  [instances]:
    "_cad_cast _cad_fields _cad_items _entity_json_object _cad_context_entities",
};

function callback(ref: unknown, query: boolean): string {
  if (!record(ref) && typeof ref !== "string") return "_camera_alias_invalid";
  if (reservedRoot(ref)) return "_camera_alias_root";
  if (typeof ref === "string")
    return ref ? "_camera_alias_name" : "_camera_alias_basic";
  if (query)
    return record(ref["query"]) && fixedQuery(ref["query"])
      ? "_camera_alias_direct_query"
      : "_camera_alias_query";
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
  readonly members?: readonly string[];
  readonly bindings?: Readonly<Record<string, Readonly<Record<string, null>>>>;
}

// Direct global dependencies, not whole source files. Context method calls
// recurse through the private, per-invocation context rather than module imports.
const needs: Readonly<Record<string, string>> = {
  _camera_bound_root_query: "_camera_default_tolerance math _cad_xyz _cad_cast",
  _camera_default_tolerance: "math",
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
  _camera_alias_direct_query: "json _cad_cast _entity_resolve_reference",
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

// Projected methods are executable roots too. Their globals must never be
// supplied accidentally by a separate outer selector or a sibling callback.
const memberNeeds: Readonly<Record<string, string>> = {
  _cad_resolve_basic_reference:
    "_CAD_ALIAS_GROUP _CAD_ORIGINS _cad_cast _cad_items _cad_kind _cad_owner _cad_unique json",
  _entities: "_CAD_KINDS _cad_cast _cad_items",
  _proxy: "_cad_cast _cad_kind _cad_require_result",
  resolve: "_cad_cast _entity_resolve_reference",
  ref: "_cad_cast _cad_kind _cad_owner",
  describe:
    "_cad_cast _cad_geometry _cad_json _cad_kind _cad_parameter_info _cad_xyz adsk",
  _expression: "_CAD_UNITLESS _cad_cast math re",
  point: "_cad_cast adsk",
};

export function planCameraAlias(
  raw: string,
  observed: readonly { name: string; raw: string }[] = [],
) {
  const queryShapes: Data[] = [];
  const fixedQueries: { q: Data; kind: unknown }[] = [];
  const callbacks = new Set<string>();
  function route(text: string) {
    const shape = parseShape(text),
      found: Data[] = [];
    queries(shape, found);
    queryShapes.push(...found);
    const symbol = callback(shape, found.length > 0);
    if (
      symbol === "_camera_alias_direct_query" &&
      record(shape) &&
      record(shape["query"])
    )
      fixedQueries.push({
        q: shape["query"],
        kind: truthy(shape["kind"])
          ? shape["kind"]
          : "kind" in shape["query"]
            ? shape["query"]["kind"]
            : "face",
      });
    callbacks.add(symbol);
    return symbol;
  }
  // Strip JSON whitespace, never characters inside strings. Do not certify
  // duplicate keys, extra options, or a different literal with similar values.
  const compact = raw.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/g, (token) =>
    token[0] === '"' ? token : "",
  );
  const rootQuery =
    !observed.length &&
    (compact ===
      '{"query":{"kind":"component","scope":{"component":"root"}}}' ||
      compact ===
        '{"query":{"scope":{"component":"root"},"kind":"component"}}');
  const resolverSymbol = rootQuery ? "_camera_bound_root_query" : route(raw);
  if (rootQuery) callbacks.add(resolverSymbol);
  const seen = new Set<string>();
  const aliasBindings = observed.map(({ name, raw: text }) => {
    if (seen.has(name)) throw new Error("Duplicate camera alias observation");
    seen.add(name);
    return { name, raw: text, resolverSymbol: route(text) };
  });
  const guardedQuery = callbacks.has("_camera_alias_query");
  const query = guardedQuery || callbacks.has("_camera_alias_direct_query");
  const basic = callbacks.has("_camera_alias_basic") || guardedQuery;
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
    options: {
      onlyType?: boolean;
      uses?: string | undefined;
      importName?: string;
      guard?: string;
      members?: readonly string[];
      bindings?: NonNullable<Source["bindings"]>;
    } = {},
  ) {
    const { onlyType, uses, ...ref } = options;
    const id = `camera.alias.${symbol}`;
    (onlyType ? typingReferences : references).push({
      id,
      filename,
      symbol,
      ...ref,
    });
    if (!onlyType) {
      const deps = uses ?? needs[symbol];
      definitions.push({
        symbol,
        sourceId: id,
        dependencies: deps ? deps.split(" ").map((symbol) => ({ symbol })) : [],
      });
    }
  }
  for (const symbol of callbacks) source(rootQuery ? boundRoot : alias, symbol);
  if (rootQuery) {
    source(boundRoot, "_camera_default_tolerance");
    source(core, "math", { importName: "math" });
    source(values, "Callable", {
      importName: "collections.abc.Callable",
      onlyType: true,
    });
  }
  if (names) {
    source(alias, "_CameraAliasRequired");
    source(alias, "_camera_alias_target");
  }
  if (!rootQuery && [...callbacks].some((s) => s !== "_camera_alias_root"))
    source(core, "json", { importName: "json" });
  const contextMembers: string[] = [];
  const contextTypingMembers: string[] = [];
  if (basic || query)
    source(core, "_cad_overload", {
      importName: "typing.overload",
      onlyType: true,
    });
  if (basic) {
    source(alias, "_camera_alias_resolve_value");
    source(alias, "_camera_alias_complex_name");
    source(entity, "_cad_context_entities");
    source(entity, "_cad_context_proxy");
    for (const s of ["_entities", "_proxy", "_cad_resolve_basic_reference"])
      contextMembers.push(s);
    source(core, "_CadBasicReferenceResolver", {
      onlyType: true,
      guard: "TYPE_CHECKING",
    });
    source(core, "_cad_require_result");
  }
  if (query) {
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
    // The SDK's Component, Parameter and Occurrence have no geometry
    // property. Adjacency, however, can describe a second entity of another kind.
    const geometry =
      guardedQuery ||
      has("adjacency") ||
      fixedQueries.some(
        ({ kind }) =>
          kind !== "component" && kind !== "parameter" && kind !== "occurrence",
      );
    if (guardedQuery) contextMembers.push("_scope", "resolve");
    else contextTypingMembers.push("resolve");
    contextMembers.push("ref", "describe", "_expression", "length", "angle");
    (has("position") || has("bbox")
      ? contextMembers
      : contextTypingMembers
    ).push("point");

    const enumerated = fixedQueries.filter(
      ({ kind, q }) =>
        kind !== "occurrence" &&
        (kind !== "component" ||
          (!q["instances"] &&
            !(
              "component" in q ||
              "occurrence" in q ||
              (record(q["scope"]) &&
                ("component" in q["scope"] || "occurrence" in q["scope"]))
            ))),
    );
    if (!basic) {
      const members = collectionKinds.filter((k) =>
        enumerated.some(({ kind }) => kind === k),
      );
      const directCollection =
        members.length === 1
          ? members[0] === "component"
            ? rootScope
            : members[0] === "parameter"
              ? parameterCollection
              : null
          : null;
      const proxy =
        has("adjacency") ||
        fixedQueries.some(
          ({ kind, q }) =>
            kind === "body" ||
            kind === "face" ||
            kind === "edge" ||
            kind === "vertex" ||
            (q["instances"] === true &&
              kind !== "component" &&
              kind !== "occurrence" &&
              kind !== "parameter"),
        );
      if (proxy) {
        contextMembers.push("_proxy");
        source(core, "_cad_require_result");
      }
      if (members.length && !directCollection) {
        const proxied = enumerated.some(({ q }) => q["instances"] === true);
        source(collections, "_CameraQueryCollections", {
          members: [...members, "enumerate"],
          uses: proxied
            ? "_cad_items _cad_cast _cad_context_proxy"
            : "_cad_items _cad_cast",
          ...(proxied ? {} : { bindings: { enumerate: { occurrence: null } } }),
        });
      }
      source(
        members.length ? (directCollection ?? collections) : entity,
        "_cad_context_entities",
        {
          onlyType: members.length === 0,
          uses: directCollection ? "_cad_items" : "_CameraQueryCollections",
        },
      );
      source(entity, "_cad_context_proxy", { onlyType: !proxy });
    }
    const candidatePlans = new Set(
      fixedQueries.map(({ q, kind }) => fixedCandidateSource(q, kind)),
    );
    const candidate = guardedQuery
      ? entity
      : candidatePlans.size === 1
        ? [...candidatePlans][0]!
        : instances;
    source(candidate, "_entity_candidates", {
      uses: candidateDependencies[candidate],
    });
    if (candidate === collections || candidate === occurrences)
      source(core, "_cad_dedup");
    source(guardedQuery ? entity : rootScope, "_cad_context_scope", {
      uses: guardedQuery ? undefined : "",
      onlyType:
        !guardedQuery &&
        !queryShapes.some(
          (q) => record(q["frame"]) && !("sketch" in q["frame"]),
        ),
    });
    source(core, "math", { importName: "math" });
    source(core, "re", { importName: "re" });
    source(values, "Iterable", {
      importName: "collections.abc.Iterable",
      onlyType: true,
    });
    source(core, "_CAD_UNITLESS");
    source(core, "_cad_geometry", { onlyType: !geometry });
    const parameters =
      guardedQuery || fixedQueries.some(({ kind }) => kind === "parameter");
    for (const s of ["_CAD_PARAM_GROUP", "_cad_parameter_info"])
      source(core, s, { onlyType: !parameters });
    source(values, "_cad_fields");
    source(values, "_value_math", { importName: "math" });
    source(values, "_value_enum", { importName: "enum" });
    source(values, "cast", { importName: "typing.cast" });
    source(values, "direction", { onlyType: !geometry && !has("axis") });
    source(values, "json_value");
    source(fusion, "fusion_json");
    source(alias, "_cad_direction", { onlyType: !geometry && !has("axis") });
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
    ])
      source(entity, s);
    const descriptor = queryShapes.some(
      (q) =>
        ![undefined, "component", "root", "context"].includes(
          q["frame"] as string | undefined,
        ),
    );
    const rootFrame = guardedQuery
      ? queryShapes.some((q) => q["frame"] !== "component")
      : fixedQueries.some(
          ({ q, kind }) =>
            q["frame"] !== "component" &&
            // Definitions and parameters have no assemblyContext. For them the
            // implicit/context frame is component-local, regardless of instances.
            ((q["frame"] !== undefined && q["frame"] !== "context") ||
              (kind !== "component" && kind !== "parameter") ||
              has("adjacency")),
        );
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
    entry.dependencies = entry.dependencies.filter(
      (d) => !erased.has(d.symbol),
    );
    for (const dependency of entry.dependencies)
      required.add(dependency.symbol);
  }
  const roots = [
    ...new Set([
      ...definitions.map((d) => d.symbol).filter((s) => !required.has(s)),
      ...contextMembers
        .flatMap((m) => memberNeeds[m]?.split(" ") ?? [])
        .filter((s) => !erased.has(s)),
    ]),
  ];
  // Unselected topology/frame function bodies are still checked offline.
  // Their SDK collection reader is not executable for e.g. a root-only query.
  if (query && !roots.includes("_cad_items") && !required.has("_cad_items"))
    source(core, "_cad_items", { onlyType: true });
  return {
    resolverSymbol,
    receiver: rootQuery ? ("design" as const) : ("context" as const),
    acceptsRaw: !rootQuery,
    rootQuery,
    aliasBindings,
    contextMembers,
    contextTypingMembers,
    definitions,
    roots,
    references,
    typingReferences,
    conditions: {},
  };
}
