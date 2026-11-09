'use strict';
// Pure text layout, independent of the terminal renderer and all live services.
const { wordWrapAnsi } = require('terminal-kit/lib/misc');
function formatHelp(text, width = 80) {
  return text.split('\n').flatMap(line => !line || /^\s|^[{[]/.test(line) ? [line]
    : wordWrapAnsi(line, Math.max(40, width)).map(part => part.trimEnd())).join('\n');
}
module.exports = { formatHelp };
