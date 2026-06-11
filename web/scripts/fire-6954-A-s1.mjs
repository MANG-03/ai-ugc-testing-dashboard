// Fire ONLY Plan A scene 1 (woman→blonde) via the real pipeline executor, at 480p.
// runPlan fires call 1 and would chain the rest on completion → we cancel calls 2+ immediately.
import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);
const SRC = "jn71p0eaxavct5a50jpbysyysd88ds9v";
const PLAN_A = "j971b461s4d4s06y1x9gv40w5x88dwsx";

// safety: confirm call 1 is 480p before firing
const plan = await c.query(api.geminiPlans.get, { id: PLAN_A });
const q = plan.fullPlan.models[0].calls.find((x) => x.callIndex === 1)?.apiParameters?.quality;
log("scene-1 quality:", q);
if (q !== "480p") { log("ABORT — scene 1 not 480p:", q); process.exit(1); }

log("runPlan (fires scene 1, chains rest on completion)…");
await c.action(api.generate.runPlan, { planId: PLAN_A });
log("cancel calls 2+ so ONLY scene 1 runs…");
const cancelled = await c.mutation(api.generations.cancelPlanCallsFrom, { geminiPlanId: PLAN_A, fromCallIndex: 2 });
log("  cancelled:", JSON.stringify(cancelled));

log("polling scene 1…");
const deadline = Date.now() + 16 * 60 * 1000;
let g = null, last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  g = tiles.find((t) => t.geminiPlanId === PLAN_A && t.geminiPlanCallIndex === 1);
  const st = g?.outputStatus ?? "?";
  if (st !== last) { log("  status:", st, g?.notes ? "· " + g.notes : ""); last = st; }
  if (g && ["completed", "failed"].includes(g.outputStatus)) break;
}
if (!g || g.outputStatus !== "completed") { log("✗ not completed:", g?.outputStatus, g?.notes); process.exit(1); }
log(`✅ scene 1 · ${g.costEstimate}cr · ${Math.round(g.generationTime)}s · ${g.outputUrl?.slice(0, 60)}`);

const buf = Buffer.from(await (await fetch(g.outputUrl)).arrayBuffer());
writeFileSync("/tmp/gen_6954_A_s1.mp4", buf);
const ff = (await import("ffmpeg-static")).default;
for (const t of [1, 4, 7]) spawnSync(ff, ["-y", "-loglevel", "error", "-ss", String(t), "-i", "/tmp/gen_6954_A_s1.mp4", "-frames:v", "1", `/tmp/a1_f${t}.png`]);
log("saved /tmp/gen_6954_A_s1.mp4 + /tmp/a1_f{1,4,7}.png");
