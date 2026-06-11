import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = process.env.SOURCE_ID, AVATAR = process.env.AVATAR, PROMPT = process.env.PROMPT;

const aurl = await c.mutation(api.sourceVideos.generateUploadUrl, {});
const ares = await fetch(aurl, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(AVATAR) });
const { storageId: avatarId } = await ares.json();
console.log("avatar uploaded:", avatarId);
const plan = await c.action(api.gemini.plan, { sourceVideoId: SRC, pipeline: "A", userPrompt: PROMPT, modelIds: ["seedance-2.0-reference-to-video"], avatarStorageIds: [avatarId] });
console.log("plan:", JSON.stringify(plan));
const r = await c.action(api.generate.runPlan, { planId: plan.planId });
console.log("runPlan:", JSON.stringify(r));
const deadline = Date.now() + 8 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, 12000));
  const tiles = await c.query(api.generations.listForSourceVideo, { sourceVideoId: SRC });
  const sum = tiles.map((t) => t.outputStatus).join(",");
  if (sum !== last) { console.log(new Date().toISOString().slice(11,19), "status:", sum); last = sum; }
  if (tiles.length && tiles.every((t) => ["completed", "failed"].includes(t.outputStatus))) {
    for (const t of tiles) {
      console.log(`gen: ${t.outputStatus} · ${t.costEstimate ?? "?"}cr · prompt="${(t.translatedPrompt||"").slice(0,160)}"`);
      if (t.outputStatus === "completed" && t.outputUrl) { writeFileSync("/tmp/gen_pov.mp4", Buffer.from(await (await fetch(t.outputUrl)).arrayBuffer())); console.log("saved /tmp/gen_pov.mp4"); }
      if (t.notes) console.log("  notes:", t.notes);
    }
    break;
  }
}
