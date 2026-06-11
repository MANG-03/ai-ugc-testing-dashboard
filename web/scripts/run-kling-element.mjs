// Kling O3 IDENTITY swap via the dedicated element channel (the channel the pipeline never used).
// 2-call workflow (doc-verified June 2026):
//   1) kling-custom-element  → create a reusable subject from the avatar → returns element_id
//   2) kling-o3-video-edit   → model_params.element_list:[{element_id}] + prompt ref <<<element_1>>>
// Uses video_url (STRING) and keep_original_sound (NOT video_urls / keep_audio).
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const KEY = process.env.EVOLINK_API_KEY;
if (!KEY) { console.error("EVOLINK_API_KEY not set"); process.exit(1); }

const videoUrl = "https://files.catbox.moe/h6am27.mp4"; // frizzy clipped to 10s (720x1280, 29.97fps)
const avatarUrl = "https://files.catbox.moe/n1pc1j.png"; // grooming avatar, 960x1280 frontal
const ts = () => new Date().toISOString().slice(11, 19);
const post = async (body) => {
  const r = await fetch("https://api.evolink.ai/v1/videos/generations", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: JSON.parse(await r.text().catch(() => "{}")) };
};
const poll = async (taskId, minutes, label) => {
  const deadline = Date.now() + minutes * 60 * 1000; let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const pj = await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
    const st = String(pj.status ?? "").toLowerCase();
    if (st !== last) { console.log(ts(), label, st, `(${pj.progress ?? 0}%)`); last = st; }
    if (["completed", "succeeded", "success", "done"].includes(st)) return pj;
    if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED body:", JSON.stringify(pj).slice(0, 500)); return null; }
  }
  console.log("TIMEOUT", label, taskId); return null;
};
// robust element_id finder (docs say result_data.element_id, but probe the whole tree)
const findElementId = (obj) => {
  let id = null;
  JSON.stringify(obj, (k, val) => {
    if (!id && /element_id/i.test(k) && (typeof val === "string" || typeof val === "number")) id = String(val);
    return val;
  });
  return id;
};

// ---- STEP 1: create the identity element from the avatar ----
console.log(ts(), "STEP 1 — create element from avatar…");
const create = await post({
  model: "kling-custom-element",
  model_params: {
    element_name: "Groom Avatar",
    element_description: "Young man, short dark hair, short facial hair, black t-shirt",
    reference_type: "image_refer",
    // refer_images is documented "optional" but is EMPIRICALLY REQUIRED — frontal-only fails as
    // invalid_parameters. Populate it (here we reuse the only avatar shot we have).
    element_image_list: { frontal_image: avatarUrl, refer_images: [{ image_url: avatarUrl }] },
  },
});
console.log(ts(), "create status", create.status, JSON.stringify(create.json).slice(0, 240));
const elemTaskId = create.json.id ?? create.json.task_id;
if (!elemTaskId) { console.error("no element task id — likely a param/credit error (see body above)"); process.exit(1); }
const elemFinal = await poll(elemTaskId, 12, "element");
if (!elemFinal) process.exit(1);
const elementId = findElementId(elemFinal);
console.log(ts(), "element_id =", elementId, elementId ? "" : "(NOT FOUND — dumping)\n" + JSON.stringify(elemFinal).slice(0, 600));
if (!elementId) process.exit(1);

// ---- STEP 2: edit the video, swapping identity via <<<element_1>>> ----
const prompt = `Replace the person in the video with <<<element_1>>>. In every frame his face, head shape, hairstyle, facial hair and skin tone are entirely those of <<<element_1>>> — do NOT keep the original man's face or head. Change ONLY the person's identity; keep the original camera, all body and hand movements, the background room, lighting, framing and timing exactly as in the source video. He pulls his hair tie out, sprays a white aerosol can onto his hair and rubs it in, squeezes a white pump bottle onto his head twice and rubs it in, then (after the cut at ~0:06) looks up with styled hair, runs a hand through the back, and holds up two hair products to the camera. Preserve the on-screen caption 'POV: you realise frizzy hair is optional'.`;
console.log(ts(), "STEP 2 — kling-o3-video-edit with element_list…");
const edit = await post({
  model: "kling-o3-video-edit",
  prompt,
  video_url: videoUrl,           // STRING (singular) per docs
  quality: "720p",
  keep_original_sound: true,     // correct audio param
  model_params: { element_list: [{ element_id: elementId }] },
});
console.log(ts(), "edit status", edit.status, JSON.stringify(edit.json).slice(0, 240));
const editTaskId = edit.json.id ?? edit.json.task_id;
if (!editTaskId) { console.error("no edit task id (see body above)"); process.exit(1); }
const editFinal = await poll(editTaskId, 14, "edit");
if (!editFinal) process.exit(1);

const out = editFinal.results?.[0] ?? JSON.stringify(editFinal).match(/https?:\/\/[^"]+\.mp4/)?.[0];
console.log(ts(), "output:", out, "| credits_used:", editFinal.usage?.credits_used);
if (!out) process.exit(1);
writeFileSync("/tmp/gen_kling_element.mp4", Buffer.from(await (await fetch(out)).arrayBuffer()));
// pull 3 frames to eyeball the swap
const ff = (await import("ffmpeg-static")).default;
for (const t of [1, 5, 9]) {
  spawnSync(ff, ["-y", "-loglevel", "error", "-ss", String(t), "-i", "/tmp/gen_kling_element.mp4", "-frames:v", "1", `/tmp/kling_elem_f${t}.png`]);
}
console.log(ts(), "saved /tmp/gen_kling_element.mp4 + frames /tmp/kling_elem_f{1,5,9}.png");
