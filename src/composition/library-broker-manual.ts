import type { CommandManual } from "./library-help-manual";
import { createRequire } from "node:module";

const { descriptors } = createRequire(__filename)("../../queue-cli") as {
  descriptors: Record<string, unknown>;
};
const returns: Record<string, string> = {
  serve:
    "Runs until a controlled drain/stop. The broker reserves one Fusion instance; startup is not model validation. Existing active or unknown work prevents ownership release. It does not start or restart Fusion.",
  exec: "Stdout/stderr are the child command output. Durable request/job/result receipts use FMCAD_QUEUE_* lines on stderr. Exit zero means the job succeeded, not that geometry or physical manufacturing was validated. Inspect the domain outcome.",
  submit:
    "Returns a durable public job record including id and state without waiting for completion. Admission is not execution or success. Keep the job ID and inspect result; never resubmit merely because the reply was lost.",
  status:
    "Returns broker state/revision, public job states, control phase and ownership/recovery observations; --job returns one public job. This is metadata, not a Fusion model audit or an instruction to retry.",
  result:
    "Returns the owned durable job outcome, available stdout/stderr, RPC result or bounded output-file references. Unknown and unavailable results are not converted to success. Reading the result never replays the operation.",
  cancel:
    "Cancels only a queued/preparing job before its first SDK turn. Returns the resulting job record. Started, active or unknown Fusion work is never remotely cancelled.",
  release:
    "Returns the owned idle sequence release record. This ends an idle reservation, not a native transaction, and cannot release active/unknown execution or another owner's sequence.",
  pause:
    "Returns the control snapshot and closes new physical admission. Active SDK work drains rather than being cancelled. Queued waiting budgets freeze; already executing SDK and still-running offline work retain their own budgets.",
  resume:
    "Returns the resumed control snapshot only after required readiness/identity checks. Unresolved work prevents unsafe reopening. Frozen waiting budgets resume with remaining time, not a fresh full timeout.",
  stop: "Returns stopping/draining status and drains settled local/SDK work before releasing the broker. Unknown execution prevents release; this is not cancellation or a Fusion shutdown.",
  reclaim:
    "Returns the verified recovery result for a dead local broker/startup marker. PID/birth checks preserve live ownership; unknown jobs remain fenced. No SDK operation is replayed.",
  reconcile:
    "Returns the owned resolved job only after matching completion evidence and any permitted idle/identity observation. Missing, mismatched or nonterminal workflow evidence keeps the fence. It never reruns the original command.",
  "observe-atomic":
    "Returns the owned read-only observation job, not an accepted outcome for its original target. Keep its request/job ID and read result. Missing or nonterminal native evidence remains unknown; observation never replays or resolves the original operation by itself.",
  "audit-atomic":
    "Returns the original pending, complete or failed source-bound audit receipt and current facts. sdkRequestsSent describes this audit only. A complete audit is not historical model/rollback validation and does not reopen general modeling admission.",
  "migrate-atomic":
    "Returns owner-authenticated migration preflight/status or its original durable transaction receipt. Inspect its explicit readiness, SDK and admission fields. Installation or acknowledgement alone does not establish the original model or rollback outcome; pending/unknown never authorizes replay.",
  "capture-audit-facts":
    "Returns the original pending, complete or failed current-facts capture receipt with pinned evidence. This separately observed capture does not replay the original audit/operation, validate its historical model or copy modeling grants.",
  "authorize-isolated-scratch":
    "Returns owner-bound metadata authorization and pinned current-facts evidence for one future proven-new scratch. SDK0: no document is created, no broad modeling grant is released and historical unknown outcomes remain unchanged.",
  "create-isolated-scratch":
    "Returns the original one-shot creation receipt: pending, complete or failed, with actual sdkRequestsSent. Only known independent/empty/unsaved SDK evidence plus confirmed admission-epoch publication permits modeling. Pending/failed never authorizes another create, adoption or grant copying.",
  "close-isolated-scratch":
    "Returns the original pending, complete or failed exact owned-scratch cleanup receipt. Known SDK close/save evidence and, where captured, actual active-document restore evidence must be verified. Reading the receipt never closes another document, replays cleanup or validates the historical model.",
  "grant-isolated-scratch":
    "Returns metadata containing the exact epochId, registered clientId, owned document and bounded scratch scope. SDK0: it does not create or mutate a model, authorize broker administration or grant access to historical/recovered documents.",
  "successor-epoch":
    "Returns an exact dead-predecessor preflight or metadata-ready/pending successor bootstrap receipt with source/build and owner evidence. SDK0: current observation, proven-new document creation and a new grant are separate actions. No old model, grant or historical outcome is adopted or replayed.",
  "observe-successor":
    "Returns the original pending, complete or failed current-process observation for an existing owner successor authority. Known current facts must remain request/source/process-bound; the historical native outcome stays unknown. It does not create a document or authorize a second observation after a lost reply.",
  "authorize-closed-successor":
    "Returns closed-epoch-successor-authorized metadata with requestId and the hashed authority reference after exact known cleanup/restore on the same live Fusion process. SDK0: new current observation, creation and grant remain separate; no restart, adoption or old-grant copying occurs.",
  "grant-native-fixture":
    "Returns the explicit epoch/client/document-bound fixture grant, including its typed subset or exact registered source program, source/build and manifest/script SHA-256. SDK0: this is permission, not a native test PASS. It never broadens an existing grant in place or permits arbitrary raw scripts, files or cloud effects.",
  "probe-saved-destination":
    "Returns an owner-bound pending administrative receipt or an existing verified native destination record. Uses an actual readiness job, never a fabricated prior observation. SDK project IDs are observed, not inferred from workspace IDs; no save or grant.",
  "grant-saved-first-save":
    "Returns one exact first-save request scope with the original unsaved document and independently approved/observed destination. SDK0 permission only. Ordinary modeling is blocked during transition and existing client grants cannot be broadened.",
  "observe-saved-first-save":
    "Returns a separate original-save publication observation. SDK read completion is distinct from accepted/pending/complete publication; no save is replayed and no saved modeling grant is issued.",
  "retain-saved-fixture":
    "Returns a stable owner receipt for UI close/restore while retaining the exact complete unmodified DataFile. An immutable retention intent refuses another close request ID after uncertainty; no existing cloud data or permissions are changed.",
};

