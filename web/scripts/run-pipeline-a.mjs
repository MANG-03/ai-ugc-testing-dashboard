// Pipeline A continuity run on an already-analyzed source. Env: CONVEX_URL, SOURCE_ID
import { ConvexHttpClient } from "convex/browser";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const id = process.env.SOURCE_ID;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] [pipeA]`, ...a);

log("source:", id);
log("1. Gemini plan (Pipeline A, Seedance)…");
await c.action(api.gemini.plan, {
  sourceVideoId: id,
  pipeline: "A",
  userPrompt: "Recreate this video faithfully — same script, pacing, framing, and product.",
  modelIds: ["seedance-2.0-reference-to-video"],
});
const plan = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: id });
log("   plan calls:", plan.totalCallsPlanned);

log("2. runPlan (fires scene 1; scenes 2+ chain via last-frame)…");
log("   ", JSON.stringify(await c.action(api.generate.runPlan, { planId: plan._id })));

log("3. polling sequential scenes (up to ~18 min)…");
const deadline = Date.now() + 18 * 60 * 1000;
let tiles = [];
let lastSummary = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15000));
  tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: id });
  const summary = tiles
    .sort((a, b) => (a.geminiPlanCallIndex ?? 0) - (b.geminiPlanCallIndex ?? 0))
    .map((t) => `s${t.sceneNumber ?? t.geminiPlanCallIndex}:${t.outputStatus}`)
    .join(" ");
  if (summary !== lastSummary) { log("   ", summary); lastSummary = summary; }
  if (tiles.length >= plan.totalCallsPlanned && tiles.every((t) => ["completed", "failed"].includes(t.outputStatus))) break;
}

log("4. results (chain works if scenes 2+ completed — they only fire via continuity):");
let totalCost = 0;
for (const t of tiles.sort((a, b) => (a.geminiPlanCallIndex ?? 0) - (b.geminiPlanCallIndex ?? 0))) {
  let audio = "—";
  if (t.outputUrl) {
    try {
      const buf = Buffer.from(await (await fetch(t.outputUrl)).arrayBuffer());
      const f = `/tmp/pipeA_s${t.geminiPlanCallIndex}.mp4`;
      writeFileSync(f, buf);
      const pr = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", f], { encoding: "utf8" });
      audio = pr.stdout.includes("audio") ? "video+audio" : "video-only";
    } catch { audio = "fetch-failed"; }
  }
  totalCost += t.costEstimate ?? 0;
  log(`   scene ${t.sceneNumber ?? t.geminiPlanCallIndex}: ${t.outputStatus} · ${audio} · ${t.costEstimate ?? "?"} cr${t.notes ? " · " + t.notes : ""}`);
}
const completed = tiles.filter((t) => t.outputStatus === "completed").length;
log(`total: ${completed}/${tiles.length} scenes completed · ${Math.round(totalCost)} credits`);
log(completed === tiles.length && tiles.length >= 2 ? "✅ PIPELINE A PASS — continuity chain fired all scenes." : "⚠ chain incomplete (see per-scene status)");
