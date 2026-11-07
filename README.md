# fmcad

`fmcad` is one installable Node.js package containing the typed JavaScript API,
CLI, standalone stdio MCP server, Python runtime/resources, and optional
OpenCode V1/V2 plugin. Node.js `22.13.x` or `24.x` is supported. Installing this
package does not install or start Autodesk Fusion or its add-in.

## Install and use

See [Install and migrate](docs/INSTALLATION.md) for requirements, npm/tarball
installation, standalone MCP setup, migration, runtime storage, and safe update
guidance.

Install the downloaded npm tarball in a project:

```sh
npm install ./fmcad-0.1.0.tgz
npx --no-install fmcad --help
```

The public library is available from `fmcad/api`:

```js
import { createCatalogServices } from "fmcad/api";

const catalog = createCatalogServices();
console.log(catalog.list());
```

The standalone MCP command is `fmcad-mcp`. Configure it as one local stdio
server in the MCP host; its standard output is reserved for MCP protocol
messages. CLI metadata and MCP tool listing work without OpenCode or Fusion.
Operations requiring the Fusion add-in follow broker admission and report
unavailable/unknown states honestly. An accepted or unknown receipt does not
mean CAD work succeeded.

The root `fmcad` export is the optional, side-effect-free OpenCode plugin
entrypoint. It selects the installed host's V1 `server()` or V2 `setup()` hook;
no plugin is needed for the API, CLI, or MCP. See
[`docs/OPENCODE_PLUGIN.md`](docs/OPENCODE_PLUGIN.md) for supported host
versions and configuration. API consumers can consult
[`docs/LIBRARY_API.md`](docs/LIBRARY_API.md).

## Runtime resources and notices

The tarball includes the Python worker/runtime, Fusion helper scripts,
PowerShell UI helper, formatter and requirements files, plus the verified
Autodesk editor-definition snapshot used by the type checker. The snapshot's
manifest pins its upstream commit and file hashes; its notices, upstream
license/readme, and the `Point3D.create` annotation change are retained beside
it under `dist/runtime/python/typing/snapshots/`. See [`NOTICE.md`](NOTICE.md)
and the snapshot's own `NOTICES.md` for the retained upstream terms and
provenance.

The user authorized distribution with the documented uncertainty accepted.
This is not Autodesk permission or legal clearance; the package does not
assert Autodesk sponsorship, endorsement, or SDK implementation status.
