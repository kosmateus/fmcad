/** Pure dependency planning; canonical source loading belongs to the adapter. */
export interface PayloadDefinition {
  readonly symbol: string;
  readonly sourceId: string;
  readonly dependencies: readonly {
    readonly symbol: string;
    readonly when?: string;
  }[];
}

export function planPayloadDependencies(
  definitions: readonly PayloadDefinition[],
  roots: readonly string[],
  conditions: Readonly<Record<string, boolean>>,
): readonly string[] {
  const registry = new Map<string, PayloadDefinition>();
  for (const definition of definitions) {
    if (!definition.symbol || registry.has(definition.symbol))
      throw new Error(
        `Duplicate or empty payload symbol: ${definition.symbol}`,
      );
    registry.set(definition.symbol, definition);
  }
  const completed = new Set<string>();
  const active = new Set<string>();
  const symbols: string[] = [];
  const visit = (symbol: string): void => {
    if (completed.has(symbol)) return;
    if (active.has(symbol))
      throw new Error(`Cyclic payload dependency: ${symbol}`);
    const definition = registry.get(symbol);
    if (!definition) throw new Error(`Missing payload definition: ${symbol}`);
    active.add(symbol);
    for (const dependency of definition.dependencies) {
      if (dependency.when !== undefined) {
        if (!Object.hasOwn(conditions, dependency.when))
          throw new Error(`Unresolved payload condition: ${dependency.when}`);
        if (!conditions[dependency.when]) continue;
      }
      visit(dependency.symbol);
    }
    active.delete(symbol);
    completed.add(symbol);
    symbols.push(symbol);
  };
  roots.forEach(visit);
  return symbols;
}
