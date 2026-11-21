'use strict';

// Run real CLI parsing/handlers locally; the injected transport, not this local
// driver, owns queue admission. This keeps test fixture activation in the same
// SDK turn even for active-viewport and legacy active-document commands.
const path = require('node:path');
const { main } = process.env.FMCAD_LIVE_RUNTIME_ROOT
  ? require(path.resolve(process.env.FMCAD_LIVE_RUNTIME_ROOT, 'dist/src/cli'))
  : require('../../src/cli');
const handoff = process.env.FMCAD_LIVE_COMMAND_INTENT
  ? require('../../dist/tests/scenarios/legacy-handoff') : null;
if (handoff) handoff.beginCliIntent();
const stderr = { write(chunk) {
  if (handoff) handoff.observeCliIntent(String(chunk));
  return process.stderr.write(chunk);
} };
main(process.argv.slice(2), { stderr }).then(code => {
  if (handoff) handoff.finishCliIntent(code);
  process.exitCode = code;
}).catch(error => {
  // No terminal handoff on an unexpected driver failure. Original lookup must settle it.
  console.error(error.stack); process.exitCode = 1;
});
