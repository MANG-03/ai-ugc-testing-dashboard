// Probe kling-custom-element param requirements. Tries variants on an already-hosted clean face,
// stops at first SUCCESS. Goal: find the minimal valid request shape.
const KEY = process.env.EVOLINK_API_KEY;
const ts = () => new Date().toISOString().slice(11, 19);
const faceUrl = "https://files.catbox.moe/g2rnzq.jpg"; // clean frontal face hosted earlier

const variants = [
  ["B: frontal + 1 refer", { frontal_image: faceUrl, refer_images: [{ image_url: faceUrl }] }],
  ["C: frontal + 3 refer", { frontal_image: faceUrl, refer_images: [{ image_url: faceUrl }, { image_url: faceUrl }, { image_url: faceUrl }] }],
  ["D: refer only (no frontal)", { refer_images: [{ image_url: faceUrl }] }],
];

const run = async (label, eil) => {
  const create = await (await fetch("https://api.evolink.ai/v1/videos/generations", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "kling-custom-element",
      model_params: { element_name: "Probe", element_description: "A young adult, clear frontal face", reference_type: "image_refer", element_image_list: eil },
    }),
  })).json();
  const taskId = create.id ?? create.task_id;
  console.log(ts(), label, "→ task", taskId ?? JSON.stringify(create).slice(0, 160));
  if (!taskId) return false;
  const deadline = Date.now() + 4 * 60 * 1000; let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const pj = await (await fetch(`https://api.evolink.ai/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
    const st = String(pj.status ?? "").toLowerCase();
    if (st !== last) { console.log("   ", ts(), st, `(${pj.progress ?? 0}%)`); last = st; }
    if (["completed", "succeeded", "success", "done"].includes(st)) {
      let id = null; JSON.stringify(pj, (k, val) => { if (!id && /element_id/i.test(k)) id = String(val); return val; });
      console.log("    ✅", label, "SUCCESS element_id =", id);
      return true;
    }
    if (["failed", "error", "cancelled"].includes(st)) { console.log("    ❌", label, "FAILED:", (pj.error?.message ?? "").replace(/\n/g, " ").slice(0, 120)); return false; }
  }
  console.log("    ⌛", label, "timeout"); return false;
};

for (const [label, eil] of variants) {
  const ok = await run(label, eil);
  if (ok) { console.log("\n>>> WINNING SHAPE:", label, JSON.stringify(eil)); process.exit(0); }
}
console.log("\n>>> all variants failed");
