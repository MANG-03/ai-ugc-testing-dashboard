// One-off backend check: upload a sample → inspect the getUrl() → (maybe) run Pegasus.
// Run: node --env-file=.env.local scripts/e2e-check.mjs
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
const file = readFileSync("../probes/out/sample_9p5s.mp4");

console.log("1. generateUploadUrl…");
const postUrl = await client.mutation(api.sourceVideos.generateUploadUrl, {});
console.log("2. POST file bytes…");
const up = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: file });
const { storageId } = await up.json();
console.log("   storageId:", storageId);

console.log("3. createSourceVideo…");
const id = await client.mutation(api.sourceVideos.createSourceVideo, {
  fileName: "sample_9p5s.mp4", storageId, duration: 9.5,
});
const doc = await client.query(api.sourceVideos.get, { id });
console.log("   fileUrl:", doc.fileUrl);

const local = /127\.0\.0\.1|localhost/.test(doc.fileUrl || "");
console.log(`\nfileUrl is ${local ? "LOCALHOST → external APIs cannot fetch it" : "external → fetchable"}`);

if (local) {
  console.log("⏭  Skipping Pegasus (Twelve Labs can't reach a localhost URL). Need a CLOUD deployment.");
  process.exit(0);
}

console.log("4. pegasus.analyze…");
const res = await client.action(api.pegasus.analyze, { sourceVideoId: id });
console.log("   result:", res);
