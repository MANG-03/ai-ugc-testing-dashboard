"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

// Twelve Labs Pegasus 1.5 TBM. Request shape confirmed by Phase 0 probe 1:
//   POST /v1.3/analyze/tasks  (auth: x-api-key)
//   body { model_name:"pegasus1.5", analysis_mode:"time_based_metadata",
//          video:{type:"url", url}, response_format:{type:"segment_definitions", ...} }
//   → 202 {task_id}; poll GET /analyze/tasks/{id} until status==="ready".
// NOTE: the source video URL must be publicly fetchable with a real content-length —
// Convex storage.getUrl() qualifies.

const TWELVELABS_BASE = "https://api.twelvelabs.io/v1.3";

// Full scene schema (spec §8). Field descriptions ARE the prompt in TBM mode.
const SCENE_DEFINITION = {
  id: "scenes",
  description:
    "Segment the video into distinct scenes. A scene changes when there is a visible cut, a significant " +
    "change in camera angle, a change in setting, or a shift in the subject's action. For each scene, " +
    "extract detailed visual, audio, and narrative metadata.",
  fields: [
    { name: "scene_description", type: "string", description: "A detailed description of what is happening visually in this scene. Include the subject's actions, body language, gestures, facial expressions, and any objects or people they interact with." },
    { name: "characters", type: "string", description: "Identify EVERY distinct person who appears or speaks in this scene. For each, give a short, consistent label based on their role and appearance, e.g. 'Interviewer — man in black shirt holding a microphone' or 'Interviewee — woman with curly brown hair'. Use the SAME label for the same person across the whole video. Note who is on-screen and who is currently speaking. List all people even if they do not speak." },
    { name: "dialogue_transcript", type: "string", description: "The exact words spoken during this scene, ATTRIBUTED to the speaker. Use lip movement and voice to determine who says each line, and format every line as 'Label: spoken words' using the SAME labels from the characters field. For off-screen narration use 'Narrator'. If no one speaks, write 'no dialogue'." },
    { name: "delivery_style", type: "string", description: "How the dialogue is delivered: tone of voice, pacing, energy level, emotional quality." },
    { name: "shot_type", type: "string", description: "The primary camera framing used in this scene.", enum: ["extreme_close_up", "close_up", "medium_close_up", "medium", "medium_wide", "wide", "extreme_wide"] },
    { name: "camera_movement", type: "string", description: "How the camera moves during this scene, e.g. 'static', 'slight handheld shake', 'panning left', 'tracking subject', 'zooming in slowly', 'POV movement'." },
    { name: "subject_framing", type: "string", description: "Where the subject is positioned in the frame and what parts of them are visible, e.g. 'center frame, shoulders up'." },
    { name: "subject_appearance", type: "string", description: "What the subject looks like and is wearing. Include clothing colors, accessories, hair style, and any distinctive visual features." },
    { name: "background_description", type: "string", description: "What is behind and around the subject: setting, objects, other people, depth of field, and how in or out of focus the background is." },
    { name: "lighting", type: "string", description: "Lighting conditions: direction, quality (harsh/soft), color temperature (warm/cool/neutral), and notable shadows or highlights." },
    { name: "audio_atmosphere", type: "string", description: "Non-dialogue audio: background music, ambient sounds, sound effects, and the mood/energy they create." },
    { name: "on_screen_text", type: "string", description: "Any text visible on screen: captions, subtitles, labels, watermarks, overlay text. If none, write 'none'." },
    { name: "scene_purpose", type: "string", description: "The narrative/structural role of this scene, e.g. 'hook/attention grabber', 'context setup', 'main point delivery', 'call to action', 'transition', 'punchline'." },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractScenes(final: any): unknown[] {
  let d = final?.result?.data ?? final?.data ?? final;
  if (typeof d === "string") {
    try { d = JSON.parse(d); } catch { /* leave as-is */ }
  }
  if (d && Array.isArray(d.scenes)) return d.scenes;
  if (d && typeof d === "object") {
    for (const val of Object.values(d)) {
      if (Array.isArray(val) && val.length && typeof val[0] === "object" && val[0] && "start_time" in val[0]) {
        return val as unknown[];
      }
    }
  }
  return [];
}

export const analyze = action({
  args: { sourceVideoId: v.id("sourceVideos") },
  handler: async (ctx, args) => {
    const apiKey = process.env.TWELVELABS_API_KEY;
    if (!apiKey) throw new Error("TWELVELABS_API_KEY not set on the Convex deployment (npx convex env set TWELVELABS_API_KEY ...)");

    const video = await ctx.runQuery(internal.sourceVideos.getInternal, { id: args.sourceVideoId });
    if (!video) throw new Error("source video not found");

    const url = await ctx.storage.getUrl(video.storageId);
    if (!url) throw new Error("could not resolve a storage URL for the source video");

    // Twelve Labs can't fetch a localhost URL → on local dev, send the bytes as base64
    // (confirmed shape). On cloud, the public URL is the proven, leaner path for large videos.
    const isLocal = /127\.0\.0\.1|localhost/.test(url);
    let videoField: Record<string, unknown>;
    if (isLocal) {
      const blob = await ctx.storage.get(video.storageId);
      if (!blob) throw new Error("source video blob missing from storage");
      videoField = {
        type: "base64_string",
        base64_string: Buffer.from(await blob.arrayBuffer()).toString("base64"),
      };
    } else {
      videoField = { type: "url", url };
    }

    await ctx.runMutation(internal.sourceVideos.setPegasusStatus, {
      id: args.sourceVideoId,
      status: "processing",
    });

    try {
      // 1. create the analysis task
      const createRes = await fetch(`${TWELVELABS_BASE}/analyze/tasks`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model_name: "pegasus1.5",
          analysis_mode: "time_based_metadata",
          min_segment_duration: 2.0,
          max_segment_duration: 15.0,
          temperature: 0.2,
          video: videoField,
          response_format: { type: "segment_definitions", segment_definitions: [SCENE_DEFINITION] },
        }),
      });
      const createText = await createRes.text();
      if (!createRes.ok) throw new Error(`Twelve Labs create failed (${createRes.status}): ${createText.slice(0, 400)}`);
      const created = JSON.parse(createText);
      const taskId: string = created.task_id ?? created._id ?? created.id;
      if (!taskId) throw new Error(`no task id in create response: ${createText.slice(0, 300)}`);

      await ctx.runMutation(internal.sourceVideos.setPegasusStatus, {
        id: args.sourceVideoId,
        status: "processing",
        taskId,
      });

      // 2. poll until ready (TBM is fast; well within the 10-min action limit)
      const deadline = Date.now() + 9 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(4000);
        const pollRes = await fetch(`${TWELVELABS_BASE}/analyze/tasks/${taskId}`, {
          headers: { "x-api-key": apiKey },
        });
        const pollText = await pollRes.text();
        const poll = JSON.parse(pollText);
        const status = poll.status;
        if (status === "ready" || status === "completed") {
          const scenes = extractScenes(poll);
          await ctx.runMutation(internal.sourceVideos.setPegasusStatus, {
            id: args.sourceVideoId,
            status: "completed",
            analysis: { scenes, raw: poll },
          });
          return { ok: true, sceneCount: scenes.length };
        }
        if (status === "failed" || status === "error") {
          throw new Error(`Twelve Labs task ${status}: ${pollText.slice(0, 400)}`);
        }
      }
      throw new Error("Twelve Labs analysis timed out after 9 minutes");
    } catch (e) {
      await ctx.runMutation(internal.sourceVideos.setPegasusStatus, {
        id: args.sourceVideoId,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },
});
