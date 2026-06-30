# TIFO — the offline matchday companion (Tether Developers Cup, QVAC track)

**Verdict: 🟢 GO.** A fully offline `speech → ASR → translate → speech` pipeline **and** a
grounded offline Q&A companion run on this machine (Dell Inspiron 16 5640, Intel Core 7 150U,
**CPU-only**, no GPU/Vulkan) using Tether's `@qvac/sdk@0.14.0`. Nothing here calls the cloud or
any API key — **0 KB sent, 100% on-device.**

## Why offline — and why that wins (this is the pitch, not a gimmick)

TIFO is **not** a "smarter couch companion." That lane is taken by well-funded, cloud-bound
rivals — the **Premier League Companion** (Microsoft) and Bundesliga **"Captain"** (AWS Bedrock) —
and a small on-device model will never out-IQ GPT-4-class cloud. So we **don't compete on IQ. We
compete on access, sovereignty, language and zero cost.** *It's not a football app; it's the QVAC
thesis wearing a Juventus shirt.* Where offline genuinely wins (evidence-backed):

1. **In the stadium, the cloud dies.** Crowds of 25k–80k crush cellular networks and concrete/steel
   block signal — venues install Distributed Antenna Systems precisely because phones fail at
   capacity. On-device works at 0 bars. ([Wireless Infrastructure Group](https://www.wirelessinfrastructure.com/insights/blog-why-mobile-signal-fails-in-stadiums-when-you-need-it-most/), [Mobile Industry Review](https://www.mobileindustryreview.com/premier-league-signal-nightmares-which-stadiums-leave-fans-in-a-connectivity-black-hole/))
2. **Cloud companions are walled gardens.** PL Companion knows only the Premier League; Captain only
   the Bundesliga. They do nothing for a Copa Libertadores night, AFCON, a second-division derby, or a
   kid's match. **TIFO is league-agnostic — it works on any audio.**
3. **Data cost locks out Tether's own user base.** 1 GB ≈ 2.4% of monthly income in Sub-Saharan Africa
   (≈5% for the poorest 40%; West Africa ~$29.79/GB); only 45% of adults are online. TIFO sends **0 KB**
   after a one-time model download. ([World Bank via Kenyan Wall Street](https://kenyanwallstreet.com/expensive-mobile-data-is-stalling-africas-digital-leap-world-bank), [Broadband.co.uk](https://www.broadband.co.uk/mobile-data-world-affordability))
4. **It *is* Tether/QVAC's thesis.** Tether's own words: *"AI agents on user devices, not Big Tech data
   centers,"* with explicit focus on data sovereignty, privacy, and *"operational continuity in
   high-latency geographical areas (emerging markets)."* A cloud football companion is **off-thesis** at
   this hackathon; the judges built QVAC for exactly this. ([tether.io](https://tether.io/news/tether-announces-qvac-its-upcoming-development-platform-for-infinite-and-ubiquitous-intelligence-deploying-and-evolving-ai-agents-on-user-devices-not-big-tech-data-centers/))
5. **Language.** Broadcasters don't carry your language for most matches. TIFO does offline
   speech→speech commentary translation (hi/ar/pt/it/…) with no localized stream and no cloud — which no
   cloud companion does for the audio in front of you.

### Form factor: TIFO ships as a *phone* app — the laptop is only the dev rig
Nobody carries a laptop to a stadium. The Dell here is just the hardware we had for a 15-day spike;
**QVAC's first-class targets are iOS + Android via Expo/React Native** (see Architecture below). The
models fit a modern phone — Whisper-tiny ~75 MB, Bergamot ~37 MB, Supertonic ~127 MB, LLaMA-1B-Q4
~770 MB — and phone NPUs (Apple Neural Engine, Qualcomm Hexagon) run them *more* power-efficiently than
our laptop CPU. You bring the phone you already own (+ a cheap power bank). **Honest gaps:** the Expo
build is the next port (this spike is Node/web); continuous 90-min live translation is a real
battery/thermal load, so on phone it's the "expensive mode" (use in bursts) while the bursty Q&A
companion is cheap; and for phone we'd swap the 670 MB GTE-large embedder for the ~240 MB
EmbeddingGemma-300M (config-driven, needs threshold re-calibration).

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
- `src/rag.js` — QVAC `embed()` + disk-cached in-memory cosine index (`smoke | build | query`).
- `src/companion.js` — `askCompanion()` generator (retrieve → grounded LLM → translate → speak) + CLI.
- `data/football-pack.json` — curated, IFAB-grounded retrieval corpus (the companion's knowledge).
- `src/00-inspect.js` — dumps the real SDK exports/model constants for the installed version.
- `out/` — generated audio + logs (`sdk-exports.txt` has the full constant list).

## Architecture decision (where each language goes)
- **AI core / orchestration:** TypeScript via `@qvac/sdk` (engines are native C++: llama.cpp, whisper.cpp, Bergamot, ONNX).
- **App UI:** Expo + React Native (TypeScript) — QVAC's blessed mobile path. (Desktop alt: Electron/Node, also supported.)
- **Heavy inference runtime:** Bare (in-process native addons), off the UI thread.
- **Model prep / RAG pack (build-time only):** Python.
- **P2P stretch (Cup):** Hyperswarm/Hypercore via Pears (JS on Bare).

## Day 3 — DONE 🟢 near-real-time streaming + web UI

Live, **fully offline** commentary translation works on CPU. Streaming Whisper + Silero VAD
segment speech by silence; each finalized utterance is translated (Bergamot) and spoken (Supertonic).

```
node src/stream.js                 # CLI: EN commentary -> target lang, with per-utterance latency
QVAC_TARGET=hi node src/stream.js  # switch language (hi, ar, fr, pt, it, es, ...)
node src/server.js                 # local web UI at http://localhost:8787
```

Measured (Intel Core 7 150U, CPU): **4/4 utterances translated, avg added latency ~2.9–3.2s**
(translate+speak per utterance), 100% on-device. Example (en→it): *"He shoots and it's a goal..."*
→ *"Spara ed è un gol, un fulmine assoluto nell'ultimo minuto."*

- `src/pipeline.js` — shared engine: `liveTranslate()` async generator (status / utterance / done events).
- `src/stream.js` — CLI consumer (writes the spoken-translation WAV).
- `src/server.js` + `public/index.html` — local web UI: "pick your nation" → live dual subtitles,
  plays each translated clip, **"0 KB sent · 100% on-device"** badge. Events stream over SSE.

Streaming gotchas solved: streaming ASR wants **`audio_format:"f32le"`** + `vadModelSrc:VAD_SILERO_5_1_2`
+ `vad_params`; `transcribeStream({modelId})` returns a duplex session (`.write(f32 chunk)`, `.end()`,
async-iterable for utterances); filter Whisper silence-phantoms. The QVAC registry is **single-writer** —
kill stray `node ... dl` processes if you hit `File descriptor could not be locked`.

## Day 4 — DONE 🟢 offline grounded Q&A companion (RAG)

Ask a football question, get a **grounded** spoken answer — 100% on-device. Uses **QVAC-native
embeddings** (`embed()` with `GTE_LARGE_FP16`, 1024-dim) over a curated football pack, an in-memory
cosine index (no external vector DB → truly offline), then a strict-grounded LLM (LLaMA 3.2 1B) →
optional Bergamot translate + Supertonic speak.

```
node src/rag.js smoke                       # de-risk: prove embed() + topic separation
node src/rag.js build                        # embed the pack → out/rag-index.json (cached)
node src/companion.js "what is offside?"      # grounded answer
node src/companion.js --speak "how many substitutions are allowed?"
QVAC_TARGET=it node src/companion.js --speak "what is VAR?"   # answer + speak in Italian
node src/server.js                            # web UI: "⚽ Ask" tab at http://localhost:8787
```

**Anti-hallucination is the headline feature, not a footnote.** A small model earns trust by
**grounding + honest refusal**, not by pretending to be GPT-4:
- Retrieval threshold calibrated from real data: in-pack top-1 cosine **0.88–0.93** vs out-of-pack
  **0.73–0.79** (clean ~0.09 gap) → `rag.minScore = 0.84`. Below it, TIFO **refuses** ("I don't have
  that in my offline matchday pack yet") instead of inventing. Verified: *"Who won the 2018 World Cup
  final?"* → refused (our pack has rules, not results).
- `temp:0` + strict extractive prompt fixed a real faithfulness bug (1B first answered "**4**
  substitutions"; context says "**five**" → now correct). Measured warm latency **~1–3 s/answer** on CPU.
- The LLM is config-driven: `QVAC_LLM=GEMMA4_2B_MULTIMODAL_Q4_K_M` swaps in a stronger 2B model for
  comparison/synthesis questions (with `reasoning_budget:0` already set, a no-op on LLaMA).

New files: `src/rag.js` (embeddings + cosine index), `src/companion.js` (`askCompanion()` generator +
CLI), `data/football-pack.json` (curated, IFAB-grounded corpus), plus the **⚽ Ask** tab in
`public/index.html` and the `/ask` SSE route in `src/server.js`.

## Config & secrets
`config/config.json` holds every tunable (models, languages, CPU flags, RAG/companion params) — **no
hardcoded models in code**. It is **gitignored** (machine-local); `config/config.example.json` is the
committed template and `loadConfig()` falls back to it, so a fresh clone still runs. Override either with
`QVAC_CONFIG=/path`. Per-run env overrides: `QVAC_TARGET/SOURCE/NMT/ASR/TTS/LLM/EMBED`.

## Next
Port the UI to **Expo/React Native** (the real phone build), lower live-translation latency (Parakeet
streaming ASR / fewer TTS steps), optionally lighten the embedder (EmbeddingGemma) for phones, and record
the ≤3-min video (airplane mode → live translate → ask the companion → mission close).
