# Stage 4q: typed broker request preparation

Broker request preparation now lives in `src/composition/execution-request.ts`.
The existing entry delegates to the compiled composition module. It uses the
existing CLI parser, catalog validator and command services; workers still receive
the same payload and policy arguments. Accepted job identity and input pins are
not rewritten.

The frozen comparison source is archive commit
`f336653148a53d539c60fcba9e3394da49a66105`, byte-identical to this module at
`abddf3071effd1c3aaff4536210925618caf04b7`. Its SHA-256 is
`12a3702d7a3a27773aad58fb4c1a5728b82a8047b67e4face73b72e97c416f59`.
This broker projection was introduced during the earlier refactor; it is not a
module from the pre-TypeScript `a26222f` reference. The fixture and its provenance
are retained so comparisons also work in a shallow checkout.

The 38 migration cases compare complete results and serialized field order for
CAD aliases, batch observation, definitions, run arguments, helper/read-only
requests, output paths, legacy commands and purpose precedence. They also compare
rejections for changed relative/absolute file pins, duplicate or missing document
selectors, malformed inputs, unknown helpers and missing files. Already typed
requests keep their original object identity; rebuilding an old legacy projection
does not mutate the accepted request. No expected outcome or error was relaxed.

Legacy optional keys that explicitly contain `undefined` remain in the projected
objects. The composition boundary preserves that representation while the command
service still runs its production decoder. There is no alternative parser,
physical SDK transport or retry path.

Both existing execution-pipeline suites are now included in regression CI. Their
temporary fixtures use the platform temporary directory instead of requiring an
unrelated `/tmp/opencode` directory to exist first. Their assertions about
preparation, admission, process restart and no replay are unchanged. Package checks
require the implementation and declarations, including an external TypeScript
consumer without private workspace paths.

The pinned build, lint, formatting and test types pass locally. Local focused
validation passed 64 tests: 38 migration cases, the existing
command-service comparisons, both execution-pipeline suites and installed
declaration checks. Initial CI caught a packaging regression introduced by this
test's source-type import: test compilation emitted a second implementation over
the packaged compatibility facade. The historical module did not have that
emission collision. The test now consumes staged declarations, and an additional
case compares all successful historical projections through the packaged facade.
It reproduced the missing-module error before the fix and passes after rebuilding;
no runtime path or expected request result changed.

The local installed-broker test reaches process identity
validation but this host cannot read `/proc/<pid>/stat`; production process guards
are unchanged. Installed broker execution therefore requires the Linux CI result.
Full CI remains required before merging. The remaining
stage-dependency/admission/recovery implementations and shared live scenario
coverage stay open; this extraction does not qualify native Fusion.
