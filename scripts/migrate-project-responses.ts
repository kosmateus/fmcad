import { main } from "../dist/scripts/devtools/migrate-project-responses.js";
export * from "../dist/scripts/devtools/migrate-project-responses.js";

if (require.main === module) void main(process.argv.slice(2));
