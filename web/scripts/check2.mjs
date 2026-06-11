import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q", PLAN = "j97fg8h0vfx5hx2n6t0p1p9a4588b85r";
const deadline = Date.now() + 6 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  const tiles = (await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC })).filter(t => t.geminiPlanId === PLAN);
  const t = tiles.sort((a,b)=>b._creationTime-a._creationTime)[0];
  if (t && t.outputStatus !== last) { console.log(new Date().toISOString().slice(11,19), t.outputStatus); last = t.outputStatus; }
  if (t && ["completed","failed"].includes(t.outputStatus)) {
    console.log(`\n${t.outputStatus} · ${t.costEstimate ?? "?"}cr`);
    if (t.notes) console.log("notes:", t.notes);
    if (t.outputStatus === "completed" && t.outputUrl) { writeFileSync("/tmp/gen_pov2.mp4", Buffer.from(await (await fetch(t.outputUrl)).arrayBuffer())); console.log("saved /tmp/gen_pov2.mp4"); }
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 12000));
}
console.log("still processing at deadline");
