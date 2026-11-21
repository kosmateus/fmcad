import type { ConsoleRow } from "./console-read-model";

/** Input must already be redacted and stripped of terminal controls by the edge. */
export function parseConsoleLog(raw: string): ConsoleRow {
  const match = raw.match(
    /^(\S+)\s+(INFO|WARN|ERROR|DEBUG|TRACE)\s+(\S+)\s*(.*)$/,
  );
  const explicit = raw.match(/\bcomponent=([^\s]+)/)?.[1];
  const componentToken =
    match &&
    ["broker", "fusion", "client", "admin", "observer"].includes(
      match[3] || "",
    );
  const row: ConsoleRow = {
    timestamp: match?.[1] || null,
    level: match?.[2] || "OTHER",
    component:
      explicit || (componentToken ? match[3] || "project-log" : "project-log"),
    message: match
      ? componentToken
        ? match[4] || ""
        : match[3] + " " + match[4]
      : raw,
  };
  if (match && !componentToken && match[3]) row.event = match[3];
  for (const [key, pattern] of Object.entries({
    taskId: /\b(?:job|jobId|job_id|task|taskId|task_id)=([^\s]+)/,
    agentId: /\b(?:client|agent)=([^\s]+)/,
    requestId: /\b(?:request|requestId|request_id)=([^\s]+)/,
  })) {
    const value = raw.match(pattern)?.[1];
    if (value) row[key] = value;
  }
  return row;
}

const events: Record<"en" | "pl", Record<string, string>> = {
  en: {
    job_queued: "Task queued",
    job_running: "Execution started",
    job_sending: "Dispatching call",
    job_succeeded: "Task completed",
    job_failed: "Task failed",
    job_cancelled: "Queued task cancelled",
    job_expired: "Queue budget expired",
    job_needs_reconciliation: "Outcome unresolved",
    job_attached: "Attached to existing task",
    job_progress: "Task observation",
    client_requested: "Client invoked fmcad",
    client_finished: "Client invocation ended",
    client_failed: "Client invocation failed",
    broker_observed: "Broker observed",
    heartbeat: "Observer heartbeat",
    snapshot_unavailable: "Snapshot unavailable",
    snapshot_read_recovered: "Snapshot reads recovered",
  },
  pl: {
    job_queued: "Zadanie przyjęte do kolejki",
    job_running: "Rozpoczęto wykonanie",
    job_sending: "Wysyłanie wywołania",
    job_succeeded: "Zadanie zakończone",
    job_failed: "Zadanie zakończone błędem",
    job_cancelled: "Anulowano oczekujące zadanie",
    job_expired: "Upłynął budżet kolejki",
    job_needs_reconciliation: "Wynik nierozstrzygnięty",
    job_attached: "Dołączono do istniejącego zadania",
    job_progress: "Obserwacja zadania",
    client_requested: "Klient wywołał fmcad",
    client_finished: "Zakończono wywołanie klienta",
    client_failed: "Błąd wywołania klienta",
    broker_observed: "Zaobserwowano broker",
    heartbeat: "Sygnał obserwatora",
    snapshot_unavailable: "Migawka niedostępna",
    snapshot_read_recovered: "Odczyt migawek przywrócony",
  },
};
export function logMessage(row: ConsoleRow, language = "en") {
  const text = events[language === "pl" ? "pl" : "en"][row.event ?? ""];
  if (!text) return row.message || "";
  const fields = Object.fromEntries(
    [...String(row.message).matchAll(/\b([a-z_]+)=([^\s]+)/g)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
  const pl = language === "pl",
    parts: string[] = [];
  if (fields["broker_process"])
    parts.push(
      "broker: " +
        (fields["broker_process"] === "alive"
          ? pl
            ? "proces działa"
            : "process alive"
          : fields["broker_process"] === "absent"
            ? pl
              ? "zatrzymany"
              : "stopped"
            : fields["broker_process"]),
    );
  if (/^\d+$/.test(fields["queued"] || ""))
    parts.push((pl ? "oczekujące " : "queued ") + fields["queued"]);
  if (/^\d+$/.test(fields["active"] || ""))
    parts.push((pl ? "aktywne " : "active ") + fields["active"]);
  if (fields["paused"] === "true") parts.push(pl ? "pauza" : "paused");
  if (fields["global_blocked"] === "true")
    parts.push(pl ? "wymaga uzgodnienia" : "reconciliation required");
  if (row.taskId)
    parts.push((pl ? "zadanie " : "task ") + row.taskId.slice(0, 8));
  if (fields["code"]) parts.push(fields["code"]);
  if (fields["stage"]) parts.push(fields["stage"]);
  if (fields["active_ms"] && /^\d+$/.test(fields["active_ms"]))
    parts.push(fields["active_ms"] + " ms");
  if (fields["rpc"] || fields["ack"])
    parts.push(`RPC ${fields["ack"] || "—"}/${fields["rpc"] || "—"}`);
  return text + (parts.length ? " · " + parts.join(" · ") : "");
}
