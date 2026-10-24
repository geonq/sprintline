# Upstream source

This folder vendors the MIT-licensed `voice-glow` 0.3.0 source by Jakub Antalik.

- Project: <https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/voice-glow>
- Source revision: `b0e5a8f1e659ac549e6035e42a750e73678ed67a`
- License: see `LICENSE`
- Build switch: Sprintline sets `__VOICE_SURFACE__` to `false` in `vite.config.ts`; the public glow and microphone APIs remain enabled.

The microphone is requested only when a user selects “Preview microphone”. The effect measures a local `MediaStream`; Sprintline does not record or transcribe it.
