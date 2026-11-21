/*
	String Kit

	Copyright (c) 2014 - 2021 Cédric Ronvel

	The MIT License (MIT)

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
*/
// Adapted from String Kit's pinned Unicode width rules. Keep historical layout
// stable independently of the retired terminal renderer; see NOTICE.md.
const isZeroWidthDiacriticCodePoint = (code: number): boolean =>
  // Combining Diacritical Marks
  (0x300 <= code && code <= 0x36f) ||
  // Combining Diacritical Marks Extended
  (0x1ab0 <= code && code <= 0x1aff) ||
  // Combining Diacritical Marks Supplement
  (0x1dc0 <= code && code <= 0x1dff) ||
  // Combining Diacritical Marks for Symbols
  (0x20d0 <= code && code <= 0x20ff) ||
  // Combining Half Marks
  (0xfe20 <= code && code <= 0xfe2f) ||
  // Dakuten and handakuten (japanese)
  code === 0x3099 ||
  code === 0x309a ||
  // Devanagari
  (0x900 <= code && code <= 0x903) ||
  (0x93a <= code && code <= 0x957 && code !== 0x93d && code !== 0x950) ||
  code === 0x962 ||
  code === 0x963 ||
  // Thai
  code === 0xe31 ||
  (0xe34 <= code && code <= 0xe3a) ||
  (0xe47 <= code && code <= 0xe4e);
const isEmojiCodePoint = (code: number): boolean =>
  // Miscellaneous symbols
  (0x2600 <= code && code <= 0x26ff) ||
  // Dingbats
  (0x2700 <= code && code <= 0x27bf) ||
  // Emoji
  (0x1f000 <= code && code <= 0x1f1ff) ||
  (0x1f300 <= code && code <= 0x1f3fa) ||
  (0x1f400 <= code && code <= 0x1faff);
const isEmojiModifierCodePoint = (code: number): boolean =>
  (0x1f3fb <= code && code <= 0x1f3ff) || // (Fitzpatrick): https://en.wikipedia.org/wiki/Miscellaneous_Symbols_and_Pictographs#Emoji_modifiers
  code === 0xfe0f;
