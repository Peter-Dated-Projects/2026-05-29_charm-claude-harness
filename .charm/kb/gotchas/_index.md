# Gotchas

Traps, flaky behavior, and non-obvious constraints -- the things that bite you twice.

| Note | Summary | Status |
|---|---|---|
| [binary-sniff-utf8-truncation.md](binary-sniff-utf8-truncation.md) | A fatal UTF-8 decode of a fixed-size head chunk false-positives valid text files because the chunk boundary can split a multibyte sequence; trim the partial trailing sequence before decoding. | current |
| [ink-comounted-useinput-keysets.md](ink-comounted-useinput-keysets.md) | Ink delivers every keypress to every mounted useInput with isActive=true; two handlers co-mounted in one console tab must use disjoint key sets or shared keys double-fire. | current |
| [orchestrator-context-pressure-gaps.md](orchestrator-context-pressure-gaps.md) | The orchestrator accumulates context across all five stages with no proactive compaction, no persisted planning rationale, and no post-compaction recovery path -- three gaps that compound as session length grows. | current |
| [gpui-distribution-crates-io-lag.md](gpui-distribution-crates-io-lag.md) | The gpui crate on crates.io (v0.2.2) is significantly behind the live Zed repo; use a git dependency at a pinned Zed commit -- crates.io is not usable for real work. | current |
