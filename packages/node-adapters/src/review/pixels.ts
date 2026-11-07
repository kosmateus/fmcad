import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type {
  CapturePixelThresholds,
  DecodedReviewPixels,
} from "../../../core/src/application/review/pixels.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode an 8-bit, non-interlaced PNG and return bounded pixel diagnostics. */
export function decodeReviewPng(
  input: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
  thresholds: CapturePixelThresholds,
): DecodedReviewPixels {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    throw new Error("Review artifact is not a PNG");

  let offset = PNG_SIGNATURE.length;
  let header:
    | {
        readonly width: number;
        readonly height: number;
        readonly bitDepth: number;
        readonly colorType: number;
        readonly interlace: number;
      }
    | undefined;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  let dataStarted = false;
  let dataEnded = false;
  let ended = false;
  const idat: Buffer[] = [];

  while (offset < bytes.length) {
    if (bytes.length - offset < 12)
      throw new Error("Truncated review PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const type = bytes.toString("ascii", typeOffset, typeOffset + 4);
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    if (dataEnd + 4 > bytes.length)
      throw new Error("Truncated review PNG chunk data");
    if (crc32(bytes, typeOffset, dataEnd) !== bytes.readUInt32BE(dataEnd))
      throw new Error("Review PNG chunk CRC mismatch: " + type);
    const data = bytes.subarray(dataOffset, dataEnd);

    if (type === "IHDR") {
      if (header || offset !== PNG_SIGNATURE.length || length !== 13)
        throw new Error("Invalid review PNG header");
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8]!,
        colorType: data[9]!,
        interlace: data[12]!,
      };
      if (data[10] !== 0 || data[11] !== 0)
        throw new Error("Unsupported review PNG compression or filter method");
    } else if (type === "PLTE") {
      if (dataStarted || length === 0 || length % 3 !== 0 || length > 768)
        throw new Error("Invalid review PNG palette");
      palette = data;
    } else if (type === "tRNS") {
      if (dataStarted) throw new Error("Invalid review PNG transparency order");
      transparency = data;
    } else if (type === "IDAT") {
      if (dataEnded) throw new Error("Nonconsecutive review PNG image data");
      dataStarted = true;
      idat.push(data);
    } else if (type === "IEND") {
      if (!dataStarted || length !== 0)
        throw new Error("Invalid review PNG end");
      ended = true;
      offset = dataEnd + 4;
      break;
    } else {
      if (dataStarted) dataEnded = true;
      if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90)
        throw new Error("Unsupported critical review PNG chunk: " + type);
    }
    if (type !== "IDAT" && dataStarted && type !== "IEND") dataEnded = true;
    offset = dataEnd + 4;
  }

  if (!ended || offset !== bytes.length || !header || idat.length === 0)
    throw new Error("Incomplete review PNG");
  const { width, height, bitDepth, colorType, interlace } = header;
  if (
    width !== expectedWidth ||
    height !== expectedHeight ||
    width < 1 ||
    height < 1 ||
    width * height > thresholds.maxPixels
  )
    throw new Error("Review PNG dimensions do not match the request");
  if (bitDepth !== 8 || interlace !== 0)
    throw new Error("Unsupported review PNG pixel encoding");
  const channelCount = channels(colorType);
  if (colorType === 3 && !palette)
    throw new Error("Indexed review PNG has no palette");
  if (
    transparency &&
    ((colorType === 3 && transparency.length > (palette?.length ?? 0) / 3) ||
      (colorType === 0 && transparency.length !== 2) ||
      (colorType === 2 && transparency.length !== 6) ||
      colorType === 4 ||
      colorType === 6)
  )
    throw new Error("Invalid review PNG transparency table");

  const rowBytes = width * channelCount;
  const thumbnailSize = thresholds.thumbnailSize;
  const edgeDelta = thresholds.edgeDelta;
  const colorShift = 8 - thresholds.colorBinBits;
  const expectedInflated = (rowBytes + 1) * height;
  const packed = Buffer.concat(idat);
  const raw = inflateSync(packed, { maxOutputLength: expectedInflated });
  if (raw.length !== expectedInflated)
    throw new Error("Review PNG pixel stream has an invalid length");

  const previous = new Uint8Array(rowBytes);
  const current = new Uint8Array(rowBytes);
  const previousLuma = new Float64Array(width);
  const currentLuma = new Float64Array(width);
  const histogram = new Set<number>();
  const thumbnail = new Uint8Array(thumbnailSize * thumbnailSize * 3);
  const xSamples = sampleCoordinates(width, thumbnailSize);
  const ySamples = sampleCoordinates(height, thumbnailSize);
  const digest = createHash("sha256");
  const dimensions = Buffer.allocUnsafe(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  digest.update(dimensions);
  let sum = 0;
  let sumSquares = 0;
  let edgePixels = 0;
  let cursor = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++]!;
    if (filter > 4) throw new Error("Invalid review PNG row filter");
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= channelCount ? current[x - channelCount]! : 0;
      const above = previous[x]!;
      const upperLeft = x >= channelCount ? previous[x - channelCount]! : 0;
      const predictor = filterValue(filter, left, above, upperLeft);
      current[x] = (raw[cursor++]! + predictor) & 0xff;
    }

    const rgbaRow = Buffer.allocUnsafe(width * 4);
    const thumbnailY = ySamples.get(y);
    for (let x = 0; x < width; x++) {
      const source = x * channelCount;
      const rgba = readRgba(current, source, colorType, palette, transparency);
      const rgbaOffset = x * 4;
      rgbaRow[rgbaOffset] = rgba[0];
      rgbaRow[rgbaOffset + 1] = rgba[1];
      rgbaRow[rgbaOffset + 2] = rgba[2];
      rgbaRow[rgbaOffset + 3] = rgba[3];

      const alpha = rgba[3] / 255;
      const red = rgba[0] * alpha + 255 * (1 - alpha);
      const green = rgba[1] * alpha + 255 * (1 - alpha);
      const blue = rgba[2] * alpha + 255 * (1 - alpha);
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      sum += luma;
      sumSquares += luma * luma;
      histogram.add(
        ((Math.round(red) >> colorShift) << (thresholds.colorBinBits * 2)) |
          ((Math.round(green) >> colorShift) << thresholds.colorBinBits) |
          (Math.round(blue) >> colorShift),
      );
      if (
        (x > 0 && Math.abs(luma - currentLuma[x - 1]!) >= edgeDelta) ||
        (y > 0 && Math.abs(luma - previousLuma[x]!) >= edgeDelta)
      )
        edgePixels++;
      currentLuma[x] = luma;

      const thumbnailX = xSamples.get(x);
      if (thumbnailY !== undefined && thumbnailX !== undefined) {
        const index = (thumbnailY * thumbnailSize + thumbnailX) * 3;
        thumbnail[index] = Math.round(red);
        thumbnail[index + 1] = Math.round(green);
        thumbnail[index + 2] = Math.round(blue);
      }
    }
    digest.update(rgbaRow);
    previous.set(current);
    previousLuma.set(currentLuma);
  }

  const count = width * height;
  const mean = sum / count;
  return {
    width,
    height,
    pixelDigest: digest.digest("hex"),
    edgePixelRatio: edgePixels / count,
    lumaStandardDeviation: Math.sqrt(
      Math.max(0, sumSquares / count - mean * mean),
    ),
    distinctColorBins: histogram.size,
    thumbnail,
  };
}

