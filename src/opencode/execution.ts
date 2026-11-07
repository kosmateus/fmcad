import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

export const MAX_LOCAL_MS = 1_260_000
const DEFAULT_LOCAL_MS = 180_000
const MAX_RPC_MS = 1_200_000

type Run = {
  executable: string
  entry: string
  argv: string[]
  cwd: string
  timeout: number
  discovery: boolean
  output: string
  queueMode?: boolean
  metadata?: Record<string, unknown>
}

function cliTimeout(argv: string[]) {
  const index = argv.indexOf("--timeout")
  if (index < 0) return undefined
  const value = Number(argv[index + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("--timeout requires positive integer milliseconds")
  return value
}

export function executionBudget(argv: string[], requested?: number) {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1_000 || requested > MAX_LOCAL_MS)) throw new Error(`timeout_ms must be between 1000 and ${MAX_LOCAL_MS}`)
  const commandTimeout = cliTimeout(argv)
  if (requested !== undefined && commandTimeout !== undefined && requested <= commandTimeout) throw new Error("timeout_ms must leave a local reporting reserve beyond --timeout")
  const requestedRpc = Math.min(MAX_RPC_MS, requested ?? (commandTimeout === undefined ? DEFAULT_LOCAL_MS : commandTimeout))
  const reserve = Math.min(10_000, Math.floor(requestedRpc / 10))
  if (requested !== undefined && commandTimeout !== undefined && requested - commandTimeout < reserve) throw new Error("timeout_ms does not leave the required reporting reserve")
  const local_ms = Math.min(MAX_LOCAL_MS, requested ?? (commandTimeout === undefined ? DEFAULT_LOCAL_MS : Math.max(DEFAULT_LOCAL_MS, commandTimeout + 60_000)))
  const rpc_ms = Math.max(1_000, requestedRpc - reserve)
  const cleanArgv = [...argv]
  const index = cleanArgv.indexOf("--timeout")
  if (index >= 0) cleanArgv.splice(index, 2)
  cleanArgv.push("--timeout", String(rpc_ms))
  return { argv: cleanArgv, local_ms, rpc_ms, reporting_reserve_ms: reserve }
}

function resultRecord(state: string, values: Record<string, unknown> = {}) {
  return { state, mayHaveMutated: state !== "NOT_STARTED", modelValidated: false, ...values }
}

