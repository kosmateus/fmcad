// One snapshot binds parser text and provenance to the same read of source bytes.
export interface DataImportFiles {
  cwd(): string;
  isAbsolute(path: string): boolean;
  resolve(...paths: string[]): string;
  extension(path: string): string;
  exists(path: string): boolean;
  stat(path: string): { regular: boolean; size: number };
  snapshot(path: string): { text: string; sha256: string };
}
