import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q";
const BASE = "/Users/armaanmanji/Downloads/Echos Content";
const prodDir = readdirSync(BASE).find((d) => d.toLowerCase().startsWith("products"));
const prodPath = `${BASE}/${prodDir}`;
const prodFiles = readdirSync(prodPath).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
const IMAGES = [
  `${BASE}/male echos content/11-ugc-grooming.png`,  // image 1 = subject
  `${prodPath}/${prodFiles[0]}`,                       // image 2 = curl cream tube
  `${prodPath}/${prodFiles[1]}`,                       // image 3 = curl mousse bottle
];
console.log("images:", IMAGES.map((p) => p.split("/").pop()));

const sv = await c.query(api.sourceVideos.get, { id: SRC });
const pegasus = sv.pegasusAnalysis;

const urls = [];
for (const p of IMAGES) {
  const fd = new FormData();
  fd.append("file", new Blob([readFileSync(p)]), "img.png");
  const up = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd });
  urls.push((await up.json()).data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/"));
}
console.log("hosted:", urls);

const instruction = `You are writing ONE prompt for an IMAGE-TO-VIDEO model (Seedance 2.0). THREE reference images are given (positional): "image 1" = the PERSON (only subject), "image 2" = a hair-product TUBE (BASED Curl Cream), "image 3" = a hair-product BOTTLE (BASED Curl Mousse). NO source video is provided. Using the scene breakdown below, write a vivid, self-contained prompt (MAX 1900 chars) animating the man in image 1 performing the EXACT scene: actions in order, setting, wardrobe, camera framing/movement, lighting, pacing. He keeps his own face/hair/identity from image 1. He applies cream from the tube in image 2, and at the end holds up BOTH products to camera — the tube (image 2) and the bottle (image 3) — rendered EXACTLY as in those images (same shape, colour and "BASED" label). CLEAN PLATE: NO on-screen text, captions, subtitles, watermarks or graphics (printed labels ON the bottles are fine). Do NOT reference any "video 1". Output ONLY the prompt text.\n\nSCENE BREAKDOWN (Pegasus):\n${JSON.stringify(pegasus)}`;
const gres = await fetch("https://api.evolink.ai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gemini-3.1-pro-preview", messages: [{ role: "user", content: instruction }] }) });
const prompt = ((await gres.json())?.choices?.[0]?.message?.content ?? "").trim();
console.log("\n=== PROMPT (" + prompt.length + " chars) ===\n" + prompt + "\n");

const body = { model: "seedance-2.0-reference-to-video", prompt, image_urls: urls, aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: true };
const cr = await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const crt = await cr.text();
if (!cr.ok) { console.log("CREATE FAILED", cr.status, crt.slice(0, 400)); process.exit(1); }
const taskId = JSON.parse(crt).id ?? JSON.parse(crt).task_id ?? JSON.parse(crt).data?.id;
console.log("taskId:", taskId, new Date().toISOString().slice(11, 19));

const deadline = Date.now() + 11 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const pj = JSON.parse(await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).text());
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { console.log(new Date().toISOString().slice(11, 19), st); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) {
    const out = pj.results?.[0] ?? pj.output?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0];
    console.log("output:", out, "| credits:", pj.usage?.credits_used);
    if (out) { writeFileSync("/tmp/gen_products.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_products.mp4"); }
    process.exit(0);
  }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 400)); process.exit(1); }
}
console.log("timed out");
