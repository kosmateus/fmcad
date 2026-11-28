"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_module_1 = require("node:module");
const load = (0, node_module_1.createRequire)(__filename);
void (async () => {
    const args = process.argv.slice(2), modes = [
        "--preflight-retirement",
        "--confirm-retirement",
        "--resume-evaluator",
        "--preflight-acceptance",
        "--confirm-acceptance",
        "--inspect-handoff",
    ];
    if (args.length !== 4 ||
        args[0] !== "--approval" ||
        !modes.includes(args[2] ?? "") ||
        args[3] !== "true")
        throw new Error("Use --approval FILE with exactly one --preflight-retirement / --confirm-retirement / --resume-evaluator / --preflight-acceptance / --confirm-acceptance / --inspect-handoff true; no root, client or test-port overrides");
    const approval = node_fs_1.default.realpathSync(args[1]);
    const { QueueClient } = load("../dist/src/queue-client.js");
    const runtime = load("../dist/src/dist/composition/queue-epoch-successor-retained.js");
    const client = new QueueClient(undefined, { existingCredentialsOnly: true });
    try {
        const result = args[2] === "--inspect-handoff"
            ? runtime.readRetainedHandoff(client, approval)
            : args[2] === "--resume-evaluator"
                ? await runtime.resumeRetainedSuccessor(client, load("../dist/src/config.js").loadConfig({}).cfg, approval)
                : args[2].includes("acceptance")
                    ? await runtime.acceptRetainedSuccessor(client, approval, args[2] === "--confirm-acceptance")
                    : await runtime.recoverRetainedSuccessor(client, approval, args[2] === "--confirm-retirement");
        console.log(JSON.stringify(result, null, 2));
    }
    finally {
        client.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
