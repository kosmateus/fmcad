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
