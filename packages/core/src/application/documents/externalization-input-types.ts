import type {
  ExternalizationItem,
  ExternalizationRequest,
} from "./externalization";
interface SourcePin extends Record<string, unknown> {
  projectId: string;
  fileId: string;
  version: number;
  creationId: string;
  context?: string;
}
interface Destination extends Record<string, unknown> {
  projectId: string;
  folderId: string;
  name?: string;
  fileName?: string;
}
interface Item extends ExternalizationItem {
  instancePolicy: string;
  definitionPolicy?: string;
  selection?: unknown;
  dataFileId?: string;
  projectId?: string;
  version?: number;
  creationId?: string;
  context?: string;
  destination?: Destination;
  groupId?: string;
  destinationOccurrence?: unknown;
  name?: string;
  placementSpace?: string;
  sharedParentPolicy?: string;
  placement?: { translation?: string[]; axis?: number[]; angle?: string };
  occurrenceMap?: unknown;
  bodyMap?: unknown;
}
interface Probe extends Record<string, unknown> {
  probeId: string;
  itemId: string;
  source: SourcePin & { itemId?: string };
  scope?: string;
  parameter: string;
  expression: string;
  minimum: string;
  maximum: string;
  checks: unknown[];
  refresh: {
    reportPath: string;
    nativeFallback?: string;
    driverUiLeases?: unknown;
    restoreUiLeases?: unknown;
  };
}
export interface ExternalizationInput extends ExternalizationRequest {
  schemaVersion: number;
  source: SourcePin;
  destinationDocument?: Destination;
  save?: boolean;
  confirmReplace?: boolean;
  confirmRetire?: boolean;
  items: Item[];
  extractionGroups: { id: string; members: unknown[] }[];
  parameterBindings: { targetItemId?: string; [key: string]: unknown }[];
  rootDatums: unknown[];
  boundaries: unknown[];
  probes: Probe[];
  callerNamespaces: {
    itemId: string;
    scope: string;
    group: string;
    keys: string[];
  }[];
  expectedInventory: Record<string, Record<string, number>>;
  linearTolerance: string;
  angularTolerance: string;
  volumeTolerance: string;
}
