import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const sv = await c.query(api.sourceVideos.get, { id: "jn71dsyamvtgxvd1xan6ky032988bg5q" });
console.log(JSON.stringify(sv.pegasusAnalysis, null, 2));
