#!/usr/bin/env node
'use strict';
const tool = require('../dist/scripts/devtools/start-installed-queue-phases.js');
module.exports = tool;
if (require.main === module) tool.main(process.argv.slice(2));
