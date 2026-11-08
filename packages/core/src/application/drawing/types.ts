export type Point = [number, number];
export interface Source {
  path: string;
  status: string;
  derivedFrom?: unknown[];
}
export interface EntityFields {
  id?: string;
  from?: Point;
  to?: Point;
  center?: Point;
  r?: number;
  startDeg?: number;
  sweepDeg?: number;
  points?: Point[];
  closed?: boolean;
  boundary?: Point[];
  spacing?: number;
  angleDeg?: number;
  at?: Point;
  text?: string;
  height?: number;
}
export type Entity = EntityFields &
  (
    | { kind: "line"; from: Point; to: Point }
    | { kind: "circle"; center: Point; r: number }
    | {
        kind: "arc";
        center: Point;
        r: number;
        startDeg: number;
        sweepDeg: number;
      }
    | { kind: "polyline"; points: Point[]; closed: boolean }
    | { kind: "hatch"; boundary: Point[]; spacing: number; angleDeg: number }
    | { kind: "text"; at: Point; text: string; height: number }
  );
export interface View {
  id: string;
  kind: string;
  scale: number;
  origin: Point;
  entities: Entity[];
  orientation?: string;
  parent?: string;
  cutFrom?: Point;
  cutTo?: Point;
  detailFrom?: Point;
  detailRadius?: number;
}
export interface Dimension {
  id: string;
  view: string;
  kind: string;
  source: Source;
  toleranceMm: { upper: number; lower: number } | null;
  a?: Point;
  b?: Point;
  vertex?: Point;
  offset?: number;
  valueMm?: number;
  valueRad?: number;
  circle?: string | undefined;
}
export interface Datum {
  id: string;
  view: string;
  kind: string;
  at: Point;
  label: string;
  source: Source;
  direction?: unknown;
}
export interface Control {
  id: string;
  view: string;
  kind: string;
  valueMm: number;
  source: Source;
  target: string;
  datums?: string[];
  anchor?: Point;
}
export interface Note {
  id: string;
  kind: string;
  text: string;
  at: Point;
  height: number;
  source: Source;
}
export interface Item {
  item: number;
  partId: string;
  description: string;
  qty: number;
  purchased: boolean;
  source: Source;
}
export interface Balloon {
  id: string;
  view: string;
  item: number;
  at: Point;
  anchor: Point;
}
export interface Fit {
  id: string;
  view: string;
  shaft: string | undefined;
  bore: string | undefined;
  clearance: { minMm: number; maxMm: number; source: Source };
}
export interface Sheet {
  format: unknown;
  orientation: string;
  sizeMm: Point;
  titleBlock: Record<string, string>;
}
export interface Model {
  documentIdentity: { name: string; revision: string };
  sheet: Sheet;
  views: View[];
  dimensions: Dimension[];
  datums: Datum[];
  controls: Control[];
  notes: Note[];
  items: Item[];
  balloons: Balloon[];
  fits: Fit[];
  axisToleranceMm: number;
}
export interface DrawingInput extends Record<string, unknown> {
  documentIdentity: Record<string, unknown>;
  sheet: unknown;
  views: unknown[];
  dimensions?: unknown[];
  datums?: unknown[];
  controls?: unknown[];
  notes?: unknown[];
  items?: unknown[];
  balloons?: unknown[];
  fits?: unknown[];
  axisTolerance?: unknown;
}
export interface CheckRow {
  id: string;
  kind: string;
  status: string;
  detail: string;
  view?: string;
}

export type Arc = {
  type: "arc";
  center: Point;
  r: number;
  startDeg: number;
  sweepDeg: number;
};
export type Primitive =
  | { type: "line" | "rect"; from: Point; to: Point; width?: number }
  | { type: "circle"; center: Point; r: number }
  | Arc
  | { type: "polyline"; points: Point[]; closed?: boolean }
  | { type: "solid"; points: [Point, Point, Point, ...Point[]] }
  | { type: "text"; at: Point; text: string; height: number; align?: string };
export interface Scene {
  schemaVersion?: number;
  sheet: { sizeMm: Point };
  semantics: {
    sourceMap: {
      dimensions: Record<string, Source>;
      items: Record<string, Source>;
      notes: Record<string, Source>;
    };
    items?: Item[];
    balloons?: { id: string; view: string; item: number }[];
    dimensions?: {
      id: string;
      view: string;
      kind: string;
      valueMm: number | undefined;
      toleranceMm: Dimension["toleranceMm"];
      source: Source;
    }[];
  };
  primitives: Primitive[];
}
