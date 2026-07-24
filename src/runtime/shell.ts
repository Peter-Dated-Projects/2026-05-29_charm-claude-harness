/** Shell-escape a string for embedding in a single-quoted tmux/shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
