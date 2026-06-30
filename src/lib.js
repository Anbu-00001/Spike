// Shared helpers for the QVAC de-risk spike.
// Everything is config-driven; nothing about models/languages is hardcoded here.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export function loadConfig() {
  // config/config.json is machine-local (gitignored); fall back to the committed
  // template so a fresh clone still runs. Override either with QVAC_CONFIG.
  const candidates = [
    process.env.QVAC_CONFIG,
    path.join(ROOT, "config", "config.json"),
    path.join(ROOT, "config", "config.example.json"),
  ].filter(Boolean);
  const file = candidates.find((p) => existsSync(p));
  if (!file) throw new Error(`No config found (looked for: ${candidates.join(", ")})`);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  // Allow shallow env overrides without touching the file (no hardcoded bits).
  if (process.env.QVAC_TARGET) cfg.lang.target = process.env.QVAC_TARGET;
  if (process.env.QVAC_SOURCE) cfg.lang.source = process.env.QVAC_SOURCE;
  if (process.env.QVAC_NMT) cfg.models.nmt.const = process.env.QVAC_NMT;
  if (process.env.QVAC_ASR) cfg.models.asr.const = process.env.QVAC_ASR;
  if (process.env.QVAC_TTS) cfg.models.tts.const = process.env.QVAC_TTS;
  if (process.env.QVAC_LLM) cfg.models.llm.const = process.env.QVAC_LLM;
  if (process.env.QVAC_EMBED) cfg.models.embed.const = process.env.QVAC_EMBED;
  return cfg;
}

let _sdk;
export async function getSdk() {
  if (!_sdk) _sdk = await import("@qvac/sdk");
  return _sdk;
}

// Resolve a model descriptor object from its exported constant NAME.
export async function resolveModel(constName) {
  const sdk = await getSdk();
  if (!(constName in sdk)) {
    throw new Error(`Model constant "${constName}" is not exported by @qvac/sdk (check spelling / version).`);
  }
  return sdk[constName];
}

const mb = (b) => (b / 1e6).toFixed(0);
const LOAD_TIMEOUT_MS = Number(process.env.QVAC_LOAD_TIMEOUT_MS || 1_800_000); // 30 min

// Pre-download an asset (resumable, no inference timeout). Safe to call when already cached.
export async function predownload(constName, { retries = 8 } = {}) {
  const sdk = await getSdk();
  const desc = await resolveModel(constName);
  let lastPct = -1;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sdk.downloadAsset({
        assetSrc: desc,
        onProgress: (p) => {
          if (!p || typeof p.percentage !== "number") return;
          const pct = Math.floor(p.percentage);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`    ▸ ${constName} ${pct}% (${mb(p.downloaded || 0)}/${mb(p.total || 0)} MB)\r`);
          }
        },
      });
      process.stdout.write(`\n  ✓ cached ${constName}\n`);
      return;
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`\n  download attempt ${attempt}/${retries} for ${constName} failed: ${msg.slice(0, 160)}`);
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30000, 3000 * attempt)));
    }
  }
}

// Load a model with progress logging; returns its modelId. modelConfig is passed through verbatim.
// Pre-downloads first (resumable) so the big blob never trips loadModel's per-request timeout.
export async function load({ constName, type, modelConfig }) {
  const sdk = await getSdk();
  const modelSrc = await resolveModel(constName);
  await predownload(constName);
  let lastPct = -1;
  const t0 = Date.now();
  process.stdout.write(`  loadModel(${constName}, type=${type ?? "auto"})\n`);
  const loaded = await sdk.loadModel({
    modelSrc,
    ...(type ? { modelType: type } : {}), // embedders auto-detect; omit to let the SDK infer
    ...(modelConfig ? { modelConfig } : {}),
    onProgress: (p) => {
      if (!p || typeof p.percentage !== "number") return;
      const pct = Math.floor(p.percentage);
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        process.stdout.write(`    ▸ loading ${pct}% (${mb(p.downloaded || 0)}/${mb(p.total || 0)} MB)\r`);
      }
    },
  });
  // loadModel resolves to the modelId string (decorated with requestId); be defensive about shape.
  const modelId = typeof loaded === "string" ? loaded : loaded?.modelId;
  if (!modelId) throw new Error(`loadModel(${constName}) returned no modelId (got ${JSON.stringify(loaded)?.slice(0, 80)})`);
  process.stdout.write(`\n  ✓ loaded ${constName} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${modelId}\n`);
  return modelId;
}

export async function unload(modelId) {
  if (!modelId) return;
  try {
    const sdk = await getSdk();
    await sdk.unloadModel({ modelId });
  } catch (e) {
    console.warn(`  (unload warning) ${e?.message || e}`);
  }
}

// Normalize various return shapes (string | {text} | {tokenStream} | {buffer|bufferStream}) into text.
export async function streamToText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  // translate(stream:false) exposes `.text` as a Promise; transcribe returns a plain string field.
  if (result.text !== undefined) {
    return typeof result.text?.then === "function" ? String(await result.text) : String(result.text);
  }
  if (result.tokenStream && typeof result.tokenStream[Symbol.asyncIterator] === "function") {
    let acc = "";
    for await (const tok of result.tokenStream) acc += typeof tok === "string" ? tok : (tok?.text ?? "");
    return acc;
  }
  if (typeof result[Symbol.asyncIterator] === "function") {
    let acc = "";
    for await (const tok of result) acc += typeof tok === "string" ? tok : (tok?.text ?? tok?.token ?? "");
    return acc;
  }
  return JSON.stringify(result);
}

// Collect a TTS result into a flat Int16Array of PCM samples, regardless of buffer vs bufferStream.
export async function collectPcm(result) {
  const chunks = [];
  const push = (b) => {
    if (b == null) return;
    if (b instanceof Int16Array) chunks.push(b);
    else if (ArrayBuffer.isView(b)) chunks.push(new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)));
    else if (b instanceof ArrayBuffer) chunks.push(new Int16Array(b));
    else if (Array.isArray(b)) chunks.push(Int16Array.from(b));
  };
  // Prefer the materialized buffer (stream:false). Consuming bufferStream as well would
  // cancel the non-stream synth ("cancelled before text encoder") and leak an unhandled rejection.
  if (result?.buffer !== undefined) {
    push(await result.buffer);
  } else if (result?.bufferStream && typeof result.bufferStream[Symbol.asyncIterator] === "function") {
    for await (const c of result.bufferStream) push(c);
  } else if (typeof result?.[Symbol.asyncIterator] === "function") {
    for await (const c of result) push(c?.buffer ?? c);
  } else {
    push(result);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Minimal canonical WAV (PCM s16le) writer.
export function pcm16ToWav(int16, sampleRate, channels = 1) {
  const bytesPerSample = 2;
  const dataLen = int16.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], 44 + i * 2);
  return buf;
}

// Convert any audio file to RAW s16le mono PCM at the given rate (what Whisper base64 wants).
export function ffmpegToRawPcm(inPath, outPath, sampleRate = 16000) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-i", inPath, "-ar", String(sampleRate), "-ac", "1", "-f", "s16le", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(outPath) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });
}

export function ok(msg) { console.log(`\x1b[32m✔ ${msg}\x1b[0m`); }
export function bad(msg) { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
export function head(msg) { console.log(`\n\x1b[36m=== ${msg} ===\x1b[0m`); }
