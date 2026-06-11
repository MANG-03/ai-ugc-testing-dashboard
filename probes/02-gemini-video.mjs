// PROBE 2 — EvoLink Gemini multimodal VIDEO input  ✅ SOLVED
// CONFIRMED working format (recorded 2026-06-06):
//   model: "gemini-3.1-pro-preview"   (bare "gemini-3.1-pro" → "no available service")
//   content part: { type: "image_url", image_url: { url: "data:video/mp4;base64,<...>" } }
//   - media MUST be an inline base64 data URI; remote URLs are rejected (400)
//   - the part type is image_url, NOT video_url
// This script re-confirms it end to end against SAMPLE_VIDEO_URL.
import { EVOLINK_BASE, reqEnv, optEnv, hr, pretty } from "./lib.mjs";

const KEY = reqEnv("EVOLINK_API_KEY");
const VIDEO = optEnv("SAMPLE_VIDEO_URL");
const MODEL = optEnv("GEMINI_MODEL", "gemini-3.1-pro-preview");

hr(`Gemini video probe — model=${MODEL}`);
console.log("Fetching + base64-encoding video:", VIDEO);
const buf = Buffer.from(await (await fetch(VIDEO)).arrayBuffer());
const dataUri = `data:video/mp4;base64,${buf.toString("base64")}`;
console.log(`encoded ${Math.round(buf.length / 1024)} KB → ${Math.round(dataUri.length / 1024)} KB base64`);

const res = await fetch(`${EVOLINK_BASE}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: [
      { type: "text", text: "Describe, scene by scene with rough timestamps, what happens in this video. If you cannot see it, reply exactly NO_VIDEO." },
      { type: "image_url", image_url: { url: dataUri } }, // ← the confirmed video shape
    ]}],
  }),
});
const text = await res.text();
let json = null; try { json = JSON.parse(text); } catch {}
const out = json?.choices?.[0]?.message?.content;

hr("RESULT");
console.log("HTTP", res.status);
if (res.ok && typeof out === "string" && !/NO_VIDEO/i.test(out)) {
  console.log("✅ Gemini watched the video:\n\n" + out);
} else {
  console.log("✗ Unexpected:\n" + pretty(out ?? text, 1500));
}
