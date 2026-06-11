// PROBE 5 — Local FFmpeg extract → overlay re-mux (the audio safety net)
// Question: can we reliably extract the source audio and overlay it onto a (silent) generated
//           clip locally? This is the ONLY FFmpeg step in the whole build, and only needed if
//           probe 3 showed Seedance output is silent.
// Self-contained: downloads the source, strips its audio to simulate a "generated silent clip",
// then re-muxes the original audio back on — proving the extract+overlay pipeline end to end.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { optEnv, hr, download, ffprobe } from "./lib.mjs";

const VIDEO = optEnv("SAMPLE_VIDEO_URL");
if (!VIDEO) { console.error("Set SAMPLE_VIDEO_URL in .env.local"); process.exit(1); }
mkdirSync("out", { recursive: true });

function ff(args, label) {
  console.log(`\n$ ffmpeg ${args.join(" ")}`);
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (r.status !== 0) { console.error(`✗ ${label} failed:\n`, r.stderr); process.exit(1); }
  console.log(`✓ ${label}`);
}

hr("1. Download source");
const src = await download(VIDEO, "remux_source.mp4");
console.log("source:", src, "→", ffprobe(src).hasAudio ? "has audio ✓" : "NO audio ✗ (pick a sample with sound)");

hr("2. Extract original audio → out/audio.m4a");
ff(["-i", src, "-vn", "-acodec", "copy", "out/audio.m4a"], "extract audio");

hr("3. Simulate a generated SILENT clip (strip audio) → out/silent.mp4");
ff(["-i", src, "-an", "-c:v", "copy", "out/silent.mp4"], "make silent video");
console.log("silent clip audio?", ffprobe("out/silent.mp4").hasAudio ? "still has audio ✗" : "silent ✓");

hr("4. Re-mux: overlay original audio onto the silent clip → out/remuxed.mp4");
ff(["-i", "out/silent.mp4", "-i", "out/audio.m4a", "-c:v", "copy", "-c:a", "aac", "-shortest", "out/remuxed.mp4"], "re-mux");

hr("VERDICT");
const final = ffprobe("out/remuxed.mp4");
console.log("remuxed.mp4:", final.hasVideo ? "video ✓" : "no video ✗", "·", final.hasAudio ? "audio ✓" : "no audio ✗");
console.log(final.hasVideo && final.hasAudio
  ? "✅ Extract→overlay re-mux works locally. This is all the FFmpeg the build needs (if probe 3 was silent)."
  : "✗ Something's off — inspect out/ files.");
