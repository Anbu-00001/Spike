// TIFO offline voice companion: ask a football question, get a grounded spoken
// answer — 100% on-device. Retrieval (QVAC embeddings) → strict-grounded LLM
// (LLaMA 3.2 1B) → optional translate (Bergamot) + speak (Supertonic). If the
// matchday pack doesn't cover the question, it refuses instead of hallucinating.
//
//   node src/companion.js "what is offside?"
//   node src/companion.js --speak "how many substitutions are allowed?"
//   QVAC_TARGET=it node src/companion.js --speak "what is VAR?"   # answer + speak in Italian
import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  ROOT, loadConfig, getSdk, load, unload, collectPcm, streamToText, pcm16ToWav, head, ok,
} from "./lib.js";
import { search, unloadEmbedder, cfg as ragCfg } from "./rag.js";

export const cfg = loadConfig();
const OUT = path.join(ROOT, cfg.outDir);
const TTS_RATE = cfg.audio.ttsSampleRate;
const comp = cfg.companion;

// ── lazily-loaded, reused models (one set per server lifetime) ────────────────
let _llm = null;
async function llm() {
  if (!_llm) _llm = await load({ constName: cfg.models.llm.const, type: "llm", modelConfig: { ctx_size: comp.ctxSize } });
  return _llm;
}
const _nmt = new Map(); // target -> modelId
async function nmt(source, target) {
  const key = `${source}->${target}`;
  if (_nmt.has(key)) return _nmt.get(key);
  const sdk = await getSdk();
  const guess = `BERGAMOT_${source.toUpperCase()}_${target.toUpperCase()}`;
  const constName = guess in sdk ? guess : cfg.models.nmt.const;
  const id = await load({ constName, type: "nmt", modelConfig: { engine: cfg.models.nmt.engine, from: source, to: target } });
  _nmt.set(key, id);
  return id;
}
const _tts = new Map(); // lang -> modelId
async function tts(lang) {
  if (_tts.has(lang)) return _tts.get(lang);
  const id = await load({
    constName: cfg.models.tts.const, type: "tts",
    modelConfig: { ttsEngine: cfg.models.tts.engine, language: lang, ttsSpeed: cfg.stream.ttsSpeed, ttsNumInferenceSteps: cfg.stream.ttsSteps },
  });
  _tts.set(lang, id);
  return id;
}
export async function unloadCompanion() {
  if (_llm) { await unload(_llm); _llm = null; }
  for (const id of _nmt.values()) await unload(id);
  for (const id of _tts.values()) await unload(id);
  _nmt.clear(); _tts.clear();
  await unloadEmbedder();
}

function buildContext(hits) {
  let used = 0;
  const lines = [];
  for (const h of hits) {
    const line = `- ${h.topic}: ${h.text}`;
    if (used + line.length > comp.maxContextChars && lines.length) break;
    lines.push(line); used += line.length;
  }
  return lines.join("\n");
}

/**
 * Ask the companion. Async generator of events:
 *   { type:"status", msg }
 *   { type:"sources", sources:[{topic,score}], grounded }
 *   { type:"token", token }                 // streamed English answer tokens
 *   { type:"answer", text, grounded }       // final English answer
 *   { type:"translated", text, lang }       // optional (target != source)
 *   { type:"audio", pcm:Int16Array, ttsRate }
 *   { type:"done", latMs, grounded }
 */
