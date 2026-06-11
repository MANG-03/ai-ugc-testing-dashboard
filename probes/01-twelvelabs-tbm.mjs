// PROBE 1 — Twelve Labs Pegasus 1.5 time-based-metadata (TBM)
// Question: does the analyze_async TBM flow accept our video + segment_definitions
//           and return timestamped structured scene data? What's the real REST shape?
import { TWELVELABS_BASE, reqEnv, optEnv, hr, pretty, sleep } from "./lib.mjs";

const KEY = reqEnv("TWELVELABS_API_KEY");
const VIDEO = optEnv("SAMPLE_VIDEO_URL");
if (!VIDEO) { console.error("Set SAMPLE_VIDEO_URL in .env.local"); process.exit(1); }

// A deliberately tiny 2-field schema — the real §8 schema is bigger; this just proves the flow.
const segment_definitions = [{
  id: "scenes",
  description:
    "Segment the video into distinct scenes. A scene changes on a visible cut, a camera-angle change, " +
    "a setting change, or a shift in the subject's action.",
  fields: [
    { name: "scene_description", type: "string",
      description: "Detailed description of what happens visually in this scene." },
    { name: "shot_type", type: "string", description: "Primary camera framing.",
      enum: ["extreme_close_up", "close_up", "medium", "wide", "extreme_wide"] },
  ],
}];

// The exact `video` field shape for a URL input isn't in public docs → try the likely forms, log each.
const videoShapes = [
  { label: "video:{url}",       extra: { video: { url: VIDEO } } },
  { label: "video:{type:url}",  extra: { video: { type: "url", url: VIDEO } } },
  { label: "video_url",         extra: { video_url: VIDEO } },
  { label: "video:{video_url}", extra: { video: { video_url: VIDEO } } },
];

let accepted = null;
for (const shape of videoShapes) {
  hr(`POST /analyze/tasks — video shape: ${shape.label}`);
  const body = {
    model_name: "pegasus1.5",
    analysis_mode: "time_based_metadata",
    response_format: { type: "segment_definitions", segment_definitions },
    ...shape.extra,
  };
  const res = await fetch(`${TWELVELABS_BASE}/analyze/tasks`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  console.log("HTTP", res.status);
  console.log(pretty(text, 1200));
  const taskId = json?._id || json?.id || json?.task_id;
  if (res.ok && taskId) { accepted = { shape: shape.label, taskId }; break; }
  console.log("→ rejected, trying next shape…");
}

if (!accepted) {
  hr("RESULT");
  console.log("✗ No video shape accepted. The error bodies above tell us the right field shape.");
  console.log("  (Likely fix: upload as an asset first via POST /assets, then pass asset_id.)");
  process.exit(0);
}

hr(`✓ Accepted with shape "${accepted.shape}". task=${accepted.taskId} — polling…`);
const start = Date.now();
while (Date.now() - start < 600000) {
  const res = await fetch(`${TWELVELABS_BASE}/analyze/tasks/${accepted.taskId}`, { headers: { "x-api-key": KEY } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  const status = json?.status || "?";
  console.log(`  poll ${Math.round((Date.now() - start) / 1000)}s → ${status}`);
  if (["ready", "completed", "failed", "error"].includes(status)) {
    hr("FINAL RESULT");
    // The structured output lives in result.data (a JSON string keyed by definition id)
    const data = json?.result?.data ?? json?.data ?? json;
    console.log(pretty(typeof data === "string" ? data : json, 6000));
    console.log("\nKEY TAKEAWAYS to record: working `video` shape, status field, where timestamped data lives.");
    process.exit(0);
  }
  await sleep(5000);
}
console.log("timeout (raise the limit if the video is long).");
