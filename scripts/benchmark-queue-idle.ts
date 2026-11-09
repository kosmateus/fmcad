import { main } from "../dist/scripts/devtools/benchmark-queue-idle.js";
export * from "../dist/scripts/devtools/benchmark-queue-idle.js";

if (require.main === module) void main(process.argv.slice(2));
