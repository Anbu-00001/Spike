// QVAC de-risk spike orchestrator.
//   node src/spike.js <env|llm|tts|asr|nmt|e2e>
// Proves the offline football-companion pipeline: audio -> ASR -> NMT -> TTS -> audio.
// Config-driven (config/config.json + QVAC_* env overrides). No hardcoded models/languages.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ROOT, loadConfig, getSdk, load, unload, predownload,
  streamToText, collectPcm, pcm16ToWav, ffmpegToRawPcm,
  ok, bad, head,
} from "./lib.js";

const cfg = loadConfig();
const OUT = path.join(ROOT, cfg.outDir);
mkdirSync(OUT, { recursive: true });

// During process teardown the SDK aborts in-flight RPCs (WORKER_SHUTDOWN); don't let that
// stray rejection crash a stage that already produced its result.
process.on("unhandledRejection", (e) => {
  const m = e?.message || String(e);
  if (/WORKER_SHUTDOWN|shutting down/i.test(m)) return;
  console.warn(`  (unhandledRejection) ${m}`);
});

const llmCfg = () => (cfg.useGpu ? { ctx_size: 4096 } : { ctx_size: 4096, gpu_layers: 0 });
const asrCfg = (lang) => ({ language: lang, contextParams: { use_gpu: !!cfg.useGpu } });
const ttsCfg = (lang) => ({ ttsEngine: cfg.models.tts.engine, language: lang, useGPU: !!cfg.useGpu });

// Derive a Bergamot pair constant from languages, falling back to the configured one.
async function nmtConst(src, tgt) {
  const sdk = await getSdk();
  const guess = `BERGAMOT_${src.toUpperCase()}_${tgt.toUpperCase()}`;
  if (guess in sdk) return guess;
  return cfg.models.nmt.const;
}

async function synth(lang, text, outName) {
  const sdk = await getSdk();
  const id = await load({ constName: cfg.models.tts.const, type: cfg.models.tts.type, modelConfig: ttsCfg(lang) });
  try {
    const res = await sdk.textToSpeech({ modelId: id, text, inputType: "text", stream: false });
    console.log(`    tts result keys: ${Object.keys(res || {}).join(", ") || "(none)"}`);
    const pcm = await collectPcm(res);
    const rate = res?.sampleRate ?? res?.sample_rate ?? cfg.audio.ttsSampleRate ?? 44100;
    const wav = pcm16ToWav(pcm, rate, 1);
    const p = path.join(OUT, outName);
    writeFileSync(p, wav);
    console.log(`    samples=${pcm.length} rate=${rate} -> ${path.relative(ROOT, p)} (${(wav.length / 1024).toFixed(0)} KB)`);
    return { path: p, samples: pcm.length, rate };
  } finally {
    await unload(id);
  }
}

async function transcribe(lang, wavPath) {
  const sdk = await getSdk();
  const pcmPath = path.join(OUT, "asr_input_16k.pcm");
  await ffmpegToRawPcm(wavPath, pcmPath, cfg.audio.asrSampleRate);
  const pcmBuf = readFileSync(pcmPath); // raw s16le mono PCM bytes; client base64-encodes a Buffer
  const id = await load({
    constName: cfg.models.asr.const,
    type: cfg.models.asr.type,
    modelConfig: { ...asrCfg(lang), audio_format: "s16le" },
  });
  try {
    const res = await sdk.transcribe({ modelId: id, audioChunk: pcmBuf });
    const text = (await streamToText(res)).trim();
    return text;
  } finally {
    await unload(id);
  }
}

async function translate(src, tgt, text) {
  const sdk = await getSdk();
  const c = await nmtConst(src, tgt);
  const id = await load({
    constName: c,
    type: cfg.models.nmt.type,
    modelConfig: { engine: cfg.models.nmt.engine, from: src, to: tgt },
  });
  try {
    const res = await sdk.translate({ modelId: id, text, stream: false, modelType: "nmt" });
    return { text: (await streamToText(res)).trim(), model: c };
  } finally {
    await unload(id);
  }
}