export async function* askCompanion({ question, source = cfg.lang.source, target = source, speak = comp.speak } = {}) {
  const q = String(question || "").trim();
  if (!q) { yield { type: "answer", text: "Ask me something about the match.", grounded: false }; yield { type: "done", latMs: 0, grounded: false }; return; }
  const sdk = await getSdk();
  const t0 = Date.now();

  yield { type: "status", msg: "Searching the offline matchday pack…" };
  const hits = await search(q, ragCfg.rag.topK);
  const top = hits[0]?.score ?? 0;
  const grounded = top >= ragCfg.rag.minScore;
  yield { type: "sources", sources: hits.map((h) => ({ topic: h.topic, score: Number(h.score.toFixed(3)) })), grounded };

  let answer;
  if (!grounded) {
    // Anti-hallucination: retrieval too weak → refuse rather than invent.
    answer = comp.refusal;
    yield { type: "token", token: answer };
    yield { type: "answer", text: answer, grounded: false };
  } else {
    yield { type: "status", msg: "Answering from the pack (on-device LLM)…" };
    const history = [
      { role: "system", content: comp.systemPrompt },
      { role: "user", content: `CONTEXT:\n${buildContext(hits)}\n\nQUESTION: ${q}` },
    ];
    const result = sdk.completion({ modelId: await llm(), history, stream: true, generationParams: comp.generationParams });
    answer = "";
    for await (const token of result.tokenStream) {
      const piece = typeof token === "string" ? token : (token?.text ?? "");
      answer += piece;
      yield { type: "token", token: piece };
    }
    answer = answer.trim() || comp.refusal;
    yield { type: "answer", text: answer, grounded: true };
  }

  // Optional: translate the answer into the user's language, then speak it.
  let spokenText = answer, spokenLang = source;
  if (target && target !== source) {
    yield { type: "status", msg: `Translating to ${target}…` };
    const tr = await sdk.translate({ modelId: await nmt(source, target), text: answer, stream: false, modelType: "nmt" });
    spokenText = (await streamToText(tr)).trim() || answer;
    spokenLang = target;
    yield { type: "translated", text: spokenText, lang: target };
  }

  if (speak) {
    yield { type: "status", msg: "Speaking…" };
    const ttsRes = sdk.textToSpeech({ modelId: await tts(spokenLang), text: spokenText || "...", inputType: "text", stream: false });
    const pcm = await collectPcm(ttsRes);
    yield { type: "audio", pcm, ttsRate: TTS_RATE };
  }

  yield { type: "done", latMs: Date.now() - t0, grounded };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const speak = args.includes("--speak");
  const question = args.filter((a) => a !== "--speak").join(" ") || "What is the offside rule?";
  const source = cfg.lang.source;
  const target = process.env.QVAC_TARGET || source; // QVAC_TARGET=it → answer+speak in Italian
  head(`TIFO companion  (source ${source}${target !== source ? ` → ${target}` : ""}${speak ? ", speak" : ""})`);
  console.log(`  Q: ${question}\n`);
  try {
    const spoken = [];
    let grounded = false, latMs = 0, finalEn = "", finalTr = "";
    for await (const ev of askCompanion({ question, source, target, speak })) {
      if (ev.type === "status") console.log(`  · ${ev.msg}`);
      else if (ev.type === "sources") {
        console.log(`  sources: ${ev.sources.map((s) => `${s.topic}(${s.score})`).join(", ")}`);
        console.log(`  grounded: ${ev.grounded ? "yes" : "NO → refusing (anti-hallucination)"}\n`);
      } else if (ev.type === "token") process.stdout.write(ev.token);
      else if (ev.type === "answer") { finalEn = ev.text; grounded = ev.grounded; process.stdout.write("\n"); }
      else if (ev.type === "translated") { finalTr = ev.text; console.log(`\n  [${ev.lang}] ${ev.text}`); }
      else if (ev.type === "audio") spoken.push(ev.pcm);
      else if (ev.type === "done") latMs = ev.latMs;
    }
    if (spoken.length) {
      const outPath = path.join(OUT, `companion_${target}.wav`);
      writeFileSync(outPath, pcm16ToWav(spoken[0], TTS_RATE, 1));
      console.log(`\n  spoken answer → ${path.relative(ROOT, outPath)}  (play: aplay '${outPath}')`);
    }
    head("RESULT");
    console.log(`  grounded : ${grounded ? "yes (answered from pack)" : "no (refused — not in pack)"}`);
    console.log(`  latency  : ${latMs}ms`);
    ok("companion turn complete");
    await unloadCompanion();
    process.exit(0);
  } catch (e) {
    console.error("\n✖", e?.stack || e);
    process.exit(1);
  }
}
