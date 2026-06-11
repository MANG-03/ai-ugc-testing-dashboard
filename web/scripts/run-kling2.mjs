import { writeFileSync } from "node:fs";
const KEY = process.env.EVOLINK_API_KEY;
const videoUrl = "https://files.catbox.moe/h6am27.mp4"; // frizzy clipped to 10s
const avatarUrl = "https://files.catbox.moe/n1pc1j.png"; // grooming avatar
const prompt = `Edit this video to SWAP THE PERSON: replace the man in @Video1 with the man in @Image1. In every frame his face, head shape, hairstyle, facial hair and skin tone are entirely those of the man in @Image1 — do NOT keep the original man's face or head. Change ONLY the person's identity; keep the original camera, all body and hand movements, the background room, lighting, framing and timing exactly as in @Video1. The new man (@Image1) sprays mousse from a white can and rubs it in, applies cream from a white tube and scrunches his hair into defined curls, then holds up the two products to the camera. Preserve the on-screen caption 'POV: you realise frizzy hair is optional'.`;
const body = { model: "kling-o3-video-edit", prompt, video_urls: [videoUrl], image_urls: [avatarUrl], aspect_ratio: "9:16", quality: "720p", keep_audio: true };
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
  if (["completed", "succeeded", "success", "done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; console.log("output:", out, "credits:", pj.usage?.credits_used); if (out) { writeFileSync("/tmp/gen_kling2.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_kling2.mp4"); } process.exit(0); }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
console.log("TIMEOUT");
