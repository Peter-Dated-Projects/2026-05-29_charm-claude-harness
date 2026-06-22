use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
struct TicketFm {
    id: String,
    title: String,
    status: String,
    stage: String,
    depends_on: Vec<String>,
    touches: Vec<String>,
}

#[derive(Serialize, Debug)]
struct WorktreeInfo {
    name: String,
    path: String,
    branch: String,
}

#[derive(Serialize, Debug)]
struct CharmMeta {
    description: String,
    created_at: Option<u64>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Debug)]
struct CharmState {
    tickets: Vec<TicketFm>,
    worktrees: Vec<WorktreeInfo>,
    meta: CharmMeta,
    coordination: String,
    charm_root: String,
}

#[derive(Serialize, Debug)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

// ─── Frontmatter parser ──────────────────────────────────────────────────────

fn extract_frontmatter(content: &str) -> Option<String> {
    let s = content.trim_start();
    if !s.starts_with("---") {
        return None;
    }
    let after = &s[3..];
    // skip optional newline after ---
    let after = after.trim_start_matches('\r').trim_start_matches('\n');
    let end = after.find("\n---")?;
    Some(after[..end].to_string())
}

#[derive(PartialEq)]
enum FmMode { Top, List, Multiline }

fn parse_ticket(content: &str, path: &str) -> Option<TicketFm> {
    let fm = extract_frontmatter(content)?;

    let mut id = String::new();
    let mut title = String::new();
    let mut status = String::new();
    let mut stage = String::new();
    let mut depends_on: Vec<String> = Vec::new();
    let mut touches: Vec<String> = Vec::new();

    let mut mode = FmMode::Top;
    let mut current_key = String::new();
    let mut multiline_buf: Vec<String> = Vec::new();

    let flush_multiline = |key: &str, buf: &[String], title: &mut String| {
        if key == "title" {
            *title = buf.join(" ");
        }
    };

    for line in fm.lines() {
        match mode {
            FmMode::Multiline => {
                if line.starts_with("  ") || line.starts_with('\t') {
                    multiline_buf.push(line.trim().to_string());
                    continue;
                } else {
                    flush_multiline(&current_key, &multiline_buf, &mut title);
                    multiline_buf.clear();
                    mode = FmMode::Top;
                }
            }
            FmMode::List => {
                let t = line.trim();
                if t.starts_with("- ") {
                    let item = t[2..].trim().to_string();
                    match current_key.as_str() {
                        "depends_on" => depends_on.push(item),
                        "touches" => touches.push(item),
                        _ => {}
                    }
                    continue;
                } else {
                    mode = FmMode::Top;
                }
            }
            FmMode::Top => {}
        }

        if let Some(ci) = line.find(": ") {
            let key = line[..ci].trim();
            let value = line[ci + 2..].trim();
            match key {
                "id" => id = value.to_string(),
                "status" => status = value.to_string(),
                "stage" => stage = value.to_string(),
                "title" => {
                    if value == ">-" || value == ">" {
                        current_key = "title".to_string();
                        mode = FmMode::Multiline;
                        multiline_buf.clear();
                    } else {
                        title = value.trim_matches('"').to_string();
                    }
                }
                "depends_on" => {
                    if value == "[]" { depends_on = Vec::new(); }
                    else { current_key = "depends_on".to_string(); mode = FmMode::List; }
                }
                "touches" => {
                    if value == "[]" { touches = Vec::new(); }
                    else { current_key = "touches".to_string(); mode = FmMode::List; }
                }
                _ => {}
            }
        } else {
            let t = line.trim();
            if t == "depends_on:" { current_key = "depends_on".to_string(); mode = FmMode::List; }
            else if t == "touches:" { current_key = "touches".to_string(); mode = FmMode::List; }
        }
    }

    // Flush remaining multiline
    if mode == FmMode::Multiline {
        flush_multiline(&current_key, &multiline_buf, &mut title);
    }

    if id.is_empty() { return None; }

    Some(TicketFm { id, title, status, stage, depends_on, touches })
}

// ─── Worktree list via git ───────────────────────────────────────────────────

fn list_worktrees(repo_root: &Path) -> Vec<WorktreeInfo> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_root)
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut worktrees: Vec<WorktreeInfo> = Vec::new();
    let mut cur_path = String::new();
    let mut cur_branch = String::new();

    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if !cur_path.is_empty() {
                let name = PathBuf::from(&cur_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                worktrees.push(WorktreeInfo { name, path: cur_path.clone(), branch: cur_branch.clone() });
            }
            cur_path = p.to_string();
            cur_branch = String::new();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            cur_branch = b.to_string();
        }
    }
    // flush last
    if !cur_path.is_empty() {
        let name = PathBuf::from(&cur_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        worktrees.push(WorktreeInfo { name, path: cur_path, branch: cur_branch });
    }

    // Drop the main worktree (first entry) — only return charm worktrees
    worktrees.into_iter().skip(1)
        .filter(|w| w.path.contains(".charm/worktrees/"))
        .collect()
}

// ─── Detect charm root ───────────────────────────────────────────────────────

fn find_charm_root(hint: &str) -> Option<PathBuf> {
    if !hint.is_empty() {
        let p = PathBuf::from(hint);
        if p.join(".charm").is_dir() { return Some(p); }
    }
    // Walk up from cwd
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join(".charm").is_dir() { return Some(dir.clone()); }
        if !dir.pop() { break; }
    }
    None
}

// ─── IPC commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_charm_state(charm_root: String) -> Result<CharmState, String> {
    let root = find_charm_root(&charm_root)
        .ok_or_else(|| "charm root not found — no .charm/ directory".to_string())?;

    let charm_dir = root.join(".charm");

    // Tickets
    let tickets_dir = charm_dir.join("tickets");
    let mut tickets: Vec<TicketFm> = Vec::new();
    if let Ok(rd) = fs::read_dir(&tickets_dir) {
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.extension().map(|e| e == "md").unwrap_or(false) {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Some(t) = parse_ticket(&content, &path.to_string_lossy()) {
                        tickets.push(t);
                    }
                }
            }
        }
    }

    // Worktrees
    let worktrees = list_worktrees(&root);

    // Meta
    let meta_path = charm_dir.join("meta.json");
    let meta: CharmMeta = if let Ok(s) = fs::read_to_string(&meta_path) {
        let v: serde_json::Value = serde_json::from_str(&s).unwrap_or(serde_json::Value::Null);
        CharmMeta {
            description: v.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
            created_at:  v.get("created_at").and_then(|d| d.as_u64()),
            updated_at:  v.get("updated_at").and_then(|d| d.as_u64()),
        }
    } else {
        CharmMeta { description: String::new(), created_at: None, updated_at: None }
    };

    // Coordination
    let coordination = fs::read_to_string(charm_dir.join("COORDINATION.md")).unwrap_or_default();

    Ok(CharmState {
        tickets,
        worktrees,
        meta,
        coordination,
        charm_root: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = rd
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
            }
        })
        .collect();
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(entries)
}

// ─── App entry ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_charm_state,
            read_file_content,
            list_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
