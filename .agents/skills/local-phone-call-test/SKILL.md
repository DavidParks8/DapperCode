---
name: local-phone-call-test
description: Run a repeatable, deterministic, fully isolated local SIP phone call with the AI ("talk about whatever the user wants") that records synchronized audio WAVs and a structured transcript/report bundle for analysis and iterative voice/dialogue improvement.
user-invocable: true
---

# Local Phone Call Test & Analysis

Use this skill to run repeatable, deterministic live phone calls against the local DapperCode voice
pipeline (real `dappercode-bridge`, real SIP/RTP, real local STT/LLM/TTS, and local `baresip`
CoreAudio mic/speakers) without touching the user's running broker, `~/.baresip`, or `config.json`.
Every run produces synchronized audio recordings and a structured transcript/timing report ready to
feed back to an agent for root-cause analysis and improvement.

## Prerequisites

- `baresip` installed (`brew install baresip`)
- Local voice endpoint(s) running on loopback (for example Ollama on `http://127.0.0.1:11434/v1`
  with your configured STT/LLM/TTS models, or `mlx_audio.server` if selected)
- `dappercode-bridge` built once (or pass `--build`):

```bash
pnpm run cargo build --locked --release --manifest-path services/rust-bridge/Cargo.toml
```

## 1. Run a Recorded Local Test Call

From the repository root:

```bash
pnpm run phone:test-call
```

Or invoke the script directly with custom options:

```bash
node .agents/skills/local-phone-call-test/scripts/run-call.mjs \
  --out /tmp/dappercode-phone-tests/my-run
```

By default, the runner:

1. Reads non-secret voice defaults (`stt/llm/tts` URLs, models, voice, display name) from the
   desktop `config.json` (or falls back to Ollama `gemma4:e4b` + `phonon`), with CLI flags overriding
   any field.
2. Starts an isolated `baresip` instance, an embedded transparent SIP/RTP recording proxy, and an
   isolated production `dappercode-bridge` on ephemeral loopback ports with random ephemeral
   credentials.
3. Triggers `start_phone_call` deterministically through a minimal ACP driver (`acp-call-driver.mjs`)
   with an open-ended objective and greeting ("talk about whatever you want"), then auto-approves
   the local test call modal on the bridge WebSocket—no phone or manual approval needed.
4. Streams live status changes and transcript turns to the terminal. During the call:
   - Speak into your Mac microphone and listen on your speakers.
   - Type any line + Enter in the terminal to send a private `steer_phone_call` instruction mid-call.
   - Type `/hangup` (or press `Ctrl+C`) to hang up cleanly and flush all artifacts.

### Useful Overrides

| Flag | Purpose |
| --- | --- |
| `--out <dir>` | Output folder for recordings and transcript (never inside the repo) |
| `--objective <text>` | Override the call objective |
| `--first-message <text>` | Override the opening spoken turn guidance |
| `--context <text>` | Add background context for scenario testing |
| `--callee-name <name>` | Override the recipient label in transcripts |
| `--stt-base-url` / `--stt-model` | Override STT endpoint or model |
| `--llm-base-url` / `--llm-model` | Override LLM endpoint or model |
| `--tts-base-url` / `--tts-model` / `--tts-voice` | Override TTS endpoint, model, or voice |
| `--answer-delay <sec>` | Override `baresip` auto-answer delay (default: `1`) |
| `--max-duration <sec>` | Automatic hang-up deadline in seconds (default: `900`) |
| `--build` | Build release `dappercode-bridge` automatically if missing |

## 2. Recorded Artifacts

Each run writes a self-contained bundle to the output directory (default
`/tmp/dappercode-phone-tests/call-<timestamp>-<hex>/`):

| File | Contents |
| --- | --- |
| `transcript.md` | Analysis-ready Markdown report: metadata, models, phase timings, audio stats, chronological transcript, steers, and errors |
| `transcript.json` | Machine-readable bundle with `metadata`, `timings`, `audio`, `transcript`, `steers`, and raw `callReport` from `get_phone_call` |
| `events.jsonl` | Timestamped JSON Lines of every bridge UI surface event, transcript arrival, steer, and SIP/RTP event |
| `mixed.wav` | Mono 8 kHz PCM16 mix of AI + User (time-aligned) |
| `stereo.wav` | Stereo 8 kHz PCM16 (Left = AI, Right = User) for inspecting barge-in, echo, and turn gaps |
| `ai.wav` / `user.wav` | Separate mono 8 kHz PCM16 tracks for independent ASR or listening checks |
| `bridge.log` / `baresip.log` | Raw process logs for transport or model debugging |

## 3. Analyze a Recorded Call for Improvements

When the user hands you a call bundle directory (or asks you to analyze the latest run):

1. Read `transcript.md` and `transcript.json` first, then inspect `events.jsonl` for exact
   inter-turn latencies, barge-in interruptions (`[interrupted]`), hold transitions, and errors.
2. Check audio health from `transcript.json` (`audio.tracks.ai` and `audio.tracks.user`):
   - Very low `user` RMS / `nonSilentRatio` suggests microphone gain or CoreAudio input issues.
   - High `clippedSamples` indicates PCMU headroom clipping (`services/rust-bridge/src/phone_call/audio.rs`).
   - Compare `user.wav` against the transcribed user turns (re-transcribing `user.wav` with an
     independent local recognizer when helpful) to separate **STT errors** from **LLM reasoning
     issues**.
3. Map concrete failure modes back to the owning layer:
   - **Latency / warm-up / timeouts / streaming:** `services/rust-bridge/src/phone_call/voice.rs`
   - **Turn-taking, VAD, barge-in, hold, steering, premature hang-up:** `services/rust-bridge/src/phone_call/mod.rs`
   - **Prompting, tone, brevity, role adherence, structured `phone_turn` schema:** `services/rust-bridge/src/phone_call/voice.rs`
   - **Telephone filtering, headroom, PCMU encode/decode:** `services/rust-bridge/src/phone_call/audio.rs`
   - **SIP signaling, RTP pacing, hold/re-INVITE:** `services/rust-bridge/src/phone_call/sip.rs`
4. Verify any fix with unit/regression tests and a fresh recorded run using the same flags so before
   and after bundles are directly comparable.

## Self-Test

After editing any script in this skill, run:

```bash
node --test .agents/skills/local-phone-call-test/scripts/test.mjs
```
