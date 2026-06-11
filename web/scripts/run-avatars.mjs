import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn7esmgcaqtnng8gjryfx6s2x988avpx";
const DIR = "/Users/armaanmanji/Downloads/Echos Content/male echos content";
async function hostImage(path) {
  for (let i = 0; i < 2; i++) { try { const fd = new FormData(); fd.append("file", new Blob([readFileSync(path)]), "a.png"); const j = await (await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd })).json(); if (j?.data?.url) return j.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/"); } catch {} await new Promise(r => setTimeout(r, 3000)); }
  const fd = new FormData(); fd.append("reqtype", "fileupload"); fd.append("fileToUpload", new Blob([readFileSync(path)]), "a.png");
  const url = (await (await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd })).text()).trim();
  if (url.startsWith("http")) return url; throw new Error("host failed");
}
const sv = await c.query(api.sourceVideos.get, { id: SRC });
const videoUrl = sv.fileUrl;
const COMMON = `He performs the exact actions from video 1, in order: he starts with his hair tied up and pulls the tie out letting it fall; sprays a white aerosol can onto his hair and rubs it in; squeezes a white pump bottle onto his head twice and works it in thoroughly; at the 0:06 cut he looks up with perfectly styled curls; runs a hand through the back of his hair; then holds up the two hair products to the camera. Keep the background, setting, framing, lighting, camera and timing identical to video 1 — only the person changes. Preserve the on-screen text 'POV: you realise frizzy hair is optional'.`;
const AV = {
  "06": { file: `${DIR}/06-ugc-gym-selfie.png`, desc: "a young man with curly brown hair and a lean athletic build" },
  "08": { file: `${DIR}/08-ugc-streetwear-ootd.png`, desc: "a young man with light brown hair and fair skin" },
  "13": { file: `${DIR}/13-ugc-rooftop.png`, desc: "a young man with short STRAIGHT dark hair and light stubble" },
};
const tasks = {};
for (const [k, a] of Object.entries(AV)) {
  const avatarUrl = await hostImage(a.file);
  const prompt = `In every frame, completely re-render the subject's face, head, hair, skin and build to be the man in image 1 (${a.desc}) — the original person is fully discarded and replaced; do NOT retain any of the original person's face or head. ${COMMON}`;
  const body = { model: "seedance-2.0-reference-to-video", prompt, video_urls: [videoUrl], image_urls: [avatarUrl], aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: false };
  const crt = await (await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).text();
  tasks[k] = JSON.parse(crt).id ?? JSON.parse(crt).task_id;
  console.log(`avatar ${k} (${a.file.split("/").pop()}): ${tasks[k] || "FAILED " + crt.slice(0, 150)}`);
}
const pending = new Set(Object.keys(tasks).filter(k => tasks[k]));
const deadline = Date.now() + 14 * 60 * 1000;
while (pending.size && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 10000));
  for (const k of [...pending]) {
    const pj = JSON.parse(await (await fetch(`https://api.evolink.ai/v1/tasks/${tasks[k]}`, { headers: { Authorization: `Bearer ${KEY}` } })).text());
    const st = String(pj.status ?? "").toLowerCase();
    if (["completed","succeeded","success","done"].includes(st)) { const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0]; if (out) writeFileSync(`/tmp/gen_av_${k}.mp4`, Buffer.from(await (await fetch(out)).arrayBuffer())); console.log(`✅ ${k} done (${pj.usage?.credits_used}cr) → /tmp/gen_av_${k}.mp4`); pending.delete(k); }
    else if (["failed","error","cancelled"].includes(st)) { console.log(`❌ ${k} failed: ${JSON.stringify(pj).slice(0,120)}`); pending.delete(k); }
  }
}
console.log("done. remaining:", [...pending].join(",") || "none");
