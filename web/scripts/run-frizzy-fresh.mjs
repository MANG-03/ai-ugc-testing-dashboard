import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const WS = "js7btjnxy6y4amq1sg0mt2068s8863p1";
const VIDEO = "/Users/armaanmanji/Desktop/AI UGC Testing/dashboard/testing batch/ssstik.io_@based_1780787626595.mp4";
const AVATAR = "/Users/armaanmanji/Downloads/Echos Content/male echos content/11-ugc-grooming.png";

// 1. fresh upload + Pegasus
const u = await c.mutation(api.sourceVideos.generateUploadUrl, {});
const { storageId } = await (await fetch(u, { method: "POST", headers: { "Content-Type": "video/mp4" }, body: readFileSync(VIDEO) })).json();
const SRC = await c.mutation(api.sourceVideos.createSourceVideo, { fileName: "frizzy-fresh.mp4", storageId, duration: 11.08, workspaceId: WS });
console.log("source:", SRC, "\nrunning Pegasus…");
await c.action(api.pegasus.analyze, { sourceVideoId: SRC });

// 2. upload avatar + Gemini plan (Pipeline A, video reference)
const au = await c.mutation(api.sourceVideos.generateUploadUrl, {});
const { storageId: avatarId } = await (await fetch(au, { method: "POST", headers: { "Content-Type": "image/png" }, body: readFileSync(AVATAR) })).json();
console.log("planning with Gemini…");
const plan = await c.action(api.gemini.plan, { sourceVideoId: SRC, pipeline: "A", userPrompt: "Recreate this hair-care POV with the man in the avatar image as the subject — keep the setting, actions and timing, replace the person with the avatar.", modelIds: ["seedance-2.0-reference-to-video"], avatarStorageIds: [avatarId] });
const p = await c.query(api.geminiPlans.get, { id: plan.planId });
const call = p.fullPlan.models[0].calls[0];
console.log("\nPLAN_ID=" + plan.planId, "AVATAR_ID=" + avatarId, "SRC=" + SRC);
console.log("\n=== changesFromPegasus ===\n" + (p.fullPlan.changesFromPegasus ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n"));
console.log("\n=== SUGGESTED SEEDANCE PROMPT ===\n" + call.prompt);
console.log("\n=== mediaSegments ===\n" + JSON.stringify(call.mediaSegments, null, 1));
