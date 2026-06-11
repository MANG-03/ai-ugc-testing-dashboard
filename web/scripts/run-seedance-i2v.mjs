import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn7esmgcaqtnng8gjryfx6s2x988avpx";
const avatarUrl = "https://files.catbox.moe/n1pc1j.png";
const sv = await c.query(api.sourceVideos.get, { id: SRC });
const videoUrl = sv.fileUrl;
const prompt = `The man performs a hair-care routine: he starts with messy hair, sprays mousse from a white can and rubs it in, applies cream from a white tube and scrunches his hair into defined curls, then holds up two products to the camera. Use video 1 for the exact body motion, hand movements, timing, camera framing and the indoor setting (a room with a window and greenery behind him). The on-screen man's face, head and identity stay exactly as in image 1. Keep the on-screen text 'POV: you realise frizzy hair is optional'.`;
const body = { model: "seedance-2.0-image-to-video", prompt, image_urls: [avatarUrl], video_urls: [videoUrl], aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: false };
const crt = await (await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).text();
console.log("create:", crt.slice(0, 220));
const taskId = JSON.parse(crt).id ?? JSON.parse(crt).task_id;
if (!taskId) process.exit(1);
console.log("taskId:", taskId, new Date().toISOString().slice(11, 19));
const deadline = Date.now() + 13 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 9000));
  const pj = JSON.parse(await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).text());
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { console.log(new Date().toISOString().slice(11, 19), st); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; console.log("output:", out, "credits:", pj.usage?.credits_used); if (out) { writeFileSync("/tmp/gen_seedance_i2v.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_seedance_i2v.mp4"); } process.exit(0); }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
console.log("TIMEOUT");