export async function invoke(run: Run, ctx: any, spawnImpl: typeof nodeSpawn = nodeSpawn, readClock?: () => number) {
  const started = Number(process.hrtime.bigint()) / 1e6
  const id = randomUUID()
  const outRoot = run.output || join(tmpdir(), "fmcad-output")
  await mkdir(outRoot, { recursive: true })
  const artifactDir = await mkdtemp(join(outRoot, `${id}-`).replace(/\/$/, ""))
  const requestArtifact = join(artifactDir, "request.json")
  const resultArtifact = join(artifactDir, "result.json")
  await writeFile(requestArtifact, JSON.stringify({ id, cwd: run.cwd, argv: run.argv, startedAt: Date.now(), metadata: run.metadata ?? {} }), { flag: "wx", mode: 0o600 })
  const remaining = Math.max(0, run.timeout - (Number(process.hrtime.bigint()) / 1e6 - started))
  if (ctx.abort?.aborted || remaining <= 0) {
    const result = resultRecord("NOT_STARTED", { reason: ctx.abort?.aborted ? "aborted" : "timeout", mayHaveMutated: false, requestArtifact })
    await writeFile(resultArtifact, JSON.stringify(result), { mode: 0o600 })
    return JSON.stringify({ ...result, resultArtifact })
  }

  let targetClock: number
  try {
    targetClock = readClock ? readClock() : Number(execFileSync(run.executable, ["-p", "Number(process.hrtime.bigint()) / 1e6"], { encoding: "utf8", timeout: Math.min(2_000, remaining), maxBuffer: 1024 }).trim())
    if (!Number.isFinite(targetClock) || targetClock <= 0) throw new Error("invalid target Node monotonic clock")
  } catch (error) {
    const result = resultRecord("NOT_STARTED", { reason: "clock_probe_failed", mayHaveMutated: false, error: String(error), requestArtifact })
    await writeFile(resultArtifact, JSON.stringify(result), { mode: 0o600 })
    return JSON.stringify({ ...result, resultArtifact })
  }
  if (ctx.abort?.aborted) {
    const result = resultRecord("NOT_STARTED", { reason: "aborted", mayHaveMutated: false, requestArtifact })
    await writeFile(resultArtifact, JSON.stringify(result), { mode: 0o600 })
    return JSON.stringify({ ...result, resultArtifact })
  }

  const now = Number(process.hrtime.bigint()) / 1e6
  const reserve = Math.min(5_000, Math.floor(run.timeout / 20))
  const deadline = targetClock + remaining - reserve + (now - started)
  const stdoutPath = join(artifactDir, "stdout.log"), stderrPath = join(artifactDir, "stderr.log")
  const stdoutFile = await writeFile(stdoutPath, "", { mode: 0o600 }).then(() => stdoutPath)
  const stderrFile = await writeFile(stderrPath, "", { mode: 0o600 }).then(() => stderrPath)
  let stdout = "", stderr = "", truncated = false, reason: string | undefined
  const cap = 16 * 1024 * 1024
  const args = [run.entry, ...run.argv]
  const options = { cwd: run.cwd, shell: false, detached: process.platform !== "win32", env: { ...process.env, FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS: String(deadline) }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] }
  let child: ChildProcess
  try { child = spawnImpl(run.executable, args, options) }
  catch (error) {
    const result = resultRecord("NOT_STARTED", { reason: "spawn_failed", mayHaveMutated: false, error: String(error), requestArtifact })
    await writeFile(resultArtifact, JSON.stringify(result), { mode: 0o600 })
    return JSON.stringify({ ...result, resultArtifact })
  }
  const append = (which: "stdout" | "stderr", chunk: Buffer) => {
    const value = which === "stdout" ? stdout : stderr
    const next = value + chunk.toString("utf8")
    if (Buffer.byteLength(next) > cap) {
      const tail = Buffer.from(next).subarray(-cap).toString("utf8")
      if (which === "stdout") stdout = tail; else stderr = tail
      truncated = true
    } else if (which === "stdout") stdout = next; else stderr = next
  }
  child.stdout?.on("data", chunk => append("stdout", Buffer.from(chunk)))
  child.stderr?.on("data", chunk => append("stderr", Buffer.from(chunk)))
  let timer: NodeJS.Timeout
  const abort = () => { reason = "aborted"; terminate() }
  const terminate = () => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
      else child.kill("SIGTERM")
    } catch { try { child.kill("SIGTERM") } catch {} }
    setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL") } catch {} }, 1_000).unref()
  }
  timer = setTimeout(() => { reason = "timeout"; terminate() }, run.timeout)
  ctx.abort?.addEventListener("abort", abort, { once: true })
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
  }).catch(error => { reason ??= "spawn_failed"; return [null, null] as [number | null, NodeJS.Signals | null] })
  clearTimeout(timer)
  ctx.abort?.removeEventListener("abort", abort)
  await Promise.all([writeFile(stdoutFile, stdout, { mode: 0o600 }), writeFile(stderrFile, stderr, { mode: 0o600 })])
  let domainOutcome: any
  for (const match of stdout.matchAll(/FMCAD_RESULT\s+(\{[^\n]*\})/g)) { try { domainOutcome = JSON.parse(match[1]) } catch {} }
  if (!domainOutcome) {
    const candidates = [...stdout.matchAll(/\{\s*"(?:success|error)"[\s\S]*?\n\}/g)].map(match => match[0])
    for (const parsed of candidates.reverse()) { try { domainOutcome = JSON.parse(parsed); break } catch {} }
  }
  const state = reason === "timeout" ? "UNKNOWN" : reason === "aborted" ? "UNKNOWN" : "CLI_EXITED"
  const result = resultRecord(state, { reason, exitCode: code, signal, mayHaveMutated: run.discovery ? false : state !== "NOT_STARTED", elapsed_ms: Number(process.hrtime.bigint()) / 1e6 - started,
    domainOutcome, requestArtifact, resultArtifact, stdout: { tail: stdout.slice(-20_000), artifactTruncated: truncated, tailArtifact: truncated ? stdoutFile : undefined },
    stderr: { tail: stderr.slice(-20_000), artifactTruncated: truncated, tailArtifact: truncated ? stderrFile : undefined } })
  await writeFile(resultArtifact, JSON.stringify(result), { mode: 0o600 })
  return JSON.stringify(result)
}
