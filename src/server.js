// TIFO local web UI server. Serves the matchday companion + live translation and
// streams everything to the browser over Server-Sent Events. No cloud, no keys.
//   node src/server.js   ->   http://localhost:8787
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, pcm16ToWav } from "./lib.js";
import { liveTranslate, cfg } from "./pipeline.js";
import { askCompanion } from "./companion.js";

const PORT = Number(process.env.PORT || 8787);
const indexHtml = readFileSync(path.join(ROOT, "public", "index.html"));

let busy = false; // single-user demo: one heavy session at a time (registry is single-writer)

// Run an async generator of events out to an SSE response, converting any
// {pcm,ttsRate} audio into a base64 WAV the browser can play.
async function streamSse(res, gen) {
  if (busy) { res.writeHead(409); return res.end("busy"); }
  busy = true;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let closed = false;
  res.on("close", () => { closed = true; });
  try {
    for await (const ev of gen) {
      if (closed) break;
      if (ev.type === "utterance") {
        send({ type: "utterance", src: ev.src, tgt: ev.tgt, latMs: ev.latMs, wav: pcm16ToWav(ev.pcm, ev.ttsRate, 1).toString("base64") });
      } else if (ev.type === "audio") {
        send({ type: "audio", wav: pcm16ToWav(ev.pcm, ev.ttsRate, 1).toString("base64") });
      } else {
        send(ev);
      }
    }
  } catch (e) {
    send({ type: "status", msg: `error: ${e?.message || e}` });
  } finally {
    busy = false;
    if (!closed) { send({ type: "end" }); res.end(); }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(indexHtml);
  }
  if (url.pathname === "/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ source: cfg.lang.source, minScore: cfg.rag.minScore, ui: cfg.ui }));
  }
  if (url.pathname === "/events") {
    const target = (url.searchParams.get("target") || cfg.lang.target).toLowerCase();
    return streamSse(res, liveTranslate({ target }));
  }
  if (url.pathname === "/ask") {
    const question = url.searchParams.get("q") || "";
    const target = (url.searchParams.get("target") || cfg.lang.source).toLowerCase();
    const speak = url.searchParams.get("speak") !== "0";
    return streamSse(res, askCompanion({ question, source: cfg.lang.source, target, speak }));
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => console.log(`TIFO web UI on http://localhost:${PORT}`));
