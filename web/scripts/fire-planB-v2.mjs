// Re-fire Plan B after the executor fix (Pipeline B now clips per planned scene range).
import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);
const SRC = "jn71p0eaxavct5a50jpbysyysd88ds9v";
const PLAN_B = "j9766s1ftm00vttn8jdkx4rhhd88c6jp";
const ff = (await import("ffmpeg-static")).default;

log("re-fire Plan B (Pipeline B, now clips per scene)…");
log("  ", JSON.stringify(await c.action(api.generate.runPlan, { planId: PLAN_B })));
const t0 = Date.now();
const latest = (tiles, idx) => tiles.filter((t) => t.geminiPlanId === PLAN_B && t.geminiPlanCallIndex === idx).sort((a, b) => b.createdAt - a.createdAt)[0];

const deadline = Date.now() + 25 * 60 * 1000; let seen = "", done = false;
while (Date.now() < deadline && !done) {
  await new Promise((r) => setTimeout(r, 9000));
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  done = true; const s = [];
  for (const i of [1, 2, 3]) { const g = latest(tiles, i); const st = g?.outputStatus ?? "none"; s.push(`B${i}:${st}`); if (!["completed", "failed"].includes(st)) done = false; }
  const str = s.join(" "); if (str !== seen) { log(str); seen = str; }
}

const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
const parts = [];
console.log("\n=== PLAN B (v2) ===");
for (const i of [1, 2, 3]) {
  const g = latest(tiles, i);
  console.log(`  call ${i}: ${g?.outputStatus} ${g?.costEstimate ? "· " + Math.round(g.costEstimate) + "cr" : ""} ${g?.notes ? "· " + String(g.notes).slice(0, 160) : ""}`);
  if (g?.outputStatus === "completed" && g.outputUrl) {
    const p = `/tmp/6954_B_s${i}.mp4`;
    writeFileSync(p, Buffer.from(await (await fetch(g.outputUrl)).arrayBuffer()));
    parts.push([i, p]);
  }
}
if (parts.length) {
  writeFileSync("/tmp/concat_B.txt", parts.map(([, p]) => `file '${p}'`).join("\n"));
  spawnSync(ff, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "/tmp/concat_B.txt", "-c", "copy", "/tmp/6954_B_full.mp4"]);
  for (const [i, p] of parts) spawnSync(ff, ["-y", "-loglevel", "error", "-ss", "2", "-i", p, "-frames:v", "1", `/tmp/6954_B_s${i}_f.png`]);
  console.log(`  → concatenated ${parts.length} parts → /tmp/6954_B_full.mp4`);
}
log("DONE B · total", Math.round((Date.now() - t0) / 1000) + "s");
