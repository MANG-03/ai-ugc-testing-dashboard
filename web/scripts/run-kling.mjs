import { readFileSync, writeFileSync } from "node:fs";
const KEY = process.env.EVOLINK_API_KEY;
async function host(path, name, type) {
  const fd = new FormData(); fd.append("reqtype", "fileupload"); fd.append("fileToUpload", new Blob([readFileSync(path)], { type }), name);
  const url = (await (await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd })).text()).trim();
  if (!url.startsWith("http")) throw new Error("host failed: " + url.slice(0, 100)); return url;
}
const videoUrl = await host("/tmp/frizzy10.mp4", "v.mp4", "video/mp4");
const avatarUrl = "https://files.catbox.moe/n1pc1j.png";
console.log("video:", videoUrl);
const prompt = `Replace the Young Man in video 1 with the man in image 1. The new man has short dark hair and facial hair, wearing a black t-shirt. The man starts with his hair tied up, pulls the tie out letting it fall. He sprays a white aerosol can onto his hair, rubs it in, then squeezes a white pump bottle directly onto his head twice, rubbing it in thoroughly. At 0:06 there is a cut where he suddenly looks up with perfectly styled hair. He runs his hand through the back of his head, then holds up two hair products to the camera. Keep everything else identical — same motion, framing, timing, setting, and composition. Preserve the on-screen text 'POV: you realise frizzy hair is optional'.`;
const body = { model: "kling-o3-video-edit", prompt, video_urls: [videoUrl], image_urls: [avatarUrl], aspect_ratio: "9:16", quality: "720p", keep_audio: true };
const crt = await (await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).text();
console.log("create response:", crt.slice(0, 250));
const taskId = JSON.parse(crt).id ?? JSON.parse(crt).task_id ?? JSON.parse(crt).data?.id;
if (!taskId) process.exit(1);
console.log("taskId:", taskId, new Date().toISOString().slice(11, 19));
const deadline = Date.now() + 13 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 9000));
  const pj = JSON.parse(await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).text());
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { console.log(new Date().toISOString().slice(11, 19), st); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; console.log("output:", out, "credits:", pj.usage?.credits_used); if (out) { writeFileSync("/tmp/gen_kling.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_kling.mp4"); } process.exit(0); }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 400)); process.exit(1); }
}
console.log("TIMEOUT taskId=" + taskId);
