import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q";
const VIDEO = "/Users/armaanmanji/Desktop/AI UGC Testing/dashboard/testing batch/ssstik.io_@based_1780787626595.mp4";
const BASE = "/Users/armaanmanji/Downloads/Echos Content";
const prodPath = `${BASE}/${readdirSync(BASE).find((d) => d.toLowerCase().startsWith("products"))}`;
const prodFiles = readdirSync(prodPath).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
const AVATAR = `${BASE}/male echos content/11-ugc-grooming.png`;
const IMAGES = [AVATAR, `${prodPath}/${prodFiles[0]}`, `${prodPath}/${prodFiles[1]}`];

const urls = [];
for (const p of IMAGES) { const fd = new FormData(); fd.append("file", new Blob([readFileSync(p)]), "img.png"); urls.push((await (await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd })).json()).data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/")); }
console.log("hosted", urls.length, "images");

const instruction = `You are writing ONE prompt for an IMAGE-TO-VIDEO model (Seedance 2.0). The generator gets THREE images ONLY — NO source video: "image 1" = the PERSON (the only subject), "image 2" = a hair-product TUBE (BASED Curl Cream), "image 3" = a hair-product BOTTLE (BASED Curl Mousse). You can WATCH the source video below and STUDY image 1's face.

Write a vivid, self-contained prompt (MAX 1900 chars) that animates the man in image 1 performing the EXACT sequence of actions you see in the video, in order. Be exhaustive — enumerate EVERY product use separately: state when he applies the MOUSSE (image 3) and when he applies the CREAM (image 2), in the same order as the video. He keeps his own face/hair/identity from image 1 (describe his appearance). Keep his hair length consistent — it must not grow. At the end he holds up BOTH products (render them exactly as image 2 and image 3 with their "BASED" labels). CLEAN PLATE: no on-screen text, captions, subtitles, watermarks or graphics. Do NOT reference "video 1" — there is no source video for the generator. Output ONLY the prompt text.`;
const content = [
  { type: "text", text: instruction },
  { type: "image_url", image_url: { url: `data:video/mp4;base64,${readFileSync(VIDEO).toString("base64")}` } },
  { type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(AVATAR).toString("base64")}` } },
];
const prompt = ((await (await fetch("https://api.evolink.ai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gemini-3.1-pro-preview", messages: [{ role: "user", content }] }) })).json())?.choices?.[0]?.message?.content ?? "").trim();
console.log("\n=== PROMPT (" + prompt.length + " chars) ===\n" + prompt + "\n");

const body = { model: "seedance-2.0-reference-to-video", prompt, image_urls: urls, aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: true };
const crt = await (await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).text();
const taskId = JSON.parse(crt).id ?? JSON.parse(crt).task_id;
if (!taskId) { console.log("CREATE FAILED:", crt.slice(0, 300)); process.exit(1); }
console.log("taskId:", taskId, new Date().toISOString().slice(11, 19));
const deadline = Date.now() + 13 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 9000));
  const pj = JSON.parse(await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).text());
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { console.log(new Date().toISOString().slice(11, 19), st); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; console.log("output:", out, "credits:", pj.usage?.credits_used); if (out) { writeFileSync("/tmp/gen_final.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_final.mp4"); } process.exit(0); }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
console.log("TIMEOUT taskId=" + taskId);
