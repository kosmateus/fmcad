import type { ConsoleRow, ConsoleSnapshot } from "./console-read-model";

export function responseTaskError(
  row: ConsoleRow,
  snapshot: ConsoleSnapshot,
  retained?: ConsoleRow | null,
): string | null {
  if (snapshot.mode !== "broker") return "DIRECT_RESPONSE_NOT_RETAINED";
  if (
    !/^[a-zA-Z0-9_-]+$/.test(row.id || "") ||
    !snapshot.operations?.some((item) => item.id === row.id)
  )
    return "TASK_NOT_IN_SNAPSHOT";
  if (retained !== undefined && (!retained || retained.id !== row.id))
    return "TASK_NO_LONGER_RETAINED";
  return null;
}
export function jsonLines(text: string) {
  return text.split("\n").map((line) => {
    const spans: { text: string; tone: string }[] = [];
    let end = 0;
    const tokens =
      /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    for (const match of line.matchAll(tokens)) {
      if (match.index > end)
        spans.push({ text: line.slice(end, match.index), tone: "text" });
      const value = match[0],
        key =
          value.startsWith('"') &&
          /^\s*:/.test(line.slice(match.index + value.length));
      spans.push({
        text: value,
        tone: key
          ? "syntaxKey"
          : value.startsWith('"')
            ? "success"
            : /^(true|false|null)$/.test(value)
              ? "syntaxKeyword"
              : "warning",
      });
      end = match.index + value.length;
    }
    if (end < line.length) spans.push({ text: line.slice(end), tone: "text" });
    return spans;
  });
}
