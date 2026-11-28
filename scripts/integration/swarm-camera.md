# Read a camera through the raw swarm broker

Build fmcad first. From the repository root, generate a new raw request offline:

```sh
node scripts/integration/swarm-camera.cjs prepare tests/fixtures/swarm-camera-document.json REQUEST.json
```

The fixture pin is for offline use. For Fusion, supply an actual owned document's `name` and `creationId`, optionally its `fileId` and `version`. The `code` field comes from the registered `camera.save` program, with its selected typing declarations because swarm checks raw Python independently. The caller contains no receipt from another broker.

For a single unscoped read, submit the fresh JSON with `fs-cli execute REQUEST.json` or as the arguments to the swarm MCP tool `execute_python`. Retrieve the same request through the submitting client. A successful terminal job contains `result.stdout` with the `FMCAD_RESULT` camera snapshot.

To run the full public fmcad selection flow through `fs-cli`:

```sh
node scripts/integration/swarm-camera.cjs run OWNED-PIN.json NEW-EVIDENCE-DIR [component]
```

`SWARM_CLI` optionally selects the executable. Set `SWARM_DIRECTORY` to pass the same `--directory PATH` to every `execute` and `get`; otherwise `fs-cli` uses its default. The runner writes each fresh request before submitting it, uses `get` for that request, and leaves all evidence in the new directory. The existing fmcad host handles private alias observations and pins the next program to the original document. On success `camera-result.json` contains the validated final snapshot. On an unknown outcome, inspect the recorded request ID rather than submitting it again.

Offline test with a built swarm checkout and its installed SDK type definitions:

```sh
SWARM_OFFLINE_ROOT=/path/to/fusion-swarm-mcp node --test tests/swarm-camera-client.test.cjs
```
