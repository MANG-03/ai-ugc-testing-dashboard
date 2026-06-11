// Local test of the Gemini planning layer (Phase 2). Uses the REAL Pegasus result from the
// probe (injected via devSetPegasus) so it works on a local deployment.
// Run: node --env-file=.env.local scripts/test-planning.mjs
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);

// Real Pegasus TBM output captured in Phase 0 probe 1 for sample_9p5s.mp4.
const pegasus = {
  scenes: [
    {
      start_time: 0,
      end_time: 9.5,
      metadata: {
        scene_description:
          "A young man with brown hair is outdoors, wearing a black t-shirt. He is styling only one side of his hair while a white towel with the word 'BASS' is draped over the other side. The background shows a scenic view of trees and hills under a bright sky. He uses his hands to tousle and shape the exposed side of his hair, occasionally looking at the camera and then away.",
        dialogue_transcript: "no dialogue",
        delivery_style: "no dialogue",
        shot_type: "close_up",
        camera_movement: "slight handheld shake",
        subject_framing: "center frame, head and shoulders",
        subject_appearance: "young man, brown hair, black t-shirt, white towel over one side of head",
        background_description: "outdoor scenic view, trees and hills, bright sky, shallow depth of field",
        lighting: "bright natural daylight, warm",
        audio_atmosphere: "outdoor ambient, light wind",
        on_screen_text: "none",
        scene_purpose: "hook/attention grabber",
      },
    },
  ],
};

console.log("1. seed prompt skills…");
console.log("  ", await client.mutation(api.promptSkills.seedDefaults, {}));

console.log("2. upload sample + create source video…");
const postUrl = await client.mutation(api.sourceVideos.generateUploadUrl, {});
const up = await fetch(postUrl, {
  method: "POST",
  headers: { "Content-Type": "video/mp4" },
  body: readFileSync("../probes/out/sample_9p5s.mp4"),
});
const { storageId } = await up.json();
const id = await client.mutation(api.sourceVideos.createSourceVideo, {
  fileName: "planning-test.mp4", storageId, duration: 9.5,
});

console.log("3. inject Pegasus analysis (dev)…");
await client.mutation(api.sourceVideos.devSetPegasus, { id, analysis: pegasus });

console.log("4. run Gemini planner (pipeline B, both models)…");
const res = await client.action(api.gemini.plan, {
  sourceVideoId: id,
  pipeline: "B",
  userPrompt: "Change the subject's black t-shirt to a bright red hoodie. Keep everything else identical.",
  modelIds: ["seedance-2.0-reference-to-video", "kling-o3-video-edit"],
});
console.log("   planner result:", JSON.stringify(res, null, 2));

console.log("\n5. fetch stored plan…");
const planDoc = await client.query(api.geminiPlans.getForSourceVideo, { sourceVideoId: id });
console.log(JSON.stringify(planDoc?.fullPlan, null, 2));
