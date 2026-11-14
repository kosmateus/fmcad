# Successor controller migration

`queue-epoch-successor` and `queue-epoch-successor-control` retain their public
CommonJS entrypoints and delegate to strict TypeScript compositions. Named
journal/approval/process/current-facts types reuse canonical lineage references,
authority predecessor types and recovery-audit ports. Dependencies resolve from
the original public entrypoint, retaining installed runtime identity and dynamic
worker paths. Source checks, credentials, prior-owner/process checks, exclusive
guards, immutable qualification references, no-replay intent and physical receipt
checks are unchanged.

The scratch composition keeps one explicit private port assertion: its existing
scope intentionally starts with null current instance/prerequisite. Only successful
current-facts validation populates it, and the existing inspect fence rejects
creation beforehand. The scratch controller's legacy TypeScript interface assumes
an already-populated scope. Private journal reads retain protocol type assertions
alongside the original runtime field/hash/identity checks; these are not new input
validation claims. No `any`, suppression or process observer bypass is introduced.

Hash-bound 330849f snapshots run alongside emitted migrated modules. Paired checks
exercise thirteen approval failures, exact owner/request binding, unknown receipt
outcomes, changed source/process/version receipts, pre-observation scratch refusal,
and pending original-journal replay refusal with changed credentials/approval.
External ports are controlled; actual journal file reads and retained bytes are
checked. These are offline orchestration checks, not native or live-process proof.
The existing dead/closed successor bootstrap/control and Linux process cases remain
required in CI, with their actual PID observers intact.

Validation: strict core/node/API build, targeted ESLint, six paired emitted tests,
and both facade identity/export smoke checks pass. Full runtime-tests compilation
reports only the unrelated `tests/data_import.test.ts` top-level `require` binding
(TS2441) inherited at baseline 16fd3d3; C/D confirmed and owns its correction.
Successor tests emit and pass; integration must rerun that compiler after the C/D
fix. Native/Linux PID qualification is not claimed in this host.

Follow-up: applying C/D's exact data-import binding correction from 9a2df48 to
this baseline makes the complete runtime-tests compiler pass (exit 0). The
correction remains owned by C/D and is not duplicated in this migration commit.
