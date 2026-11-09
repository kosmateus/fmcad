import type {
  CheckRow,
  Source,
  Scene,
  Model,
} from "../packages/core/src/application/drawing/types";
import type {
  ExportedFile,
  DrawingExportPorts,
} from "../packages/node-adapters/src/persistence/drawing-export";
import type { DrawingCheckPorts } from "../packages/node-adapters/src/persistence/drawing-check";
export interface GeometryInput {
  id?: string;
  kind: string;
  from?: number[];
  to?: number[];
  center?: number[];
  r?: number;
  startDeg?: number;
  sweepDeg?: number;
  points?: number[][];
  closed?: boolean;
  boundary?: number[][];
  spacing?: number;
  angleDeg?: number;
  at?: number[];
  text?: string;
  height?: number;
}
export interface ViewInput {
  id: string;
  kind: string;
  orientation?: string;
  parent?: string;
  scale?: number;
  origin: number[];
  geometry: GeometryInput[];
  cutFrom?: number[];
  cutTo?: number[];
  detailFrom?: number[];
  detailRadius?: number;
}
type PointInput = number[] | { entity: string; role?: string; index?: number };
export interface DimensionInput {
  id: string;
  view: string;
  kind: string;
  source: Source;
  tolerance?: { upper: string; lower: string } | undefined;
  a?: PointInput;
  b?: PointInput;
  vertex?: PointInput;
  offset?: number;
  value?: string;
  circle?: string;
}
export interface DrawingFixture extends Record<string, unknown> {
  schemaVersion: number;
  representation?: string;
  out: string;
  axisTolerance?: string;
  documentIdentity: { name: string; revision?: string };
  sheet: {
    format: string;
    orientation?: string;
    titleBlock?: Record<string, string>;
    custom?: string[];
  };
  views: ViewInput[];
  dimensions: DimensionInput[];
  items: {
    item: number;
    partId: string;
    description: string;
    qty: number;
    source: Source;
  }[];
  balloons: {
    id: string;
    view: string;
    item: number;
    at: number[];
    anchor: PointInput;
  }[];
  fits: {
    id: string;
    view: string;
    shaft: string;
    bore: string;
    clearance: { min: string; max: string; source: Source };
  }[];
  datums?: Record<string, unknown>[];
  controls?: Record<string, unknown>[];
}
export interface DrawingResult extends Record<string, unknown>, Model {
  checks: CheckRow[];
  sourceMap: { dimensions: Record<string, Source> };
  nativeDrawing: { status: string };
  scene: { path: string; sha256: string };
  reason: string;
  files: ExportedFile[];
  packageStatus: string;
  documentIdentity: { name: string; revision: string };
}
export interface DrawingReport extends Record<string, unknown> {
  status: string;
  success: boolean;
  documentIdentity: { name: string };
  nativeAcceptance: string;
  associativity: string;
  result: DrawingResult;
  reportPath: string;
}
export interface DrawingDescriptor {
  offline: boolean;
  nodeOnly: boolean;
  requiresDoc: boolean;
  limitations: string[];
  example: DrawingFixture;
}
export interface DrawingApi
  extends
    DrawingExportPorts,
    DrawingCheckPorts,
    Pick<
      typeof import("../packages/core/src/application/drawing/model"),
      "length" | "quantity" | "source" | "safeId"
    > {
  dimensionStatus(
    dim: {
      source: { status: string };
      kind?: string;
      valueMm?: number;
      toleranceMm?: { upper: number; lower: number };
    },
    measured: number,
  ): string;
  descriptors: Record<string, DrawingDescriptor>;
  familyDescriptors: Record<string, DrawingDescriptor>;
  execute(operation: string, request: Record<string, unknown>): DrawingReport;
  validate(operation: string, request: Record<string, unknown>): void;
  readPackage(
    file: unknown,
    expected: string,
  ): { report: DrawingReport; identity: unknown; scene: Scene };
}
