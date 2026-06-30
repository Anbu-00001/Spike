// Empirically dump the REAL @qvac/sdk surface so we never reference a method or
// model constant that doesn't exist in the installed version. No hardcoded API.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

let sdk;
try {
  sdk = await import("@qvac/sdk");
} catch (err) {
  console.error("FAILED to import @qvac/sdk:", err?.message || err);
  process.exit(2);
}

let version = "unknown";
try {
  version = require("@qvac/sdk/package.json").version;
} catch {}

const names = Object.keys(sdk).sort();
const isFn = (n) => typeof sdk[n] === "function";
const fns = names.filter(isFn);
const consts = names.filter((n) => !isFn(n));

const describe = (v) => {
  try {
    if (v === null || v === undefined) return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "object") return JSON.stringify(v).slice(0, 200);
    return String(v).slice(0, 200);
  } catch {
    return "(unserializable)";
  }
};

console.log(`@qvac/sdk version: ${version}`);
console.log(`total exports: ${names.length}`);

console.log(`\n=== FUNCTIONS (${fns.length}) ===`);
console.log(fns.join("\n"));

console.log(`\n=== NON-FUNCTION EXPORTS (${consts.length}) ===`);
for (const n of consts) console.log(`${n} = ${describe(sdk[n])}`);

// Highlight the specific methods/constants our pipeline depends on.
const want = [
  "loadModel", "unloadModel", "completion",
  "transcribe", "transcribeStream",
  "translate", "textToSpeech",
];
console.log(`\n=== PIPELINE METHOD CHECK ===`);
for (const w of want) console.log(`${w}: ${w in sdk ? "present" : "MISSING"}`);

// Surface anything that looks like a model-asset constant by naming convention.
const modelish = consts.filter((n) =>
  /(WHISPER|PARAKEET|BERGAMOT|TTS_|LLAMA|QWEN|GTE_|VAD_|SUPERTONIC|CHATTERBOX|NMT|INDICTRANS)/i.test(n)
);
console.log(`\n=== LIKELY MODEL CONSTANTS (${modelish.length}) ===`);
console.log(modelish.join("\n"));
