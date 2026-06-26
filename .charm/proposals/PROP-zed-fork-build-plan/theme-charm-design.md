# PROP-zed-theme-charm-design

**Status:** draft
**Author:** T-031 investigation
**Depends on:** PROP-zed-fork-build-plan

Feasibility and recommended approach for applying the charm studio design language
to the Zed fork's color system. Covers: how Zed's theme system works, the extracted
concrete palette, the mapping of charm semantic roles to Zed tokens, the mechanism
recommendation, and what does NOT map.

---

## Verdict: feasible, recommended mechanism is hybrid

The re-theme is fully feasible. The design language is completely defined in the
`.dc.html` mockups as CSS custom properties -- both light and dark variants -- so
there are no unknowns in the palette. The Zed theme JSON covers roughly half the
charm semantic roles; the rest are charm-specific agent-status semantics with no
Zed equivalent. The clean path is a hybrid: one theme JSON for the Zed-native
chrome, and a small `CharmPalette` struct in `crates/charm` for the charm-specific
tokens. Both layers switch on `cx.theme().appearance()`, so the full app re-themes
from one toggle.

---

## 1. How Zed's theme system works

### The JSON format

Themes live as JSON files (one file can hold multiple named themes). Zed ships
its built-in themes under `crates/zed/assets/themes/`. The schema:

```
{
  "$schema": "https://zed.dev/schema/themes/v0.1.0.json",
  "name": "charm",
  "author": "charm",
  "themes": [
    { "name": "charm Light", "appearance": "light", "style": { ... } },
    { "name": "charm Dark",  "appearance": "dark",  "style": { ... } }
  ]
}
```

The `style` object contains all `ThemeColors` fields.

### ThemeColors -- the relevant token set

`crates/theme/src/theme.rs` defines `ThemeColors`. The fields that matter for
the Zed-native chrome charm uses:

```
Surfaces / backgrounds
  background                 -- base app background
  surface_background         -- activity rail, toolbar backgrounds
  elevated_surface_background -- panels floating above base (explorer, sidebar)
  panel_background           -- panel contents
  editor_background          -- main content area (the canvas background)
  status_bar_background      -- status bar strip

Borders
  border                     -- primary border
  border_variant             -- card/secondary border
  border_focused             -- focused input border

Text
  text                       -- body text
  text_muted                 -- muted / secondary text
  text_placeholder           -- placeholder / faint text
  text_disabled              -- disabled text
  text_accent                -- accent-colored text

Icons
  icon                       -- default icon color
  icon_muted                 -- muted icon
  icon_accent                -- accent icon (active rail button)

Tabs
  tab_bar_background
  tab_active_background
  tab_inactive_background
  tab_active_foreground
  tab_inactive_foreground

Accent
  accent                     -- general accent (links, selection, active states)
  link_text_hover

Git diff (used by explorer tree badges)
  created                    -- git U / untracked
  modified                   -- git M / modified
  deleted
  conflict
  ignored
  renamed
```

### How GPUI reads theme

In any GPUI view or element:

```rust
let colors = cx.theme().colors();
let bg = colors.background;
let text = colors.text;
// etc.
```

`cx.theme()` returns `Arc<Theme>`. `cx.theme().appearance()` returns
`gpui::Appearance::Light | gpui::Appearance::Dark`. This is the switch
the `CharmPalette` struct uses (see Section 4).

### What is hardcoded vs. themeable in GPUI

All GPUI visual primitives (div, path, text, image) accept inline color values
at render time -- nothing is hardcoded at the framework level. The `ThemeColors`
struct is the voluntary convention Zed uses to centralize colors; the charm crate
can read from it or define its own constants alongside it. The constraint is only
that `ThemeColors` does not have fields for charm-specific semantics (orchestrator
color, agent active color, etc.) -- those live outside it.

---

## 2. Extracted concrete palette

Source: `.dc.html` mockups extracted directly. The CSS custom properties defined
in `:root` for light mode and `[data-theme="dark"]` for dark mode are reproduced
below as the authoritative palette. These are the values that go into the theme
JSON and the `CharmPalette` struct.

### Light theme (primary -- "charm Light")

