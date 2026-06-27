---
id: collab-teardown-leaves-webrtc-via-audio
root: gotchas
type: gotcha
status: current
summary: "Deleting the `call` crate removes the LiveKit SDK (`livekit_client`: rooms/video/tracks) from zed's tree but NOT the WebRTC native libs -- `libwebrtc`/`webrtc-sys` are still pulled by the hard-keep `audio` crate (used by zed + settings_ui) for audio processing. The LiveKit binary-size win is only partial."
created: 2026-06-26
updated: 2026-06-26
---

The Phase-0 collab-cluster teardown ticket assumed deleting `call` (the LiveKit
voice/video wrapper) would drop "the LiveKit/WebRTC native libs, the big binary-size
win." Verified after T-046: that is only half true.

After deleting `call`/`channel`/`collab_ui`:
- `cargo tree -p zed -i livekit_client` -> no match. The LiveKit *SDK* (the
  room/track/video/screen-share machinery) is fully gone from zed's tree. Good.
- `cargo tree -p zed -i libwebrtc` -> still present, pulled by:
  `libwebrtc -> audio -> {settings_ui, zed}`.

The `audio` crate (a hard-keep, out of scope) independently depends on `libwebrtc`
(from the livekit-rust-sdks repo) for audio-processing primitives -- echo cancellation /
device handling -- NOT for collaboration. `webrtc-sys` + `webrtc-sys-build` (the heavy
native build) come in through that same `audio` edge. So the bulky native WebRTC libs
remain after the collab teardown.

**Implication:** fully reclaiming the WebRTC binary-size win requires a separate effort
on the `audio` crate -- either replacing its `libwebrtc`-based audio processing with a
lighter backend, or gating it out -- which is outside the collab-cluster teardown's
scope. Don't claim the WebRTC size win is delivered just because `call` is gone.

Related: [[notifications-crate-gut-not-delete-statustoast]] (the other partial-removal
finding from the same ticket).
