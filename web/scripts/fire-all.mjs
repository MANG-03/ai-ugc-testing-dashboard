// Fire ALL scenes of a Pipeline A plan (chained), then concat the outputs into one video.
// Env: CONVEX_URL, PLAN_ID, SOURCE_ID
import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const PLAN = process.env.PLAN_ID, SRC = process.env.SOURCE_ID;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const plan = await c.query(api.geminiPlans.get, { id: PLAN });
const total = plan.totalCallsPlanned;
log(`runPlan — ${total} scenes, chained…`);
log("  ", JSON.stringify(await c.action(api.generate.runPlan, { planId: PLAN })));

const deadline = Date.now() + 30 * 60 * 1000;
let tiles = [];
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15000));
  tiles = (await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC }))
    .filter((t) => t.geminiPlanId === PLAN)
    .sort((a, b) => (a.geminiPlanCallIndex ?? 0) - (b.geminiPlanCallIndex ?? 0));
  const sum = tiles.map((t) => `c${t.geminiPlanCallIndex}:${t.outputStatus}`).join(" ");
  if (sum !== last) { log("  ", sum); last = sum; }
  if (tiles.length >= total && tiles.every((t) => ["completed", "failed"].includes(t.outputStatus))) break;
}

log("\nresults:");
const files = [];
for (const t of tiles) {
  log(`  c${t.geminiPlanCallIndex} scene ${t.sceneNumber}: ${t.outputStatus} · ${t.costEstimate ?? "?"} cr${t.notes ? " · " + t.notes : ""}`);
  if (t.outputStatus === "completed" && t.outputUrl) {
    const f = `/tmp/full_c${t.geminiPlanCallIndex}.mp4`;
    writeFileSync(f, Buffer.from(await (await fetch(t.outputUrl)).arrayBuffer()));
    files.push(f);
  }
}
log(`total cost: ${Math.round(tiles.reduce((s, t) => s + (t.costEstimate ?? 0), 0))} cr`);

if (files.length >= 2) {
  log(`concat ${files.length} clips → /tmp/full_interview.mp4`);
  const ff = (await import("ffmpeg-static")).default;
  const inputs = files.flatMap((f) => ["-i", f]);
  const n = files.length;
  const fc = files.map((_, i) => `[${i}:v][${i}:a]`).join("") + `concat=n=${n}:v=1:a=1[v][a]`;
  const r = spawnSync(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "/tmp/full_interview.mp4"], { maxBuffer: 1 << 27 });
  log(r.status === 0 ? "✅ assembled /tmp/full_interview.mp4" : "concat failed: " + (r.stderr?.toString().slice(0, 200)));
} else log("not enough completed clips to concat");
