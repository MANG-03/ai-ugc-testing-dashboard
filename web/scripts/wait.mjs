import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q";
const deadline = Date.now() + 6.5 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  const sum = tiles.map((t) => t.outputStatus).join(",");
  if (sum !== last) { console.log(new Date().toISOString().slice(11,19), sum); last = sum; }
  if (tiles.length && tiles.every((t) => ["completed","failed"].includes(t.outputStatus))) {
    for (const t of tiles) {
      console.log(`\n${t.outputStatus} · ${t.costEstimate ?? "?"}cr`);
      console.log("full prompt:", t.translatedPrompt);
      if (t.notes) console.log("notes:", t.notes);
      if (t.outputStatus === "completed" && t.outputUrl) { writeFileSync("/tmp/gen_pov.mp4", Buffer.from(await (await fetch(t.outputUrl)).arrayBuffer())); console.log("saved /tmp/gen_pov.mp4"); }
    }
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 12000));
}
console.log("still processing at deadline");
