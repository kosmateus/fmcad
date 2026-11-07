# Runtime paths and platform capability

The Node adapters in `config-platform/runtime-paths.ts`, `platform.ts` and
`python.ts` are the shared runtime boundary. They have no import-time filesystem
writes, configuration creation, Fusion probes or dependency installation.

## Locations

| Purpose | Location |
| --- | --- |
| Installation | Walk from the executing module's absolute filename to the `fmcad` package manifest; never use cwd |
| Packaged assets / Python | Installed `dist/assets` / `dist/runtime/python`, with transitional source-tree locations |
| Configuration | `$XDG_CONFIG_HOME/fmcad/config.json`, otherwise `$HOME/.config/fmcad/config.json` |
| Explicit configuration | Explicit option, then `FMCAD_CONFIG`; relative paths are resolved against config home |
| User scripts | `scripts/` next to the selected configuration, including custom configuration |
| State / cache / data | `$XDG_STATE_HOME/fmcad`, `$XDG_CACHE_HOME/fmcad`, `$XDG_DATA_HOME/fmcad`; standard HOME defaults |
| Project results | Explicit absolute project root plus `.cad/results` |
| Diagnostics | Unique `fmcad-diagnostics-*` directory with mode `0700` under the OS temporary directory |

Published npm bins are `dist/bin/fmcad.js` and `dist/bin/fmcad-mcp.js`.
`build:code` stages the transitional runtime under `dist/src`, its dependencies
under `dist/src/dist`, and resources under `dist/assets` and `dist/scripts`.
`dist/package.json` marks this self-contained installation boundary; no consumer
needs the checkout's `src`, `assets`, virtual environments or private workspaces.
The root source launchers remain developer conveniences, not installed npm bins.

`dist/runtime-build.json` records the SHA-256 fingerprint and installed child
entrypoints. The fingerprint is recomputed from actual executable bytes for
broker/worker fencing; the manifest is not trusted instead of checking those
bytes. `build`/`build:dev` refresh identity after typing refresh. Bin shebang bytes
are normalized before hashing because npm normalizes them during installation.
Rebuilding executable code while a broker is pinned intentionally causes
`BUILD_CHANGED`; no retry or fence bypass is introduced.

Relative XDG values resolve against HOME, not cwd. Resolving paths does not create
directories. Installed files are read-only inputs. Child processes prefer installed
`dist/processes` entrypoints; transitional launchers are a final fallback. Build
identity hashes the actual executable JS, Python and resource bytes with stable
relative names, not Git metadata or installation prefixes. Symlinked executable
resources are refused rather than silently omitted.

Configuration loading and `init` now use the same selection rule, including
`FMCAD_CONFIG`. `defaultConfigPath()` still reports the default XDG location,
ignoring that override. Init creates the scripts directory next to the selected
configuration. The `run` consumer honors this location for listing, name resolution
and bundling, and preserves source-path/source-hash provenance. Explicit `--config`
is passed through the CLI to the resolver rather than changing process environment.
Queue admission uses the same option for command pinning and accepted-input hashes.
Owned-result inode/symlink/hash/provenance checks remain in the execution store.
Child processes preserve config/Python/XDG settings and never use the package as
a writable working directory. UI lifecycle state defaults to user state, not a
shared predictable temporary directory.

## Supported capability

Local operations target Ubuntu 22.04/24.04 x64 and Node 22.13+ (22.x) or 24.x.
Full CAD requires WSL2 on Windows 11 with an independently installed Fusion.
The host must provide the actual `WSL_DISTRO_NAME`; there is no Ubuntu fallback.
Drive paths use `/mnt/<drive>` mapping, and Linux paths use the detected
`\\wsl$\<distribution>` namespace. Plain Linux cannot map paths to Windows.
Native Windows/macOS, other distributions and architectures return an explicit
`FMCAD_UNSUPPORTED_PLATFORM`; that result never authorizes direct SDK routing.
WSL detection alone cannot prove the Windows version, Fusion installation or SDK
compatibility; those need separate integration validation.

## Python

Interpreter precedence is explicit `pythonPath`, `FMCAD_PYTHON`, then `python3`.
Checkout virtual environments are never discovered implicitly. The isolated,
bounded preflight requires CPython 3.10–3.12 and checks feature imports before
helper execution. Fusion's embedded Python is separate and is not replaced.
Imports are actually loaded in the probe, so a missing native library also refuses
before helper execution. The console formatter reports an unavailable environment
and preserves the original source in memory rather than executing or rewriting it.

Dependencies are user-managed, never installed by runtime code:

- Formatter: `scripts/console-source-requirements.txt` (Black and Pygments).
- Trace: `assets/image_trace_requirements.txt`.
- Optimize: `assets/image_optimize_requirements.txt`.
- Shared boundaries: `assets/image_boundaries_requirements.txt`.
- Detail tracing: `assets/image_trace_detail_requirements.txt`.
- Reference image analysis: Pillow, NumPy and SciPy (see reference requirements).

CairoSVG also needs the system Cairo library. A successful import preflight does
not establish physical CAD validity or validate all native library behavior.

Dedicated offline coverage: `node --test tests/runtime-paths.test.js` after
`npm run build:code`. Artifact tests copy compiled adapters into an unrelated
Unicode/spaces installation, use a clean HOME and foreign cwd, and make the
installation root read-only. They do not connect to live Fusion.

`tests/runtime-consumers.test.js` also exercises actual image, reference, formatter
and configuration consumers. Its synthetic interpreter verifies probe-before-helper
ordering and failure before worker execution; it does not certify the image algorithms.

`tests/runtime-artifact.test.js` packs and installs the real npm tarball, installs
its production dependencies without lifecycle scripts, then runs CLI, local MCP
catalog and a capability-bound offline worker with a read-only installation and a
clean HOME/foreign Unicode cwd. It checks custom configuration, missing Python,
plain-Linux unsupported mapping, unchanged installed files and the executable
`BUILD_CHANGED` fence after deliberate resource modification. No live Fusion is
contacted. Run this test after a stable completed build, not during rebuilds.
