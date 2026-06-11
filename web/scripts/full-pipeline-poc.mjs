// FULL PIPELINE PoC: upload frizzy → Pegasus → Gemini plan → take its prompt →
// append a MAXIMALLY-DIFFERENT character description ("this is a different person") →
// fire Seedance (text-driven, NO avatar image) and see if the person actually changes.
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);
const VIDEO = "/Users/armaanmanji/Desktop/AI UGC Testing/dashboard/testing batch/ssstik.io_@based_1780787626595.mp4";
const AVATAR = "/tmp/avatar_grooming.png";

// 1) upload source + Pegasus
log("1. upload frizzy source…");
let postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
let up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: readFileSync(VIDEO) });
const { storageId } = await up.json();
const srcId = await c.mutation(api.sourceVideos.createSourceVideo, { fileName: "frizzy-poc.mp4", storageId, duration: 11.09 });
log("   sourceVideoId:", srcId);
log("2. Pegasus analyze (blocks until ready)…");
await c.action(api.pegasus.analyze, { sourceVideoId: srcId });
const doc = await c.query(api.sourceVideos.get, { id: srcId });
const scenes = doc.pegasusAnalysis?.scenes ?? [];
log("   Pegasus scenes:", scenes.length);
for (const [i, s] of scenes.entries()) log(`   scene ${i + 1}: ${Number(s.start_time).toFixed(1)}-${Number(s.end_time).toFixed(1)}s · ${(s.scene_description ?? s.metadata?.scene_description ?? "").slice(0, 120)}`);

// 3) Gemini plan (real pipeline, Pipeline A, with grooming avatar)
log("3. upload avatar + Gemini plan (Pipeline A, Seedance)…");
postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(AVATAR) });
const { storageId: avatarId } = await up.json();
await c.action(api.gemini.plan, {
  sourceVideoId: srcId, pipeline: "A",
  userPrompt: "Replace the person in this hair-care POV with a different person, keeping every action, the setting, framing, timing and on-screen caption identical.",
  modelIds: ["seedance-2.0-reference-to-video"], avatarStorageIds: [avatarId],
});
const plan = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: srcId });
const calls = plan.fullPlan.models[0].calls;
log("   plan:", plan._id, "· calls:", calls.length);
const basePrompt = calls[0].prompt;
console.log("\n=== GEMINI-GENERATED PROMPT (call 0, " + basePrompt.length + " chars) ===\n" + basePrompt + "\n");

// 4) append the maximally-different character override
const override = `

—— CHARACTER OVERRIDE (HIGHEST PRIORITY — READ THIS LAST) ——
There is NO reference image. Ignore any mention of "image 1" or the previously described man's appearance above.
The on-screen person must be COMPLETELY REPLACED by a DIFFERENT individual. This is NOT the man currently in the video — discard his face, skin tone, hair and build entirely. We do NOT want the original man; we want this NEW person:
A dark-skinned Black man, around 30 years old, deep ebony-brown complexion, broad nose, full short dark beard and moustache, short black tightly-coiled afro hair, warm brown eyes, athletic build. In EVERY frame his face, head, skin and hair are entirely this man's.
He performs the exact same actions in the same order; the background, framing, camera, lighting, timing and the on-screen caption "POV: you realise frizzy hair is optional" all stay identical. ONLY the person's identity changes — to this dark-skinned Black man.`;
const finalPrompt = (basePrompt + override).slice(0, 4000);
console.log("=== FINAL SEEDANCE PROMPT (" + finalPrompt.length + " chars) ===\n" + finalPrompt + "\n");

// 5) fire Seedance — source video, NO image_urls (text-driven)
const videoUrl = doc.fileUrl;
log("5. fire Seedance (text-driven, no image)… video:", videoUrl?.slice(0, 50));
const body = { model: "seedance-2.0-reference-to-video", prompt: finalPrompt, video_urls: [videoUrl], aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: false };
const create = await (await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
log("   create:", JSON.stringify(create).slice(0, 180));
const taskId = create.id ?? create.task_id;
if (!taskId) { log("CREATE FAILED — trying litterbox re-host of source…");
  const fd = new FormData(); fd.append("reqtype", "fileupload"); fd.append("time", "1h"); fd.append("fileToUpload", new Blob([readFileSync(VIDEO)], { type: "video/mp4" }), "frizzy.mp4");
  const litter = (await (await fetch("https://litterbox.catbox.moe/resources/internals/api.php", { method: "POST", body: fd })).text()).trim();
  log("   litterbox:", litter);
  const c2 = await (await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, video_urls: [litter] }) })).json();
  log("   create2:", JSON.stringify(c2).slice(0, 180));
  if (!(c2.id ?? c2.task_id)) process.exit(1);
  globalThis.__tid = c2.id ?? c2.task_id;
}
const tid = globalThis.__tid ?? taskId;
log("   taskId:", tid);

// 6) poll generously (R2V is slow, ~22min)
const deadline = Date.now() + 30 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const pj = await (await fetch(`https://api.evolink.ai/v1/tasks/${tid}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { log("   ", st, `(${pj.progress ?? 0}%)`); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) {
    const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0];
    log("   output:", out?.slice(0, 70), "credits:", pj.usage?.credits_used);
    writeFileSync("/tmp/gen_poc.mp4", Buffer.from(await (await fetch(out)).arrayBuffer()));
    const ff = (await import("ffmpeg-static")).default;
    for (const t of [1, 5, 9]) spawnSync(ff, ["-y", "-loglevel", "error", "-ss", String(t), "-i", "/tmp/gen_poc.mp4", "-frames:v", "1", `/tmp/poc_f${t}.png`]);
    log("   saved /tmp/gen_poc.mp4 + /tmp/poc_f{1,5,9}.png");
    process.exit(0);
  }
  if (["failed", "error", "cancelled"].includes(st)) { log("   FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
log("timeout — taskId", tid);
