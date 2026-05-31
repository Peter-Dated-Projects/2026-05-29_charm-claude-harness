#!/usr/bin/env bun
import React, { useState } from "react";
import { render, Box, Text, useInput } from "ink";

function ConfirmPrompt({
  title,
  detail,
  onPick,
  onAbort,
}: {
  title: string;
  detail: string;
  onPick: (v: boolean) => void;
  onAbort: () => void;
}) {
  const [yes, setYes] = useState(true);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onAbort();
      return;
    }
    const c = input.toLowerCase();
    if (c === "y") {
      onPick(true);
    } else if (c === "n") {
      onPick(false);
    } else if (key.leftArrow || key.rightArrow || c === "h" || c === "l") {
      setYes((v) => !v);
    } else if (key.return) {
      onPick(yes);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{detail}</Text>
      <Box marginTop={1}>
        <Text color={yes ? "cyan" : undefined} bold={yes}>
          {yes ? "> " : "  "}Yes [y]
        </Text>
        <Text>{"    "}</Text>
        <Text color={!yes ? "cyan" : undefined} bold={!yes}>
          {!yes ? "> " : "  "}No [n]
        </Text>
      </Box>
      <Text dimColor>Left/Right to move, Enter to confirm. Esc to skip.</Text>
    </Box>
  );
}

/** Render an in-terminal yes/no confirm and resolve to the choice. Must run before
 *  the daemon spawns and tmux attaches, so the terminal is clean. Esc/Ctrl-C
 *  resolves to `false` (skip) rather than aborting the caller — a declined prompt
 *  is a normal outcome, not a failure. */
export async function confirm(title: string, detail: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const instance = render(
      <ConfirmPrompt
        title={title}
        detail={detail}
        onPick={(v) => {
          instance.clear();
          instance.unmount();
          resolvePromise(v);
        }}
        onAbort={() => {
          instance.clear();
          instance.unmount();
          resolvePromise(false);
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
