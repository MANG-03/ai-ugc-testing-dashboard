import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";

// Editable, versioned prompt-skill documents fed to Gemini as planning context (spec §9).

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("promptSkills").collect();
    return all.filter((s) => s.isActive);
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("promptSkills").order("desc").collect(),
});

export const getActiveForModelInternal = internalQuery({
  args: { modelId: v.string() },
  handler: async (ctx, args) => {
    const skills = await ctx.db
      .query("promptSkills")
      .withIndex("by_model", (q) => q.eq("modelId", args.modelId))
      .collect();
    return skills.filter((s) => s.isActive).sort((a, b) => b.version - a.version)[0] ?? null;
  },
});

// Save an edited skill as a NEW version and deactivate the prior active one (A/B-friendly).
export const saveVersion = mutation({
  args: { modelId: v.string(), skillName: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("promptSkills")
      .withIndex("by_model", (q) => q.eq("modelId", args.modelId))
      .collect();
    for (const s of existing.filter((s) => s.isActive)) {
      await ctx.db.patch(s._id, { isActive: false });
    }
    const nextVersion = existing.reduce((m, s) => Math.max(m, s.version), 0) + 1;
    return ctx.db.insert("promptSkills", {
      modelId: args.modelId,
      skillName: args.skillName,
      content: args.content,
      version: nextVersion,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

export const seedDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("promptSkills").collect();
    const have = new Set(existing.map((s) => s.modelId));
    let added = 0;
    for (const [modelId, skill] of Object.entries(DEFAULT_SKILLS)) {
      if (have.has(modelId)) continue;
      await ctx.db.insert("promptSkills", {
        modelId,
        skillName: skill.name,
        content: skill.content,
        version: 1,
        isActive: true,
        createdAt: Date.now(),
      });
      added++;
    }
    return { added };
  },
});

const DEFAULT_SKILLS: Record<string, { name: string; content: string }> = {
  "seedance-2.0-reference-to-video": {
    name: "Seedance 2.0 V2V/Reference Skill",
    content: `# Seedance 2.0 (seedance-2.0-reference-to-video) — prompting skill

## Reference syntax
- Reference uploaded media POSITIONALLY in the prompt: "video 1" → video_urls[0], "image 1" → image_urls[0], "audio 1" → audio_urls[0].
- For a V2V edit, the SOURCE video is video_urls[0]; refer to it as "video 1" and describe the change while preserving everything else.

## Reference limits
- Up to 9 images, 3 videos, 3 audio; 12 files total.
- first_frame_url and reference_images are mutually exclusive — for scene bridging, pass the previous clip's last frame as an image reference, not first_frame_url.

## Prompting style
- Director-style: explicit about camera, lighting, action, and what must stay identical.
- For edits, lead with the change, then "keep everything else identical — same motion, framing, timing, and composition."

## Audio (CRITICAL)
- generate_audio:false produces a SILENT output (it does NOT preserve source audio).
- To keep the original audio, plan audioHandling:"ffmpeg_remux" (extract source audio, overlay on the silent output).
- Set generate_audio:true only when you WANT newly generated audio.

## Params
- quality: "480p" (iteration tier) or "720p". duration: 4–15s (configurable). aspect_ratio: "9:16" for TikTok.

## Anti-patterns
- Don't request >15s in one call. Don't rely on generate_audio:false to keep audio. Don't combine first_frame_url with reference images.`,
  },
  "kling-o3-video-edit": {
    name: "Kling O3 Edit Skill",
    content: `# Kling O3 (kling-o3-video-edit) — prompting skill (doc-verified June 2026)

## CRITICAL: how to actually REPLACE a person (identity swap)
Identity replacement requires a DEDICATED ELEMENT, created in a separate call BEFORE the edit:
1. Create the avatar as an element via the \`kling-custom-element\` model (reference_type:"image_refer",
   element_image_list.frontal_image = avatar front shot, refer_images[].image_url = optional extra angles).
   Poll the create task → it returns an \`element_id\`.
2. In the edit call, pass model_params.element_list:[{ element_id }] and reference it in the prompt as
   <<<element_1>>> (first element), <<<element_2>>>, …
Passing the avatar only through image_urls (\`<<<image_1>>>\`) is a STYLE nudge and yields only a PARTIAL
swap — do NOT rely on it for true identity replacement.

## Reference syntax (EXACT)
- <<<element_1>>>  → identity element (model_params.element_list[0]) — use this to swap the PERSON.
- <<<image_1>>>    → plain style/scene reference image (image_urls[0]).
- (The "@Element1 / @Image1" notation is WRONG — that was EvoLink marketing copy, not the API.)
- The source video is passed via \`video_url\` (a STRING, singular — not video_urls[]).

## Reference limits
- image count + element count ≤ 4 combined.
- Source video 3–10.05s, 720–2160px, 24–60fps, ≤200MB.
- Element images ≥300px on each side, aspect ratio between 1:2.5 and 2.5:1.

## Prompting style
- State the edit concisely; Kling reasons over the prompt. For a swap: "Replace the person in the video
  with <<<element_1>>>. Keep the original background, scene, motion, framing, lighting and timing intact."
- Reinforce that face/head/hair/skin become the element's in EVERY frame, and ONLY identity changes.
- HARD LIMIT: prompt ≤ 2500 characters.

## Audio
- Field is \`keep_original_sound\` (default true) → preserves the ORIGINAL audio natively, no FFmpeg
  (audioHandling:"native_keep_audio"). NOT "keep_audio".
- New-audio GENERATION is not supported when a video input is provided; only the original sound is kept.

## Params
- quality: "720p" or "1080p" — NO 480p tier. (1080p bills ×1.334.)
- duration is IGNORED — output matches the source clip length. Do not try to shorten via duration.
- aspect_ratio: "9:16" for TikTok.
- first/last-frame editing is NOT supported. Video-based elements are NOT supported (use image_refer).

## Anti-patterns
- Don't expect image_urls alone to swap identity — create an element. Don't write @Element1/@Image1 — use
  <<<element_1>>>/<<<image_1>>>. Don't send video_urls[] — use video_url. Don't use keep_audio — use
  keep_original_sound. Don't request 480p, exceed 2500 chars, expect duration to trim, or exceed 4 refs.`,
  },
};
