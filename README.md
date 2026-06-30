# QVAC De-Risk Spike — Day 1–2 (Tether Developers Cup, QVAC track)

**Verdict: 🟢 GO.** A fully offline `speech → ASR → translate → speech` pipeline runs on
this machine (Dell Inspiron 16 5640, Intel Core 7 150U, **CPU-only**, no GPU/Vulkan) using
Tether's `@qvac/sdk@0.14.0`. This is the core of the planned **TIFO** offline football
companion. Nothing here calls the cloud or any API key.

## What was proven (real runs, not mockups)

| Stage | Model (CPU) | Result |
|-------|-------------|--------|
| LLM   | `LLAMA_3_2_1B_INST_Q4_0` | correct offside-rule explanation, 174 chars in **3.0s** |
| TTS (en) | `TTS_MULTILINGUAL_SUPERTONIC3_Q8_0` | 302k samples @ 44.1kHz WAV |
| ASR | `WHISPER_TINY` (`audio_format:"s16le"`) | "And it's a goal, an absolute thunderbolt from outside the box in the final minute of the match." |
| NMT (en→es) | `BERGAMOT_EN_ES` | "Y es un gol, un trueno absoluto desde fuera del área en el último minuto del partido." |
| TTS (es) | `TTS_MULTILINGUAL_SUPERTONIC3_Q8_0` | `out/e2e_out_es.wav` (~6s Spanish) |
| **End-to-end** | all of the above | **all 4 checks GREEN, 19.8s** incl. 4 model loads |

Model loads from local cache: TTS ~0.9s, Whisper ~0.8s, Bergamot ~0.3s.

## How to run

```bash
cd qvac-spike
npm install                       # ~5.5 GB native engines (one time)
node src/spike.js dl              # warm model cache (~1 GB, resumable)
node src/spike.js env             # method presence check
node src/spike.js llm             # LLM sanity
node src/spike.js e2e             # the full offline pipeline + GO/NO-GO
aplay out/e2e_out_es.wav          # listen to the Spanish output
```

Config lives in `config/config.json` (no hardcoded models/languages in code). Override per-run:
```bash
QVAC_TARGET=hi node src/spike.js nmt     # English → Hindi
QVAC_TARGET=ar QVAC_NMT=BERGAMOT_EN_AR node src/spike.js e2e
```

## Hard-won facts (the stuff the LLM dossiers got wrong or omitted)

1. **No Flutter.** QVAC's runtimes are **Node.js ≥22.17, Bare, Expo (React Native)**. The app
   UI should be **Expo/React Native (TypeScript)**, not Flutter. (Verified in `@qvac/sdk` README + docs.)
2. **Big-blob download timeout.** The registry stream times out at **60s** by default → fails on
   the 773 MB LLaMA blob. Fix: `qvac.config.json` with `registryStreamTimeoutMs: 600000`. Auto-discovered
   in project root (or `QVAC_CONFIG_PATH`). Use `downloadAsset()` (resumable) before `loadModel`.
3. **`loadModel` returns the modelId STRING** (decorated with `requestId`), not `{ modelId }`.
4. **`loadModel` rejects unknown top-level keys** (e.g. `timeout`) — `timeout` lives inside `modelConfig`.
5. **NMT needs `modelConfig: { engine:"Bergamot", from, to }`** at load; `translate({...,modelType:"nmt"})` at call.
   For `stream:false`, the translation is in **`await result.text`** (a Promise).
6. **TTS**: `textToSpeech({modelId,text,inputType:"text",stream:false})` → `await result.buffer` (Int16Array).
   Do **not** also consume `result.bufferStream` — that cancels the synth ("cancelled before text encoder").
   Supertonic output is **44.1 kHz mono s16le**.
7. **ASR audio input**: pass `audioChunk` as a **string file path** OR a **raw Buffer** — NOT a `{type,value}`
   object (the client base64-encodes a Buffer for you). We feed **raw s16le 16 kHz mono PCM** (via ffmpeg)
   as a Buffer with `modelConfig.audio_format:"s16le"`.
8. **Language coverage** (verified in the SDK schemas): Bergamot NMT EN↔{es,hi,ar,fr,pt,zh,…} + IndicTrans +
   an African model; Supertonic/Chatterbox TTS include **es, hi, ar, fr, pt, sw, zh**. Whisper ASR multilingual.

## Files
- `config/config.json` — all tunables (models, languages, CPU flags, sample text).
- `qvac.config.json` — SDK config (raised registry timeout for slow links).
- `src/lib.js` — SDK helpers: predownload (resumable), load/unload, WAV writer, ffmpeg raw-PCM, result normalizers.
- `src/spike.js` — stages: `env | dl | llm | tts | asr | nmt | e2e`.
- `src/00-inspect.js` — dumps the real SDK exports/model constants for the installed version.
- `out/` — generated audio + logs (`sdk-exports.txt` has the full constant list).

## Architecture decision (where each language goes)
- **AI core / orchestration:** TypeScript via `@qvac/sdk` (engines are native C++: llama.cpp, whisper.cpp, Bergamot, ONNX).
- **App UI:** Expo + React Native (TypeScript) — QVAC's blessed mobile path. (Desktop alt: Electron/Node, also supported.)
- **Heavy inference runtime:** Bare (in-process native addons), off the UI thread.
- **Model prep / RAG pack (build-time only):** Python.
- **P2P stretch (Cup):** Hyperswarm/Hypercore via Pears (JS on Bare).

## Next (Day 3+)
Build the chunked **near-real-time** path (segment mic audio → ASR → NMT → TTS queue) and the polished
Expo UI ("pick your nation" → live dual subtitles + spoken translation), then the offline voice companion
(LLM + RAG football pack), then the airplane-mode "0 KB / 100% on-device" proof for the demo.
