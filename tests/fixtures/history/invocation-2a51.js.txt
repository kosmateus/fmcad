'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const { createInvocationContext, description, parseInvocation } = require('./dist/core');
const { createMcpExecutionContext, mcpRequestState } = require('./dist/core');
module.exports = { context, createInvocationContext, createMcpExecutionContext, mcpRequestState, description, parseInvocation };
