// Re-plan Pipeline A on an existing (already-analyzed) source with a NEW avatar, fire scene 1 only.
// Env: CONVEX_URL, SOURCE_ID, AVATAR
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = process.env.SOURCE_ID;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

log("upload new avatar…");
const postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
const up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(process.env.AVATAR) });
const { storageId: avatarId } = await up.json();

log("plan Pipeline A with new avatar (reusing Pegasus)…");
await c.action(api.gemini.plan, {
  sourceVideoId: SRC,
  pipeline: "A",
  userPrompt: "Recreate this video with the interviewee replaced by the man in the avatar image — keep the interviewer, the script, and everything else identical.",
  modelIds: ["seedance-2.0-reference-to-video"],
  avatarStorageIds: [avatarId],
});
const plan = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: SRC });
log("  new plan:", plan._id, "· call-1 prompt:", plan.fullPlan.models[0].calls[0].prompt.slice(0, 140));

log("runPlan + delete calls 2+ (fire scene 1 only)…");
await c.action(api.generate.runPlan, { planId: plan._id });
log("  ", JSON.stringify(await c.mutation(api.generations.cancelPlanCallsFrom, { geminiPlanId: plan._id, fromCallIndex: 2 })));

log("polling scene 1…");
const deadline = Date.now() + 7 * 60 * 1000;
let g = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 12000));
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  g = tiles.find((t) => t.geminiPlanId === plan._id && t.geminiPlanCallIndex === 1);
  log(`  status=${g?.outputStatus}${g?.notes ? " · " + g.notes : ""}`);
  if (g && ["completed", "failed"].includes(g.outputStatus)) break;
}
if (!g || g.outputStatus !== "completed") { log("✗", g?.notes ?? g?.outputStatus); process.exit(1); }

log(`✅ scene 1 · ${g.costEstimate} cr · ${Math.round(g.generationTime)}s`);
const buf = Buffer.from(await (await fetch(g.outputUrl)).arrayBuffer());
writeFileSync("/tmp/scene1b_out.mp4", buf);
const ff = (await import("ffmpeg-static")).default;
spawnSync(ff, ["-y", "-loglevel", "error", "-ss", "2", "-i", "/tmp/scene1b_out.mp4", "-frames:v", "1", "/tmp/scene1b_frame.png"]);
log("frame: /tmp/scene1b_frame.png · output:", Math.round(buf.length / 1024), "KB");
