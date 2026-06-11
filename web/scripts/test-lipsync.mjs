// Fire ONLY scene 2 of a fresh Pipeline A plan with audio-driven Seedance (generate_audio:true +
// scene-audio reference) to test lip-sync. Env: CONVEX_URL, SOURCE_ID, AVATAR
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = process.env.SOURCE_ID;
const MODELS = (process.env.MODELS ?? "seedance-2.0-reference-to-video").split(",");
const OUT = process.env.OUT ?? "/tmp/lipsync_scene2.mp4";
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

log("upload avatar + plan Pipeline A…");
const postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
const up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(process.env.AVATAR) });
const { storageId: avatarId } = await up.json();
await c.action(api.gemini.plan, {
  sourceVideoId: SRC, pipeline: "A",
  userPrompt: "Recreate this video with the interviewee replaced by the man in the avatar image — keep the interviewer, the script, and everything else identical.",
  modelIds: MODELS, avatarStorageIds: [avatarId],
});
const plan = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: SRC });
const calls = plan.fullPlan.models[0].calls;
log("plan calls:", calls.map((x) => `c${x.callIndex}(scene ${x.sceneNumber})`).join(" "));
// pick the first call that covers scene 2 (the monologue we're testing)
const sceneTwo = calls.find((x) => x.sceneNumber === 2) ?? calls[1] ?? calls[0];
const KEEP = sceneTwo.callIndex;
log(`scene under test = call ${KEEP} (scene ${sceneTwo.sceneNumber}):`, sceneTwo.prompt.slice(0, 120));

log("create rows, keep only call 2, fire it (audio-driven)…");
await c.action(api.generate.runPlan, { planId: plan._id });
const { kept } = await c.mutation(api.generations.keepOnlyCall, { geminiPlanId: plan._id, keepCallIndex: KEEP });
await c.action(api.generate.fireGeneration, { generationId: kept });

log("polling…");
const deadline = Date.now() + 9 * 60 * 1000;
let g = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 12000));
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  g = tiles.find((t) => t._id === kept);
  log("  ", g?.outputStatus, g?.notes ?? "");
  if (g && ["completed", "failed"].includes(g.outputStatus)) break;
}
if (g?.outputStatus !== "completed") { log("✗", g?.notes ?? g?.outputStatus); process.exit(1); }
const buf = Buffer.from(await (await fetch(g.outputUrl)).arrayBuffer());
writeFileSync(OUT, buf);
log(`✅ done · ${g.costEstimate} cr · saved ${OUT} (${Math.round(buf.length / 1024)}KB) — WATCH THIS for lip-sync`);
