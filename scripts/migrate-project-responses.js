'use strict';
const tool = require('../dist/scripts/devtools/migrate-project-responses.js');
module.exports = tool;
if (require.main === module) tool.main(process.argv.slice(2));
