import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const c = new ConvexHttpClient(process.env.CONVEX_URL);
const WS = "js7btjnxy6y4amq1sg0mt2068s8863p1"; // Armaan
const FILE = process.env.FILE, NAME = process.env.NAME, DUR = Number(process.env.DUR || 0);

const url = await c.mutation(api.sourceVideos.generateUploadUrl, {});
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: readFileSync(FILE) });
if (!res.ok) throw new Error("upload failed " + res.status);
const { storageId } = await res.json();
const id = await c.mutation(api.sourceVideos.createSourceVideo, { fileName: NAME, storageId, duration: DUR, workspaceId: WS });
console.log("created sourceVideo:", id, "\nrunning Pegasus (Twelve Labs)…");
const r = await c.action(api.pegasus.analyze, { sourceVideoId: id });
console.log("pegasus result:", JSON.stringify(r));
const sv = await c.query(api.sourceVideos.get, { id });
const scenes = sv?.pegasusAnalysis?.scenes ?? [];
console.log(`\nscenes: ${scenes.length}`);
for (const [i, s] of scenes.entries()) {
  const m = s.metadata ?? s;
  console.log(`[${i + 1}] ${s.start_time ?? s.start}s–${s.end_time ?? s.end}s`);
  console.log(`    desc: ${(m.scene_description || "").slice(0, 140)}`);
  console.log(`    on_screen_text: ${m.on_screen_text || "—"} | dialogue: ${(m.dialogue_transcript||"").slice(0,80) || "—"}`);
}
console.log("\nSOURCE_ID=" + id);
