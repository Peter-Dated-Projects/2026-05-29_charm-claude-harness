import React from "react";
import { Text } from "ink";
import stringWidth from "string-width";

export type Row = { text: string };

/** Render plain text into a flat array of cell-wrapped rows.
 *  No markdown styling — one visual line per Row. The caller windows over them
 *  to implement scroll. */
/** Emoji → ASCII replacements. Terminals disagree on whether ✅/⏭/etc. occupy
 *  1 or 2 cells (it depends on font + terminal + variation-selector handling),
 *  so width-based wrapping with raw emojis leaves visible gaps at line breaks.
 *  We normalize to ASCII before wrapping so cell counts are unambiguous. */
const EMOJI_REPLACEMENTS: [RegExp, string][] = [
  [/✅/g, "[x]"],
  [/❌/g, "[ ]"],
  [/⏭️?/g, ">>"],
  [/⏩/g, ">>"],
  [/⚠️?/g, "(!)"],
  [/✨/g, "*"],
  [/⭐/g, "*"],
  [/🚀/g, "->"],
  [/🔥/g, "(!)"],
  [/📝/g, "[ ]"],
  [/📌/g, "*"],
  [/🐛/g, "(bug)"],
  [/💡/g, "(i)"],
  [/▶️?/g, ">"],
  [/◀️?/g, "<"],
];

function asciifyEmoji(s: string): string {
  let out = s;
  for (const [re, repl] of EMOJI_REPLACEMENTS) out = out.replace(re, repl);
  // Catch-all: any remaining Extended_Pictographic codepoint becomes `·`.
  // Also strip variation selectors (U+FE0E/U+FE0F) so leftover ones don't
  // confuse string-width.
  out = out.replace(/\p{Extended_Pictographic}/gu, "·");
  out = out.replace(/[︎️]/g, "");
  return out;
}

export function renderMarkdown(text: string, width: number): Row[] {
  const max = Math.max(1, width);
  const rows: Row[] = [];
  for (const rawLine of asciifyEmoji(text).split("\n")) {
    if (rawLine === "") {
      rows.push({ text: "" });
      continue;
    }
    // wrap each source line to `max` cells, breaking on words when possible.
    let remaining = rawLine;
    while (stringWidth(remaining) > max) {
      const cut = breakAt(remaining, max);
      rows.push({ text: remaining.slice(0, cut).trimEnd() });
      remaining = remaining.slice(cut).replace(/^\s+/, "");
    }
    rows.push({ text: remaining });
  }
  return rows;
}

export function MarkdownRow({ row }: { row: Row }) {
  return <Text wrap="truncate-end">{row.text === "" ? " " : row.text}</Text>;
}

/** Find the largest prefix of `s` (in characters) whose cell width is <= max,
 *  preferring to break at the last whitespace within that window. */
function breakAt(s: string, max: number): number {
  let cells = 0;
  let lastSpace = -1;
  let i = 0;
  for (const ch of s) {
    const w = stringWidth(ch);
    if (cells + w > max) break;
    cells += w;
    i += ch.length;
    if (/\s/.test(ch)) lastSpace = i;
  }
  // If we found a space and it's not too far back, break there.
  if (lastSpace > 0 && lastSpace >= Math.floor(max * 0.5)) return lastSpace;
  // Otherwise hard-break at the cell boundary.
  return Math.max(1, i);
}
