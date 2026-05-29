#!/usr/bin/env bun
import React, { useState } from "react";
import { render, Box, Text, useInput } from "ink";
import type { CharmMode } from "../daemon/spawn.ts";

type Option = { mode: CharmMode; label: string; desc: string; key: string };

const OPTIONS: Option[] = [
  {
    mode: "research",
    label: "Research",
    desc: "Every agent runs on Sonnet -- fast and cheap for exploration.",
    key: "r",
  },
  {
    mode: "development",
    label: "Development",
    desc: "Every agent runs on Opus -- most capable, for writing and shipping code.",
    key: "d",
  },
];

function ModePrompt({ onPick, onAbort }: { onPick: (m: CharmMode) => void; onAbort: () => void }) {
  const [idx, setIdx] = useState(0);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onAbort();
      return;
    }
    if (key.upArrow || input === "k") {
      setIdx((i) => (i + OPTIONS.length - 1) % OPTIONS.length);
    } else if (key.downArrow || input === "j") {
      setIdx((i) => (i + 1) % OPTIONS.length);
    } else if (key.return) {
      onPick(OPTIONS[idx]!.mode);
    } else {
      const hit = OPTIONS.find((o) => o.key === input.toLowerCase());
      if (hit) onPick(hit.mode);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>Start charm in which mode?</Text>
      <Text dimColor>Up/Down to move, Enter to select. Shortcuts: r / d. Esc to cancel.</Text>
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((o, i) => {
          const active = i === idx;
          return (
            <Box key={o.mode} flexDirection="column" marginBottom={i === OPTIONS.length - 1 ? 0 : 1}>
              <Text color={active ? "cyan" : undefined} bold={active}>
                {active ? "> " : "  "}
                {o.label}  [{o.key}]
              </Text>
              <Text dimColor>{"    " + o.desc}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** Render an in-terminal selector and resolve to the chosen mode. Must run before
 *  the daemon spawns and tmux attaches, so the terminal is clean. On Esc/Ctrl-C
 *  the process exits (130) rather than silently defaulting to a mode. */
export async function promptMode(): Promise<CharmMode> {
  return new Promise<CharmMode>((resolvePromise) => {
    const instance = render(
      <ModePrompt
        onPick={(m) => {
          instance.clear();
          instance.unmount();
          resolvePromise(m);
        }}
        onAbort={() => {
          instance.clear();
          instance.unmount();
          process.exit(130);
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
