# Gotchas

Traps, flaky behavior, and non-obvious constraints -- the things that bite you twice.

| Note | Summary | Status |
|---|---|---|
| [binary-sniff-utf8-truncation.md](binary-sniff-utf8-truncation.md) | A fatal UTF-8 decode of a fixed-size head chunk false-positives valid text files because the chunk boundary can split a multibyte sequence; trim the partial trailing sequence before decoding. | current |
