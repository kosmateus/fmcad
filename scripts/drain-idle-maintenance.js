'use strict';
const tool = require('../dist/scripts/devtools/drain-idle-maintenance.js');
module.exports = tool;
if (require.main === module) tool.main(process.argv.slice(2));
