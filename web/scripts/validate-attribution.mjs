// Cheap validation (Pegasus + Gemini only, NO generation): does speaker attribution + avatar
// targeting now flow into the plan prompts? Env: CONVEX_URL
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const log = (...a) => console.log(...a);
const VIDEO = "/Users/armaanmanji/Downloads/ssstik.io_@based_1780434659304.mp4";
const AVATAR = "/Users/armaanmanji/Downloads/ChatGPT Image Jun 3, 2026, 12_22_05 PM.png";

log("1. upload interview video + analyze (new schema)…");
let postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
let up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: readFileSync(VIDEO) });
const { storageId } = await up.json();
const id = await c.mutation(api.sourceVideos.createSourceVideo, { fileName: "attribution-test.mp4", storageId, duration: 40.5 });
await c.action(api.pegasus.analyze, { sourceVideoId: id });
const doc = await c.query(api.sourceVideos.get, { id });

log("\n=== PEGASUS: characters + attributed dialogue per scene ===");
for (const [i, s] of (doc.pegasusAnalysis?.scenes ?? []).entries()) {
  const m = s.metadata ?? s;
  log(`\nScene ${i + 1} (${Number(s.start_time).toFixed(1)}-${Number(s.end_time).toFixed(1)}s)`);
  log("  characters:", m.characters);
  log("  dialogue:  ", m.dialogue_transcript);
}

log("\n2. upload avatar + plan Pipeline A (Seedance) with avatar attached…");
postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(AVATAR) });
const { storageId: avatarId } = await up.json();
await c.action(api.gemini.plan, {
  sourceVideoId: id,
  pipeline: "A",
  userPrompt: "Recreate this video with the interviewee replaced by the man in the avatar image — keep the interviewer, the script, and everything else identical.",
  modelIds: ["seedance-2.0-reference-to-video"],
  avatarStorageIds: [avatarId],
});
const plan = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: id });

log("\n=== GEMINI PLAN: per-call prompts (should attribute speakers + name the avatar swap) ===");
for (const m of plan.fullPlan.models) {
  for (const call of m.calls) {
    log(`\n[${m.model}] call ${call.callIndex}${call.sceneNumber != null ? ` · scene ${call.sceneNumber}` : ""}`);
    log("  prompt:", call.prompt);
    log("  media:", (call.mediaSegments ?? []).map((s) => `${s.type}:${s.source}${s.startTime != null ? `(${s.startTime}-${s.endTime}s)` : ""}`).join(", "));
  }
}
log("\nSOURCE_ID:", id, "· AVATAR_ID:", avatarId, "· PLAN_ID:", plan._id);