```
-- Chrome / surface layer (-> Zed ThemeColors) --
bg-app:        #E9E4F4     (base app background, very light lavender)
rail-bg:       #F1EDF9     (activity bar and toolbar strip)
panel:         #FFFFFF     (file explorer, sidebar panels)
canvas:        #F4F1FB     (main content area -- the "editor background")
elev:          #FFFFFF     (elevated cards within panels)
subtle:        #FBFAFE     (subtle background variant, faint wash rows)

border:        rgba(52,28,140,0.09)    (primary border)
border-card:   rgba(52,28,140,0.10)    (card border / border_variant)
border-soft:   rgba(52,28,140,0.08)    (very soft border)
grid-dot:      rgba(52,28,140,0.11)    (canvas dot-grid pattern)
scrollthumb:   rgba(52,28,140,0.18)

text:          #4A3F6E     (body text)
strong:        #2A1A5E     (emphasis / strong text)
title:         #3A2E60     (title text)
muted:         #6A5F8E     (secondary / muted text)
faint:         #9A92B5     (placeholder / faint text)
faint2:        #A39CC0     (extra faint, elapsed labels)

ui-active:     #341C8C     (active icon / active tab foreground)
accent:        #9475BF     (general accent -- links, active states, status dots)
accent-soft:   rgba(148,117,191,0.10)
accent-line:   rgba(148,117,191,0.26)

-- Charm semantic layer (-> CharmPalette, no Zed equivalent) --
orch:          #341C8C     (orchestrator card fill)
orch-sh:       rgba(41,20,102,0.6)   (orchestrator shadow)
on-orch:       rgba(255,255,255,0.62)  (text on orchestrator card)
on-orch-faint: rgba(255,255,255,0.5)
on-orch-div:   rgba(255,255,255,0.14)
on-orch-box:   rgba(255,255,255,0.13)

blue:          #5A6FA8     (sub-orchestrator / worktree fill)
blue-bg:       rgba(101,126,190,0.05)
blue-border:   rgba(101,126,190,0.45)
blue-head:     rgba(101,126,190,0.18)
blue-pill:     rgba(101,126,190,0.14)

blocked:       #C2557A     (blocked state fill / stroke)
blocked-text:  #B05274
blocked-bg:    rgba(194,85,122,0.10)
blocked-border: rgba(194,85,122,0.30)

gold:          #F2E1AE     (warm accent on dark surfaces -- orch header label)
idle:          #C8C1DB     (idle / queued agent tone)
done:          #4F8A6A     (completed state)
track:         rgba(52,28,140,0.10)  (progress bar empty track)

edge:          rgba(52,28,140,0.34)
edge-idle:     rgba(148,117,191,0.26)
edge-blocked:  rgba(194,85,122,0.42)
edge-flow:     rgba(52,28,140,0.55)  (traveling flow dots on active edges)

card-sh:       rgba(52,28,140,0.06)
pop-sh:        rgba(52,28,140,0.08)
overlay:       rgba(255,255,255,0.96)
overlay2:      rgba(255,255,255,0.94)
overlay3:      rgba(255,255,255,0.85)

mock-bg:       rgba(242,225,174,0.5)
mock-border:   rgba(166,121,30,0.32)
mock-text:     #8A6612
```

### Dark theme ("charm Dark")

