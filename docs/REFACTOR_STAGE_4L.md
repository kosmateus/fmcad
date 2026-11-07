# Stage 4l: document save stages

Document stage policy now lives in the typed core. Its composition root opens
the existing Node journal adapter; no new receipt store or retry path is added.
The old save-stage integration test is compiled TypeScript and remains in CI.
Its temporary directory uses the host's temporary root and is removed by the
test cleanup hook, including after a failed assertion.

## Comparison and correction

`src/document-stages.js` first appears at
`2bad473b98d29486d4b21a19b0a8253d1914fb6d`, after the pre-refactor baseline.
That entire source matches the version immediately before this extraction and
is retained with its SHA-256. Paired tests execute it and the typed policy using
the same in-memory journal port and real stage validator, inspector and save use
case. This isolates policy behavior; it does not establish OS durability or a
native Fusion result.

The paired cases retain exact plan/intent bytes, including a Unicode file ID,
receipt references, target/request rejection, completed advice and the rule that
an unknown save response never permits another physical submission.

One result deliberately changes: a journal disappearing after the `started`
append must stop the save. The old reader returned an absent head and the save
use case could still call its physical save port. The same fault now throws and
returns `blocked`, with zero save calls. Disappearance after the plan also fails
immediately; the old path already blocked later when it could not find that plan.
Missing evidence is never permission to send or replay a mutation.

The fault is reproduced in post-baseline source, not attributed to the initial
TypeScript migration or to a demonstrated real filesystem race. Native final
qualification and the guarded filesystem integration suite remain separate.

## Checks

The 18 policy comparisons and three publication comparisons pass locally.
The installed package check also requires the new JavaScript and declaration.
CI runs the real filesystem integration plus the full broker, checker and model
matrix before merge. The local container cannot run guarded `/proc/self/fd`
reads; those guards remain intact.
