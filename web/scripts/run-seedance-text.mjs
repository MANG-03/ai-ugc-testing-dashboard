// Seedance R2V with the source video but NO image reference — purely TEXT-described identity change.
// Different from all 7 prior nulls (those used an avatar image). Tests if text-only swap works.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const KEY = process.env.EVOLINK_API_KEY;
const ts = () => new Date().toISOString().slice(11, 19);
const videoUrl = "https://litter.catbox.moe/pgquqb.mp4"; // litterbox (files.catbox.moe probe was failing for R2V billing)
console.log(ts(), "video:", videoUrl);

const prompt = "Can you change the person in the video to look like a white blonde guy?";
const body = { model: "seedance-2.0-reference-to-video", prompt, video_urls: [videoUrl], aspect_ratio: "9:16", quality: "720p", duration: 10, generate_audio: false };
console.log(ts(), "prompt:", prompt);
const create = await (await fetch("https://api.evolink.ai/v1/videos/generations", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
})).json();
console.log(ts(), "create:", JSON.stringify(create).slice(0, 200));
const taskId = create.id ?? create.task_id;
if (!taskId) process.exit(1);
const deadline = Date.now() + 14 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 6000));
  const pj = await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { console.log(ts(), st, `(${pj.progress ?? 0}%)`); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) {
    const out = pj.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0];
    console.log(ts(), "output:", out?.slice(0, 80), "credits:", pj.usage?.credits_used);
    writeFileSync("/tmp/gen_seedance_text.mp4", Buffer.from(await (await fetch(out)).arrayBuffer()));
    const ff = (await import("ffmpeg-static")).default;
    for (const t of [1, 5, 9]) spawnSync(ff, ["-y", "-loglevel", "error", "-ss", String(t), "-i", "/tmp/gen_seedance_text.mp4", "-frames:v", "1", `/tmp/sdtext_f${t}.png`]);
    console.log(ts(), "saved /tmp/gen_seedance_text.mp4 + /tmp/sdtext_f{1,5,9}.png");
    process.exit(0);
  }
  if (["failed", "error", "cancelled"].includes(st)) { console.log(ts(), "FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
console.log(ts(), "timeout");
