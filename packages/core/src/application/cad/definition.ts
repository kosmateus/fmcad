import {
  canonical,
  clone,
  referenceParts,
  transform,
  utf8Length,
} from "./json";
import { record } from "./contracts";

type Dict = Record<string, unknown>;
function dictionary(value: unknown, label: string): Dict {
  if (!record(value) || Object.keys(value).some((key) => !validName(key)))
    throw new Error(`Invalid ${label} names`);
  return value;
}
function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    !["constructor", "prototype", "__proto__"].includes(value)
  );
}
function fields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Dict {
  if (!record(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`Unknown ${label} field: ${key}`);
}
const optional = (value: unknown, fallback: unknown): unknown =>
  value === undefined ? fallback : value;
function literalValues(values: unknown): void {
  for (const marker of ["$ref", "$param", "$input", "$local"])
    transform(values, marker, () => {
      throw new Error(
        "Scoped defaults/root values must be literal JSON; bind caller references through inputs",
      );
    });
}
function steps(value: unknown, message: string): Dict[] {
  if (!Array.isArray(value) || !value.length || !value.every(record))
    throw new Error(message);
  return value as Dict[];
}
export function expandDefinition(data: unknown): Dict {
  const input = clone(data);
  if (!record(input)) throw new Error("Batch must be an object");
  if (
    input["formatVersion"] !== undefined ||
    input["definitions"] !== undefined
  )
    return expandScoped(input);
  const parameters = optional(input["parameters"], {});
  if (!record(parameters)) throw new Error("parameters must be an object");
  input["operations"] = transform(input["operations"], "$param", (name) => {
    if (!Object.hasOwn(parameters, name))
      throw new Error(`Unknown parameter: ${name}`);
    return clone(parameters[name]);
  });
  return input;
}
function expandScoped(input: Dict): Dict {
  if (input["formatVersion"] !== 1)
    throw new Error("Scoped definitions require formatVersion: 1");
  const maximum = optional(input["maxExpansion"], 10000);
  if (
    typeof maximum !== "number" ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 100000
  )
    throw new Error("maxExpansion must be an integer in 1..100000");
  const max: number = maximum;
  const definitions = optional(input["definitions"], {});
  if (!record(definitions)) throw new Error("definitions must be an object");
  dictionary(definitions, "definition");
  literalValues(optional(input["parameters"], {}));
  literalValues(optional(input["inputs"], {}));
  const library: Record<string, Dict> = {};
  for (const [name, def] of Object.entries(definitions)) {
    fields(
      def,
      ["parameters", "inputs", "operations", "outputs", "revision"],
      `definition ${name}`,
    );
    dictionary(optional(def["parameters"], {}), "parameter");
    literalValues(optional(def["parameters"], {}));
    const names = optional(def["inputs"], []);
    if (
      !Array.isArray(names) ||
      new Set(names).size !== names.length ||
      names.some((key) => !validName(key))
    )
      throw new Error(`Invalid inputs in ${name}`);
    dictionary(optional(def["outputs"], {}), "output");
    if (
      def["revision"] !== undefined &&
      (typeof def["revision"] !== "string" || !def["revision"])
    )
      throw new Error(`Invalid revision in ${name}`);
    library[name] = def;
  }
  const checked = new Set<string>();
  function checkLibrary(name: string, chain: string[] = []): void {
    if (chain.includes(name))
      throw new Error(`Definition cycle: ${[...chain, name].join(" -> ")}`);
    if (checked.has(name)) return;
    if (chain.length > 128) throw new Error("Definition depth exceeds 128");
    function walk(raw: unknown, depth = 0): void {
      if (depth > 128) throw new Error("Invalid definition operations/depth");
      for (const step of steps(raw, "Invalid definition operations/depth")) {
        if (Object.hasOwn(step, "use")) {
          const use = step["use"];
          if (typeof use !== "string" || !Object.hasOwn(library, use))
            throw new Error(`Unknown definition: ${String(use)}`);
          checkLibrary(use, [...chain, name]);
        }
        if (Object.hasOwn(step, "operations"))
          walk(step["operations"], depth + 1);
      }
    }
    walk(library[name]!["operations"]);
    checked.add(name);
  }
  for (const name of Object.keys(library)) checkLibrary(name);
  let visits = 0,
    expandedBytes = 0;
  const maxExpandedBytes = 32 * 1024 * 1024;
  function boundedCopy(value: unknown): unknown {
    const encoded = canonical(value);
    expandedBytes += utf8Length(encoded);
    if (expandedBytes > maxExpandedBytes)
      throw new Error(
        "Expansion memory budget exceeded: 32 MiB of copied JSON",
      );
    return JSON.parse(encoded) as unknown;
  }
  const operations: unknown[] = [],
    scopes: { id: string; path: string[] }[] = [];
  let bindings: unknown;
  const generated = new Set<string>();
  function scope(
    raw: unknown,
    prefix: string[],
    params: Dict,
    inputs: Dict,
    locals: Dict,
    outputs: Dict,
    stack: string[],
    inheritedComponent: unknown,
  ): unknown {
    if (stack.length + prefix.length > 128)
      throw new Error("Expansion depth exceeds 128");
    const entries = steps(raw, "operations must be a nonempty array");
    dictionary(params, "parameter");
    dictionary(inputs, "input");
    const symbols = new Map<string, unknown>();
    function value(rawValue: Dict): unknown {
      for (const [marker, source, message] of [
        ["$param", params, "Unknown parameter"],
        ["$input", inputs, "Unbound input"],
      ] as const)
        if (Object.hasOwn(rawValue, marker))
          return transform(rawValue, marker, (key) => {
            if (!Object.hasOwn(source, key))
              throw new Error(`${message}: ${key}`);
            return boundedCopy(source[key]);
          });
      if (Object.hasOwn(rawValue, "$local"))
        return transform(rawValue, "$local", (key) => {
          let result: unknown = locals;
          for (const part of referenceParts(`local.${key}`).slice(1)) {
            if (
              (!record(result) && !Array.isArray(result)) ||
              !Object.hasOwn(result, part)
            )
              throw new Error(`Unbound local: ${key}`);
            result = (result as Dict)[part];
          }
          return boundedCopy(result);
        });
      return transform(rawValue, "$ref", (ref) => {
        const [id, ...parts] = referenceParts(ref);
        if (!symbols.has(id!))
          throw new Error(`Unbound, future or cross-scope reference: ${ref}`);
        let result = symbols.get(id!);
        if (typeof result === "string")
          return { $ref: [result, ...parts].join(".") };
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]!;
          if (record(result) && Object.hasOwn(result, "$ref"))
            return { $ref: [result["$ref"], ...parts.slice(i)].join(".") };
          if (
            (!record(result) && !Array.isArray(result)) ||
            !Object.hasOwn(result, part)
          )
            throw new Error(`Unexposed reference: ${ref}`);
          result = (result as Dict)[part];
        }
        return boundedCopy(result);
      });
    }
    function substitute(rawValue: unknown): unknown {
      if (Array.isArray(rawValue)) return rawValue.map(substitute);
      if (!record(rawValue)) return rawValue;
      if (
        ["$param", "$input", "$local", "$ref"].some((marker) =>
          Object.hasOwn(rawValue, marker),
        )
      )
        return value(rawValue);
      return Object.fromEntries(
        Object.entries(rawValue).map(([key, item]) => [key, substitute(item)]),
      );
    }
    for (const step of entries) {
      if (++visits > max)
        throw new Error(`Expansion limit exceeded: ${max} nodes`);
      const stepId = step["id"];
      if (!validName(stepId)) throw new Error("Invalid scoped step id");
      if (symbols.has(stepId)) throw new Error(`Duplicate step id: ${stepId}`);
      const address = [...prefix, stepId];
      const component = Object.hasOwn(step, "component")
        ? substitute(step["component"])
        : inheritedComponent;
      if (Object.hasOwn(step, "use")) {
        fields(step, ["id", "use", "parameters", "inputs", "component"], "use");
        const use = step["use"];
        if (typeof use !== "string" || !Object.hasOwn(library, use))
          throw new Error(`Unknown definition: ${String(use)}`);
        if (stack.includes(use))
          throw new Error(`Definition cycle: ${[...stack, use].join(" -> ")}`);
        const def = library[use]!;
        const overrides = dictionary(
          optional(step["parameters"], {}),
          "parameter",
        );
        const defaults = dictionary(
          optional(def["parameters"], {}),
          "parameter",
        );
        for (const key of Object.keys(overrides))
          if (!Object.hasOwn(defaults, key))
            throw new Error(`Unknown parameter: ${use}.${key}`);
        const bound = dictionary(optional(step["inputs"], {}), "input");
        const names = optional(def["inputs"], []) as string[];
        if (
          names.some((key) => !Object.hasOwn(bound, key)) ||
          Object.keys(bound).some((key) => !names.includes(key))
        )
          throw new Error(`Missing or unknown inputs: ${use}`);
        const exports = scope(
          def["operations"],
          address,
          { ...defaults, ...(substitute(overrides) as Dict) },
          substitute(bound) as Dict,
          {},
          dictionary(optional(def["outputs"], {}), "output"),
          [...stack, use],
          component,
        );
        symbols.set(stepId, { outputs: exports });
      } else if (
        Object.hasOwn(step, "repeat") ||
        Object.hasOwn(step, "forEach")
      ) {
        fields(
          step,
          [
            "id",
            "repeat",
            "forEach",
            "as",
            "index",
            "operations",
            "outputs",
            "component",
          ],
          "loop",
        );
        const repeat = Object.hasOwn(step, "repeat");
        if (repeat === Object.hasOwn(step, "forEach"))
          throw new Error("Specify exactly one of repeat or forEach");
        steps(step["operations"], "Loop operations must be a nonempty array");
        const outputFields = dictionary(
          optional(step["outputs"], {}),
          "output",
        );
        const items = substitute(repeat ? step["repeat"] : step["forEach"]);
        const count = repeat
          ? items
          : Array.isArray(items)
            ? items.length
            : undefined;
        if (
          (!repeat && !Array.isArray(items)) ||
          typeof count !== "number" ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > max - visits
        )
          throw new Error(
            "Loop requires a finite bounded count or array within maxExpansion",
          );
        const itemName = optional(step["as"], "item"),
          indexName = optional(step["index"], "index");
        if (
          !validName(itemName) ||
          !validName(indexName) ||
          itemName === indexName ||
          Object.hasOwn(locals, itemName) ||
          Object.hasOwn(locals, indexName)
        )
          throw new Error("Loop local name collision");
        const exported: unknown[] = [];
        for (let i = 0; i < count; i++) {
          if (++visits > max) throw new Error("Expansion limit exceeded");
          exported.push(
            scope(
              step["operations"],
              [...address, String(i)],
              params,
              inputs,
              {
                ...locals,
                [itemName]: repeat ? i : (items as unknown[])[i],
                [indexName]: i,
              },
              outputFields,
              stack,
              component,
            ),
          );
        }
        symbols.set(stepId, { outputs: exported });
      } else {
        fields(
          step,
          ["id", "operation", "data", "component", "onExisting", "expectFail"],
          "step",
        );
        const id = prefix.length
          ? "scope_" + address.map((part) => `${part.length}_${part}`).join("_")
          : stepId;
        if (generated.has(id)) throw new Error(`Expanded ID collision: ${id}`);
        generated.add(id);
        const flat: Dict = { ...step, id, data: substitute(step["data"]) };
        if (component !== undefined) flat["component"] = component;
        operations.push(boundedCopy(flat));
        scopes.push({ id, path: address });
        symbols.set(stepId, id);
      }
    }
    dictionary(outputs, "output");
    if (!prefix.length && record(input["recipe"]))
      bindings = substitute(input["recipe"]["bindings"]);
    return boundedCopy(substitute(outputs));
  }
  const exports = scope(
    input["operations"],
    [],
    dictionary(optional(input["parameters"], {}), "parameter"),
    dictionary(optional(input["inputs"], {}), "input"),
    {},
    dictionary(optional(input["outputs"], {}), "output"),
    [],
    undefined,
  );
  const result: Dict = {
    ...input,
    operations,
    exports,
    expansion: {
      nodes: visits,
      steps: operations.length,
      maxExpansion: max,
      expandedBytes,
      maxExpandedBytes,
      scopes,
    },
  };
  if (record(input["recipe"]))
    result["recipe"] = { ...input["recipe"], bindings };
  for (const key of [
    "formatVersion",
    "definitions",
    "maxExpansion",
    "inputs",
    "outputs",
  ])
    delete result[key];
  return result;
}
