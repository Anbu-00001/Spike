// TIFO Day-3 CLI: near-real-time OFFLINE commentary translation.
//   node src/stream.js              # EN commentary -> target lang (config.lang.target)
//   QVAC_TARGET=hi node src/stream.js
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, pcm16ToWav, head } from "./lib.js";
import { liveTranslate, OUT, cfg, concatInt16 } from "./pipeline.js";

process.on("unhandledRejection", (e) => {
  const m = e?.message || String(e);
  if (/WORKER_SHUTDOWN|shutting down/i.test(m)) return;
  console.warn(`  (unhandledRejection) ${m}`);
});

const SRC = cfg.lang.source, TGT = cfg.lang.target;
head(`TIFO live translation  ${SRC} speech -> ${TGT} speech  (offline, CPU)`);

const spoken = [];
const t0 = Date.now();
for await (const ev of liveTranslate({})) {
  if (ev.type === "status") {
    console.log(`  · ${ev.msg}`);
  } else if (ev.type === "utterance") {
    spoken.push(ev.pcm);
    console.log(`  [${SRC}] ${ev.src}`);
    console.log(`  [${TGT}] ${ev.tgt}   \x1b[2m(+${ev.latMs}ms translate+speak)\x1b[0m\n`);
  } else if (ev.type === "done") {
    let outPath = "(none)";
    if (spoken.length) {
      outPath = path.join(OUT, `stream_out_${TGT}.wav`);
      writeFileSync(outPath, pcm16ToWav(concatInt16(spoken), cfg.audio.ttsSampleRate, 1));
    }
    head("RESULT");
    console.log(`  utterances translated : ${ev.count}`);
    console.log(`  avg added latency     : ${ev.avgLatMs}ms (translate+speak per utterance)`);
    console.log(`  wall clock            : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  spoken translation    : ${outPath === "(none)" ? "(none)" : path.relative(ROOT, outPath) + `  (play: aplay '${outPath}')`}`);
    const pass = ev.count >= 2;
    console.log(pass ? "\n\x1b[42m\x1b[30m GO — live offline ASR->NMT->TTS translation works \x1b[0m"
                     : "\n\x1b[41m NO-GO — too few utterances \x1b[0m");
    process.exit(pass ? 0 : 1);
  }
}
