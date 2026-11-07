import { readFileSync } from "node:fs";

/** Stable for a single OS process lifetime, including on hosts without /proc. */
export function processBirthIdentity(pid = process.pid): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat
        .slice(end + 2)
        .trim()
        .split(/\s+/);
      const boot = readFileSync(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      ).trim();
      const startTicks = fields[19];
      if (end >= 0 && boot && startTicks) return `linux:${boot}:${startTicks}`;
    } catch {
      // Fall through for restricted procfs and non-Linux hosts.
    }
  }
  if (pid === process.pid)
    return `process:${pid}:${Math.floor(performance.timeOrigin)}:${process.execPath}`;
  return null;
}

export function processIsAlive(pid: number, birth: string): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const state = stat
          .slice(end + 2)
          .trim()
          .split(/\s+/, 1)[0];
        if (state === "Z" || state === "X") return false;
      } catch {
        // A restricted procfs does not invalidate a successful kill(pid, 0).
      }
    }
    const currentBirth = processBirthIdentity(pid);
    return currentBirth === null || currentBirth === birth;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}
