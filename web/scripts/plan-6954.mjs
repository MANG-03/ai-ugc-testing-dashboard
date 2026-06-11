// PLAN ONLY (no generation): upload 6954 interview → Pegasus → two Gemini plans:
//   A) Pipeline A, replace the WOMAN with the blonde female avatar (image)
//   B) Pipeline B, targeted edit: male's graphic tee → plain grey tee
// Prints scene counts, per-call prompts, clip ranges, and a cost estimate. Fires NOTHING.
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);
const VIDEO = "/Users/armaanmanji/Desktop/AI UGC Testing/dashboard/testing batch/ssstik.io_@based_1780787506954.mp4";
const AVATAR_F = "/Users/armaanmanji/Downloads/Echos Content/Female echos content/05-ugc-walking-candid.png";

log("1. upload 6954 source…");
let postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
let up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: readFileSync(VIDEO) });
const { storageId } = await up.json();
const srcId = await c.mutation(api.sourceVideos.createSourceVideo, { fileName: "6954-interview.mp4", storageId, duration: 33.0 });
log("   sourceVideoId:", srcId);

log("2. Pegasus analyze (blocks until ready)…");
await c.action(api.pegasus.analyze, { sourceVideoId: srcId });
const doc = await c.query(api.sourceVideos.get, { id: srcId });
const scenes = doc.pegasusAnalysis?.scenes ?? [];
console.log("\n=== PEGASUS SCENES (" + scenes.length + ") ===");
for (const [i, s] of scenes.entries()) console.log(`scene ${i + 1}: ${Number(s.start_time).toFixed(1)}-${Number(s.end_time).toFixed(1)}s · ${(s.scene_description ?? s.metadata?.scene_description ?? "").slice(0, 150)}`);

// ---- Plan A: replace the WOMAN with the blonde avatar (Pipeline A, image) ----
log("\n3. upload blonde avatar + Plan A (Pipeline A, replace woman)…");
postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(AVATAR_F) });
const { storageId: avatarId } = await up.json();
await c.action(api.gemini.plan, {
  sourceVideoId: srcId, pipeline: "A",
  userPrompt: "Replace ONLY the female presenter/interviewer (the woman in the black 'struggle' top with long brown hair) with the woman in the avatar image (a blonde woman). She keeps the woman's exact dialogue, actions, mic and products. The male interviewee and everything else stay completely unchanged.",
  modelIds: ["seedance-2.0-reference-to-video"], avatarStorageIds: [avatarId],
});
const planA = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: srcId });
const callsA = planA.fullPlan.models[0].calls;
console.log("\n=== PLAN A (replace woman, Pipeline A) — " + callsA.length + " calls ===");
for (const call of callsA) {
  const vid = (call.mediaSegments ?? []).find((s) => s.type === "video" && s.source === "original");
  console.log(`\ncall ${call.callIndex} · scene ${call.sceneNumber ?? "?"} · clip ${vid ? `${vid.startTime}-${vid.endTime}s` : "?"}`);
  console.log("  " + (call.prompt ?? "").slice(0, 500));
}

// ---- Plan B: male's tee → plain grey (Pipeline B, targeted edit) ----
log("\n4. Plan B (Pipeline B, male tee edit)…");
await c.action(api.gemini.plan, {
  sourceVideoId: srcId, pipeline: "B",
  userPrompt: "Targeted edit: change ONLY the male interviewee's graphic t-shirt (the dark Pulp Fiction 'don't' tee) into a plain solid grey t-shirt with no graphics. Keep both people's faces, the woman, the setting, all motion, dialogue and timing exactly the same.",
  modelIds: ["seedance-2.0-reference-to-video"],
});
const planB = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: srcId });
const callsB = planB.fullPlan.models[0].calls;
console.log("\n=== PLAN B (male tee edit, Pipeline B) — " + callsB.length + " calls ===");
for (const call of callsB) {
  const vid = (call.mediaSegments ?? []).find((s) => s.type === "video" && s.source === "original");
  console.log(`\ncall ${call.callIndex} · clip ${vid ? `${vid.startTime}-${vid.endTime}s` : "?"}`);
  console.log("  " + (call.prompt ?? "").slice(0, 500));
}

const estPerCall = 200; // rough cr/call observed (~181 for 11s; scenes up to 15s)
console.log("\n=== COST ESTIMATE (rough) ===");
console.log(`Plan A: ${callsA.length} calls × ~${estPerCall}cr ≈ ${callsA.length * estPerCall}cr`);
console.log(`Plan B: ${callsB.length} calls × ~${estPerCall}cr ≈ ${callsB.length * estPerCall}cr`);
console.log("\nSOURCE_ID:", srcId, "· PLAN_A:", planA._id, "· PLAN_B:", planB._id, "· AVATAR_ID:", avatarId);
console.log("(NO generation fired — awaiting approval.)");
