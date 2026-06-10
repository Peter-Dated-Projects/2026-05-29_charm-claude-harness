---
id: binary-sniff-utf8-truncation
root: gotchas
type: gotcha
status: current
summary: "A fatal UTF-8 decode of a fixed-size head chunk false-positives valid text files, because the chunk boundary can split a multibyte sequence; trim the partial trailing sequence before decoding."
created: 2026-06-10
updated: 2026-06-10
---

# Binary-file sniffing: don't fatal-decode a truncated chunk

`isBinaryFile` (`src/console/file-tree.tsx`) detects binary files by reading the
first ~4KB and checking for (a) a null byte and (b) UTF-8 validity. The null-byte
check is definitive and safe. The UTF-8 check is the trap.

A naive `new TextDecoder("utf-8", { fatal: true }).decode(head)` throws — and so
flags the file as binary — whenever the 4KB read boundary lands in the middle of
a multibyte UTF-8 sequence. That happens for any perfectly valid UTF-8 text file
larger than the sniff size whose 4096th byte falls mid-character (common with
non-ASCII content). The result is a false "binary" verdict that dims the row in
the tree and shows the viewer placeholder for a readable text file.

Fix: when the read filled the whole buffer (i.e. the file is larger than the
sniff window), back off the trailing bytes that form an incomplete multibyte
sequence before the fatal decode. Walk back over continuation bytes (`10xxxxxx`),
look at the lead byte to learn the sequence's expected length, and if fewer
continuation bytes are present than required, drop that partial tail. Only do
this on a full read — a short read already has the file's true tail.

Also: `Buffer.subarray()` is typed as returning `Buffer`, not `Uint8Array`, so a
`let slice = buf.subarray(...)` later reassigned to a `Uint8Array` (the trimmed
result) trips TS2740. Annotate `let slice: Uint8Array = ...`.
