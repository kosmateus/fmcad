#!/usr/bin/env node
import { main } from "../dist/scripts/devtools/verify-queue-phases.js";
export * from "../dist/scripts/devtools/verify-queue-phases.js";

if (require.main === module) void main(process.argv.slice(2));
