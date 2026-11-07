"use strict";

const { deflateSync } = require("node:zlib");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
  const type = Buffer.from(name, "ascii");
  const body = Buffer.concat([type, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}

function capturePng(
  width,
  height,
  seed = 0,
  blank = false,
  compressionLevel = 6,
  variantDelta = 0,
) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const offset = 1 + x * 4;
      row.fill(240, offset, offset + 3);
      row[offset + 3] = 255;
      if (
        !blank &&
        x >= Math.floor(width / 8) &&
        x < Math.floor((width * 7) / 8) &&
        y >= Math.floor(height / 8) &&
        y < Math.floor((height * 7) / 8)
      ) {
        const edge =
          x === Math.floor(width / 8) ||
          x === Math.floor((width * 7) / 8) - 1 ||
          y === Math.floor(height / 8) ||
          y === Math.floor((height * 7) / 8) - 1;
        const stripe =
          (x + seed * 7) % Math.max(3, Math.floor(width / 5)) <
          Math.max(1, Math.floor(width / 12));
        if (edge || stripe) row.fill(24, offset, offset + 3);
        else {
          row[offset] = 40 + ((seed * 17) % 180);
          row[offset + 1] = 50 + ((seed * 29) % 170);
          row[offset + 2] = 60 + ((seed * 41) % 160);
        }
      }
      if (
        !blank &&
        variantDelta &&
        x === Math.floor(width / 2) &&
        y === Math.floor(height / 2)
      )
        row[offset] = Math.min(255, row[offset] + variantDelta);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(Buffer.concat(rows), { level: compressionLevel }),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

module.exports = { capturePng };
