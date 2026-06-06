import React from "react";
import { Text } from "ink";
import stringWidth from "string-width";
import { marked, type Token, type Tokens } from "marked";

/** Inline styling carried by a rendered span. Maps 1:1 onto Ink <Text> props
 *  in MarkdownRow. `dim` -> dimColor, `strike` -> strikethrough. */
export type Style = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  dim?: boolean;
  color?: string;
};

/** A styled run of text within a single visual row. */
export type Segment = { text: string; style?: Style };

/** One visual line. The caller windows over Row[] to implement scroll, so each
 *  Row MUST be exactly one terminal line (no embedded newlines, width already
 *  bounded). A Row with no segments (or only empty text) renders as a blank. */
export type Row = { segments: Segment[] };

/** Emoji -> ASCII replacements. Terminals disagree on whether emoji occupy 1 or
 *  2 cells (font + terminal + variation-selector dependent), so width-based
 *  wrapping with raw emoji leaves visible gaps at line breaks. We normalize to
 *  ASCII before parsing so cell counts are unambiguous and Ink's row-height
 *  layout stays stable. */
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

/** Decode the handful of HTML entities marked leaves encoded in token text, so
 *  the preview shows `&`/`<`/`>` rather than `&amp;`/`&lt;`/`&gt;`. */
function unesc(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'");
}

/**
 * Render markdown into a flat array of styled rows. Same contract as before
 * (text + width in, one Row per visual line out) so the caller's windowed
 * scroll is unchanged — but rows now carry inline styling parsed from the
 * markdown via `marked` (headings, bold/italic, inline code, lists,
 * blockquotes, code fences, rules, tables).
 *
 * Stays fully synchronous and in-process: marked.lexer is cheap at preview
 * sizes and re-runs in a useMemo on resize, so there's no subprocess or async
 * machinery to manage.
 */
export function renderMarkdown(text: string, width: number): Row[] {
  const max = Math.max(1, width);
  const rows: Row[] = [];
  let tokens: Token[];
  try {
    tokens = marked.lexer(asciifyEmoji(text));
  } catch {
    // Never let a parser hiccup blank the live preview — fall back to the old
    // plain-text behavior (one Row per source line, hard-wrapped).
    for (const line of asciifyEmoji(text).split("\n")) pushHardWrapped(rows, line, max);
    return rows;
  }
  renderBlocks(tokens, max, rows);
  // Collapse runs of blank lines to a single one. marked emits `space` tokens
  // AND we push a blank after paragraphs/headings, so adjacent blocks otherwise
  // accumulate double gaps.
  const collapsed: Row[] = [];
  for (const r of rows) {
    if (isBlank(r) && collapsed.length && isBlank(collapsed[collapsed.length - 1]!)) continue;
    collapsed.push(r);
  }
  // Trim leading/trailing blanks.
  while (collapsed.length && isBlank(collapsed[0]!)) collapsed.shift();
  trimTrailingBlanks(collapsed);
  return collapsed;
}

