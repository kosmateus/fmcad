'use strict';

// Run real CLI parsing/handlers locally; the injected transport, not this local
// driver, owns queue admission. This keeps test fixture activation in the same
// SDK turn even for active-viewport and legacy active-document commands.
const { main } = require('../../src/cli');
main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  console.error(error.stack); process.exitCode = 1;
});
