'use strict';
const kit = require('terminal-kit');
const { sanitize } = require('./console-logs');
const colors = {
  background: '#02080C', surface: '#040C11', alternate: '#081822', raised: '#0C1E2B',
  text: '#D2DFEA', muted: '#98ADBB', border: '#1987A3', accent: '#09CAE5',
  selected: '#064B99', success: '#54E979', warning: '#F5D447', danger: '#FF626D', meterEmpty: '#27383E',
  syntaxKeyword: '#C792EA', syntaxFunction: '#82AAFF', syntaxType: '#FFCB6B', syntaxBuiltin: '#F78C6C', syntaxKey: '#89DDFF',
};
const indexed = { background: 0, surface: 232, alternate: 233, raised: 234,
  text: 253, muted: 247, border: 31, accent: 45, selected: 25, success: 78, warning: 221, danger: 210, meterEmpty: 237,
  syntaxKeyword: 177, syntaxFunction: 111, syntaxType: 222, syntaxBuiltin: 209, syntaxKey: 117 };
const clean = value => sanitize(value ?? '').replaceAll('\n', ' ');
function clip(value, width) {
  const text = clean(value); width = Math.max(0, width);
  return kit.stringWidth(text) > width && width > 1 ? kit.truncateString(text, width - 1) + '…' : kit.truncateString(text, width);
}
function middle(value, width) {
  const text = clean(value);
  if (kit.stringWidth(text) <= width) return text;
  const right = Math.max(1, Math.floor((width - 1) * 0.6));
  const chars = Array.from(text); let suffix = '';
  while (chars.length && kit.stringWidth(chars.at(-1) + suffix) <= right) suffix = chars.pop() + suffix;
  return clip(text, Math.max(1, width - right - 1)).replace(/…$/, '') + '…' + suffix;
}
function pad(value, width, right = false) {
  const text = clip(value, width), spaces = ' '.repeat(Math.max(0, width - kit.stringWidth(text)));
  return right ? spaces + text : text + spaces;
}
const wrap = (value, width) => String(value ?? '').split('\n').flatMap(line => kit.wordWrapAnsi(sanitize(line), Math.max(1, width)).map(part => part.trimEnd()));
function painter(buffer, prefs) {
  const mono = prefs.color === 'off' || Object.hasOwn(process.env, 'NO_COLOR');
  const hd = buffer instanceof kit.ScreenBufferHD;
  const attr = (fg = 'text', bg = 'surface', extra = {}) => mono
    ? { color: hd ? '#D6E2ED' : 'default', bgColor: hd ? '#071018' : 'default', ...extra }
    : { color: hd ? colors[fg] : indexed[fg], bgColor: hd ? colors[bg] : indexed[bg], ...extra };
  function put(x, y, value, width = buffer.width - x, fg = 'text', bg = 'surface', extra = {}) {
    if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height || width < 1) return;
    buffer.put({ x, y, attr: attr(fg, bg, extra), markup: false }, clip(value, Math.min(width, buffer.width - x)));
  }
  function fill(x, y, width, height, bg = 'surface') {
    for (let row = y; row < Math.min(buffer.height, y + height); row++) put(x, row, ' '.repeat(Math.max(0, width)), width, 'text', bg);
  }
  buffer.fill({ attr: attr('text', 'background') });
  return { put, fill, attr, mono, hd };
}
module.exports = { colors, indexed, painter, clip, middle, pad, wrap };
