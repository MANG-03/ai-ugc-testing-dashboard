import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q";
const r = await c.action(api.generate.runPlan, { planId: "j97d8d343sm3zfyt8658s0znc988bc1n" });
console.log("refired:", JSON.stringify(r), new Date().toISOString().slice(11,19));
const deadline = Date.now() + 11 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, 12000));
  const tiles = (await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC })).filter(t => t.geminiPlanId === "j97d8d343sm3zfyt8658s0znc988bc1n");
  const latest = tiles.sort((a,b)=>b._creationTime-a._creationTime)[0];
  if (!latest) continue;
  if (latest.outputStatus !== last) { console.log(new Date().toISOString().slice(11,19), latest.outputStatus); last = latest.outputStatus; }
  if (["completed","failed"].includes(latest.outputStatus)) {
    console.log(`\n${latest.outputStatus} · ${latest.costEstimate ?? "?"}cr`);
    if (latest.notes) console.log("notes:", latest.notes);
    if (latest.outputStatus === "completed" && latest.outputUrl) { writeFileSync("/tmp/gen_pov.mp4", Buffer.from(await (await fetch(latest.outputUrl)).arrayBuffer())); console.log("saved /tmp/gen_pov.mp4"); }
    process.exit(0);
  }
}
console.log("still processing at deadline");
