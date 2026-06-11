// Fresh source → Pegasus → Gemini plan (Seedance + avatar), dump everything for inspection. NO generation.
// Env: CONVEX_URL, VIDEO, AVATAR
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const log = (...a) => console.log(...a);

log("1. upload fresh source + Pegasus…");
let postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
let up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: readFileSync(process.env.VIDEO) });
const { storageId } = await up.json();
const id = await c.mutation(api.sourceVideos.createSourceVideo, { fileName: "street-interview-fresh.mp4", storageId, duration: 40.5 });
await c.action(api.pegasus.analyze, { sourceVideoId: id });
const doc = await c.query(api.sourceVideos.get, { id });
const scenes = doc.pegasusAnalysis?.scenes ?? [];

log("\n=== PEGASUS SCENES (timestamps + dialogue) ===");
let prevEnd = 0;
for (const [i, s] of scenes.entries()) {
  const m = s.metadata ?? s;
  const gap = Number(s.start_time) - prevEnd;
  log(`\nScene ${i + 1}: ${Number(s.start_time).toFixed(2)}–${Number(s.end_time).toFixed(2)}s (len ${(Number(s.end_time) - Number(s.start_time)).toFixed(2)}s)${Math.abs(gap) > 0.05 ? `  ⚠ GAP/OVERLAP from prev: ${gap.toFixed(2)}s` : ""}`);
  log("  dialogue:", m.dialogue_transcript);
  prevEnd = Number(s.end_time);
}
log(`\ncoverage: 0–${prevEnd.toFixed(2)}s of ${doc.duration}s`);

log("\n2. upload avatar + Gemini plan (Seedance)…");
postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(process.env.AVATAR) });
const { storageId: avatarId } = await up.json();
await c.action(api.gemini.plan, {
  sourceVideoId: id, pipeline: "A",
  userPrompt: "Recreate this video with the interviewee replaced by the man in the avatar image — keep the interviewer, the exact script, and everything else identical.",
  modelIds: ["seedance-2.0-reference-to-video"], avatarStorageIds: [avatarId],
});
const plan = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: id });

log("\n=== GEMINI PLAN (call time-ranges + prompts) ===");
for (const call of plan.fullPlan.models[0].calls) {
  const vid = (call.mediaSegments ?? []).find((s) => s.type === "video" && s.source === "original");
  log(`\ncall ${call.callIndex} · scene ${call.sceneNumber} · clip ${vid ? `${vid.startTime}–${vid.endTime}s` : "?"}`);
  log("  prompt:", call.prompt);
}
log("\nSOURCE_ID:", id, "· PLAN_ID:", plan._id, "· AVATAR_ID:", avatarId);
