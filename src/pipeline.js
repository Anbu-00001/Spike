// TIFO shared engine: offline near-real-time commentary translation.
// Exposes liveTranslate() as an async generator of events, consumed by both the
// CLI (src/stream.js) and the web server (src/server.js). No cloud, no API keys.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  ROOT, loadConfig, getSdk, load, unload, predownload,
  pcm16ToWav, collectPcm, streamToText, resolveModel,
} from "./lib.js";

export const cfg = loadConfig();
export const OUT = path.join(ROOT, cfg.outDir);
mkdirSync(OUT, { recursive: true });

const RATE = 16000, BYTES_PER_SAMPLE = 4; // f32le for streaming ASR
const CHUNK_BYTES = Math.floor((cfg.stream.chunkMs / 1000) * RATE) * BYTES_PER_SAMPLE;
const TTS_RATE = 44100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function concatInt16(list) {
  const total = list.reduce((n, a) => n + a.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const a of list) { out.set(a, off); off += a.length; }
  return out;
}
const silenceInt16 = (ms, rate) => new Int16Array(Math.floor((ms / 1000) * rate));

// Whisper hallucinates short phantoms ("you", "[BLANK_AUDIO]") on silence — drop them.
function isMeaningful(text) {
  const t = (text || "").trim();
  if (!t || t.includes("[No speech detected]") || /^\[[^\]]+\]$/.test(t)) return false;
  return t.replace(/[^\p{L}\p{N}]/gu, "").length >= 3;
}

function ffmpegF32le(inPath, rate = RATE) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-i", inPath, "-ar", String(rate), "-ac", "1", "-sample_fmt", "flt", "-f", "f32le", "pipe:1"],
      { stdio: ["ignore", "pipe", "ignore"] });
    const bufs = [];
    ff.stdout.on("data", (d) => bufs.push(d));
    ff.on("close", (c) => (c === 0 ? resolve(Buffer.concat(bufs)) : reject(new Error(`ffmpeg exited ${c}`))));
  });
}

// Synthesize a multi-utterance source-language commentary clip (cached on disk).
export async function buildCommentary(source) {
  const p = path.join(OUT, `commentary_${source}.wav`);
  if (existsSync(p)) return p;
  const sdk = await getSdk();
  const id = await load({
    constName: cfg.models.tts.const, type: "tts",
    modelConfig: { ttsEngine: cfg.models.tts.engine, language: source, ttsSpeed: cfg.stream.ttsSpeed, ttsNumInferenceSteps: cfg.stream.ttsSteps },
  });
  try {
    const parts = [];
    for (const line of cfg.sample.commentaryLines) {
      const res = await sdk.textToSpeech({ modelId: id, text: line, inputType: "text", stream: false });
      parts.push(await collectPcm(res), silenceInt16(cfg.stream.gapMs, TTS_RATE));
    }
    writeFileSync(p, pcm16ToWav(concatInt16(parts), TTS_RATE, 1));
    return p;
  } finally { await unload(id); }
}

/**
 * Live offline translation as an async generator of events:
 *   { type:"status", msg }
 *   { type:"utterance", src, tgt, latMs, pcm:Int16Array, ttsRate }
 *   { type:"done", count, avgLatMs }
 */
export async function* liveTranslate({ source = cfg.lang.source, target = cfg.lang.target, paced = cfg.stream.paceRealtime, inputWav } = {}) {
  const sdk = await getSdk();
  yield { type: "status", msg: "Preparing audio…" };
  const clip = inputWav || await buildCommentary(source);
  const f32 = await ffmpegF32le(clip);

  yield { type: "status", msg: "Loading on-device models (Whisper + Silero VAD, Bergamot, Supertonic)…" };
  await predownload(cfg.stream.vad);
  const vadDesc = await resolveModel(cfg.stream.vad);
  const asrId = await load({
    constName: cfg.models.asr.const, type: "whisper",
    modelConfig: {
      vadModelSrc: vadDesc, audio_format: "f32le", strategy: "greedy", n_threads: cfg.stream.asrThreads,
      language: source, no_timestamps: true, suppress_blank: true, suppress_nst: true, temperature: 0.0,
      vad_params: cfg.stream.vadParams,
    },
  });
  const nmtGuess = `BERGAMOT_${source.toUpperCase()}_${target.toUpperCase()}`;
  const nmtConst = (nmtGuess in sdk) ? nmtGuess : cfg.models.nmt.const;
  const nmtId = await load({ constName: nmtConst, type: "nmt", modelConfig: { engine: cfg.models.nmt.engine, from: source, to: target } });
  const ttsId = await load({
    constName: cfg.models.tts.const, type: "tts",
    modelConfig: { ttsEngine: cfg.models.tts.engine, language: target, ttsSpeed: cfg.stream.ttsSpeed, ttsNumInferenceSteps: cfg.stream.ttsSteps },
  });

  yield { type: "status", msg: `Live — ${source} → ${target}, 100% on-device, 0 KB sent` };
  const session = await sdk.transcribeStream({ modelId: asrId });
  (async () => {
    try {
      for (let off = 0; off < f32.length; off += CHUNK_BYTES) {
        session.write(f32.subarray(off, off + CHUNK_BYTES));
        if (paced) await sleep(cfg.stream.chunkMs);
      }
    } catch { /* feeder aborted */ }
    finally { try { session.end(); } catch {} }
  })();

  const lat = [];
  try {
    for await (const raw of session) {
      if (!isMeaningful(raw)) continue;
      const t0 = Date.now();
      const src = raw.trim();
      const tr = await sdk.translate({ modelId: nmtId, text: src, stream: false, modelType: "nmt" });
      const tgt = (await streamToText(tr)).trim();
      const ttsRes = await sdk.textToSpeech({ modelId: ttsId, text: tgt || "...", inputType: "text", stream: false });
      const pcm = await collectPcm(ttsRes);
      const latMs = Date.now() - t0;
      lat.push(latMs);
      yield { type: "utterance", src, tgt, latMs, pcm, ttsRate: TTS_RATE };
    }
  } catch (e) {
    yield { type: "status", msg: `error: ${e?.message || e}` };
  }
  await unload(asrId); await unload(nmtId); await unload(ttsId);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
  yield { type: "done", count: lat.length, avgLatMs: avg };
}
