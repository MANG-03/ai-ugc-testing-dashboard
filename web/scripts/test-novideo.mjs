import { ConvexHttpClient } from "convex/browser";
import { readFileSync, writeFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const KEY = process.env.EVOLINK_API_KEY;
const c = new ConvexHttpClient(process.env.CONVEX_URL);
const SRC = "jn71dsyamvtgxvd1xan6ky032988bg5q";
const AVATAR = "/Users/armaanmanji/Downloads/Echos Content/male echos content/11-ugc-grooming.png";

const sv = await c.query(api.sourceVideos.get, { id: SRC });
const pegasus = sv.pegasusAnalysis;

const fd = new FormData();
fd.append("file", new Blob([readFileSync(AVATAR)]), "avatar.png");
const up = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd });
const uj = await up.json();
const avatarUrl = uj.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
console.log("avatar hosted:", avatarUrl);

const instruction = `You are writing ONE prompt for an IMAGE-TO-VIDEO model (Seedance 2.0). A single reference image of a person ("image 1") is given to the generator; NO source video is provided. Using the rich scene breakdown below, write a vivid, self-contained prompt (MAX 1900 characters) that animates the man in image 1 performing the EXACT scene: every action in order, the setting, wardrobe, camera framing/movement, lighting, mood and pacing. The man in image 1 is the ONLY subject and must keep his own face, hair and identity. CLEAN PLATE: explicitly require NO on-screen text, captions, subtitles, watermarks or graphics. Do NOT reference any "video 1" — there is no source video. Output ONLY the prompt text.\n\nSCENE BREAKDOWN (Pegasus):\n${JSON.stringify(pegasus)}`;
const gres = await fetch("https://api.evolink.ai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gemini-3.1-pro-preview", messages: [{ role: "user", content: instruction }] }) });
const gj = await gres.json();
const prompt = (gj?.choices?.[0]?.message?.content ?? "").trim();
console.log("\n=== PROMPT (" + prompt.length + " chars) ===\n" + prompt + "\n");

const body = { model: "seedance-2.0-reference-to-video", prompt, image_urls: [avatarUrl], aspect_ratio: "9:16", quality: "720p", duration: 11, generate_audio: true };
const cr = await fetch("https://api.evolink.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const crt = await cr.text();
if (!cr.ok) { console.log("CREATE FAILED", cr.status, crt.slice(0, 400)); process.exit(1); }
const taskId = JSON.parse(crt).id ?? JSON.parse(crt).task_id ?? JSON.parse(crt).data?.id;
console.log("taskId:", taskId, new Date().toISOString().slice(11, 19));

const deadline = Date.now() + 11 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const pr = await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } });
  const pj = JSON.parse(await pr.text());
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { console.log(new Date().toISOString().slice(11, 19), st); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) {
    const out = pj.results?.[0] ?? pj.output?.[0] ?? pj.data?.results?.[0] ?? JSON.stringify(pj).match(/https?:\/\/[^"]+\.mp4/)?.[0];
    console.log("output:", out, "| credits:", pj.usage?.credits_used);
    if (out) { writeFileSync("/tmp/gen_novideo.mp4", Buffer.from(await (await fetch(out)).arrayBuffer())); console.log("saved /tmp/gen_novideo.mp4"); }
    process.exit(0);
  }
  if (["failed", "error", "cancelled"].includes(st)) { console.log("FAILED:", JSON.stringify(pj).slice(0, 400)); process.exit(1); }
}
console.log("timed out");
