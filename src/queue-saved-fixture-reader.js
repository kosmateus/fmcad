'use strict';
const { prepareSavedFixtureReader } = require('./dist/node-adapters/persistence/saved-fixture-reader');
const { parseSavedFixtureReader } = require('./dist/core/application/cad/saved-fixture-proof');
module.exports = { prepareSavedFixtureReader, parseSavedFixtureReader };
