import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ReviewArtifactStore } from "../../../core/src/application/review/contracts.js";
import { decodeReviewPng } from "./pixels.js";

function filePath(directory: string, name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name !== name.split(/[\\/]/).at(-1)
  )
    throw new Error("Review artifact name must be a single filename");
  return join(directory, name);
}

function readRegularFile(file: string): { regular: boolean; bytes: Buffer } {
  const fd = openSync(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!fstatSync(fd).isFile())
      return { regular: false, bytes: Buffer.alloc(0) };
    return { regular: true, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

export function createReviewArtifactStore(): ReviewArtifactStore {
  return {
    async claim(directory) {
      mkdirSync(directory, { mode: 0o700 });
    },
    async writeExclusive(directory, name, content) {
      const fd = openSync(filePath(directory, name), "wx", 0o600);
      try {
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
    },
    async readText(directory, name) {
      const result = readRegularFile(filePath(directory, name));
      if (!result.regular)
        throw new Error("Review artifact is not a regular file: " + name);
      return result.bytes.toString("utf8");
    },
    async readImage(directory, name) {
      return readRegularFile(filePath(directory, name));
    },
    decodePixels: decodeReviewPng,
  };
}

export function sha256ReviewImage(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