export function MarkdownRow({ row }: { row: Row }) {
  if (isBlank(row)) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {row.segments.map((s, i) => (
        <Text
          key={i}
          bold={s.style?.bold}
          italic={s.style?.italic}
          underline={s.style?.underline}
          strikethrough={s.style?.strike}
          dimColor={s.style?.dim}
          color={s.style?.color}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

// ---- block-level rendering ------------------------------------------------

function renderBlocks(tokens: Token[], max: number, rows: Row[]): void {
  for (const tk of tokens) {
    switch (tk.type) {
      case "space":
        rows.push(blank());
        break;
      case "heading": {
        const h = tk as Tokens.Heading;
        const style = headingStyle(h.depth);
        const marker: Segment = { text: "#".repeat(h.depth) + " ", style: { ...style, dim: true } };
        wrapInto(rows, [marker, ...inline(h.tokens, style)], max);
        rows.push(blank());
        break;
      }
      case "paragraph": {
        const p = tk as Tokens.Paragraph;
        wrapInto(rows, inline(p.tokens, {}), max);
        rows.push(blank());
        break;
      }
      case "text": {
        // Loose top-level text (e.g. inside a tight list); may or may not carry
        // inline tokens depending on context.
        const t = tk as Tokens.Text;
        const segs = t.tokens ? inline(t.tokens, {}) : [{ text: unesc(t.text) }];
        wrapInto(rows, segs, max);
        break;
      }
      case "blockquote": {
        const bq = tk as Tokens.Blockquote;
        const inner: Row[] = [];
        renderBlocks(bq.tokens, Math.max(1, max - 2), inner);
        trimTrailingBlanks(inner);
        for (const r of inner) {
          rows.push({ segments: [{ text: "| ", style: { dim: true } }, ...dimify(r.segments)] });
        }
        rows.push(blank());
        break;
      }
      case "list": {
        const list = tk as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        list.items.forEach((item, i) => {
          const marker = list.ordered ? `${start + i}. ` : "- ";
          renderListItem(item, marker, max, rows);
        });
        rows.push(blank());
        break;
      }
      case "code": {
        const code = tk as Tokens.Code;
        for (const ln of code.text.split("\n")) pushHardWrapped(rows, "  " + ln, max, { dim: true });
        rows.push(blank());
        break;
      }
      case "hr":
        rows.push({ segments: [{ text: "-".repeat(max), style: { dim: true } }] });
        rows.push(blank());
        break;
      case "table":
        renderTable(tk as Tokens.Table, max, rows);
        break;
      case "html": {
        const html = tk as Tokens.HTML;
        for (const ln of String(html.text).replace(/\n$/, "").split("\n")) {
          pushHardWrapped(rows, ln, max, { dim: true });
        }
        break;
      }
      default: {
        const raw = (tk as { raw?: string }).raw;
        if (typeof raw === "string" && raw.trim()) wrapInto(rows, [{ text: unesc(raw.trim()) }], max);
      }
    }
  }
}

function renderListItem(item: Tokens.ListItem, marker: string, max: number, rows: Row[]): void {
  const markerW = stringWidth(marker);
  const inner: Row[] = [];
  renderBlocks(item.tokens, Math.max(1, max - markerW), inner);
  trimTrailingBlanks(inner);
  if (inner.length === 0) inner.push(blank());
  inner.forEach((r, idx) => {
    // Marker on the first line; continuation (and nested-list) lines indent by
    // the marker's width so wrapped text and sublists line up under the content.
    const prefix: Segment =
      idx === 0 ? { text: marker, style: { dim: true } } : { text: " ".repeat(markerW) };
    rows.push({ segments: [prefix, ...r.segments] });
  });
}

function renderTable(tbl: Tokens.Table, max: number, rows: Row[]): void {
  wrapInto(rows, joinCells(tbl.header, { bold: true }), max);
  rows.push({ segments: [{ text: "-".repeat(max), style: { dim: true } }] });
  for (const row of tbl.rows) wrapInto(rows, joinCells(row, {}), max);
  rows.push(blank());
}

function joinCells(cells: Tokens.TableCell[], base: Style): Segment[] {
  const segs: Segment[] = [];
  cells.forEach((c, i) => {
    if (i > 0) segs.push({ text: " | ", style: { dim: true } });
    const cs = c.tokens?.length ? inline(c.tokens, base) : [{ text: unesc(c.text), style: base }];
    segs.push(...cs);
  });
  return segs;
}

// ---- inline-level rendering -----------------------------------------------

function inline(tokens: Token[] | undefined, base: Style): Segment[] {
  const out: Segment[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens) out.push(...inline(tt.tokens, base));
        else out.push({ text: unesc(tt.text), style: base });
        break;
      }
      case "escape":
        out.push({ text: (t as Tokens.Escape).text, style: base });
        break;
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, { ...base, bold: true }));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, { ...base, italic: true }));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, { ...base, strike: true, dim: true }));
        break;
      case "codespan":
        out.push({ text: unesc((t as Tokens.Codespan).text), style: { ...base, color: "yellow" } });
        break;
      case "link": {
        const lk = t as Tokens.Link;
        const linkStyle: Style = { ...base, color: "cyan", underline: true };
        if (lk.tokens?.length) out.push(...inline(lk.tokens, linkStyle));
        else out.push({ text: unesc(lk.text), style: linkStyle });
        break;
      }
      case "image":
        out.push({ text: `[${(t as Tokens.Image).text}]`, style: { ...base, dim: true } });
        break;
      case "br":
        // No newlines inside a logical line; soft-break becomes a space.
        out.push({ text: " ", style: base });
        break;
      case "html":
        out.push({ text: unesc(String((t as Tokens.HTML).text)), style: { ...base, dim: true } });
        break;
      default: {
        const any = t as { tokens?: Token[]; text?: string; raw?: string };
        if (any.tokens) out.push(...inline(any.tokens, base));
        else if (typeof any.text === "string") out.push({ text: unesc(any.text), style: base });
        else if (typeof any.raw === "string") out.push({ text: unesc(any.raw), style: base });
      }
    }
  }
  return out;
}

