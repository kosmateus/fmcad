# Workspace toolchain

The root `fmcad` package is the only publishable npm package. Its four private npm workspaces establish internal build boundaries; they are not separately published products. CLI, MCP, broker, worker, and library composition roots stay in the root package until their own migrations.

| Workspace                 | Responsibility                                                             |
| ------------------------- | -------------------------------------------------------------------------- |
| `@fmcad/core`             | Host-independent domain, application, ports, and catalog                   |
| `@fmcad/node-adapters`    | Node-backed port implementations, depending on core                        |
| `@fmcad/opencode-adapter` | OpenCode host mapping with services supplied by the root composition layer |
| `@fmcad/control-center`   | HTTP service and browser UI boundaries, without a second scheduler         |

New TypeScript modules use the shared strict `tsconfig.base.json`. Workspace builds emit CommonJS JavaScript and declarations under each private package's `dist/`; Node executes the built JavaScript and does not need a TypeScript loader. Build references encode the package dependency graph, while ESLint rejects cycles and core imports from Node, adapters, terminal-kit, or OpenCode. Workspace packages are private, and the root package's npm allowlist excludes their source and build output. The root build stages the trusted Control Center server and browser assets into the installed runtime; it does not load TypeScript at runtime.

Run `npm run build`, `npm run typecheck:tests`, `npm run lint`, `npm run format:check`, `npm run test:contracts`, and `npm run test:python` from the repository root to mirror CI. The CI matrix uses Node `22.13.0` and `24.x`; its contract tests use isolated fixtures and do not require Fusion or a global broker. `npm test` runs the full local build, typecheck, Node, and Python suites.

The supported runtime is Node `>=22.13.0 <23 || >=24.0.0 <25`. This intentionally ends the Node 18 support advertised by the former manifest; installing on Node 18 is unsupported. This declaration does not imply that every version in the range was exercised in a given environment.