const stages = {
  async dl() {
    head("PRE-DOWNLOAD (warm model cache; resumable)");
    const wanted = [cfg.models.llm, cfg.models.asr, cfg.models.tts, cfg.models.nmt].map((m) => m.const);
    for (const c of wanted) { console.log(`-> ${c}`); await predownload(c); }
    ok(`cached ${wanted.length} models`);
  },

  async env() {
    head("ENV");
    const sdk = await getSdk();
    const need = ["loadModel", "unloadModel", "completion", "transcribe", "translate", "textToSpeech"];
    let allOk = true;
    for (const n of need) { const present = n in sdk; (present ? ok : bad)(`${n} ${present ? "present" : "MISSING"}`); allOk &&= present; }
    console.log(`device=${cfg.device} useGpu=${cfg.useGpu}`);
    if (!allOk) process.exitCode = 2;
  },

  async llm() {
    head("LLM (sanity: install + native addon + inference)");
    const sdk = await getSdk();
    const id = await load({ constName: cfg.models.llm.const, type: cfg.models.llm.type, modelConfig: llmCfg() });
    try {
      const t0 = Date.now();
      const res = await sdk.completion({ modelId: id, history: [{ role: "user", content: cfg.sample.llmPrompt }], stream: true });
      const text = (await streamToText(res)).trim();
      console.log(`  prompt : ${cfg.sample.llmPrompt}`);
      console.log(`  answer : ${text}`);
      (text.length > 0 ? ok : bad)(`LLM produced ${text.length} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } finally { await unload(id); }
  },

  async tts() {
    head(`TTS (${cfg.lang.target})`);
    const r = await synth(cfg.lang.target, cfg.sample.commentary, `tts_${cfg.lang.target}.wav`);
    (r.samples > 0 ? ok : bad)(`TTS produced ${r.samples} samples`);
  },

  async asr() {
    head(`ASR (${cfg.lang.source})`);
    // Generate source-language audio with TTS if we don't already have one (cold-runnable).
    const src = path.join(OUT, `tts_${cfg.lang.source}.wav`);
    if (!existsSync(src)) { console.log("  no source wav; generating one with TTS..."); await synth(cfg.lang.source, cfg.sample.commentary, `tts_${cfg.lang.source}.wav`); }
    const text = await transcribe(cfg.lang.source, src);
    console.log(`  reference : ${cfg.sample.commentary}`);
    console.log(`  asr text  : ${text}`);
    (text.length > 0 ? ok : bad)(`ASR produced ${text.length} chars`);
  },

  async nmt() {
    head(`NMT (${cfg.lang.source} -> ${cfg.lang.target})`);
    const r = await translate(cfg.lang.source, cfg.lang.target, cfg.sample.commentary);
    console.log(`  source [${cfg.lang.source}] : ${cfg.sample.commentary}`);
    console.log(`  target [${cfg.lang.target}] : ${r.text}  (model ${r.model})`);
    (r.text.length > 0 ? ok : bad)(`NMT produced ${r.text.length} chars`);
  },

  async e2e() {
    head(`END-TO-END  ${cfg.lang.source} speech -> ${cfg.lang.target} speech (fully offline)`);
    const checks = [];
    // 1) make source-language "commentary" audio
    const inAudio = await synth(cfg.lang.source, cfg.sample.commentary, `e2e_in_${cfg.lang.source}.wav`);
    checks.push(["TTS source audio", inAudio.samples > 0]);
    // 2) ASR it back
    const heard = await transcribe(cfg.lang.source, inAudio.path);
    console.log(`  [ASR ${cfg.lang.source}] ${heard}`);
    checks.push(["ASR transcript non-empty", heard.length > 0]);
    // 3) translate
    const tr = await translate(cfg.lang.source, cfg.lang.target, heard || cfg.sample.commentary);
    console.log(`  [NMT ${cfg.lang.source}->${cfg.lang.target}] ${tr.text}`);
    checks.push(["NMT output non-empty", tr.text.length > 0]);
    // 4) speak the translation
    const outAudio = await synth(cfg.lang.target, tr.text || "hola", `e2e_out_${cfg.lang.target}.wav`);
    checks.push(["TTS target audio", outAudio.samples > 0]);

    head("GO / NO-GO");
    let pass = true;
    for (const [name, good] of checks) { (good ? ok : bad)(name); pass &&= good; }
    console.log(`\n  Output spoken file: ${path.relative(ROOT, outAudio.path)}  (play: aplay '${outAudio.path}')`);
    console.log(pass ? "\n\x1b[42m\x1b[30m GO — offline ASR->NMT->TTS pipeline works on CPU \x1b[0m"
                     : "\n\x1b[41m NO-GO — a stage failed; see logs above \x1b[0m");
    if (!pass) process.exitCode = 1;
  },
};

const stage = (process.argv[2] || "env").toLowerCase();
if (!stages[stage]) { console.error(`Unknown stage "${stage}". Use: ${Object.keys(stages).join(" | ")}`); process.exit(64); }
const T0 = Date.now();
try {
  await stages[stage]();
  console.log(`\n(${stage} finished in ${((Date.now() - T0) / 1000).toFixed(1)}s)`);
} catch (err) {
  bad(`stage "${stage}" threw:`);
  console.error(err);
  process.exit(1);
}
