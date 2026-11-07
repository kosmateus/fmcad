'use strict';
const { parseLog } = require('./console-logs');
const { recordedTime: time, matchesTask: matches, eventsFor } = require('./dist/core');
const adapter = require('./dist/node-adapters/console/task-events').createTaskEventAdapter({ parseLog, time, matches });
function readTaskEvents(project, task, cfg = {}) { return adapter.readTaskEvents(project, task, cfg); }
function createTaskEventReader(project, cfg = {}) { return adapter.createTaskEventReader(project, cfg); }
module.exports = { matches, eventsFor, readTaskEvents, createTaskEventReader };
