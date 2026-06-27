---
id: notifications-crate-gut-not-delete-statustoast
root: gotchas
type: gotcha
status: current
summary: "The collab `notifications` crate cannot be deleted in the collab teardown -- it also holds the general-purpose `StatusToast` widget consumed by 5 non-collab crates; gut it to status_toast.rs only. The `workspace::notifications` module is a SEPARATE thing in the keep-crate `workspace`."
created: 2026-06-26
updated: 2026-06-26
---

During the Phase-0 collaboration-cluster teardown (call/channel/collab_ui/notifications),
the `notifications` crate looks deletable but is not, for two reasons that are easy to conflate:

1. **Two unrelated "notifications" namespaces.** `notifications::NotificationId`,
   `NotifyTaskExt`, `NotifyResultExt`, `DetachAndPromptErr`, and
   `simple_message_notification::MessageNotification` are NOT from the `notifications`
   crate -- they live in `workspace::notifications` (a module in the hard-keep
   `workspace` crate), reached via `use workspace::notifications::...`. Grepping
   `notifications::X` conflates the two. The `workspace` module is untouched by the
   teardown.

2. **The `notifications` CRATE bundles a collab store + a general UI widget.** It has
   exactly two parts: `notification_store.rs` (the collab `NotificationStore`, coupled
   to `channel`/`client`/`rpc`) and `status_toast.rs` (`StatusToast`, a generic toast
   widget with no collab coupling). `StatusToast` is consumed via
   `notifications::status_toast::StatusToast` by FIVE crates that are NOT part of the
   collab teardown and were outside the teardown ticket's `touches`:
   `component_preview`, `debugger_ui`, `keymap_editor`, `onboarding`, `project_panel`
   (plus in-scope `git_ui`). Deleting the crate is therefore impossible without editing
   those out-of-scope crates.

**Resolution (T-046): GUT, don't delete.** Delete `notification_store.rs`, reduce
`notifications.rs` to `pub mod status_toast;`, and trim `Cargo.toml` to just what
StatusToast needs (`component`, `gpui`, `ui`, `workspace`, `zed_actions`). The crate
keeps its name and the `notifications::status_toast::StatusToast` path, so all 5
out-of-scope consumers compile unchanged. This drops the `channel`/`rpc` collab coupling
(the teardown's actual goal) while staying in scope.

**Follow-up to fully delete the crate:** relocate `StatusToast` into `ui/` (or
`workspace/`), update the 6 consumers' imports, then delete the `notifications` crate
dir + its `[workspace.members]`/`[workspace.dependencies]` entries. Needs a ticket whose
`touches` includes those 6 crates. See [[collab-teardown-leaves-webrtc-via-audio]] for
the other partial-removal finding from the same teardown.
