// PROBE 3 — EvoLink Seedance 2.0 V2V edit + the AUDIO question
// Questions: (a) does seedance-2.0-reference-to-video run a V2V edit via EvoLink?
//            (b) with generate_audio:false, is the output SILENT or does it keep source audio?
// The answer to (b) decides whether we need the FFmpeg re-mux at all.
import { reqEnv, optEnv, hr, pretty, evolinkPost, extractTaskId, evolinkPollTask, findUrl, download, ffprobe } from "./lib.mjs";

const KEY = reqEnv("EVOLINK_API_KEY");
const VIDEO = optEnv("SAMPLE_VIDEO_URL");
const MODEL = optEnv("SEEDANCE_EDIT_MODEL", "seedance-2.0-reference-to-video");

const body = {
  model: MODEL,
  // positional reference syntax: "video 1" = video_urls[0]
  prompt: "Edit video 1: change the subject's shirt to bright red. Keep everything else identical — same motion, framing, and timing.",
  video_urls: [VIDEO],
  duration: 5,
  quality: "480p",          // iteration tier
  aspect_ratio: "9:16",
  generate_audio: false,    // KEY: we want to learn if the source audio survives when false
};

hr(`POST /videos/generations — ${MODEL} (generate_audio:false)`);
console.log("request body:\n", pretty(body, 800));
const create = await evolinkPost("/videos/generations", body, KEY);
console.log("\nHTTP", create.status, "\n", pretty(create.text, 1200));

const taskId = extractTaskId(create.json);
if (!create.status.toString().startsWith("2") || !taskId) {
  hr("RESULT");
  console.log("✗ create failed or no task id. The error body above shows the real param expectations.");
  console.log("  If it complains about the model id, try the dashed variant or check the live model list.");
  process.exit(0);
}

hr(`✓ task=${taskId} — polling (this can take a few minutes)…`);
const final = await evolinkPollTask(taskId, KEY);
console.log("\nfinal status:", final.status);
console.log(pretty(final.text, 1500));

const outUrl = findUrl(final.json, "(mp4|mov|webm)");
if (!outUrl) { console.log("\nNo output video URL found in the response (see body above)."); process.exit(0); }

hr("Downloading output to inspect its audio track…");
console.log("output url:", outUrl);
try {
  const path = await download(outUrl, "seedance_v2v_out.mp4");
  const probe = ffprobe(path);
  console.log("ffprobe:", pretty(probe, 1200));
  hr("AUDIO VERDICT (the whole point of this probe)");
  if (probe.ok && probe.hasAudio) {
    console.log("🔊 Output HAS an audio track with generate_audio:false →");
    console.log("   EvoLink/Seedance likely PRESERVES source audio. The FFmpeg re-mux may be UNNECESSARY.");
    console.log("   (Confirm by listening — is it the original audio, or generated?)");
  } else {
    console.log("🔇 Output is SILENT with generate_audio:false →");
    console.log("   Confirms we NEED the FFmpeg extract→overlay re-mux for Pipeline B Seedance (probe 5).");
  }
} catch (e) {
  console.log("download/ffprobe error:", String(e));
}
