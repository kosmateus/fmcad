import type { DataImportFiles } from "../../ports/data-import-files";
import { fields, text, integer, stable, transform } from "./import-values";
import { evidence, mass, model } from "./import-evidence";
import { load } from "./import-source";
import type { LoadedImport } from "./import-source";

interface Contents {
  id: string;
  quantity: number;
}
interface CatalogRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: string;
  quantity: number;
  parent: string | null;
  contents?: Contents[];
  purchaseQuantity?: number;
  functionalGroups?: string[];
  motionMembership?: string[];
  material?: Record<string, unknown>;
  allocation?: { owner: string; quantity: number };
  mass?: unknown;
  model?: unknown;
  placement?: unknown;
}
interface CatalogItem extends CatalogRow {
  contents: Contents[];
  placement: ReturnType<typeof transform> | null;
}
interface CatalogInstance extends Record<string, unknown> {
  id: string;
  item: string;
  parent: string | null;
  localKey: string;
  placement: ReturnType<typeof transform> | null;
}
interface BomRow extends Record<string, unknown> {
  id: string;
  quantity: number;
  basis: "physical" | "purchase" | "contents";
}
/** Catalog rows are decoded by the original ordered checks before expansion. */
export function catalogPlan(
  data: Record<string, unknown>,
  loaded: LoadedImport,
  limit: number,
  unresolved: unknown[],
  files: DataImportFiles,
) {
  const items: CatalogItem[] = loaded.rows.map(({ row, provenance }, i) => {
    const r = row as CatalogRow;
    const label = `catalog row ${i + 1}`;
    fields(
      r,
      [
        "id",
        "name",
        "quantity",
        "parent",
        "kind",
        "contents",
        "allocation",
        "purchaseQuantity",
        "functionalGroups",
        "motionMembership",
        "material",
        "model",
        "placement",
        "mass",
        "status",
        "source",
        "derivation",
      ],
      label,
    );
    const id = text(r.id, `${label}.id`);
    text(r.name, `${id}.name`);
    if (
      !["part", "assembly", "purchased", "pcba", "reference"].includes(r.kind)
    )
      throw new Error(
        `${id}: kind must be part|assembly|purchased|pcba|reference`,
      );
    integer(r.quantity, `${id}.quantity`);
    if (
      !Object.hasOwn(r, "parent") ||
      (r.parent !== null && typeof r.parent !== "string")
    )
      throw new Error(`${id}: explicit physical parent (ID or null) required`);
    for (const key of ["functionalGroups", "motionMembership"])
      if (
        r[key] !== undefined &&
        (!Array.isArray(r[key]) || r[key].some((v) => typeof v !== "string"))
      )
        throw new Error(`${id}.${key} must be text array`);
    if (r.purchaseQuantity !== undefined)
      integer(r.purchaseQuantity, `${id}.purchaseQuantity`);
    if (r.material !== undefined) {
      fields(r.material, ["id", "library", "description"], `${id}.material`);
      if (r.material["id"] !== undefined) text(r.material["id"], "material.id");
      if (r.material["library"] !== undefined)
        text(r.material["library"], "material.library");
      if (!r.material["id"])
        unresolved.push({ id, field: "material", status: "unknown" });
    }
    if (r.allocation !== undefined) {
      fields(r.allocation, ["owner", "quantity"], `${id}.allocation`);
      text(r.allocation!.owner, "allocation.owner");
      integer(r.allocation.quantity, "allocation.quantity");
    }
    const contents = r.contents || [];
    if (!Array.isArray(contents))
      throw new Error(`${id}.contents must be array`);
    const seen = new Set();
    for (const c of contents) {
      fields(c, ["id", "quantity"], `${id}.contents`);
      text(c.id, "contents.id");
      integer(c.quantity, "contents.quantity", 1);
      if (seen.has(c.id)) throw new Error(`${id}: duplicate contents ID`);
      seen.add(c.id);
    }
    if (r.mass == null && ["purchased", "pcba"].includes(r.kind))
      unresolved.push({ id, field: "mass", status: "unknown" });
    return {
      ...r,
      contents,
      mass: mass(r.mass, unresolved, id),
      model: model(r.model, loaded.baseDir, unresolved, id, files),
      provenance: evidence(r, provenance, unresolved, id),
      placement:
        r.placement == null ? null : transform(r.placement, `${id}.placement`),
    };
  });
  const byId = new Map(items.map((r) => [r.id, r]));
  if (byId.size !== items.length) throw new Error("Duplicate catalog ID");
  const done = new Set<string>(),
    visiting = new Set<string>(),
    order: CatalogItem[] = [];
  function visit(id: string) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Catalog parent cycle: ${id}`);
    const r = byId.get(id);
    if (!r) throw new Error(`Unknown catalog parent: ${id}`);
    visiting.add(id);
    if (r.parent !== null) visit(r.parent);
    visiting.delete(id);
    done.add(id);
    order.push(r);
  }
  for (const r of items) visit(r.id);
  // Contents are a purchase ledger, not an instruction to create geometry.
  const contentsDone = new Set<string>();
  function contentsVisit(id: string, stack: string[] = []) {
    if (stack.includes(id)) throw new Error(`Contents cycle: ${id}`);
    if (contentsDone.has(id)) return;
    for (const c of byId.get(id)!.contents) {
      if (!byId.has(c.id)) throw new Error(`Unknown contents ID: ${c.id}`);
      contentsVisit(c.id, [...stack, id]);
    }
    contentsDone.add(id);
  }
  items.forEach((r) => contentsVisit(r.id));
  let instances: CatalogInstance[] = [];
  if (data["instances"] !== undefined) {
    if (!Array.isArray(data["instances"]) || data["instances"].length > limit)
      throw new Error("instances must be a bounded array");
    instances = (data["instances"] as CatalogInstance[]).map((r) => {
      fields(r, ["id", "item", "parent", "localKey", "placement"], "instance");
      text(r.id, "instance.id");
      text(r.localKey, "instance.localKey");
      if (!byId.has(r.item))
        throw new Error(`Unknown instance item: ${r.item}`);
      if (r.parent !== null && typeof r.parent !== "string")
        throw new Error("instance.parent must be ID or null");
      return {
        ...r,
        placement: r.placement
          ? transform(r.placement)
          : byId.get(r.item)!.placement,
      };
    });
  } else {
    for (const r of order) {
      const parents =
        r.parent === null
          ? [null]
          : instances.filter((o) => o.item === r.parent);
      for (const parent of parents)
        for (let n = 1; n <= r.quantity; n++) {
          if (instances.length >= limit)
            throw new Error("Instance expansion exceeds maxItems");
          const localKey = `${r.id}:${n}`,
            id = parent ? `${parent.id}/${localKey}` : localKey;
          instances.push({
            id,
            localKey,
            item: r.id,
            parent: parent?.id ?? null,
            placement: r.placement,
          });
        }
    }
  }
  const inst = new Map(instances.map((r) => [r.id, r]));
  if (inst.size !== instances.length) throw new Error("Duplicate instance ID");
  const sorted: CatalogInstance[] = [],
    seen = new Set<string>(),
    active = new Set<string>();
  function visitInstance(r: CatalogInstance) {
    if (seen.has(r.id)) return;
    if (active.has(r.id)) throw new Error("Instance parent cycle");
    active.add(r.id);
    if (r.parent !== null) {
      const p = inst.get(r.parent);
      if (!p) throw new Error(`Unknown instance parent: ${r.parent}`);
      visitInstance(p);
      if (byId.get(r.item)!.parent !== p.item)
        throw new Error(
          `${r.id}: instance parent conflicts with catalog physical parent`,
        );
    } else if (byId.get(r.item)!.parent !== null)
      throw new Error(`${r.id}: missing catalog parent`);
    active.delete(r.id);
    seen.add(r.id);
    sorted.push(r);
  }
  instances.forEach(visitInstance);
  instances = sorted;
  const signatures = new Map<string | null, string | undefined>();
  for (const parent of [null, ...instances]) {
    const children = instances.filter((r) => r.parent === (parent?.id ?? null));
    if (new Set(children.map((r) => r.localKey)).size !== children.length)
      throw new Error("Duplicate sibling localKey");
    const signature = stable(
      children
        .map((r) => ({ key: r.localKey, item: r.item, placement: r.placement }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
    const key = parent?.item ?? null;
    if (signatures.has(key) && signatures.get(key) !== signature)
      throw new Error(
        `Linked assembly ${key} has inconsistent child structure/placements; use separate definition IDs`,
      );
    signatures.set(key, signature);
    for (const r of children)
      if (r.placement && r.placement.frame !== "parent")
        throw new Error(
          "Catalog placements must be explicit parent-frame transforms; use placement import for root/named frames",
        );
    for (const item of items.filter(
      (r) => r.parent === (parent?.item ?? null),
    )) {
      if (children.filter((r) => r.item === item.id).length !== item.quantity)
        throw new Error(
          `${item.id}: explicit instance count conflicts with quantity per parent`,
        );
    }
  }
  for (const r of instances)
    if (!r.placement)
      unresolved.push({ id: r.id, field: "placement", status: "unknown" });
  const ledger = items.map((r) => {
    const physical = instances.filter(
      (o) => o.item === r.id && r.kind !== "reference",
    ).length;
    const owners = items.flatMap((p) =>
      p.contents
        .filter((c) => c.id === r.id)
        .map((c) => ({
          owner: p.id,
          quantity:
            p.purchaseQuantity === undefined
              ? null
              : c.quantity * p.purchaseQuantity,
        })),
    );
    const contained = owners.some((c) => c.quantity === null)
      ? null
      : owners.reduce((s, c) => s + c.quantity!, 0);
    if (
      ["purchased", "pcba"].includes(r.kind) &&
      r.purchaseQuantity !== undefined &&
      !r.allocation &&
      r.purchaseQuantity < physical
    )
      throw new Error(`${r.id}: physical quantity exceeds declared purchases`);
    if (physical && owners.length) {
      if (
        !r.allocation ||
        r.allocation.quantity !== physical ||
        !owners.some(
          (o) =>
            o.owner === r.allocation!.owner &&
            o.quantity !== null &&
            o.quantity >= physical,
        )
      )
        throw new Error(
          `${r.id}: physical contents require explicit matching PCBA allocation; would double count purchase`,
        );
      if (r.parent !== r.allocation!.owner)
        throw new Error(
          `${r.id}: allocated contents must belong to their physical owner`,
        );
      if (r.purchaseQuantity)
        throw new Error(
          `${r.id}: allocated contents cannot also be standalone purchases`,
        );
    }
    if (r.allocation && !owners.some((o) => o.owner === r.allocation!.owner))
      throw new Error(`${r.id}: allocation owner does not contain item`);
    for (const owner of items.filter((p) =>
      p.contents.some((c) => c.id === r.id),
    ))
      if (owner.purchaseQuantity === undefined)
        unresolved.push({
          id: owner.id,
          field: "purchaseQuantity",
          status: "unknown",
        });
    return {
      id: r.id,
      physical,
      reference:
        r.kind === "reference"
          ? instances.filter((o) => o.item === r.id).length
          : 0,
      purchase: r.purchaseQuantity ?? null,
      contents: contained,
      owners,
      allocation: r.allocation ?? null,
    };
  });
  const differences: Record<string, unknown>[] = [];
  let bomProvenance: LoadedImport["provenance"] | null = null;
  if (data["bom"] !== undefined) {
    let bom = data["bom"] as BomRow[] | Record<string, unknown>;
    if (!Array.isArray(bom)) {
      fields(bom, ["source", "schema", "baseDir"], "bom adapter");
      const input = load(
        {
          ...bom,
          baseDir: bom["baseDir"] || loaded.baseDir,
          revision: data["revision"],
        },
        limit,
        files,
      );
      bom = input.rows.map((r) => r.row as BomRow);
      bomProvenance = input.provenance;
    }
    if (!bom.length) throw new Error("bom must be nonempty");
    const keys = new Set();
    for (const b of bom) {
      fields(b, ["id", "quantity", "basis"], "BOM row");
      integer(b.quantity, "BOM quantity");
      if (!["physical", "purchase", "contents"].includes(b.basis))
        throw new Error("BOM basis must be physical|purchase|contents");
      const key = `${b.id}/${b.basis}`;
      if (keys.has(key)) throw new Error("Duplicate BOM row");
      keys.add(key);
      const r = ledger.find((r) => r.id === b.id),
        actual = r?.[b.basis] ?? null;
      if (actual !== b.quantity)
        differences.push({
          id: b.id,
          basis: b.basis,
          expected: b.quantity,
          actual,
          status: actual === null ? "unknown" : "fail",
        });
    }
  }
  return {
    items,
    instances,
    ledger,
    differences,
    bomProvenance,
    counts: {
      ids: items.length,
      models: items.filter((r) => r.model).length,
      instances: instances.length,
    },
  };
}