// ---- wrapping + helpers ---------------------------------------------------

/** Word-wrap a styled line to `max` cells and append the resulting Row(s).
 *  Styles are preserved across the wrap; over-long single words hard-break. */
function wrapInto(rows: Row[], segments: Segment[], max: number): void {
  for (const r of wrapSegments(segments, max)) rows.push(r);
}

type Word = { text: string; style?: Style; space: boolean };

function wrapSegments(segments: Segment[], width: number): Row[] {
  // Tokenize into words (and single-space separators), each keeping its style.
  const words: Word[] = [];
  for (const seg of segments) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (part === "") continue;
      const space = /^\s+$/.test(part);
      words.push({ text: space ? " " : part, style: seg.style, space });
    }
  }

  const out: Row[] = [];
  let line: Segment[] = [];
  let w = 0;
  const trimTrailingSpace = () => {
    for (let last = line[line.length - 1]; last && last.text === " "; last = line[line.length - 1]) {
      w -= 1;
      line.pop();
    }
  };
  const flush = () => {
    trimTrailingSpace();
    out.push({ segments: line });
    line = [];
    w = 0;
  };

  for (const tok of words) {
    if (tok.space) {
      if (w === 0) continue; // never start a line with a space
      if (w + 1 > width) {
        flush();
        continue;
      }
      line.push({ text: " ", style: tok.style });
      w += 1;
      continue;
    }
    const tw = stringWidth(tok.text);
    if (tw <= width) {
      if (w + tw > width) flush();
      line.push({ text: tok.text, style: tok.style });
      w += tw;
    } else {
      // Word wider than the whole line: hard-break it across rows.
      if (w > 0) flush();
      let rest = tok.text;
      while (stringWidth(rest) > width) {
        const cut = cutCells(rest, width);
        out.push({ segments: [{ text: rest.slice(0, cut), style: tok.style }] });
        rest = rest.slice(cut);
      }
      line.push({ text: rest, style: tok.style });
      w += stringWidth(rest);
    }
  }
  if (line.length) flush();
  if (out.length === 0) out.push(blank());
  return out;
}

/** Push raw text hard-wrapped at cell boundaries (no word breaking). Used for
 *  code fences and HTML, where whitespace and exact characters are meaningful. */
function pushHardWrapped(rows: Row[], text: string, max: number, style?: Style): void {
  let rest = text;
  if (rest === "") {
    rows.push({ segments: [{ text: "", style }] });
    return;
  }
  while (stringWidth(rest) > max) {
    const cut = cutCells(rest, max);
    rows.push({ segments: [{ text: rest.slice(0, cut), style }] });
    rest = rest.slice(cut);
  }
  rows.push({ segments: [{ text: rest, style }] });
}

/** Largest character-prefix of `s` whose cell width is <= max (hard cut). */
function cutCells(s: string, max: number): number {
  let cells = 0;
  let i = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (cells + cw > max) break;
    cells += cw;
    i += ch.length;
  }
  return Math.max(1, i);
}

function headingStyle(depth: number): Style {
  if (depth <= 1) return { bold: true, color: "cyan" };
  if (depth === 2) return { bold: true, color: "green" };
  if (depth === 3) return { bold: true, color: "yellow" };
  return { bold: true };
}

function dimify(segments: Segment[]): Segment[] {
  return segments.map((s) => ({ text: s.text, style: { ...s.style, dim: true, italic: true } }));
}

function blank(): Row {
  return { segments: [] };
}

function isBlank(row: Row): boolean {
  return row.segments.length === 0 || row.segments.every((s) => s.text === "");
}

function trimTrailingBlanks(rows: Row[]): void {
  for (let last = rows[rows.length - 1]; last && isBlank(last); last = rows[rows.length - 1]) {
    rows.pop();
  }
}
