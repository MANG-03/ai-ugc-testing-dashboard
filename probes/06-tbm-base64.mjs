// Probe: does Twelve Labs TBM accept the video as base64 (no public URL)?
// If yes, Pegasus can run on a LOCAL Convex deployment. Run: node --env-file=.env.local 06-tbm-base64.mjs
import { TWELVELABS_BASE, reqEnv, hr, pretty } from "./lib.mjs";
import { readFileSync } from "node:fs";

const KEY = reqEnv("TWELVELABS_API_KEY");
const b64 = readFileSync("out/sample_9p5s.mp4").toString("base64");
console.log("base64 size:", Math.round(b64.length / 1024), "KB");

const seg = [{ id: "scenes", description: "Segment into scenes.", fields: [{ name: "d", type: "string", description: "what happens" }] }];

const shapes = [
  { label: "video:{type:base64,data}", video: { type: "base64", data: b64 } },
  { label: "video:{type:base64,base64}", video: { type: "base64", base64: b64 } },
  { label: "video:{type:base64,video_base64}", video: { type: "base64", video_base64: b64 } },
  { label: "video_base64", video_base64: b64 },
];

for (const s of shapes) {
  const { label, ...rest } = s;
  hr(label);
  const res = await fetch(`${TWELVELABS_BASE}/analyze/tasks`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_name: "pegasus1.5",
      analysis_mode: "time_based_metadata",
      response_format: { type: "segment_definitions", segment_definitions: seg },
      ...rest,
    }),
  });
  const text = await res.text();
  console.log("HTTP", res.status, pretty(text, 300));
  if (res.ok) { console.log(`\n✅ WORKS: ${label}`); break; }
}
