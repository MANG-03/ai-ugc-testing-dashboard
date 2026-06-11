// PROBE 4 — EvoLink Kling O3 V2V edit (the undocumented request body)
// Questions: which source-video param name does kling-o3-video-edit accept, and does keep_audio work?
// EvoLink confirms the capability exists but never documents the body → discover it here.
// (Fallback if EvoLink's is unworkable: fal.ai fal-ai/kling-video/o3/pro/video-to-video/edit, schema known.)
import { reqEnv, optEnv, hr, pretty, evolinkPost, extractTaskId, evolinkPollTask, findUrl, download, ffprobe } from "./lib.mjs";

const KEY = reqEnv("EVOLINK_API_KEY");
const VIDEO = optEnv("SAMPLE_VIDEO_URL");
const IMAGE = optEnv("SAMPLE_IMAGE_URL"); // optional element/reference image
const MODEL = optEnv("KLING_EDIT_MODEL", "kling-o3-video-edit");

console.log(`Model: ${MODEL}  ·  Video: ${VIDEO}`);
console.log("NOTE: Kling O3 requires a 3–10.05s source video. If SAMPLE_VIDEO_URL is longer, expect a duration error.\n");

const prompt = "Change the subject's shirt to bright red. Keep the same motion, framing and timing.";
const audioFlag = { keep_audio: true }; // confirmed on fal O3; testing if EvoLink honors it

// Try likely source-video param names (mirroring Seedance vs Kling-native conventions).
const shapes = [
  { label: "video_urls[]", extra: { video_urls: [VIDEO] } },
  { label: "video_url",    extra: { video_url: VIDEO } },
  { label: "input_video",  extra: { input_video: VIDEO } },
  { label: "reference_video", extra: { reference_video: VIDEO } },
];

let accepted = null;
for (const s of shapes) {
  hr(`POST /videos/generations — ${MODEL}, source param: ${s.label}`);
  const body = { model: MODEL, prompt, ...audioFlag, duration: 5, quality: "720p", aspect_ratio: "9:16", ...s.extra }; // Kling O3 edit: 720p/1080p only (no 480p)
  if (IMAGE) body.image_urls = [IMAGE];
  const res = await evolinkPost("/videos/generations", body, KEY);
  console.log("HTTP", res.status, "\n", pretty(res.text, 1000));
  const taskId = extractTaskId(res.json);
  if (res.status.toString().startsWith("2") && taskId) { accepted = { shape: s.label, taskId }; break; }
  console.log("→ rejected, trying next source-param name…");
}

if (!accepted) {
  hr("RESULT");
  console.log("✗ No source-video param accepted on EvoLink for Kling edit.");
  console.log("  Record the error bodies above, then fall back to fal.ai O3 (documented schema).");
  process.exit(0);
}

hr(`✓ Accepted source param "${accepted.shape}". task=${accepted.taskId} — polling…`);
const final = await evolinkPollTask(accepted.taskId, KEY);
console.log("\nfinal status:", final.status, "\n", pretty(final.text, 1500));

const outUrl = findUrl(final.json, "(mp4|mov|webm)");
if (outUrl) {
  try {
    const path = await download(outUrl, "kling_o3_out.mp4");
    const probe = ffprobe(path);
    hr("KLING AUDIO CHECK (keep_audio:true)");
    console.log(probe.ok && probe.hasAudio
      ? "🔊 Output has audio → keep_audio honored on EvoLink. Clean no-FFmpeg path for Kling."
      : "🔇 Output silent → keep_audio NOT honored on EvoLink; treat like Seedance (re-mux) or use fal.ai.");
  } catch (e) { console.log("download/ffprobe error:", String(e)); }
}
hr("RECORD: working source-video param name + whether keep_audio worked.");
