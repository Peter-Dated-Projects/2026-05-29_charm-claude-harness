---
id: gpui-distribution-crates-io-lag
root: gotchas
type: gotcha
status: current
summary: "The gpui crate on crates.io (v0.2.2) is significantly behind the live Zed repo; use a git dependency at a pinned Zed commit — crates.io is not usable for real work."
created: 2026-06-16
updated: 2026-06-16
---

## The problem

The published `gpui` crate on crates.io is version 0.2.2 and lags the active Zed codebase
by months. External developers who add the crates.io release to their `Cargo.toml` encounter
missing APIs, behavior divergence, and examples that no longer compile. There is no backport
commitment from the Zed team.

## What to do instead

Declare a git dependency in `Cargo.toml` pinned to a specific Zed commit:

```toml
[dependencies]
gpui = { git = "https://github.com/zed-industries/zed", rev = "<commit-sha>" }
```

Pin deliberately and update the pin periodically. Do not use `branch = "main"` —
that silently absorbs breaking changes on every `cargo update`.

## Why this matters

All active GPUI apps in the wild (across the awesome-gpui ecosystem) vendor from git.
The crates.io listing is effectively a placeholder. Assume git-only distribution when
planning build infrastructure (CI, reproducible builds, caching).

## Related

[[prop-gpui-deepdive]] — full GPUI assessment including distribution details.
