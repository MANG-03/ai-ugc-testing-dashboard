"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { GEMINI_MODEL, MODELS, type ModelId } from "./models";
import { GenerationPlan, GENERATION_PLAN_JSON_SCHEMA } from "./planSchema";

const EVOLINK_CHAT = "https://api.evolink.ai/v1/chat/completions";

type PlanResult = {
  planId: Id<"geminiPlans">;
  totalCalls: number;
  models: { model: string; calls: number }[];
};

// Confirmed Phase 0 format: video goes in as an inline base64 data URI in an image_url part.
async function videoPart(ctx: any, storageId: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new Error("source video blob missing from storage");
  const b64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
  return { type: "image_url", image_url: { url: `data:video/mp4;base64,${b64}` } };
}

async function imagePart(ctx: any, storageId: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const blob = await ctx.storage.get(storageId);
  if (!blob) return null;
  const b64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
  return { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } };
}

function buildInstruction(opts: {
  pipeline: "A" | "B";
  userPrompt: string;
  modelIds: ModelId[];
  skills: { modelId: string; version: number; content: string }[];
  pegasus: unknown;
  hasAvatars: boolean;
}) {
  const specs = opts.modelIds
    .map((id) => {
      const m = MODELS[id];
      return `### ${m.label}  (model id: "${m.id}")
- qualities: ${m.qualities.join(", ")} (default ${m.defaultQuality})
- max duration per call: ${m.maxDurationSec}s${m.durationConfigurable ? "" : " — NOTE: duration is IGNORED, output = source length"}
- ${m.promptMaxChars ? `prompt limit: ${m.promptMaxChars} chars` : "no documented prompt limit"}
- source video param: ${m.sourceVideoParam}
- reference syntax: ${m.referenceSyntax}
- reference limits: ${m.referenceLimits}
- AUDIO: ${m.nativeAudioPreservation ? `native preservation via ${m.audioParam}:true → audioHandling "native_keep_audio"` : `NO native preservation. ${m.audioParam}:false ⇒ SILENT output → audioHandling "ffmpeg_remux" to keep original audio`}
- notes: ${m.notes.join(" ")}`;
    })
    .join("\n\n");

  const skillDocs = opts.skills
    .map((s) => `### Prompt skill for "${s.modelId}" (v${s.version})\n${s.content}`)
    .join("\n\n");

  const pipelineGuidance =
    opts.pipeline === "B"
      ? `PIPELINE B (targeted V2V edit): keep everything identical except the user's requested change. Normally ONE call per model. Only split into multiple calls if the source video exceeds the model's max duration; then plan continuity between calls.`
      : `PIPELINE A (full regeneration): produce ONE call per Pegasus scene per model, in order. Use the avatar reference image(s) as the new character. Chain continuity: pass the previous generation's last frame as an image reference (continuityFromCallIndex). Match each call's duration to the scene length (capped at the model max). Pick split points at natural pauses / cuts per the scene timestamps.`;

  return `You are the orchestration brain for a video regeneration engine. Produce a STRUCTURED GENERATION PLAN that a mechanical executor will run exactly as written. You are given: the original video (watch it), its Pegasus scene decomposition (timestamps + metadata), per-model constraints, prompt-skill documents, and the user's intent.

${pipelineGuidance}

## Target models (plan for EXACTLY these)
${specs}

## Prompt skills (follow these conventions when writing each model's prompt)
${skillDocs}

## Pegasus decomposition (the "what", with timestamps)
This decomposition is your GROUNDING. TRUST it for the things Pegasus is reliable at: exact on-screen text, brand/product names and spelling, character identities and labels, names, dialogue attribution, and overall scene structure. BUT Pegasus summarizes and can MISS, MERGE, or mis-order fine actions (it captures roughly one action per segment and cannot segment below 2s), so it is NOT the final word on what physically happens. WATCH THE VIDEO YOURSELF and build the exhaustive, correct, chronological action sequence. Where your own viewing reveals actions, objects, product uses, gestures, or details that Pegasus missed, merged, or got wrong, CORRECT them — you are the final authority on what actually happens on screen. You MUST record every such correction in the "changesFromPegasus" output array (each item: what Pegasus said vs what actually happens, e.g. "Pegasus logged only the cream being applied; the subject actually applies the mousse first, then the cream").
${JSON.stringify(opts.pegasus)}

## User intent
${JSON.stringify(opts.userPrompt)}
${opts.hasAvatars ? "\nAvatar reference image(s) are attached after the video — use them as the new character." : ""}

## Output
Respond with ONLY a single JSON object — no prose, no markdown fences — matching EXACTLY this JSON Schema:
${JSON.stringify(GENERATION_PLAN_JSON_SCHEMA)}

Speaker attribution & cast (IMPORTANT for multi-character videos):
- The Pegasus data labels characters and attributes dialogue PER SCENE. Reconcile these into ONE consistent cast for the whole video — the same person must keep the same label across all scenes.
- In each call's "prompt", make explicit WHO speaks each line (attributed dialogue) so the generation preserves correct lip-sync and turn-taking when more than one person is present. Never emit unattributed dialogue when multiple characters are in the scene.
- Pipeline A with an avatar: the avatar replaces EXACTLY ONE character — the primary subject, or the character implied by the user's intent. State in the prompt which named character becomes the avatar, that the avatar speaks that character's lines, and that all OTHER characters, their dialogue, and their appearance remain unchanged.

Rules:
- Write each call's "prompt" in that model's preferred format/syntax, respecting its char limit.
- Set audioHandling per the model's audio rule above.
- mediaSegments: for clips extracted from the original, give startTime/endTime (seconds) and a clear role; for the avatar image use source "avatar" (no timestamps).
- Use the source video as a reference (source "original").
- apiParameters.quality must be one of the model's allowed qualities; aspect_ratio "9:16".
- changesFromPegasus: after watching the video, list every action / object / product-use / detail you ADDED or CORRECTED that Pegasus missed, merged, or got wrong. If Pegasus was fully accurate, return an empty array.
- Be precise: the executor cannot make creative decisions.`;
}

