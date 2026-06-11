import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q";
console.log("re-running Pegasus with enriched schema…");
await c.action(api.pegasus.analyze, { sourceVideoId: SRC });
const sv = await c.query(api.sourceVideos.get, { id: SRC });
const m = (sv.pegasusAnalysis?.scenes?.[0]?.metadata) ?? {};
for (const k of ["action_timeline","props_and_objects","body_language","facial_expressions"]) {
  console.log(`\n=== ${k} ===\n${m[k] ?? "(missing)"}`);
}
