//! charm-watch — the idle-detector half of charm's investigator/researcher
//! done-enforcement.
//!
//! The TS daemon owns sqlite + the ticket/scratchpad files and is the only thing
//! that acts (marks tickets done, reaps panes). This binary is a stateless
//! DETECTOR: the daemon invokes it once per liveness-sweep tick, pipes a JSON
//! watch-list on stdin, and reads JSON verdicts on stdout. For each watched
//! interactive agent we answer two questions purely by READING:
//!
//!   1. Is the pane output-idle?  We hash the pane's visible text (tmux
//!      capture-pane). An agent actively working repaints its pane (streaming
//!      tokens, spinner, tool output) so the hash keeps changing; one sitting at
//!      the idle prompt produces a stable hash. (tmux 3.6's #{pane_activity} is
//!      not populated, and #{window_activity} is per-window — useless when several
//!      agents share one window — so content hashing is the only per-pane signal.)
//!      Idle duration is threaded through the daemon: it hands back the prior hash
//!      and the epoch the content last changed; we keep that epoch while the hash
//!      is stable, so the daemon stores only opaque blobs and all the logic lives
//!      here.
//!   2. Was anything actually written to the watched file?  (current authored
//!      length > the baseline the daemon captured at spawn). `watch_path` is an
//!      investigator's ticket file or a researcher's fixed-path scratchpad note —
//!      either way it's just a markdown file read the same way; frontmatter- and
//!      log-region-stripping are no-ops when those markers aren't present, which a
//!      researcher's note never has. This separates "finished but forgot to
//!      report" (auto-complete it) from "went silent having written nothing" (a
//!      stuck/empty agent the daemon must NOT mark done).
//!
//! `finished = idle >= threshold && findings_written`. The daemon decides what to
//! do with that; this binary never mutates tmux, tickets, or scratchpad files
//! beyond reading.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
struct Request {
    /// Markers delimiting the daemon-managed activity-log region inside a ticket
    /// body — passed in so this binary and the TS store share one definition.
    log_begin: String,
    log_end: String,
    /// Output-idle (seconds) at or beyond which a pane counts as finished.
    idle_threshold_secs: i64,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    agent_id: String,
    pane_id: String,
    /// The file to watch for authored growth — an investigator's ticket path or
    /// a researcher's fixed-path scratchpad note.
    watch_path: String,
    /// Authored-body byte length at spawn (frontmatter + log region excluded,
    /// both no-ops for a scratchpad note), computed by the daemon with the same
    /// stripping this binary applies.
    baseline_authored_len: i64,
    /// The hash and last-changed epoch this binary returned for this pane on the
    /// previous tick (empty / 0 on the first observation). Opaque to the daemon.
    #[serde(default)]
    prev_hash: String,
    #[serde(default)]
    prev_unchanged_since: i64,
}

#[derive(Serialize)]
struct Verdict {
    agent_id: String,
    /// Current pane-content hash (empty if the pane couldn't be captured). The
    /// daemon stores this and hands it back next tick as prev_hash.
    hash: String,
    /// Epoch the pane content last changed; the daemon stores it and hands it back
    /// as prev_unchanged_since.
    unchanged_since: i64,
    /// Seconds the pane content has been stable, or -1 if it couldn't be captured.
    idle_secs: i64,
    /// Current authored-body byte length, or -1 if the ticket couldn't be read.
    authored_len: i64,
    findings_written: bool,
    finished: bool,
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// FNV-1a 64-bit, hex-encoded. A content fingerprint — no crypto needed, just a
/// cheap stable hash to tell "same screen" from "screen changed".
fn fnv1a(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Hash of the pane's visible content, or None if tmux can't capture it (pane
/// gone, tmux not running). None is treated as "not idle" so a capture failure
/// never drives an auto-complete.
fn capture_hash(pane_id: &str) -> Option<String> {
    let out = Command::new("tmux")
        .args(["capture-pane", "-p", "-t", pane_id])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(fnv1a(&out.stdout))
}

/// Drop a leading `---\n…\n---\n` YAML frontmatter block, matching gray-matter's
/// view of the body. Returns the whole input unchanged when there's no block.
fn strip_frontmatter(s: &str) -> &str {
    let t = s.strip_prefix('\u{feff}').unwrap_or(s);
    if let Some(rest) = t.strip_prefix("---") {
        if let Some(idx) = rest.find("\n---") {
            let after = &rest[idx + 4..]; // past the "\n---"
            if let Some(nl) = after.find('\n') {
                return &after[nl + 1..];
            }
            return "";
        }
    }
    s
}

/// Remove the daemon-managed activity-log region so log appends (which the daemon
/// writes during the agent's life) don't count as authored findings.
fn strip_log_region(body: &str, begin: &str, end: &str) -> String {
    if let (Some(b), Some(e)) = (body.find(begin), body.find(end)) {
        if e > b {
            let mut out = String::with_capacity(body.len());
            out.push_str(&body[..b]);
            out.push_str(&body[e + end.len()..]);
            return out;
        }
    }
    body.to_string()
}

/// Authored-body byte length for a watched file (ticket or scratchpad note), or
/// None if it can't be read.
fn authored_len(watch_path: &str, begin: &str, end: &str) -> Option<usize> {
    let content = std::fs::read_to_string(watch_path).ok()?;
    let body = strip_frontmatter(&content);
    Some(strip_log_region(body, begin, end).trim().len())
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("charm-watch: failed to read stdin");
        std::process::exit(1);
    }
    let req: Request = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("charm-watch: bad request json: {e}");
            std::process::exit(1);
        }
    };

    let now = now_epoch();
    let verdicts: Vec<Verdict> = req
        .entries
        .iter()
        .map(|e| {
            let cur_hash = capture_hash(&e.pane_id);
            // Carry the unchanged-since epoch forward while the screen is stable;
            // reset to now on first sight or any change. idle_secs is -1 (never
            // finished) when the pane can't be captured.
            let (hash, unchanged_since, idle_secs) = match &cur_hash {
                Some(h) if *h == e.prev_hash && e.prev_unchanged_since > 0 => {
                    (h.clone(), e.prev_unchanged_since, (now - e.prev_unchanged_since).max(0))
                }
                Some(h) => (h.clone(), now, 0),
                None => (String::new(), 0, -1),
            };
            let cur = authored_len(&e.watch_path, &req.log_begin, &req.log_end);
            let findings_written = cur.map(|l| l as i64 > e.baseline_authored_len).unwrap_or(false);
            let finished = idle_secs >= 0 && idle_secs >= req.idle_threshold_secs && findings_written;
            Verdict {
                agent_id: e.agent_id.clone(),
                hash,
                unchanged_since,
                idle_secs,
                authored_len: cur.map(|l| l as i64).unwrap_or(-1),
                findings_written,
                finished,
            }
        })
        .collect();

    match serde_json::to_string(&verdicts) {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("charm-watch: failed to serialize verdicts: {e}");
            std::process::exit(1);
        }
    }
}