export const manuals: Record<string, CommandManual> = Object.fromEntries(
  Object.keys(descriptors).map((action) => [
    "queue " + action,
    {
      sections: [
        { title: "Return Contract", text: returns[action]! },
        {
          title: "Scope And Time Budgets",
          text: "One user-global broker is shared across managed projects targeting the same configured Fusion backend. Local preparation/processing does not occupy the Fusion slot. Queue waiting starts at SDK readiness; SDK and local processing budgets are separate. Pause is not remote cancellation and cannot freeze an already executing native operation or an external caller's wall-clock limit.",
        },
        {
          title: "Safety",
          text: "Pin document identity for model work. A timeout, disconnection or lost acknowledgement never authorizes replay or direct fallback. Receipt-backed automatic recovery can resume other clients after proven completion; unresolved/background execution stays fenced. External clients bypassing the broker are outside its protection.",
        },
      ],
      examples: [
        {
          label: "Inspect " + action + " usage",
          argv: ["help", "queue", action],
          requires:
            "Help is offline and requires no broker, project or Fusion access. For execution, use actual owned IDs and satisfy the action-specific lifecycle requirements.",
          output:
            "Command usage, supported options and the return/safety contract; no SDK operation is submitted.",
        },
      ],
      audit: {
        sources: [
          "src/queue-cli.js:queueCommand",
          "src/queue-broker.js:dispatch",
          "src/queue-state.js",
        ],
        tests: [
          "tests/queue-scheduling.test.js",
          "tests/console-pause.test.js",
          "tests/phased-queue.test.js",
          "tests/queue-probe-recovery.test.js",
        ],
        verified: [
          "Offline parsing and typed broker records",
          "Queue admission, pause budgets and receipt-bound recovery integration checks",
        ],
        gaps: [],
        bugs: [
          "Native model/physical validation is scenario-specific, never implied by a queue status or exit code",
        ],
      },
    },
  ]),
);

manuals["console"] = {
  sections: [
    {
      title: "Return Contract",
      text: "Opens an interactive terminal view of broker/project observations and authorized control actions. Normal quit returns from the console; startup/control errors are reported rather than fabricated as model success. Rendered queue state is not physical validation.",
    },
    {
      title: "Pause Scope",
      text: "Pause applies to new SDK admission for every managed project sharing the broker. The active operation drains. Queued waiting clocks freeze, but native work already running and unrelated external caller limits do not stop. Resume uses remaining budgets and refuses unresolved ownership.",
    },
    {
      title: "Ownership",
      text: "The console does not grant permission to bypass the broker, cancel native operations, reset Fusion or replay uncertain work. Read current state before control actions; stale ownership/generation checks must fail rather than overwrite another client's decision.",
    },
  ],
  examples: [
    {
      label: "Inspect console controls",
      argv: ["help", "console"],
      requires: "None: help remains local and offline.",
      output:
        "Console usage and control/ownership semantics without starting Fusion.",
    },
  ],
  audit: {
    sources: [
      "src/console.js",
      "src/console-controller.js",
      "src/queue-gate.js",
    ],
    tests: [
      "tests/console-pause.test.js",
      "tests/console-offline.test.js",
      "tests/console-services.test.js",
    ],
    verified: [
      "Offline startup/help contracts",
      "Bound control generations, drain and waiting-budget tests",
    ],
    gaps: [],
    bugs: [
      "Displayed observations do not certify native geometry or physical manufacturing",
    ],
  },
};
