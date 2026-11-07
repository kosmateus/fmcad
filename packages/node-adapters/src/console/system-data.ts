import type { ConsoleMetricsPort, ConsoleSnapshot } from "@fmcad/core";
import nodeOs from "node:os";
import nodeFs from "node:fs";
import { performance as nodePerformance } from "node:perf_hooks";

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const attempt = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export function parseProcStat(text: string) {
  if (typeof text !== "string" || text.lastIndexOf(")") < 0) return null;
  const fields = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  if (!/^\d+$/.test(fields[19] || "")) return null;
  const user = finite(Number(fields[11])),
    kernel = finite(Number(fields[12]));
  return {
    state: fields[0],
    start: fields[19],
    ticks: user === null || kernel === null ? null : user + kernel,
  };
}

export function parseNetwork(text: string, name: string | null) {
  if (typeof text !== "string" || !name) return null;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0 || line.slice(0, colon).trim() !== name) continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    const rx = finite(Number(fields[0])),
      tx = finite(Number(fields[8]));
    return rx === null || tx === null ? null : { name, rx, tx };
  }
  return null;
}

interface CollectorOptions {
  os?: typeof nodeOs;
  fs?: typeof nodeFs;
  process?: Pick<NodeJS.Process, "pid" | "memoryUsage" | "uptime" | "cpuUsage">;
  now?: () => number;
  performance?: { now(): number } | (() => number);
  clockTicks?: number;
  networkInterface?: string;
}
interface CpuSample {
  total: number;
  idle: number;
}
interface BrokerSample {
  identity: string;
  ticks: number | null;
}
interface PreviousSample {
  at: number | null;
  cpus: CpuSample[] | null;
  network: ReturnType<typeof parseNetwork>;
  panelCpu: number | null;
  pid: number | null;
  broker: BrokerSample | null;
  ticks: number | null;
}
export interface SystemMetrics {
  readAt: number | null;
  host: {
    hostname: string | null;
    cpuPercent: number | null;
    ramUsedBytes: number | null;
    ramTotalBytes: number | null;
    swapUsedBytes: number | null;
    swapTotalBytes: number | null;
    load: number[] | null;
    disk: {
      usedBytes: number | null;
      totalBytes: number | null;
      path: string | null;
    };
    network: {
      interface: string | null;
      rxBytesPerSecond: number | null;
      txBytesPerSecond: number | null;
    };
    uptimeSeconds: number | null;
    processCount: number | null;
  };
  panel: {
    pid: number | null;
    rssBytes: number | null;
    uptimeSeconds: number | null;
    cpuPercent: number | null;
  };
  broker: {
    pid: number | null;
    birth: string | null;
    alive: boolean | null;
    rssBytes: number | null;
    uptimeSeconds: number | null;
    cpuPercent: number | null;
  };
  locks: { status: string; reason: string };
}
export function createCollector(
  options: CollectorOptions = {},
): ConsoleMetricsPort<SystemMetrics> {
  const os = options.os || nodeOs,
    fs = options.fs || nodeFs;
  const proc = options.process || process,
    now = options.now || Date.now;
  const performance = options.performance || nodePerformance;
  const monotonic =
    typeof performance === "function" ? performance : () => performance.now();
  const linux = attempt(() => os.platform()) === "linux";
  const readText = (file: string) => fs.readFileSync(file, "utf8");
  let previous: PreviousSample | null = null;

  function clockTicks() {
    if (options.clockTicks !== undefined)
      return (finite(options.clockTicks) ?? 0) > 0 ? options.clockTicks : null;
    // AT_CLKTCK in the current process auxiliary vector is an OS-provided frequency, not a guessed HZ.
    return attempt(() => {
      const arch = os.arch(),
        word = [
          "x64",
          "arm64",
          "ppc64",
          "s390x",
          "riscv64",
          "loong64",
        ].includes(arch)
          ? 8
          : ["ia32", "arm"].includes(arch)
            ? 4
            : null;
      if (!word) return null;
      const data = fs.readFileSync("/proc/self/auxv"),
        le = os.endianness() === "LE";
      const get = (offset: number) =>
        word === 8
          ? Number(
              le ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset),
            )
          : le
            ? data.readUInt32LE(offset)
            : data.readUInt32BE(offset);
      for (
        let offset = 0;
        offset + word * 2 <= data.length;
        offset += word * 2
      ) {
        const type = get(offset);
        if (type === 0) break;
        if (type === 17) {
          const value = get(offset + word);
          return (finite(value) ?? 0) > 0 ? value : null;
        }
      }
      return null;
    });
  }

  function brokerSample(
    snapshot: ConsoleSnapshot,
    ticksPerSecond: number | null,
    hostUptime: number | null,
  ): { result: SystemMetrics["broker"]; sample: BrokerSample | null } {
    const result: SystemMetrics["broker"] = {
      pid: null,
      birth: null,
      alive: null,
      rssBytes: null,
      uptimeSeconds: null,
      cpuPercent: null,
    };
    const broker = snapshot["broker"] as {
      owner?: { pid: number; birth: string };
    } | null;
    const owner = snapshot.mode === "broker" ? broker?.owner : null;
    if (
      !owner ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.birth !== "string"
    )
      return { result, sample: null };
    result.pid = owner.pid;
    result.birth = owner.birth;
    if (!linux || !/^[a-fA-F0-9-]+:\d+$/.test(owner.birth))
      return { result, sample: null };
    try {
      const boot = readText("/proc/sys/kernel/random/boot_id").trim();
      const stat = parseProcStat(readText("/proc/" + owner.pid + "/stat"));
      if (!stat) return { result, sample: null };
      if (
        boot + ":" + stat.start !== owner.birth ||
        ["Z", "X", "x"].includes(stat.state || "")
      ) {
        result.alive = false;
        return { result, sample: null };
      }
      const status = attempt(() => readText("/proc/" + owner.pid + "/status"));
      const rss = status?.match(/^VmRSS:\s+(\d+)\s+kB\s*$/m);
      // Recheck identity after ancillary reads to avoid assigning another process's metrics after PID reuse.
      const after = parseProcStat(readText("/proc/" + owner.pid + "/stat"));
      if (
        !after ||
        after.start !== stat.start ||
        ["Z", "X", "x"].includes(after.state || "")
      )
        return { result, sample: null };
      result.alive = true;
      result.rssBytes = rss ? finite(Number(rss[1]) * 1024) : null;
      if (ticksPerSecond && hostUptime !== null)
        result.uptimeSeconds = finite(
          hostUptime - Number(stat.start) / ticksPerSecond,
        );
      return {
        result,
        sample: { identity: owner.pid + ":" + owner.birth, ticks: after.ticks },
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ESRCH"
      )
        result.alive = false;
      return { result, sample: null };
    }
  }

  return {
    read(snapshot: ConsoleSnapshot = {}) {
      const readAt = attempt(() => now()),
        at = attempt(monotonic);
      const elapsed =
        previous &&
        at !== null &&
        previous.at !== null &&
        Number.isFinite(at) &&
        Number.isFinite(previous.at) &&
        at > previous.at
          ? (at - previous.at) / 1000
          : null;
      const host: SystemMetrics["host"] = {
        hostname: attempt(() => os.hostname()),
        cpuPercent: null,
        ramUsedBytes: null,
        ramTotalBytes: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        load: null,
        disk: { usedBytes: null, totalBytes: null, path: null },
        network: {
          interface: null,
          rxBytesPerSecond: null,
          txBytesPerSecond: null,
        },
        uptimeSeconds: null,
        processCount: null,
      };
      const cpus = attempt(() => {
        const entries = os.cpus();
        if (!entries.length) return null;
        return entries.map((cpu) => {
          const times = (["user", "nice", "sys", "idle", "irq"] as const).map(
            (key) => finite(cpu.times[key]),
          );
          if (times.some((value) => value === null))
            throw new Error("Incomplete CPU counters");
          return {
            total: times.reduce<number>((sum, value) => sum + (value ?? 0), 0),
            idle: cpu.times.idle,
          };
        });
      });
      if (
        elapsed &&
        cpus &&
        previous?.cpus &&
        cpus.length === previous.cpus.length
      ) {
        const before = previous.cpus;
        const deltas = cpus.map((cpu, index) => ({
          total: cpu.total - before[index]!.total,
          idle: cpu.idle - before[index]!.idle,
        }));
        if (
          deltas.every(
            (delta) =>
              delta.total >= 0 && delta.idle >= 0 && delta.idle <= delta.total,
          )
        ) {
          const total = deltas.reduce((sum, delta) => sum + delta.total, 0),
            idle = deltas.reduce((sum, delta) => sum + delta.idle, 0);
          if (total > 0) host.cpuPercent = ((total - idle) / total) * 100;
        }
      }
      host.ramTotalBytes = finite(attempt(() => os.totalmem()));
      const free = finite(attempt(() => os.freemem()));
      if (
        host.ramTotalBytes !== null &&
        free !== null &&
        free <= host.ramTotalBytes
      )
        host.ramUsedBytes = host.ramTotalBytes - free;
      host.uptimeSeconds = finite(attempt(() => os.uptime()));
      if (attempt(() => os.platform()) !== "win32")
        host.load = attempt(() => {
          const values = os.loadavg();
          return values.length === 3 &&
            values.every((value) => finite(value) !== null)
            ? values
            : null;
        });
      if (typeof snapshot.project === "string" && snapshot.project) {
        host.disk.path = attempt(() => fs.realpathSync(snapshot.project!));
        if (host.disk.path) {
          const disk = attempt(() => fs.statfsSync(host.disk.path!));
          if (
            disk &&
            [disk.bsize, disk.blocks, disk.bfree].every(
              (value) => finite(value) !== null,
            ) &&
            disk.bfree <= disk.blocks
          ) {
            host.disk.totalBytes = finite(disk.bsize * disk.blocks);
            host.disk.usedBytes = finite(
              disk.bsize * (disk.blocks - disk.bfree),
            );
          }
        }
      }
      let network = null;
      if (linux) {
        const mem = attempt(() => readText("/proc/meminfo"));
        const total = mem?.match(/^SwapTotal:\s+(\d+)\s+kB\s*$/m),
          available = mem?.match(/^SwapFree:\s+(\d+)\s+kB\s*$/m);
        host.swapTotalBytes = total ? finite(Number(total[1]) * 1024) : null;
        const swapFree = available ? finite(Number(available[1]) * 1024) : null;
        if (
          host.swapTotalBytes !== null &&
          swapFree !== null &&
          swapFree <= host.swapTotalBytes
        )
          host.swapUsedBytes = host.swapTotalBytes - swapFree;
        host.processCount = attempt(
          () =>
            fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).length,
        );
        const name =
          options.networkInterface ||
          attempt(() => {
            const routes = readText("/proc/net/route")
              .trim()
              .split("\n")
              .slice(1)
              .map((line) => line.trim().split(/\s+/));
            return (
              routes.find(
                (row) =>
                  row[1] === "00000000" && parseInt(row[3] || "", 16) & 1,
              )?.[0] || null
            );
          });
        host.network.interface = name || null;
        network = attempt(() =>
          parseNetwork(readText("/proc/net/dev"), name ?? null),
        );
        if (
          elapsed &&
          network &&
          previous?.network?.name === network.name &&
          network.rx >= previous.network.rx &&
          network.tx >= previous.network.tx
        ) {
          host.network.rxBytesPerSecond =
            (network.rx - previous.network.rx) / elapsed;
          host.network.txBytesPerSecond =
            (network.tx - previous.network.tx) / elapsed;
        }
      }
      const panel: SystemMetrics["panel"] = {
        pid: Number.isSafeInteger(proc.pid) && proc.pid > 0 ? proc.pid : null,
        rssBytes: finite(attempt(() => proc.memoryUsage().rss)),
        uptimeSeconds: finite(attempt(() => proc.uptime())),
        cpuPercent: null,
      };
      const panelCpu = attempt(() => {
        const value = proc.cpuUsage();
        return finite(value.user) !== null && finite(value.system) !== null
          ? value.user + value.system
          : null;
      });
      if (
        elapsed &&
        panelCpu !== null &&
        previous &&
        previous.panelCpu !== null &&
        panelCpu >= previous.panelCpu &&
        previous.pid === panel.pid
      ) {
        panel.cpuPercent =
          ((panelCpu - previous.panelCpu) / (elapsed * 1000000)) * 100;
      }
      const ticks = linux ? clockTicks() : null;
      const broker = brokerSample(snapshot, ticks, host.uptimeSeconds);
      if (
        elapsed &&
        ticks &&
        previous?.ticks === ticks &&
        broker.sample &&
        previous.broker?.identity === broker.sample.identity &&
        broker.sample.ticks !== null &&
        previous.broker.ticks !== null &&
        broker.sample.ticks >= previous.broker.ticks
      ) {
        broker.result.cpuPercent =
          ((broker.sample.ticks - previous.broker.ticks) / ticks / elapsed) *
          100;
      }
      previous = {
        at,
        cpus,
        network,
        panelCpu,
        pid: panel.pid,
        broker: broker.sample,
        ticks,
      };
      return {
        readAt,
        host,
        panel,
        broker: broker.result,
        locks: { status: "unknown", reason: "NO_PASSIVE_LOCK_SOURCE" },
      };
    },
  };
}
