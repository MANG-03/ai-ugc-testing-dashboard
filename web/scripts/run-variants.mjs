import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn7esmgcaqtnng8gjryfx6s2x988avpx";
const AVATAR = "/Users/armaanmanji/Downloads/Echos Content/male echos content/11-ugc-grooming.png";
async function hostImage(path) {
  for (let i = 0; i < 2; i++) { try { const fd = new FormData(); fd.append("file", new Blob([readFileSync(path)]), "a.png"); const j = await (await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd })).json(); if (j?.data?.url) return j.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/"); } catch {} await new Promise(r => setTimeout(r, 3000)); }
  const fd = new FormData(); fd.append("reqtype", "fileupload"); fd.append("fileToUpload", new Blob([readFileSync(path)]), "a.png");
  const url = (await (await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd })).text()).trim();
  if (url.startsWith("http")) return url; throw new Error("host failed");
}
const sv = await c.query(api.sourceVideos.get, { id: SRC });
const videoUrl = sv.fileUrl;
const avatarUrl = await hostImage(AVATAR);
console.log("avatar:", avatarUrl);

const COMMON = `He performs the exact actions from video 1, in order: he starts with his hair tied up and pulls the tie out letting it fall; sprays a white aerosol can onto his hair and rubs it in; squeezes a white pump bottle onto his head twice and works it in thoroughly; at the 0:06 cut he looks up with perfectly styled curls; runs a hand through the back of his hair; then holds up the two hair products to the camera. Keep the background, setting, framing, lighting, camera and timing identical to video 1 — only the person changes. Preserve the on-screen text 'POV: you realise frizzy hair is optional'.`;
const variants = {
  A: `THIS IS A FULL CHARACTER REPLACEMENT. The person visible in video 1 must be COMPLETELY ERASED and REPLACED, in every single frame, by the man in image 1 (short dark hair, facial hair, black t-shirt). Do NOT keep the original person's face, head, hair, skin or features for even one frame — they are entirely deleted. The ONLY human who may appear anywhere in the video is the man from image 1. ${COMMON}`,
  B: `The visible person is the man in image 1, NOT the person in video 1 — replace him completely. He (the man in image 1) starts with his hair tied up and pulls the tie out; he (still the man in image 1) sprays a white aerosol can onto his hair and rubs it in; he squeezes a white pump bottle onto his head twice and works it in — remember, throughout, the person is the man in image 1, not the original; at the 0:06 cut he (the man in image 1) looks up with styled curls; runs a hand through the back of his hair; then holds up the two products to the camera. Keep the background, setting, framing, lighting and timing identical to video 1 — only the person changes. Preserve the on-screen text 'POV: you realise frizzy hair is optional'. Again, to be clear: in EVERY frame the visible person is the man in image 1, fully replacing the original person from video 1.`,
  C: `Use video 1 ONLY as a motion and timing skeleton — copy the body pose, hand positions, head movements and the exact timing of every action. Video 1 is NOT a reference for how the person looks; the person's entire appearance — face, head, hair, skin, build — comes SOLELY from image 1 (short dark hair, facial hair, black t-shirt). ${COMMON}`,
};
const tasks = {};
for (const [k, prompt] of Object.entries(variants)) {
  const body = { model: "seedance-2.0-reference-to-video", prompt, video_urls: [videoUrl], image_urls: [avatarUrl], aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: false };
  const crt = await (await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).text();
  tasks[k] = JSON.parse(crt).id ?? JSON.parse(crt).task_id;
  console.log(`variant ${k}: ${tasks[k] || "FAILED " + crt.slice(0,150)}`);
}
const pending = new Set(Object.keys(tasks).filter(k => tasks[k]));
const deadline = Date.now() + 14 * 60 * 1000;
while (pending.size && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 10000));
  for (const k of [...pending]) {
    const pj = JSON.parse(await (await fetch(`https://api.evolink.ai/v1/tasks/${tasks[k]}`, { headers: { Authorization: `Bearer ${KEY}` } })).text());
    const st = String(pj.status ?? "").toLowerCase();
    if (["completed","succeeded","success","done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; if (out) writeFileSync(`/tmp/gen_var_${k}.mp4`, Buffer.from(await (await fetch(out)).arrayBuffer())); console.log(`✅ ${k} done (${pj.usage?.credits_used}cr) → /tmp/gen_var_${k}.mp4`); pending.delete(k); }
    else if (["failed","error","cancelled"].includes(st)) { console.log(`❌ ${k} failed`); pending.delete(k); }
  }
}
console.log("done. remaining:", [...pending].join(",") || "none");
