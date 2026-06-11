// CONTROL: same frizzy edit, but with the CLEAN-FACE element (from probe, id 313015301769153).
// Disambiguates: does the Kling element channel swap identity at all (given a good face),
// or is the silent-clip swap a model limitation like Seedance?
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const KEY = process.env.EVOLINK_API_KEY;
const ts = () => new Date().toISOString().slice(11, 19);
const videoUrl = "https://files.catbox.moe/h6am27.mp4";
const elementId = "313015301769153"; // clean AI frontal face, already created

const prompt = `Replace the person in the video with <<<element_1>>>. In every frame his face, head shape, hairstyle and skin tone are entirely those of <<<element_1>>> — do NOT keep the original man's face or head. Change ONLY the person's identity; keep the original camera, all body and hand movements, the background, lighting, framing and timing exactly as in the source video. Preserve the on-screen caption 'POV: you realise frizzy hair is optional'.`;
const edit = await (await fetch("https://api.evolink.ai/v1/videos/generations", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "kling-o3-video-edit", prompt, video_url: videoUrl, quality: "720p", keep_original_sound: true, model_params: { element_list: [{ element_id: elementId }] } }),
})).json();
console.log(ts(), "edit:", JSON.stringify(edit).slice(0, 200));
const taskId = edit.id ?? edit.task_id;
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
    writeFileSync("/tmp/gen_kling_cleanface.mp4", Buffer.from(await (await fetch(out)).arrayBuffer()));
    const ff = (await import("ffmpeg-static")).default;
    for (const t of [1, 5, 9]) spawnSync(ff, ["-y", "-loglevel", "error", "-ss", String(t), "-i", "/tmp/gen_kling_cleanface.mp4", "-frames:v", "1", `/tmp/kclean_f${t}.png`]);
    console.log(ts(), "saved /tmp/gen_kling_cleanface.mp4 + /tmp/kclean_f{1,5,9}.png");
    process.exit(0);
  }
  if (["failed", "error", "cancelled"].includes(st)) { console.log(ts(), "FAILED:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
}
console.log(ts(), "timeout");