```
-- Chrome / surface layer --
bg-app:        #120F1C
rail-bg:       #181423
panel:         #1B1729
canvas:        #15111E
elev:          #221D31
subtle:        #1F1A2C

border:        rgba(255,255,255,0.07)
border-card:   rgba(255,255,255,0.09)
border-soft:   rgba(255,255,255,0.06)
grid-dot:      rgba(255,255,255,0.055)
scrollthumb:   rgba(255,255,255,0.16)

text:          #CFC8DF
strong:        #F2EEFA
title:         #E4DEF1
muted:         #A79EC0
faint:         #7E7596
faint2:        #6C6486

ui-active:     #C4B4EC
accent:        #A78BD8
accent-soft:   rgba(167,139,216,0.16)
accent-line:   rgba(167,139,216,0.34)

-- Charm semantic layer --
orch:          #5847C2
orch-sh:       rgba(0,0,0,0.5)
on-orch:       rgba(255,255,255,0.7)
on-orch-faint: rgba(255,255,255,0.55)
on-orch-div:   rgba(255,255,255,0.16)
on-orch-box:   rgba(255,255,255,0.14)

blue:          #8597CC
blue-bg:       rgba(126,146,200,0.10)
blue-border:   rgba(126,146,200,0.40)
blue-head:     rgba(126,146,200,0.20)
blue-pill:     rgba(126,146,200,0.18)

blocked:       #D67189
blocked-text:  #E08AA0
blocked-bg:    rgba(214,113,137,0.14)
blocked-border: rgba(214,113,137,0.34)

gold:          #F2E1AE     (same in both modes -- works on dark orch card)
idle:          #564E6E
done:          #5FA37E
track:         rgba(255,255,255,0.10)

edge:          rgba(167,139,216,0.45)
edge-idle:     rgba(167,139,216,0.28)
edge-blocked:  rgba(214,113,137,0.5)
edge-flow:     rgba(167,139,216,0.7)

card-sh:       rgba(0,0,0,0.4)
pop-sh:        rgba(0,0,0,0.45)
overlay:       rgba(33,28,47,0.96)
overlay2:      rgba(33,28,47,0.94)
overlay3:      rgba(33,28,47,0.85)

mock-bg:       rgba(242,225,174,0.16)
mock-border:   rgba(242,225,174,0.32)
mock-text:     #E4CE86
```

---

## 3. Mapping charm roles to Zed tokens

### Roles that map cleanly to Zed ThemeColors

