import type { SaveBinding } from "./save";

/** Supplied only by authenticated owning-job composition, never decoded from CAD data/context. */
export interface DocumentSaveStages {
  plan(binding: SaveBinding): Promise<string> | string;
  started(binding: SaveBinding): Promise<string> | string;
}
