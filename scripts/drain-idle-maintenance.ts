import { main } from "../dist/scripts/devtools/drain-idle-maintenance.js";
export * from "../dist/scripts/devtools/drain-idle-maintenance.js";

if (require.main === module) void main(process.argv.slice(2));