function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1) t = t.slice(start, end + 1);
  return t;
}

export const plan = action({
  args: {
    sourceVideoId: v.id("sourceVideos"),
    pipeline: v.union(v.literal("A"), v.literal("B")),
    userPrompt: v.string(),
    modelIds: v.array(v.string()),
    avatarStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args): Promise<PlanResult> => {
    const apiKey = process.env.EVOLINK_API_KEY;
    if (!apiKey) throw new Error("EVOLINK_API_KEY not set on the Convex deployment");

    const modelIds = args.modelIds.filter((m): m is ModelId => m in MODELS);
    if (modelIds.length === 0) throw new Error("no valid target models selected");

    const video = (await ctx.runQuery(internal.sourceVideos.getInternal, {
      id: args.sourceVideoId,
    })) as Doc<"sourceVideos"> | null;
    if (!video) throw new Error("source video not found");
    if (!video.pegasusAnalysis) throw new Error("run Pegasus analysis before planning");

    // gather active prompt skills for the selected models
    const skills: { modelId: string; version: number; content: string }[] = [];
    for (const id of modelIds) {
      const s = (await ctx.runQuery(internal.promptSkills.getActiveForModelInternal, {
        modelId: id,
      })) as Doc<"promptSkills"> | null;
      if (s) skills.push({ modelId: id, version: s.version, content: s.content });
    }

    const instruction = buildInstruction({
      pipeline: args.pipeline,
      userPrompt: args.userPrompt,
      modelIds,
      skills,
      pegasus: video.pegasusAnalysis,
      hasAvatars: !!args.avatarStorageIds?.length,
    });

    // build multimodal message: instruction text + the video + any avatar images
    const content: unknown[] = [{ type: "text", text: instruction }, await videoPart(ctx, video.storageId)];
    for (const sid of args.avatarStorageIds ?? []) {
      const part = await imagePart(ctx, sid);
      if (part) content.push(part);
    }

    async function callGemini(messages: unknown[]) {
      const res = await fetch(EVOLINK_CHAT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: GEMINI_MODEL, messages }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Gemini call failed (${res.status}): ${text.slice(0, 400)}`);
      const json = JSON.parse(text);
      return json?.choices?.[0]?.message?.content ?? "";
    }

    // first attempt
    let raw = await callGemini([{ role: "user", content }]);
    let parsed = GenerationPlan.safeParse(JSON.parse(extractJson(raw) || "{}"));

    // one repair retry on invalid JSON / schema
    if (!parsed.success) {
      const repair = [
        { role: "user", content },
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `That did not match the schema. Errors: ${JSON.stringify(parsed.error.issues).slice(0, 1500)}. Reply with ONLY corrected JSON matching the schema.`,
        },
      ];
      raw = await callGemini(repair);
      parsed = GenerationPlan.safeParse(JSON.parse(extractJson(raw) || "{}"));
      if (!parsed.success) {
        throw new Error(`Gemini did not return a valid plan after repair: ${JSON.stringify(parsed.error.issues).slice(0, 500)}`);
      }
    }

    const planData = parsed.data;
    const totalCalls = planData.models.reduce((n, m) => n + m.calls.length, 0);

    const planId: Id<"geminiPlans"> = await ctx.runMutation(internal.geminiPlans.insertPlanInternal, {
      sourceVideoId: args.sourceVideoId,
      pipeline: args.pipeline,
      userPrompt: args.userPrompt,
      pegasusAnalysisUsed: video.pegasusAnalysis,
      promptSkillsUsed: skills.map((s) => ({ modelId: s.modelId, version: s.version })),
      geminiInstruction: instruction,
      fullPlan: planData,
      planRationale: planData.planRationale,
      modelsPlanned: planData.models.map((m) => m.model),
      totalCallsPlanned: totalCalls,
      avatarStorageIds: args.avatarStorageIds,
    });

    return { planId, totalCalls, models: planData.models.map((m) => ({ model: m.model, calls: m.calls.length })) };
  },
});

// Human-in-the-loop refinement: the reviewer sends feedback, Gemini re-watches the video and
// reworks the SAME plan in place. Conversational — each call builds on the current plan.
export const refinePlan = action({
  args: { planId: v.id("geminiPlans"), feedback: v.string() },
  handler: async (ctx, args): Promise<PlanResult> => {
    const apiKey = process.env.EVOLINK_API_KEY;
    if (!apiKey) throw new Error("EVOLINK_API_KEY not set on the Convex deployment");

    const plan = (await ctx.runQuery(internal.geminiPlans.getInternal, { id: args.planId })) as Doc<"geminiPlans"> | null;
    if (!plan) throw new Error("plan not found");
    const video = (await ctx.runQuery(internal.sourceVideos.getInternal, { id: plan.sourceVideoId })) as Doc<"sourceVideos"> | null;
    if (!video) throw new Error("source video not found");

    // the exact instruction the plan was built from (stored on every plan; rebuild for legacy plans)
    let instruction = plan.geminiInstruction;
    if (!instruction) {
      const skills: { modelId: string; version: number; content: string }[] = [];
      for (const id of plan.modelsPlanned) {
        const s = (await ctx.runQuery(internal.promptSkills.getActiveForModelInternal, { modelId: id })) as Doc<"promptSkills"> | null;
        if (s) skills.push({ modelId: id, version: s.version, content: s.content });
      }
      instruction = buildInstruction({ pipeline: plan.pipeline, userPrompt: plan.userPrompt, modelIds: plan.modelsPlanned.filter((m): m is ModelId => m in MODELS), skills, pegasus: plan.pegasusAnalysisUsed, hasAvatars: !!plan.avatarStorageIds?.length });
    }

    const content: unknown[] = [{ type: "text", text: instruction }, await videoPart(ctx, video.storageId)];
    for (const sid of plan.avatarStorageIds ?? []) { const part = await imagePart(ctx, sid); if (part) content.push(part); }

    const refineTurn = `A human reviewer has reviewed your plan and given feedback below. RE-WATCH the video to verify their points (they may have caught something you missed, or you may need to correct course). Keep everything that is already correct; change only what the feedback requires. Update "changesFromPegasus" to reflect the corrected understanding. Reply with ONLY the full corrected JSON plan matching the schema — no prose.\n\nREVIEWER FEEDBACK:\n${args.feedback}`;
    const messages = [
      { role: "user", content },
      { role: "assistant", content: JSON.stringify(plan.fullPlan) },
      { role: "user", content: refineTurn },
    ];

    const callGemini = async (msgs: unknown[]) => {
      const res = await fetch(EVOLINK_CHAT, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: GEMINI_MODEL, messages: msgs }) });
      const text = await res.text();
      if (!res.ok) throw new Error(`Gemini refine failed (${res.status}): ${text.slice(0, 400)}`);
      return JSON.parse(text)?.choices?.[0]?.message?.content ?? "";
    };

    let raw = await callGemini(messages);
    let parsed = GenerationPlan.safeParse(JSON.parse(extractJson(raw) || "{}"));
    if (!parsed.success) {
      raw = await callGemini([...messages, { role: "assistant", content: raw }, { role: "user", content: `That did not match the schema. Errors: ${JSON.stringify(parsed.error.issues).slice(0, 1200)}. Reply with ONLY corrected JSON.` }]);
      parsed = GenerationPlan.safeParse(JSON.parse(extractJson(raw) || "{}"));
      if (!parsed.success) throw new Error(`Gemini refine did not return a valid plan: ${JSON.stringify(parsed.error.issues).slice(0, 400)}`);
    }
    const planData = parsed.data;
    const totalCalls = planData.models.reduce((n, m) => n + m.calls.length, 0);
    await ctx.runMutation(internal.geminiPlans.updatePlanInternal, {
      id: args.planId,
      fullPlan: planData,
      planRationale: planData.planRationale,
      totalCallsPlanned: totalCalls,
      modelsPlanned: planData.models.map((m) => m.model),
    });
    return { planId: args.planId, totalCalls, models: planData.models.map((m) => ({ model: m.model, calls: m.calls.length })) };
  },
});
