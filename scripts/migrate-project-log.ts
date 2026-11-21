import { main } from "../dist/scripts/devtools/migrate-project-log.js";
export * from "../dist/scripts/devtools/migrate-project-log.js";

if (require.main === module) void main(process.argv.slice(2));