const emojiRanges: readonly { s: number; e: number; w: number }[] = [
  { s: 9728, e: 9747, w: 1 },
  { s: 9748, e: 9749, w: 2 },
  { s: 9750, e: 9799, w: 1 },
  { s: 9800, e: 9811, w: 2 },
  { s: 9812, e: 9854, w: 1 },
  { s: 9855, e: 9855, w: 2 },
  { s: 9856, e: 9874, w: 1 },
  { s: 9875, e: 9875, w: 2 },
  { s: 9876, e: 9888, w: 1 },
  { s: 9889, e: 9889, w: 2 },
  { s: 9890, e: 9897, w: 1 },
  { s: 9898, e: 9899, w: 2 },
  { s: 9900, e: 9916, w: 1 },
  { s: 9917, e: 9918, w: 2 },
  { s: 9919, e: 9923, w: 1 },
  { s: 9924, e: 9925, w: 2 },
  { s: 9926, e: 9933, w: 1 },
  { s: 9934, e: 9934, w: 2 },
  { s: 9935, e: 9939, w: 1 },
  { s: 9940, e: 9940, w: 2 },
  { s: 9941, e: 9961, w: 1 },
  { s: 9962, e: 9962, w: 2 },
  { s: 9963, e: 9969, w: 1 },
  { s: 9970, e: 9971, w: 2 },
  { s: 9972, e: 9972, w: 1 },
  { s: 9973, e: 9973, w: 2 },
  { s: 9974, e: 9977, w: 1 },
  { s: 9978, e: 9978, w: 2 },
  { s: 9979, e: 9980, w: 1 },
  { s: 9981, e: 9981, w: 2 },
  { s: 9982, e: 9983, w: 1 },
  { s: 9984, e: 9988, w: 1 },
  { s: 9989, e: 9989, w: 2 },
  { s: 9990, e: 9993, w: 1 },
  { s: 9994, e: 9995, w: 2 },
  { s: 9996, e: 10023, w: 1 },
  { s: 10024, e: 10024, w: 2 },
  { s: 10025, e: 10059, w: 1 },
  { s: 10060, e: 10060, w: 2 },
  { s: 10061, e: 10061, w: 1 },
  { s: 10062, e: 10062, w: 2 },
  { s: 10063, e: 10066, w: 1 },
  { s: 10067, e: 10069, w: 2 },
  { s: 10070, e: 10070, w: 1 },
  { s: 10071, e: 10071, w: 2 },
  { s: 10072, e: 10132, w: 1 },
  { s: 10133, e: 10135, w: 2 },
  { s: 10136, e: 10159, w: 1 },
  { s: 10160, e: 10160, w: 2 },
  { s: 10161, e: 10174, w: 1 },
  { s: 10175, e: 10175, w: 2 },
  { s: 126976, e: 126979, w: 1 },
  { s: 126980, e: 126980, w: 2 },
  { s: 126981, e: 127182, w: 1 },
  { s: 127183, e: 127183, w: 2 },
  { s: 127184, e: 127373, w: 1 },
  { s: 127374, e: 127374, w: 2 },
  { s: 127375, e: 127376, w: 1 },
  { s: 127377, e: 127386, w: 2 },
  { s: 127387, e: 127487, w: 1 },
  { s: 127744, e: 127776, w: 2 },
  { s: 127777, e: 127788, w: 1 },
  { s: 127789, e: 127797, w: 2 },
  { s: 127798, e: 127798, w: 1 },
  { s: 127799, e: 127868, w: 2 },
  { s: 127869, e: 127869, w: 1 },
  { s: 127870, e: 127891, w: 2 },
  { s: 127892, e: 127903, w: 1 },
  { s: 127904, e: 127946, w: 2 },
  { s: 127947, e: 127950, w: 1 },
  { s: 127951, e: 127955, w: 2 },
  { s: 127956, e: 127967, w: 1 },
  { s: 127968, e: 127984, w: 2 },
  { s: 127985, e: 127987, w: 1 },
  { s: 127988, e: 127988, w: 2 },
  { s: 127989, e: 127991, w: 1 },
  { s: 127992, e: 127994, w: 2 },
  { s: 128000, e: 128062, w: 2 },
  { s: 128063, e: 128063, w: 1 },
  { s: 128064, e: 128064, w: 2 },
  { s: 128065, e: 128065, w: 1 },
  { s: 128066, e: 128252, w: 2 },
  { s: 128253, e: 128254, w: 1 },
  { s: 128255, e: 128317, w: 2 },
  { s: 128318, e: 128330, w: 1 },
  { s: 128331, e: 128334, w: 2 },
  { s: 128335, e: 128335, w: 1 },
  { s: 128336, e: 128359, w: 2 },
  { s: 128360, e: 128377, w: 1 },
  { s: 128378, e: 128378, w: 2 },
  { s: 128379, e: 128404, w: 1 },
  { s: 128405, e: 128406, w: 2 },
  { s: 128407, e: 128419, w: 1 },
  { s: 128420, e: 128420, w: 2 },
  { s: 128421, e: 128506, w: 1 },
  { s: 128507, e: 128591, w: 2 },
  { s: 128592, e: 128639, w: 1 },
  { s: 128640, e: 128709, w: 2 },
  { s: 128710, e: 128715, w: 1 },
  { s: 128716, e: 128716, w: 2 },
  { s: 128717, e: 128719, w: 1 },
  { s: 128720, e: 128722, w: 2 },
  { s: 128723, e: 128724, w: 1 },
  { s: 128725, e: 128727, w: 2 },
  { s: 128728, e: 128746, w: 1 },
  { s: 128747, e: 128748, w: 2 },
  { s: 128749, e: 128755, w: 1 },
  { s: 128756, e: 128764, w: 2 },
  { s: 128765, e: 128991, w: 1 },
  { s: 128992, e: 129003, w: 2 },
  { s: 129004, e: 129291, w: 1 },
  { s: 129292, e: 129338, w: 2 },
  { s: 129339, e: 129339, w: 1 },
  { s: 129340, e: 129349, w: 2 },
  { s: 129350, e: 129350, w: 1 },
  { s: 129351, e: 129400, w: 2 },
  { s: 129401, e: 129401, w: 1 },
  { s: 129402, e: 129483, w: 2 },
  { s: 129484, e: 129484, w: 1 },
  { s: 129485, e: 129535, w: 2 },
  { s: 129536, e: 129647, w: 1 },
  { s: 129648, e: 129652, w: 2 },
  { s: 129653, e: 129655, w: 1 },
  { s: 129656, e: 129658, w: 2 },
  { s: 129659, e: 129663, w: 1 },
  { s: 129664, e: 129670, w: 2 },
  { s: 129671, e: 129679, w: 1 },
  { s: 129680, e: 129704, w: 2 },
  { s: 129705, e: 129711, w: 1 },
  { s: 129712, e: 129718, w: 2 },
  { s: 129719, e: 129727, w: 1 },
  { s: 129728, e: 129730, w: 2 },
  { s: 129731, e: 129743, w: 1 },
  { s: 129744, e: 129750, w: 2 },
  { s: 129751, e: 129791, w: 1 },
];
const emojiWidthLookup = new Map<number, number>();
for (const range of emojiRanges)
  for (let code = range.s; code <= range.e; code++)
    emojiWidthLookup.set(code, range.w);
