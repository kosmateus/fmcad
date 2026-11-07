# Cloud commands and inventory

The remaining data-manager operations now live in a typed Fusion adapter. The
legacy executable asset is removed. Thirteen generated commands pass production
Python admission; no checker bypass or generic success-returning mock is added.

## Historical comparisons

The exact data-manager source at `9dc58fd` is retained with a SHA-256, preserving
later editability diagnostics and deletion receipts. AST parity checks preserve
15 executable function definitions after erasing type-only syntax. The dispatcher
passes the same operation and arguments explicitly. Fourteen existing diagnostic
tests still verify exact output, incomplete results, getter failures and selection
errors against the shipped generated source.

Paired tests also execute the original `a26222f` code for two inherited defects:

- Empty and slash-only folder paths now all reject deletion of the project root
  before calling the SDK. Previously only the empty string was rejected.
- `DataFile.move()` returning false now reports an error without `MOVED_FILE` or
  `DONE`. The pinned API documents true as successful movement. The old handler
  ignored the Boolean result. Successful output remains unchanged, and neither
  false results nor exceptions cause replay.

Deletion still distinguishes accepted deletion from verified permanent removal
and editable-slot release. These later contracts are retained, not replaced with
the older success-only output.

## Model coverage and limits

The shared cloud-inventory scenario creates its own saved file, runs the shipped
project/folder/tree/editability inventory commands, finds the exact file/project/
folder IDs and verifies the reported name and read-only state. Normal owned-file
cleanup runs after success or failure. Both backends execute the same steps and
assertions; both transports run at concurrency 1, 2 and 10 in unit tests and through
the real broker in CI. `--suite all` includes `--suite cloud`.

The model implements the inventory interface and parent paths. Project mutations,
file moves and personal-license quotas remain outside its advertised capabilities;
SDK fault fixtures cover those command contracts without inventing a cloud service.
Final native checks must verify actual folder visibility, permissions and metadata
availability. An inaccessible native inventory fails the required scenario.

## Test portability

The legacy CLI fixture previously set only `WSL_DISTRO_NAME`, while the migrated
platform adapter requires a WSL kernel release as well. This caused 15 local
failures before the intended fake backend calls. The fixture now uses the existing
explicit offline WSL adapter and restores it after each test. Production platform
detection is unchanged. All 481 legacy CLI cases pass with this correction.

Eleven later diagnostic CLI cases still injected direct clients into hooks removed
by the broker migration. They now enter through the supported queue boundary,
execute the production legacy worker and parse both real MCP/addin response
formats with only the wire endpoint replaced. Payload, output, error, read-only
and single-call assertions remain intact. These suites now run in CI.

Required completion checks include historical parity, SDK fault fixtures, all
13 admitted command payloads, shared scenarios, pinned interface checks, strict
model typing and full CI. The wider refactor remains in progress.
