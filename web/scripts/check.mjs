import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: "jn71dsyamvtgxvd1xan6ky032988bg5q" });
for (const t of tiles) {
  console.log(`${t.outputStatus} · ${t.costEstimate ?? "?"}cr`);
  console.log("  prompt:", (t.translatedPrompt||"").slice(0,200));
  if (t.notes) console.log("  notes:", t.notes);
  if (t.outputStatus === "completed" && t.outputUrl) { writeFileSync("/tmp/gen_pov.mp4", Buffer.from(await (await fetch(t.outputUrl)).arrayBuffer())); console.log("  saved /tmp/gen_pov.mp4"); }
}
