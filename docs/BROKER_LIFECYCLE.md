# Broker lifecycle

One broker owns physical execution. CLI, MCP and Control Center use the same
`core/application/broker-control` contract and `node-adapters/broker-ipc/control`
port. Every mutating request carries `requestId`, `instanceId` and
`expectedGeneration`. A lost response is observed through its original receipt;
the application never generates a new request and replays it automatically.

`pause` closes admission; `drain` does the same and reports PAUSING until active
SDK turns really settle. Neither operation cancels physical work. `resume` is
explicit and validates the instance. `console-inspect` observes Fusion only
when idle, or reads the original terminal control receipt when unresolved.
`console-stop`, `console-reload` and the compatibility `console-restart` are
idle-only, durably pause first, then publish a request-bound release receipt.
Queued/preparing/processing work, leases and unresolved physical ownership
prevent release. Reload/restart is not Fusion reset.

The local start/restart service requires the bound release receipt, clear
ownership and an atomic exclusive autostart claim. It requests `startPaused`;
the replacement must report a distinct instance, executable build identity,
closed gate and no active/unresolved operations. A foreign or stale owner is
not reclaimed by explicit start. Ordinary client autostart retains the existing
bounded PID/birth/nonce recovery protocol and never requests resume.

Fusion reset is an explicit separate use case, not a running broker RPC.
`resetPause` is assigned only after an acknowledged RUNNING→PAUSED transition,
bound to its request, instance and resulting generation. Restoration cannot
resume a foreign generation. Recovery from a dead reset owner also requires the
matching durable control receipt. Legacy boolean/timestamp markers do not prove
ownership and require explicit reconciliation; timestamps alone never authorize
resume. No broad process kill or lock deletion is introduced.

A Fusion-version change is not adopted by automatic startup. An operator may
explicitly run `fmcad queue serve --confirm-ownership true --confirm-version-transition true` only after the prior Fusion process is gone,
the queue is unpaused and has no active, blocked, leased or nonterminal work,
the current UI is idle, and every current document is unmodified. The broker records both identities and advances the
queue context epoch before readiness; it does not restart Fusion or discard
documents. Without this explicit confirmation, version changes remain fenced.

## Production composition

`queue-broker.js` installs the following hooks after coordinating its separate
lifecycle sections with the admission owner. Checker/physical dispatch changes
remain independent; administrative scope is never an exemption from checking
the final Python bytes.

1. Immediately after constructing `QueueState`, apply
   `if (options.startPaused === true) state.pause(true, 'startup:' + marker.nonce)`.
   Do not change pause otherwise. The autostart worker forwards this option.
   Run the startup probe through `gate.administrative` so a closed gate cannot
   deadlock startup before the IPC server exists. This does not resume the queue.
2. Construct `createAdmin` from `src/queue-console-admin` with the existing
   `state, gate, dir, marker`, `buildHash: codeHash`, `getContext: () =>
   ({active, busy, stopping, held})`, `setBusy: value => { busy = value; }`,
   `resumeCheck`, `close`, `diagnostics`, `durable`, `readJson`, `hash`.
   Its `observeControlCompletion` callback must read `control-resume.json`, call
   `remoteReceipt(record, false)` and return that ORIGINAL receipt. Clear `held`
   only after that terminal proof. Never invoke `resumeCheck` in this callback.
3. Construct `createLifecycleDispatcher` from
   `src/dist/node-adapters/broker-ipc/lifecycle` with this `admin`, `gate`, `dir`,
   `buildHash: codeHash`, `resumeCheck`, `diagnostics` and `canResume()` enforcing
   the existing held/blocked/localUnknown constraints.
4. After `auth(message)`, before the normal action switch:
   `if (lifecycleControl.accepts(message.action)) return
   lifecycleControl.handle(message, clientId)`.
   The dispatcher installs build/capabilities on gate snapshots. Do not advertise
   lifecycle capabilities without installing this dispatch path. Existing legacy
   `stop` is not the fenced shared control API; reset uses `console-stop`.
   In `submit`, reject `gate.adminTransition` with `BROKER_BUSY`, alongside the
   existing `stopping` guard, so no work races between stop ACK and deferred close.

`gate.adminTransition` prevents a concurrent pause/resume while an administrative
probe or release intent is pending. SDK grant/send and the checker remain owned
by their execution adapters and are not changed by this composition.

## Verification boundary

Lifecycle tests use private temporary queue directories, real Unix IPC and
owned fake child processes/physical backends. They do not restart shared user
services, invoke Fusion reset, or validate physical CAD geometry.
