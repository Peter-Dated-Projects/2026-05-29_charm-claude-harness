---
id: editor-edit-prediction-types-holds-direction
root: gotchas
type: gotcha
status: current
summary: "When severing editor from edit_prediction_types in the Phase-0 AI teardown, beware that edit_prediction_types also defines the general-purpose Direction cursor-movement enum (re-exported by editor and used pervasively in movement code) -- it must be relocated, not deleted, or normal editing breaks; the editor integration is ~500 refs across 17 files incl. a 236-ref edit_prediction.rs module."
created: 2026-06-26
updated: 2026-06-26
---

Found while doing T-043 (sever the integration edges of the AI/edit-prediction component,
then bulk-delete). The `editor` crate is the delicate edge the plan warns about. Two
facts a continuation worker needs before touching it:

1. **`edit_prediction_types` is NOT purely edit-prediction types.** It also defines
   `Direction` (an enum used for general cursor movement, re-exported as
   `pub use edit_prediction_types::Direction;` in editor.rs:97) and
   `EditPredictionRequestTrigger`. `Direction` is referenced throughout editor movement
   code, so you CANNOT just delete `edit_prediction_types` and drop editor's dep -- you
   must first relocate `Direction` (into `editor` or `text`) and repoint its users, or
   normal editing/movement breaks. Audit every `edit_prediction_types` export for
   general-purpose types before deleting the crate. (Other exports -- EditPrediction,
   EditPredictionDelegate(Handle), EditPredictionDiscardReason, EditPredictionGranularity,
   SuggestionDisplayType, PredictedCursorPosition, DataCollectionState, interpolate_edits --
   are genuinely edit-prediction-specific and go with the component.)

2. **The editor integration is large and woven into core state, not isolated.** Ref
   counts of `edit_prediction` in `crates/editor/src`: edit_prediction.rs 236 (a whole
   integration module, `mod edit_prediction;` in editor.rs:67), editor.rs 62 (Editor
   struct fields + update loop + re-exports at editor.rs:88-98,148-151), element.rs 29
   (inline rendering), completions.rs 9, input.rs 4, clipboard.rs 3, display_map.rs 3,
   split.rs 3, plus movement/selection/scroll/inlays/diagnostics/code_actions (1-2 each),
   and the test files edit_prediction_tests.rs 154 + editor_tests.rs 9. Plan to: delete
   edit_prediction.rs + edit_prediction_tests.rs, remove the Editor struct's
   edit-prediction fields and their use sites, strip element.rs rendering, and KEEP a
   no-op `Editor::set_show_edit_predictions` (language_tools and the log view already call
   it; T-043 left those call sites in place expecting the method to survive).

This edge plus the `zed` edge were the two left unsevered when T-043 checkpointed; see
[[ai-teardown-cross-deps-block-cloud-and-settings]] and [[zed-phase-0-teardown-plan]].
