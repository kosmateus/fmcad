'use strict';
const tool = require('../dist/scripts/devtools/benchmark-queue-idle.js');
module.exports = tool;
if (require.main === module) tool.main(process.argv.slice(2));