function codePointWidth(code: number): number {
  // Assuming all emoji are wide here
  if (isEmojiCodePoint(code)) {
    return emojiWidthLookup.get(code) ?? 2;
  }

  // Code points are derived from:
  // http://www.org/Public/UNIDATA/EastAsianWidth.txt
  if (
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      code === 0x2329 || // LEFT-POINTING ANGLE BRACKET
      code === 0x232a || // RIGHT-POINTING ANGLE BRACKET
      // CJK Radicals Supplement .. Enclosed CJK Letters and Months
      (0x2e80 <= code && code <= 0x3247 && code !== 0x303f) ||
      // Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
      (0x3250 <= code && code <= 0x4dbf) ||
      // CJK Unified Ideographs .. Yi Radicals
      (0x4e00 <= code && code <= 0xa4c6) ||
      // Hangul Jamo Extended-A
      (0xa960 <= code && code <= 0xa97c) ||
      // Hangul Syllables
      (0xac00 <= code && code <= 0xd7a3) ||
      // CJK Compatibility Ideographs
      (0xf900 <= code && code <= 0xfaff) ||
      // Vertical Forms
      (0xfe10 <= code && code <= 0xfe19) ||
      // CJK Compatibility Forms .. Small Form Variants
      (0xfe30 <= code && code <= 0xfe6b) ||
      // Halfwidth and Fullwidth Forms
      (0xff01 <= code && code <= 0xff60) ||
      (0xffe0 <= code && code <= 0xffe6) ||
      // Kana Supplement
      (0x1b000 <= code && code <= 0x1b001) ||
      // Enclosed Ideographic Supplement
      (0x1f200 <= code && code <= 0x1f251) ||
      // CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
      (0x20000 <= code && code <= 0x3fffd))
  ) {
    return 2;
  }

  if (isEmojiModifierCodePoint(code) || isZeroWidthDiacriticCodePoint(code)) {
    return 0;
  }

  return 1;
}

function ansiCharacters(text: string): string[] {
  const result: string[] = [];
  let sequence = "",
    csi = false;
  for (const char of text) {
    if (csi) {
      sequence += char;
      if (/[A-Za-z]/.test(char)) {
        result.push(sequence);
        sequence = "";
        csi = false;
      }
    } else if (sequence) {
      sequence += char;
      if (char === "[") csi = true;
      else {
        result.push(sequence);
        sequence = "";
      }
    } else if (char === "\x1b") sequence = char;
    else result.push(char);
  }
  // As in the retained renderer, incomplete escape sequences are not emitted.
  return result;
}
function wrapLine(text: string, requestedWidth: number): string[] {
  const width = requestedWidth > 0 ? requestedWidth : 80;
  const chars = ansiCharacters(text),
    lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    if (lines.length) while (chars[start] === " ") start++;
    if (start === chars.length) break;
    let end = start,
      lastSpace = start,
      used = 0;
    for (; end < chars.length; end++) {
      const char = chars[end]!;
      if (char === " " && !["!", "?", ":", ";"].includes(chars[end + 1] ?? ""))
        lastSpace = end;
      used += char.startsWith("\x1b")
        ? 0
        : codePointWidth(char.codePointAt(0)!);
      if (used > width) {
        if (lastSpace !== start) end = lastSpace;
        break;
      }
    }
    lines.push(chars.slice(start, end).join("").trimEnd());
    start = end;
  }
  return lines.length ? lines : [""];
}
export function formatHelp(text: string, width = 80): string {
  return text
    .split("\n")
    .flatMap((line) =>
      !line || /^\s|^[{[]/.test(line)
        ? [line]
        : wrapLine(line, Math.max(40, width)),
    )
    .join("\n");
}
