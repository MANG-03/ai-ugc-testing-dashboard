import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
const TL = process.env.TWELVELABS_API_KEY, SEG = Number(process.env.SEG || 1);
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const sv = await c.query(api.sourceVideos.get, { id: "jn71dsyamvtgxvd1xan6ky032988bg5q" });
const url = sv.fileUrl;
const SCENE_DEFINITION = { id: "scenes", description: "Segment the video into short consecutive time chunks. For each chunk extract the exact action and objects, in chronological order. Be exhaustive — never skip or merge a distinct product use or action.", fields: [
  { name: "action_timeline", type: "string", description: "A chronological, numbered list of EVERY distinct action in this time chunk. List EACH product/object pick-up, application, or show on its own line — even if a similar action repeats. Name the specific product/object used." },
  { name: "props_and_objects", type: "string", description: "Every object/product held or used in this chunk, with any visible label/brand text transcribed verbatim. If none, write 'none'." },
  { name: "scene_description", type: "string", description: "A concise description of what happens in this chunk." },
] };
const create = await (await fetch("https://api.twelvelabs.io/v1.3/analyze/tasks", { method: "POST", headers: { "x-api-key": TL, "Content-Type": "application/json" }, body: JSON.stringify({ model_name: "pegasus1.5", analysis_mode: "time_based_metadata", min_segment_duration: SEG, max_segment_duration: SEG, temperature: 0.2, max_tokens: 32768, video: { type: "url", url }, response_format: { type: "segment_definitions", segment_definitions: [SCENE_DEFINITION] } }) })).json();
const taskId = create.task_id ?? create._id ?? create.id;
if (!taskId) { console.log("CREATE FAILED:", JSON.stringify(create).slice(0, 400)); process.exit(1); }
console.log(`SEG=${SEG}s taskId=${taskId}`);
const deadline = Date.now() + 9 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const poll = await (await fetch(`https://api.twelvelabs.io/v1.3/analyze/tasks/${taskId}`, { headers: { "x-api-key": TL } })).json();
  if (poll.status === "ready" || poll.status === "completed") {
    let d = poll?.result?.data; try { d = JSON.parse(d); } catch {}
    const scenes = d?.scenes ?? [];
    console.log(`\n${scenes.length} segments:`);
    for (const s of scenes) { const m = s.metadata ?? s; console.log(`[${s.start_time}-${s.end_time}s] ${m.action_timeline || m.scene_description || ""} | props: ${m.props_and_objects || "—"}`); }
    process.exit(0);
  }
  if (poll.status === "failed" || poll.status === "error") { console.log("FAILED:", JSON.stringify(poll).slice(0, 300)); process.exit(1); }
}
console.log("timed out");
