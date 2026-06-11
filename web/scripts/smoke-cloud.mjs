// Parameterized end-to-end smoke test against the CLOUD deployment.
// Env: CONVEX_URL, MODELS (comma list), PIPELINE (A|B), SRC (file path), PROMPT, LABEL
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const URL = process.env.CONVEX_URL;
const MODELS = (process.env.MODELS ?? "seedance-2.0-reference-to-video").split(",");
const PIPELINE = process.env.PIPELINE ?? "B";
const SRC = process.env.SRC ?? "../probes/out/sample_9p5s.mp4";
const PROMPT = process.env.PROMPT ?? "Change the subject's black t-shirt to a bright red hoodie. Keep everything else identical.";
const LABEL = process.env.LABEL ?? "smoke";
const c = new ConvexHttpClient(URL);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${LABEL}]`, ...a);

log("models:", MODELS.join(","), "· pipeline:", PIPELINE, "· src:", SRC);
log("1. upload…");
const postUrl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
const up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: readFileSync(SRC) });
const { storageId } = await up.json();
const id = await c.mutation(api.sourceVideos.createSourceVideo, { fileName: `${LABEL}.mp4`, storageId });

log("2. Pegasus…");
log("   ", JSON.stringify(await c.action(api.pegasus.analyze, { sourceVideoId: id })));

log("3. Gemini plan…");
await c.action(api.gemini.plan, { sourceVideoId: id, pipeline: PIPELINE, userPrompt: PROMPT, modelIds: MODELS });
const plan = await c.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: id });
log("   plan calls:", plan.totalCallsPlanned);

log("4. runPlan…");
log("   ", JSON.stringify(await c.action(api.generate.runPlan, { planId: plan._id })));

log(`5. polling ${plan.totalCallsPlanned} generation(s)…`);
const deadline = Date.now() + 26 * 60 * 1000;
let tiles = [];
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 12000));
  tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: id });
  const summary = tiles.map((t) => `${t.model.includes("kling") ? "K" : "S"}${t.sceneNumber ?? t.geminiPlanCallIndex}:${t.outputStatus}`).join(" ");
  log("   ", summary || "(scheduling…)");
  if (tiles.length >= plan.totalCallsPlanned && tiles.every((t) => ["completed", "failed"].includes(t.outputStatus))) break;
}

log("6. results:");
for (const t of tiles.sort((a, b) => (a.geminiPlanCallIndex ?? 0) - (b.geminiPlanCallIndex ?? 0))) {
  let audio = "?";
  if (t.outputUrl) {
    try {
      const buf = Buffer.from(await (await fetch(t.outputUrl)).arrayBuffer());
      const f = `/tmp/smoke_${LABEL}_${t.geminiPlanCallIndex}.mp4`;
      writeFileSync(f, buf);
      const pr = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", f], { encoding: "utf8" });
      audio = pr.stdout.includes("audio") ? "video+audio" : "video-only";
    } catch { audio = "fetch-failed"; }
  }
  log(`   ${t.model} call ${t.geminiPlanCallIndex}${t.sceneNumber != null ? ` scene ${t.sceneNumber}` : ""}: ${t.outputStatus} · ${audio} · ${t.costEstimate ?? "?"} cr${t.notes ? " · " + t.notes : ""}`);
}
const ok = tiles.length > 0 && tiles.every((t) => t.outputStatus === "completed");
log(ok ? "✅ PASS" : "⚠ some calls did not complete");