| Charm CSS role | Zed ThemeColors field | Light value | Dark value |
|---|---|---|---|
| bg-app | background | #E9E4F4 | #120F1C |
| rail-bg | surface_background | #F1EDF9 | #181423 |
| panel | elevated_surface_background / panel_background | #FFFFFF | #1B1729 |
| canvas | editor_background | #F4F1FB | #15111E |
| elev | elevated_surface_background (second use) | #FFFFFF | #221D31 |
| border | border | rgba(52,28,140,0.09) | rgba(255,255,255,0.07) |
| border-card | border_variant | rgba(52,28,140,0.10) | rgba(255,255,255,0.09) |
| text | text | #4A3F6E | #CFC8DF |
| muted | text_muted | #6A5F8E | #A79EC0 |
| faint | text_placeholder | #9A92B5 | #7E7596 |
| ui-active / accent | icon_accent + tab_active_foreground | #341C8C | #C4B4EC |
| accent | accent | #9475BF | #A78BD8 |
| done | created (git badge -- "done" ~ "added/clean") | #4F8A6A | #5FA37E |
| git M badge (modified) | modified | (use --muted or #B5811F equiv.) | same |

Note on `strong` (#2A1A5E) and `title` (#3A2E60): Zed has no dedicated
"emphasis text" or "title text" token. These can go into `text_accent` (strong)
and be left to component code for title. They do not block the theme; they are
fine as hardcoded constants in the charm crate or approximated via `text_accent`.

Note on `panel` vs `elev`: Zed has `elevated_surface_background` for one
elevation level and `panel_background` for another. The light theme uses
#FFFFFF for both `--panel` and `--elev`, so assigning both Zed fields to
#FFFFFF is correct for light. Dark has #1B1729 for `--panel` and #221D31 for
`--elev` -- map `panel_background: #1B1729` and `elevated_surface_background: #221D31`.

### Roles with NO Zed ThemeColors equivalent (charm-specific)

These have no counterpart in the Zed theme schema. They live in `CharmPalette`:

```
orch / orch-sh             orchestrator card fill and shadow
on-orch / on-orch-faint    text and dividers on top of the dark orch card
on-orch-div / on-orch-box  structural elements on orch card
blue / blue-bg / blue-border / blue-head / blue-pill  sub-orch / worktree family
blocked / blocked-text / blocked-bg / blocked-border  blocked state family
gold                       warm accent used on dark card backgrounds
idle                       idle / queued agent tone
edge / edge-idle / edge-blocked / edge-flow  connector line colors
card-sh / pop-sh           card and popover shadow
overlay / overlay2 / overlay3  glass overlay backgrounds
grid-dot                   canvas background dot pattern
track                      progress bar empty track
mock-bg / mock-border / mock-text  mock mode badge
```

That is 19 distinct charm-specific roles (many with sub-variants), vs. 13 roles
that map to Zed tokens. The split is roughly 60/40 charm-specific.

---

## 4. Mechanism options

### Option A: Built-in theme JSON only

Ship one `crates/charm/assets/themes/charm.json` that sets all Zed `ThemeColors`
fields. Charm-specific colors live as hardcoded hex strings scattered through the
component Rust files.

- Pros: zero new infrastructure; theme toggle (light/dark) works for the Zed
  chrome immediately; standard Zed mechanism.
- Cons: the 19 charm-specific roles have no single home -- they are copy-pasted
  hex strings in `charm_sidebar.rs`, `OrchestrationItem`, etc. Re-theming the
  agent colors means grep-and-replace across multiple files. Directly violates
  the HANDOFF section 12 single-source goal.

### Option B: Extend ThemeColors with charm fields

Add charm-specific fields directly to `ThemeColors` in `crates/theme/src/theme.rs`
and the JSON schema.

- Pros: everything in one place; `cx.theme().colors().orch` would just work.
- Cons: heavy -- extending `ThemeColors` requires updating the schema, the
  serialization, all existing theme files (they'd need the new fields or they get
  defaults), and all theme tooling. Makes upstream Zed diff larger and harder to
  reason about. Overkill for ~19 extra fields used only by the charm crate.

### Option C (recommended): Hybrid -- theme JSON + CharmPalette struct

Two components, one toggle:

1. **`crates/charm/assets/themes/charm.json`** -- a built-in theme JSON that
   sets all Zed `ThemeColors` fields for light and dark. Registered at startup
   via `theme::init()` / the asset server (same path as Zed's built-in themes).
   Zed-native UI (file explorer, editor, status bar, tabs) re-themes from this.

2. **`crates/charm/src/theme.rs`** -- a `CharmPalette` struct holding all 19
   charm-specific roles (plus sub-variants). Two const instances: `LIGHT` and
   `DARK`. A constructor:
   ```rust
   impl CharmPalette {
       pub fn current(cx: &App) -> &'static CharmPalette {
           match cx.theme().appearance() {
               Appearance::Light => &CharmPalette::LIGHT,
               Appearance::Dark  => &CharmPalette::DARK,
           }
       }
   }
   ```
   Every charm component calls `CharmPalette::current(cx)` at render time; no
   hex string ever appears in component code.

3. **The toggle** is the normal Zed theme switcher. When the user switches from
   "charm Light" to "charm Dark", `cx.theme()` changes, GPUI re-renders all
   views, and `CharmPalette::current()` returns `DARK` automatically. One switch
   re-themes the entire app -- both the Zed chrome and the charm-specific elements.

This is the exact structural parallel to the CSS custom properties pattern in the
`.dc.html` design: one `:root` block sets everything, and `data-theme="dark"`
swaps the whole set at once.

---

## 5. Can charm panels and the canvas read the same tokens?

Yes, without friction. `cx.theme()` and `cx.theme().colors()` are available in
every GPUI render context, including inside `crates/charm`. No special wiring
is needed -- charm is just another Rust crate in the same GPUI app.

**Practical split:**

- `charm_explorer.rs` (the .charm/ tree panel) -- uses `cx.theme().colors()` for
  backgrounds, borders, text, git badges (`text`, `text_muted`, `border`,
  `created`, `modified`). Uses `CharmPalette::current(cx)` for ticket-dot badge
  color (= `palette.accent`).

- `charm_sidebar.rs` (Orchestrate/General tabs) -- uses `cx.theme().colors()`
  for chrome (panel_background, border, tab styles). Uses `CharmPalette::current`
  for agent status accents (live = `palette.accent`, blocked = `palette.blocked`,
  idle = `palette.idle`, done = `palette.done`) and the orch card
  (`palette.orch`, `palette.on_orch`, etc.).

- `OrchestrationItem` (the canvas tab, Phase 3) -- mostly `CharmPalette::current`
  for node fills, edge lines, flow dots, grid dots. Zed tokens for the panel
  chrome surrounding the canvas (tab bar, titlebar). The Phase 3 canvas is where
  `CharmPalette` does the most work.

The GPUI `PathBuilder`-based connectors and the animated flow dots take their
colors from `CharmPalette::current(cx).edge` and `.edge_flow` at render time.
Because the animation loop calls `cx.notify()` each frame (which triggers
re-render), `CharmPalette::current()` is re-evaluated each frame -- theme
switches propagate instantly even during animation.

**Glow effects:** The `.dc.html` design uses soft box-shadows (`--orch-sh`,
`--card-sh`, `--pop-sh`) and SVG glow filters for the live-agent halos. GPUI
has no box-shadow. Approximate with layered translucent `div()` fills (a slightly
larger div behind the card at reduced opacity using `palette.orch_sh`) and defer
the full glow to a v2 pass. The card identities (shape, accent stripe, status dot)
carry meaning without glow; glow is a depth polish, not a legibility signal.

---

## 6. What does NOT map cleanly -- worker notes

Items a build worker must handle outside the theme JSON:

1. **`strong` / `title` text** -- no Zed token. Use as constants in charm
   component code or assign `strong` to `text_accent` in the theme and read
   `cx.theme().colors().text_accent` there.

2. **`subtle` background** -- Zed has no third surface level. Closest is
   `panel_background` at the dark canvas value. If the subtle wash rows matter,
   add it to `CharmPalette` as a derived rgba of `orch` at 0.03-0.05 opacity
   rather than a distinct constant.

3. **Glow / shadows** -- as noted above: GPUI has no box-shadow, no SVG filter.
   Layered translucent divs are the approximation; full glow is post-v1.

4. **`grid-dot` pattern** -- the canvas dot-grid background. This is CSS
   `radial-gradient` which has no GPUI equivalent. Options: draw as individual
   small quads (expensive), or use a tiled texture (a 22x22 Metal texture with
   one dot). The dot color (#grid-dot) must come from `CharmPalette`.

5. **`edge-flow` animated dots** -- no `animateMotion`. Already addressed in
   Phase 3 via the imperative animation loop (`advance_dots`, `cx.notify()`).
   Colors come from `CharmPalette.edge_flow`.

6. **Monospace font stack** -- the design uses Geist Mono / Cascadia Code / Fira
   Code. Zed ships with Zed Mono as its default UI font; the charm panels can
   inherit that or specify a fallback stack in the font config. Not a theme JSON
   field -- set in the fork's default settings or in the charm panel font spec.

---

## 7. Recommended theme file location and registration

Place the theme JSON at:

```
crates/charm/assets/themes/charm.json
```

Register at startup in `crates/charm/src/lib.rs` (or wherever `charm::init(cx)`
lives, which Phase 1 establishes) alongside the asset server registration:

```rust
theme::add_user_theme_from_content(
    include_str!("../assets/themes/charm.json"),
    cx
);
// Then set it as default if no user preference:
theme::ThemeSettings::get_global(cx).active_theme_name == "charm Light"
```

The charm fork ships only the charm themes; the standard Zed built-in themes
can be kept or stripped. Setting "charm Light" as the default is a one-line
change in `assets/settings/default.json` (`"theme": "charm Light"`).

---

## 8. Files a worker will touch

| File | Action |
|---|---|
| `crates/charm/assets/themes/charm.json` | Create -- the theme JSON with light + dark |
| `crates/charm/src/theme.rs` | Create -- `CharmPalette` struct with LIGHT/DARK consts |
| `crates/charm/src/lib.rs` | Register theme asset at init |
| `assets/settings/default.json` | Set default theme to "charm Light" |
| `crates/charm/src/sidebar.rs` | Import CharmPalette; replace any placeholder colors |
| `crates/charm/src/explorer.rs` | Same |
| `crates/charm/src/canvas.rs` (Phase 3) | Main consumer of CharmPalette |

No changes to `crates/theme/` -- the `ThemeColors` struct is unchanged.

---

## Status: draft (findings from T-031)
