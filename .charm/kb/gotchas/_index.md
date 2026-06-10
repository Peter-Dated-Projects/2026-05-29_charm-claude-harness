# Gotchas

Traps, flaky behavior, and non-obvious constraints -- the things that bite you twice.

| Note | Summary | Status |
|---|---|---|
| [binary-sniff-utf8-truncation.md](binary-sniff-utf8-truncation.md) | A fatal UTF-8 decode of a fixed-size head chunk false-positives valid text files because the chunk boundary can split a multibyte sequence; trim the partial trailing sequence before decoding. | current |
| [ink-comounted-useinput-keysets.md](ink-comounted-useinput-keysets.md) | Ink delivers every keypress to every mounted useInput with isActive=true; two handlers co-mounted in one console tab must use disjoint key sets or shared keys double-fire. | current |
