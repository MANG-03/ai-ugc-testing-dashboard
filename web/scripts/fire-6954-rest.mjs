// Fire Plan A (full 4-scene chain, 480p) + Plan B (3-call tee edit). Poll all, concat, frames.
import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);
const SRC = "jn71p0eaxavct5a50jpbysyysd88ds9v";
const PLAN_A = "j971b461s4d4s06y1x9gv40w5x88dwsx";
const PLAN_B = "j9766s1ftm00vttn8jdkx4rhhd88c6jp";
const ff = (await import("ffmpeg-static")).default;

log("fire Plan B (Pipeline B, 3 calls parallel)…");
log("  ", JSON.stringify(await c.action(api.generate.runPlan, { planId: PLAN_B })));
log("fire Plan A (Pipeline A, chain from scene 1)…");
log("  ", JSON.stringify(await c.action(api.generate.runPlan, { planId: PLAN_A })));

// poll: latest row per (plan, callIndex); done when all expected indices terminal
const expect = { [PLAN_A]: [1, 2, 3, 4], [PLAN_B]: [1, 2, 3] };
const deadline = Date.now() + 35 * 60 * 1000;
const latest = (tiles, plan, idx) => tiles.filter((t) => t.geminiPlanId === plan && t.geminiPlanCallIndex === idx).sort((a, b) => b.createdAt - a.createdAt)[0];
let done = false, seen = "";
while (Date.now() < deadline && !done) {
  await new Promise((r) => setTimeout(r, 10000));
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  const summary = [];
  done = true;
  for (const [plan, idxs] of Object.entries(expect)) {
    for (const i of idxs) {
      const g = latest(tiles, plan, i);
      const st = g?.outputStatus ?? "none";
      summary.push(`${plan === PLAN_A ? "A" : "B"}${i}:${st}`);
      if (!g || !["completed", "failed"].includes(st)) done = false;
    }
  }
  const s = summary.join(" ");
  if (s !== seen) { log(s); seen = s; }
}

// collect + concat each plan's completed outputs in call order
const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
for (const [plan, idxs, tag] of [[PLAN_A, [1, 2, 3, 4], "A"], [PLAN_B, [1, 2, 3], "B"]]) {
  const parts = [];
  console.log(`\n=== PLAN ${tag} ===`);
  for (const i of idxs) {
    const g = latest(tiles, plan, i);
    console.log(`  call ${i}: ${g?.outputStatus} ${g?.costEstimate ? "· " + Math.round(g.costEstimate) + "cr" : ""} ${g?.notes ? "· " + g.notes : ""}`);
    if (g?.outputStatus === "completed" && g.outputUrl) {
      const p = `/tmp/6954_${tag}_s${i}.mp4`;
      writeFileSync(p, Buffer.from(await (await fetch(g.outputUrl)).arrayBuffer()));
      parts.push(p);
    }
  }
  if (parts.length) {
    const listFile = `/tmp/concat_${tag}.txt`;
    writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n"));
    const outFull = `/tmp/6954_${tag}_full.mp4`;
    spawnSync(ff, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outFull]);
    // mid-frame from each part for review
    parts.forEach((p, k) => spawnSync(ff, ["-y", "-loglevel", "error", "-ss", "2", "-i", p, "-frames:v", "1", `/tmp/6954_${tag}_s${idxs[k]}_f.png`]));
    console.log(`  → concatenated ${parts.length} parts → ${outFull}`);
  }
}
log("DONE");
