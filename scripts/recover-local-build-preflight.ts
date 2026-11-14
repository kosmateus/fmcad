#!/usr/bin/env node
import { main } from "../dist/scripts/devtools/recover-local-build-preflight.js";
export * from "../dist/scripts/devtools/recover-local-build-preflight.js";

if (require.main === module) void main(process.argv.slice(2));
