import { createRequire } from "node:module";
// Pure text layout, independent of the terminal renderer and all live services.
const { wordWrapAnsi } = createRequire(__filename)("terminal-kit/lib/misc") as {
  wordWrapAnsi(text: string, width: number): string[];
};
export function formatHelp(text: string, width = 80): string {
  return text
    .split("\n")
    .flatMap((line) =>
      !line || /^\s|^[{[]/.test(line)
        ? [line]
        : wordWrapAnsi(line, Math.max(40, width)).map((part) => part.trimEnd()),
    )
    .join("\n");
}