function channels(colorType: number): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error("Unsupported review PNG color type");
  }
}

function sampleCoordinates(
  length: number,
  sampleSize: number,
): Map<number, number> {
  const result = new Map<number, number>();
  for (let sample = 0; sample < sampleSize; sample++) {
    const position = Math.min(
      length - 1,
      Math.floor(((sample + 0.5) * length) / sampleSize),
    );
    result.set(position, sample);
  }
  return result;
}

function readRgba(
  row: Uint8Array,
  offset: number,
  colorType: number,
  palette: Buffer | undefined,
  transparency: Buffer | undefined,
): readonly [number, number, number, number] {
  if (colorType === 0) {
    const gray = row[offset]!;
    const alpha = transparency?.readUInt16BE(0) === gray ? 0 : 255;
    return [gray, gray, gray, alpha];
  }
  if (colorType === 2) {
    const red = row[offset]!;
    const green = row[offset + 1]!;
    const blue = row[offset + 2]!;
    const transparent =
      transparency !== undefined &&
      transparency.readUInt16BE(0) === red &&
      transparency.readUInt16BE(2) === green &&
      transparency.readUInt16BE(4) === blue;
    return [red, green, blue, transparent ? 0 : 255];
  }
  if (colorType === 3) {
    const index = row[offset]!;
    const paletteOffset = index * 3;
    if (!palette || paletteOffset + 2 >= palette.length)
      throw new Error("Review PNG palette index is out of range");
    return [
      palette[paletteOffset]!,
      palette[paletteOffset + 1]!,
      palette[paletteOffset + 2]!,
      transparency?.[index] ?? 255,
    ];
  }
  if (colorType === 4) {
    const gray = row[offset]!;
    return [gray, gray, gray, row[offset + 1]!];
  }
  return [row[offset]!, row[offset + 1]!, row[offset + 2]!, row[offset + 3]!];
}

function filterValue(
  filter: number,
  left: number,
  above: number,
  upperLeft: number,
): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance)
    return left;
  if (aboveDistance <= diagonalDistance) return above;
  return upperLeft;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++)
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
