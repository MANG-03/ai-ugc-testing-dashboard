import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn7esmgcaqtnng8gjryfx6s2x988avpx";
const avatarUrl = "https://files.catbox.moe/n1pc1j.png";
const sv = await c.query(api.sourceVideos.get, { id: SRC });
const videoUrl = sv.fileUrl;
const prompt = `TASK: This is a CHARACTER REPLACEMENT / identity swap. Your single most important job is to replace the human in video 1 with the man in image 1.
The man in image 1 (short dark hair, facial hair, black t-shirt) is the ONLY person who may appear in the output. The person currently in video 1 must be completely removed and painted over with the man from image 1, in every single frame, no exceptions.
Do NOT preserve, copy, trace, or reference ANY part of the original person's appearance: not his face, not his face shape, eyes, nose, mouth or jaw, not his hair, not his skin tone, not his build. All of it is discarded. The original man is merely a motion puppet — use his body movements and timing only; his looks are irrelevant and thrown away.
In every frame, the face you render is the face from image 1; the head is the head from image 1; the hair is the hair from image 1. If the output ever starts to resemble the original person from video 1, that is a failure — fix it so it looks like the man from image 1 instead.
The viewer must believe the man in image 1 personally filmed this clip. 100% of the on-screen person's likeness comes from image 1; 0% comes from video 1's person. Image 1 = the real identity; video 1's person = a stand-in to be replaced. Replace him fully and completely.
The man (image 1) performs these actions from video 1, in order: starts with hair tied up and pulls the tie out; sprays a white aerosol can and rubs it in; squeezes a white pump bottle onto his head twice and works it in; at the 0:06 cut he looks up with styled curls; runs a hand through the back of his hair; holds up two hair products to camera.
Keep the background, setting, framing, lighting, camera and timing identical to video 1 — only the person changes. Preserve the on-screen text 'POV: you realise frizzy hair is optional'.`;
console.log("prompt length:", prompt.length, "chars");
const body = { model: "seedance-2.0-reference-to-video", prompt, video_urls: [videoUrl], image_urls: [avatarUrl], aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: false };
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
  if (["completed", "succeeded", "success", "done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; console.log("output:", out, "credits:", pj.usage?.credits_used); if (out) { writeFileSync("/tmp/gen_maxreinf.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_maxreinf.mp4"); } process.exit(0); }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
console.log("TIMEOUT");
