# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. iPhone transcribes on device (iOS 26+). Every other client records audio and
has its environment transcribe it. "Send" is a request to submit after
transcription, and it goes through normal message submission only after the
draft-revision check passes.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. A failed
transcription keeps the recording so the user can retry or discard it. Retry
repeats the same staleness checks.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Environment transcription

- **whisper.cpp is a downloaded subprocess**, not a native addon. The desktop app
  runs the server under Electron's Node ABI, so a native binding would need a
  build per runtime. [Pinned releases](../../apps/server/src/voice/whisperReleases.ts)
  are downloaded on demand and run by [VoiceInput](../../apps/server/src/voice/VoiceInput.ts).
  Platforms without a pinned build report voice as unavailable.
- **Audio goes over a signed HTTP upload, results over RPC.** The
  [upload route](../../apps/server/src/voice/VoiceUpload.ts) keeps audio off the
  WebSocket, and returning the transcript over RPC avoids the tunnel's roughly
  100 second response limit on a long transcription.
- **Only marked installs count.** A model or binary is downloaded into a staged
  directory, gets a marker, and is renamed into place, so a partial download is
  never mistaken for an install. Only one model is installed at a time.
- **One permit guards jobs and model changes.** Transcriptions and model
  removal or replacement share it, so a running job keeps its model. Transcription
  still works while a different model downloads, because the download is staged.
