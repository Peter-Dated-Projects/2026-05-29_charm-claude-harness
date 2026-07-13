#!/usr/bin/env bun
import React, { useState } from "react";
import { render, Box, Text, useInput } from "ink";
import type { BriefMeta } from "../store/briefs.ts";

/** What the picker resolves to. The CLI turns `create` into a scaffold + $EDITOR
 *  open, `select` into a brief read, and `abort` into a clean bail-out. */
export type PickResult =
  | { action: "select"; slug: string }
  | { action: "create"; name: string }
  | { action: "abort" };

function ProjectPicker({
  initialBriefs,
  onDelete,
  onResolve,
}: {
  initialBriefs: BriefMeta[];
  onDelete: (slug: string) => void;
  onResolve: (r: PickResult) => void;
}) {
  // Briefs live in local state so a delete removes the row immediately without
  // re-opening the picker. Seeded from the on-disk listing passed in.
  const [briefs, setBriefs] = useState(initialBriefs);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Slug armed for deletion: first `x` arms (turns the row red), second `x`
  // deletes. Any navigation or edit disarms so you can't delete the wrong row.
  const [armed, setArmed] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? briefs.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.slug.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q),
      )
    : briefs;

  // The create entry sits at the end of the list. It's actionable only with a
  // non-empty query (which becomes the new project's name) — so the flow to make
  // a brand-new brief is: type its name (filters to nothing), then Enter.
  const canCreate = query.trim().length > 0;
  const rowCount = filtered.length + 1; // +1 for the create row
  const clamped = Math.max(0, Math.min(index, rowCount - 1));
  const onCreateRow = clamped === filtered.length;
  const current = onCreateRow ? null : filtered[clamped];

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onResolve({ action: "abort" });
      return;
    }
    // Delete: `x` is a command key here (it does NOT type into the filter). First
    // press on a brief arms it; second press on the same brief deletes it.
    if (input === "x" && !key.ctrl && !key.meta) {
      if (!current) return; // create row / empty list — nothing to delete
      if (armed === current.slug) {
        onDelete(current.slug);
        setBriefs((prev) => prev.filter((b) => b.slug !== current.slug));
        setArmed(null);
      } else {
        setArmed(current.slug);
      }
      return;
    }
    if (key.upArrow) {
      setArmed(null);
      setIndex(Math.max(0, clamped - 1));
      return;
    }
    if (key.downArrow) {
      setArmed(null);
      setIndex(Math.min(rowCount - 1, clamped + 1));
      return;
    }
    if (key.return) {
      setArmed(null);
      if (onCreateRow) {
        if (canCreate) onResolve({ action: "create", name: query.trim() });
        return; // create row with empty query is inert
      }
      if (current) onResolve({ action: "select", slug: current.slug });
      return;
    }
    if (key.backspace || key.delete) {
      setArmed(null);
      setQuery((s) => s.slice(0, -1));
      setIndex(0);
      return;
    }
    // Printable input edits the query. Ignore other control keys.
    if (input && !key.ctrl && !key.meta) {
      setArmed(null);
      setQuery((s) => s + input);
      setIndex(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>Select a project</Text>
      <Box>
        <Text dimColor>filter: </Text>
        <Text>{query || " "}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 && (
          <Text dimColor>{briefs.length === 0 ? "(no briefs yet)" : "(no matches)"}</Text>
        )}
        {filtered.map((b, i) => {
          const sel = i === clamped;
          const isArmed = armed === b.slug;
          return (
            <Text key={b.slug} color={isArmed ? "red" : sel ? "cyan" : undefined} bold={sel || isArmed}>
              {sel ? "> " : "  "}
              {b.name}
              {isArmed ? (
                <Text color="red">{"  (press x again to delete)"}</Text>
              ) : b.description ? (
                <Text dimColor>{`  — ${b.description}`}</Text>
              ) : null}
            </Text>
          );
        })}
        <Text color={onCreateRow ? "cyan" : undefined} bold={onCreateRow} dimColor={!canCreate}>
          {onCreateRow ? "> " : "  "}
          {canCreate ? `+ Create new project "${query.trim()}"` : "+ Create new project (type a name first)"}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Type to filter. Up/Down move, Enter select, x-x delete. Esc cancel.</Text>
      </Box>
    </Box>
  );
}

/** Render the interactive picker and resolve to the operator's choice. Runs in
 *  the same pre-daemon TTY slot as `confirm()` — before the daemon spawns and tmux
 *  attaches — so it clears and unmounts cleanly before the terminal is handed off.
 *  `onDelete` performs the on-disk removal for a two-press `x` delete. */
export async function pickProject(
  briefs: BriefMeta[],
  onDelete: (slug: string) => void,
): Promise<PickResult> {
  return new Promise<PickResult>((resolvePromise) => {
    const instance = render(
      <ProjectPicker
        initialBriefs={briefs}
        onDelete={onDelete}
        onResolve={(r) => {
          instance.clear();
          instance.unmount();
          resolvePromise(r);
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
