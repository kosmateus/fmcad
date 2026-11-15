/** Facts come from the Python parser adapter, never from source-text matching. */
export interface PythonDependencyFacts {
  readonly defines: readonly string[];
  readonly references: readonly string[];
  readonly operations: readonly string[];
  readonly methods: readonly string[];
  readonly calls: readonly string[];
  readonly opaque: boolean;
}

export interface PythonUnitFacts extends PythonDependencyFacts {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly handlers: readonly string[];
  readonly handlerReferences: Readonly<Record<string, readonly string[]>>;
  readonly eager: PythonDependencyFacts;
}

export interface PythonSelectionFacts {
  readonly user: PythonDependencyFacts;
  readonly units: readonly PythonUnitFacts[];
  readonly facade: Readonly<Record<string, PythonDependencyFacts>>;
  readonly symbols: Readonly<Record<string, readonly PythonDependencyFacts[]>>;
}

export interface PythonSourceSelection {
  readonly units: readonly string[];
  readonly methods: readonly string[];
  readonly mode: "static" | "conservative";
}

/** Least fixed point over parser facts and the existing initialization graph.
 * Unknown dynamic access retains the complete namespace, rather than silently
 * changing dispatch or asking callers to maintain dependency lists. */
export function selectPythonSources(
  facts: PythonSelectionFacts,
): PythonSourceSelection {
  const all = (): PythonSourceSelection => ({
    units: facts.units.map((unit) => unit.id),
    methods: Object.keys(facts.facade),
    mode: "conservative",
  });
  // An opaque initializer can affect the shared namespace even when no literal
  // operation or symbol points at its source unit.
  if (facts.user.opaque || facts.units.some((unit) => unit.eager.opaque))
    return all();
  const units = new Map(facts.units.map((unit) => [unit.id, unit]));
  const selected = new Set<string>();
  const methods = new Set<string>();
  const symbols = new Set<string>(["CAD_HANDLERS"]);
  const pendingUnits = ["core", "identity", "helpers"];
  const pendingSymbols = [
    "CadContext",
    "_document_target",
    "_document_assert_identity",
    "_document_activate_target",
  ];
  const pendingMethods = [
    "__init__",
    "emit",
    "has_emitted",
    "terminal",
    ...facts.user.methods,
  ];
  const pendingFacts: PythonDependencyFacts[] = [facts.user];
  while (
    pendingUnits.length ||
    pendingMethods.length ||
    pendingFacts.length ||
    pendingSymbols.length
  ) {
    const id = pendingUnits.pop();
    if (id !== undefined && !selected.has(id)) {
      const unit = units.get(id);
      if (!unit) throw new Error("Missing Python source dependency: " + id);
      selected.add(id);
      pendingUnits.push(...unit.dependencies);
      if (unit.opaque) return all();
      // All retained definitions must remain valid for the real checker. This
      // does not imply that every callable in their source unit will execute.
      for (const provider of facts.units)
        if (provider.defines.some((name) => unit.references.includes(name)))
          pendingUnits.push(provider.id);
      if (unit.eager.operations.length)
        pendingFacts.push({ ...unit.eager, references: [] });
      pendingSymbols.push(...unit.eager.calls);
    }
    const symbol = pendingSymbols.pop();
    if (symbol !== undefined && !symbols.has(symbol)) {
      symbols.add(symbol);
      pendingFacts.push(...(facts.symbols[symbol] ?? []));
    }
    const method = pendingMethods.pop();
    if (method !== undefined && !methods.has(method)) {
      const entry = facts.facade[method];
      // Preserve Python's original AttributeError for a nonexistent method.
      if (entry) {
        methods.add(method);
        pendingFacts.push(entry);
      }
    }
    const entry = pendingFacts.pop();
    if (!entry) continue;
    if (entry.opaque) return all();
    pendingMethods.push(...entry.methods);
    pendingSymbols.push(...entry.references);
    for (const unit of facts.units) {
      if (
        unit.defines.some((name) => entry.references.includes(name)) ||
        unit.handlers.some((operation) => entry.operations.includes(operation))
      )
        pendingUnits.push(unit.id);
      for (const operation of entry.operations)
        pendingSymbols.push(...(unit.handlerReferences[operation] ?? []));
    }
  }
  return {
    units: facts.units
      .filter((unit) => selected.has(unit.id))
      .map((unit) => unit.id),
    methods: [...methods],
    mode: "static",
  };
}
