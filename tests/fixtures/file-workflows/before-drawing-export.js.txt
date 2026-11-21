'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { familyDescriptors, readPackage, envelope, outputDirectory, FORMATS, fail, digest } = require('./drawing-package');

const descriptors = { 'drawing.export': familyDescriptors['drawing.export'] };
const MM_TO_PT = 72 / 25.4;

function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (data.schemaVersion !== 1) throw new Error(operation + ' schemaVersion must be 1');
  for (const key of ['package', 'formats', 'out']) if (!Object.hasOwn(data, key)) throw new Error(operation + ' requires ' + key);
}

function validateFormats(value) {
  if (!Array.isArray(value) || !value.length) fail('formats must be a nonempty array');
  const seen = new Set();
  for (const format of value) {
    if (!FORMATS.includes(format)) fail('unsupported format ' + format + '; supported: ' + FORMATS.join(', '));
    if (seen.has(format)) fail('duplicate format ' + format);
    seen.add(format);
  }
  return value;
}

function fmt(n) { return String(Math.round(n * 1000) / 1000); }

function arcPoint(p, degrees) {
  const a = degrees * Math.PI / 180;
  return [p.center[0] + p.r * Math.cos(a), p.center[1] + p.r * Math.sin(a)];
}

function asciiText(s) {
  return [...s].map(c => {
    if (c === '⌀') return 'DIA ';
    if (c === '°') return ' deg';
    if (c === '⏥') return 'FLA';
    if (c === '⌖') return 'POS';
    if (c === '⟂') return 'PER';
    if (c === '∥') return 'PAR';
    const code = c.charCodeAt(0);
    return code > 126 ? '?' : c;
  }).join('');
}

