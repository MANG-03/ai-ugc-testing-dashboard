import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q";
const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
for (const t of tiles.filter(x=>x.outputStatus==="completed").sort((a,b)=>a._creationTime-b._creationTime)) {
  console.log("=== gen", t._id, "plan", t.geminiPlanId, "·", t.costEstimate, "cr ===");
  console.log("translatedPrompt:", t.translatedPrompt);
  console.log("apiParameters:", JSON.stringify(t.apiParameters));
  console.log("mediaReferencesSent:", JSON.stringify(t.mediaReferencesSent, null, 1));
  console.log();
}
