#!/usr/bin/env node
import { main } from "../dist/scripts/devtools/install-queue-phases.js";
export * from "../dist/scripts/devtools/install-queue-phases.js";

if (require.main === module) void main(process.argv.slice(2));