function emitSvg(scene) {
  const [w, h] = scene.sheet.sizeMm;
  const lines = [];
  const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`);
  lines.push('<metadata id="fmcad-source-map">' + escapeXml(JSON.stringify(scene.semantics)) + '</metadata>');
  lines.push(`<g transform="translate(0 ${h}) scale(1 -1)">`);
  for (const p of scene.primitives) {
    if (p.type === 'line') lines.push(`<path d="M ${fmt(p.from[0])} ${fmt(p.from[1])} L ${fmt(p.to[0])} ${fmt(p.to[1])}" stroke="#000" stroke-width="${fmt(p.width || 0.35)}" fill="none"/>`);
    else if (p.type === 'circle') lines.push(`<circle cx="${fmt(p.center[0])}" cy="${fmt(p.center[1])}" r="${fmt(p.r)}" stroke="#000" stroke-width="0.35" fill="none"/>`);
    else if (p.type === 'arc') {
      const start = arcPoint(p, p.startDeg), end = arcPoint(p, p.startDeg + p.sweepDeg);
      lines.push(`<path d="M ${fmt(start[0])} ${fmt(start[1])} A ${fmt(p.r)} ${fmt(p.r)} 0 ${p.sweepDeg > 180 ? 1 : 0} 1 ${fmt(end[0])} ${fmt(end[1])}" stroke="#000" stroke-width="0.35" fill="none"/>`);
    } else if (p.type === 'polyline') {
      const pts = p.points.map(q => fmt(q[0]) + ',' + fmt(q[1])).join(' ');
      lines.push(`<${p.closed ? 'polygon' : 'polyline'} points="${pts}" stroke="#000" stroke-width="0.35" fill="none"/>`);
    } else if (p.type === 'rect') lines.push(`<rect x="${fmt(p.from[0])}" y="${fmt(p.from[1])}" width="${fmt(p.to[0] - p.from[0])}" height="${fmt(p.to[1] - p.from[1])}" stroke="#000" stroke-width="0.35" fill="none"/>`);
    else if (p.type === 'solid') lines.push(`<polygon points="${p.points.map(q => fmt(q[0]) + ',' + fmt(q[1])).join(' ')}" fill="#000"/>`);
    else if (p.type === 'text') lines.push(`<text font-size="${fmt(p.height)}" font-family="Helvetica, Arial, sans-serif" text-anchor="${p.align === 'middle' ? 'middle' : 'start'}" transform="translate(${fmt(p.at[0])} ${fmt(p.at[1])}) scale(1 -1)">${escapeXml(p.text)}</text>`);
  }
  lines.push('</g>');
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

function emitDxf(scene) {
  const pairs = [];
  const put = (...values) => { pairs.push(...values.map(String)); };
  const entity = (kind, codes) => { put(0, kind, 8, '0'); codes(); };
  put(999, JSON.stringify(scene.semantics));
  put(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  put(0, 'SECTION', 2, 'ENTITIES');
  for (const p of scene.primitives) {
    if (p.type === 'line') entity('LINE', () => put(10, fmt(p.from[0]), 20, fmt(p.from[1]), 11, fmt(p.to[0]), 21, fmt(p.to[1])));
    else if (p.type === 'circle') entity('CIRCLE', () => put(10, fmt(p.center[0]), 20, fmt(p.center[1]), 40, fmt(p.r)));
    else if (p.type === 'arc') entity('ARC', () => put(10, fmt(p.center[0]), 20, fmt(p.center[1]), 40, fmt(p.r), 50, fmt(p.startDeg), 51, fmt(p.startDeg + p.sweepDeg)));
    else if (p.type === 'polyline') {
      entity('POLYLINE', () => put(66, 1, 70, p.closed ? 1 : 0));
      for (const q of p.points) entity('VERTEX', () => put(10, fmt(q[0]), 20, fmt(q[1]), 30, 0));
      put(0, 'SEQEND');
    } else if (p.type === 'rect') {
      const [x1, y1] = p.from, [x2, y2] = p.to;
      for (const [ax, ay, bx, by] of [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]]) entity('LINE', () => put(10, fmt(ax), 20, fmt(ay), 11, fmt(bx), 21, fmt(by)));
    } else if (p.type === 'solid') entity('SOLID', () => put(10, fmt(p.points[0][0]), 20, fmt(p.points[0][1]), 11, fmt(p.points[1][0]), 21, fmt(p.points[1][1]), 12, fmt(p.points[2][0]), 22, fmt(p.points[2][1]), 13, fmt(p.points[2][0]), 23, fmt(p.points[2][1])));
    else if (p.type === 'text') {
      const value = asciiText(p.text);
      entity('TEXT', () => {
        if (p.align === 'middle') put(10, fmt(p.at[0]), 20, fmt(p.at[1]), 40, fmt(p.height), 1, value, 72, 1, 73, 2, 11, fmt(p.at[0]), 21, fmt(p.at[1]));
        else put(10, fmt(p.at[0]), 20, fmt(p.at[1]), 40, fmt(p.height), 1, value);
      });
    }
  }
  put(0, 'ENDSEC', 0, 'EOF');
  return pairs.join('\r\n') + '\r\n';
}

const HELVETICA = { 32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191, 40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278, 48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556, 56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556, 64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778, 72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778, 80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944, 88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556, 96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556, 104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556, 111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260, 125: 334, 126: 584 };

function pdfTextWidth(s) { return [...asciiText(s)].reduce((sum, c) => sum + (HELVETICA[c.charCodeAt(0)] || 556), 0); }

function escapePdfText(s) {
  return [...asciiText(s)].map(c => {
    const code = c.charCodeAt(0);
    if (code < 32 || code > 126) return '?';
    if (c === '\\') return '\\\\';
    if (c === '(') return '\\(';
    if (c === ')') return '\\)';
    return c;
  }).join('');
}

function emitPdf(scene) {
  const [wMm, hMm] = scene.sheet.sizeMm;
  const content = [];
  const c = s => content.push(s);
  const p = n => String(Math.round(n * MM_TO_PT * 100) / 100);
  const circlePath = (cx, cy, r) => {
    const k = 0.5523 * r;
    c(`${p(cx - r)} ${p(cy)} m`);
    c(`${p(cx - r)} ${p(cy + k)} ${p(cx - k)} ${p(cy + r)} ${p(cx)} ${p(cy + r)} c`);
    c(`${p(cx + k)} ${p(cy + r)} ${p(cx + r)} ${p(cy + k)} ${p(cx + r)} ${p(cy)} c`);
    c(`${p(cx + r)} ${p(cy - k)} ${p(cx + k)} ${p(cy - r)} ${p(cx)} ${p(cy - r)} c`);
    c(`${p(cx)} ${p(cy - r)} ${p(cx - k)} ${p(cy - k)} ${p(cx - r)} ${p(cy)} c`);
  };
  for (const primitive of scene.primitives) {
    if (primitive.type === 'line') {
      c(`${p(primitive.from[0])} ${p(primitive.from[1])} m ${p(primitive.to[0])} ${p(primitive.to[1])} l`);
      c(`${p(primitive.width || 0.35)} w S`);
    } else if (primitive.type === 'circle') {
      circlePath(primitive.center[0], primitive.center[1], primitive.r);
      c('0.35 w S');
    } else if (primitive.type === 'arc') {
      const steps = Math.max(8, Math.ceil(primitive.sweepDeg / 5));
      for (let i = 0; i <= steps; i++) {
        const [x, y] = arcPoint(primitive, primitive.startDeg + primitive.sweepDeg * i / steps);
        c(`${i === 0 ? p(x) + ' ' + p(y) + ' m' : p(x) + ' ' + p(y) + ' l'}`);
      }
      c('0.35 w S');
    } else if (primitive.type === 'polyline') {
      primitive.points.forEach((q, i) => c(`${p(q[0])} ${p(q[1])} ${i === 0 ? 'm' : 'l'}`));
      if (primitive.closed) c('h');
      c('0.35 w S');
    } else if (primitive.type === 'rect') {
      c(`${p(primitive.from[0])} ${p(primitive.from[1])} m ${p(primitive.to[0])} ${p(primitive.from[1])} l ${p(primitive.to[0])} ${p(primitive.to[1])} l ${p(primitive.from[0])} ${p(primitive.to[1])} l h`);
      c('0.35 w S');
    } else if (primitive.type === 'solid') {
      primitive.points.forEach((q, i) => c(`${p(q[0])} ${p(q[1])} ${i === 0 ? 'm' : 'l'}`));
      c('h f');
    } else if (primitive.type === 'text') {
      const size = primitive.height * MM_TO_PT;
      const x = primitive.align === 'middle' ? primitive.at[0] * MM_TO_PT - pdfTextWidth(primitive.text) * size / 2000 : primitive.at[0] * MM_TO_PT;
      c(`BT /F1 ${p(primitive.height * MM_TO_PT)} Tf ${p(x * 25.4 / 72)} ${p(primitive.at[1])} Td (${escapePdfText(primitive.text)}) Tj ET`);
    }
  }
  const stream = content.join('\n') + '\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p(wMm)} ${p(hMm)}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const EMITTERS = { svg: emitSvg, pdf: emitPdf, dxf: emitDxf };

function execute(operation, data) {
  validate(operation, data);
  const out = outputDirectory(data.out);
  const formats = validateFormats(data.formats);
  const { report, identity, scene } = readPackage(data.package, 'drawing.package');
  fs.mkdirSync(out, { recursive: false });
  const files = [];
  try {
    for (const format of formats) {
      const content = EMITTERS[format](scene);
      const filePath = path.join(out, 'sheet.' + format);
      fs.writeFileSync(filePath, content, { flag: 'wx' });
      files.push({ format, path: filePath, sha256: digest(Buffer.from(content)), sizeBytes: Buffer.byteLength(content) });
    }
  } catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
  const status = report.status;
  const result = envelope('drawing.export', {
    schemaVersion: 1, documentIdentity: report.result.documentIdentity, package: identity, packageStatus: report.status,
    files, formats, sourceMap: scene.semantics.sourceMap,
  }, status, ['Artifacts inherit the package status. Exported files are sheet evidence, not manufacturing certification. PDF text metrics use Helvetica approximations; DXF R12 carries no units or line types.'], [identity], files.map(f => f.path));
  try { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2), { flag: 'wx' }); }
  catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
  return { ...result, reportPath: path.join(out, 'report.json') };
}

module.exports = { descriptors, validate, execute, emitSvg, emitDxf, emitPdf };
