import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn7esmgcaqtnng8gjryfx6s2x988avpx";
const avatarUrl = "https://files.catbox.moe/n1pc1j.png";
const sv = await c.query(api.sourceVideos.get, { id: SRC });
const videoUrl = sv.fileUrl;
const prompt = `In every frame, completely re-render the subject's face, head, hair, skin and build to be the man in @Image1 (short dark hair, facial hair, black t-shirt) — the original person is fully discarded and replaced; do NOT retain any of the original person's face or head.
He performs the exact actions from @Video1, in order: he starts with his hair tied up and pulls the tie out letting it fall; sprays a white aerosol can onto his hair and rubs it in; squeezes a white pump bottle onto his head twice and works it in thoroughly; at the 0:06 cut he looks up with perfectly styled curls; runs a hand through the back of his hair; then holds up the two hair products to the camera.
Keep the background, setting, framing, lighting, camera and timing identical to @Video1 — only the person changes. Preserve the on-screen text 'POV: you realise frizzy hair is optional'.`;
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
  if (["completed", "succeeded", "success", "done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; console.log("output:", out, "credits:", pj.usage?.credits_used); if (out) { writeFileSync("/tmp/gen_seedance_at.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_seedance_at.mp4"); } process.exit(0); }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
console.log("TIMEOUT");
