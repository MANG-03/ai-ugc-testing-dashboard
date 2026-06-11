// Confirmation probe: does kling-custom-element succeed with a CLEAN frontal portrait?
// If yes → our 2-call workflow is sound and the only blocker is the avatar image quality.
import { readFileSync } from "node:fs";
const KEY = process.env.EVOLINK_API_KEY;
const ts = () => new Date().toISOString().slice(11, 19);

// grab a clean single-face frontal portrait and re-host to catbox (Kling must be able to fetch it)
const faceBuf = Buffer.from(await (await fetch("https://thispersondoesnotexist.com/")).arrayBuffer());
console.log(ts(), "clean face bytes:", faceBuf.length);
const fd = new FormData();
fd.append("reqtype", "fileupload");
fd.append("fileToUpload", new Blob([faceBuf], { type: "image/jpeg" }), "face.jpg");
const faceUrl = (await (await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd })).text()).trim();
console.log(ts(), "hosted:", faceUrl);

const create = await (await fetch("https://api.evolink.ai/v1/videos/generations", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "kling-custom-element",
    model_params: {
      element_name: "Clean Face Test",
      element_description: "A young adult with a clear frontal face, neutral expression",
      reference_type: "image_refer",
      element_image_list: { frontal_image: faceUrl },
    },
  }),
})).json();
console.log(ts(), "create:", JSON.stringify(create).slice(0, 200));
const taskId = create.id ?? create.task_id;
if (!taskId) process.exit(1);

const deadline = Date.now() + 8 * 60 * 1000; let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 6000));
  const pj = await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const st = String(pj.status ?? "").toLowerCase();
  if (st !== last) { console.log(ts(), st, `(${pj.progress ?? 0}%)`); last = st; }
  if (["completed", "succeeded", "success", "done"].includes(st)) {
    let id = null; JSON.stringify(pj, (k, val) => { if (!id && /element_id/i.test(k)) id = String(val); return val; });
    console.log(ts(), "✅ SUCCESS — element_id =", id, "\nfull:", JSON.stringify(pj).slice(0, 400));
    process.exit(0);
  }
  if (["failed", "error", "cancelled"].includes(st)) { console.log(ts(), "❌ FAILED:", JSON.stringify(pj).slice(0, 400)); process.exit(1); }
}
console.log(ts(), "timeout");
