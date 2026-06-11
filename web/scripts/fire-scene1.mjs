// Fire ONLY scene 1 of an existing Pipeline A plan (no chaining). Env: CONVEX_URL, PLAN_ID, SOURCE_ID
import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const PLAN = process.env.PLAN_ID;
const SRC = process.env.SOURCE_ID;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

log("runPlan (creates rows, schedules scene 1)…");
log("  ", JSON.stringify(await c.action(api.generate.runPlan, { planId: PLAN })));
log("delete calls 2+ so nothing chains after scene 1…");
log("  ", JSON.stringify(await c.mutation(api.generations.cancelPlanCallsFrom, { geminiPlanId: PLAN, fromCallIndex: 2 })));

log("polling scene 1…");
const deadline = Date.now() + 7 * 60 * 1000;
let g = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 12000));
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  g = tiles.find((t) => t.geminiPlanCallIndex === 1);
  log(`  status=${g?.outputStatus}${g?.notes ? " · " + g.notes : ""}`);
  if (g && ["completed", "failed"].includes(g.outputStatus)) break;
}

if (!g || g.outputStatus !== "completed") { log("✗ not completed:", g?.notes ?? g?.outputStatus); process.exit(1); }

log(`✅ scene 1 completed · ${g.costEstimate} cr · ${Math.round(g.generationTime)}s`);
const buf = Buffer.from(await (await fetch(g.outputUrl)).arrayBuffer());
writeFileSync("/tmp/scene1_out.mp4", buf);
const pr = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", "/tmp/scene1_out.mp4"], { encoding: "utf8" });
log("streams:", pr.stdout.trim().split("\n").join(","), `· ${Math.round(buf.length / 1024)}KB`);
// grab a representative frame so we can eyeball the avatar swap
import("ffmpeg-static").then(({ default: ff }) => {
  spawnSync(ff, ["-y", "-loglevel", "error", "-ss", "2", "-i", "/tmp/scene1_out.mp4", "-frames:v", "1", "/tmp/scene1_frame.png"]);
  log("frame saved: /tmp/scene1_frame.png");
});
