#!/usr/bin/env node
'use strict';
const tool = require('../dist/scripts/devtools/recover-local-build-preflight.js');
module.exports = tool;
if (require.main === module) tool.main(process.argv.slice(2));
