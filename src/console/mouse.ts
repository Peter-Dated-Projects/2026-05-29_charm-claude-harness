import { useEffect } from "react";

/** Enable terminal mouse tracking and dispatch wheel events.
 *
 *  Uses SGR mouse mode (CSI ?1006h) which is supported by every modern
 *  terminal (iTerm2, VSCode terminal, kitty, alacritty, tmux passthrough).
 *  Wheel-up sends button code 64, wheel-down 65.
 *
 *  Note: when tmux has `mouse on`, it forwards wheel events to the focused
 *  pane only if that pane's app has requested mouse tracking. So this hook is
 *  what lets the console pane "claim" the wheel.
 */
export type WheelHandler = (delta: number) => void;

export function useMouseWheel(onWheel: WheelHandler): void {
  useEffect(() => {
    const stdout = process.stdout;
    const stdin = process.stdin;
    // 1000 = button events, 1006 = SGR-encoded coordinates (no 223-char limit)
    stdout.write("\x1b[?1000h\x1b[?1006h");

    const handler = (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // CSI < button ; col ; row M/m
      const re = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const btn = parseInt(m[1]!, 10);
        if (btn === 64) onWheel(-3); // wheel up = scroll toward top
        else if (btn === 65) onWheel(+3); // wheel down = scroll toward bottom
      }
    };
    stdin.on("data", handler);

    return () => {
      stdin.off("data", handler);
      stdout.write("\x1b[?1000l\x1b[?1006l");
    };
    // Re-run when handler identity changes
  }, [onWheel]);
}
