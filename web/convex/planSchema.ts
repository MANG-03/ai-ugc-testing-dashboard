import { z } from "zod";

// The structured generation plan Gemini must return. The executor runs this mechanically,
// so it has to be precise: exact prompts, exact media segments (timestamps), exact params.

export const MediaSegment = z.object({
  type: z.enum(["video", "audio", "image"]),
  // where the media comes from
  source: z.enum(["original", "avatar", "previous_generation"]),
  // for clips extracted from the original by timestamp (omit for whole-asset refs like avatar images)
  startTime: z.number().nullable().optional(),
  endTime: z.number().nullable().optional(),
  role: z.string(), // human-readable purpose, e.g. "composition/motion reference", "lip-sync audio"
});

export const PlannedCall = z.object({
  callIndex: z.number().int(), // 1-based, per model
  sceneNumber: z.number().int().nullable().optional(), // Pipeline A
  prompt: z.string(), // model-specific translated prompt
  mediaSegments: z.array(MediaSegment),
  apiParameters: z.object({
    quality: z.string(),
    duration: z.number().nullable().optional(),
    aspect_ratio: z.string(),
    generate_audio: z.boolean().nullable().optional(), // Seedance
    keep_audio: z.boolean().nullable().optional(), // Kling
  }),
  audioHandling: z.enum(["native_keep_audio", "ffmpeg_remux", "generated", "none"]),
  continuityFromCallIndex: z.number().int().nullable().optional(),
  splitRationale: z.string().nullable().optional(),
});

export const ModelPlan = z.object({
  model: z.enum(["seedance-2.0-reference-to-video", "kling-o3-video-edit"]),
  calls: z.array(PlannedCall).min(1),
});

export const GenerationPlan = z.object({
  pipeline: z.enum(["A", "B"]),
  models: z.array(ModelPlan).min(1),
  planRationale: z.string(),
  // Every correction/addition Gemini made relative to Pegasus's analysis after watching the
  // video itself (Pegasus can miss fine actions). Each item: what Pegasus said vs what actually happens.
  changesFromPegasus: z.array(z.string()).optional().default([]),
});

export type GenerationPlanT = z.infer<typeof GenerationPlan>;

// JSON Schema handed to Gemini via response_format (kept in sync with the zod schema above).
export const GENERATION_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pipeline", "models", "planRationale", "changesFromPegasus"],
  properties: {
    pipeline: { type: "string", enum: ["A", "B"] },
    planRationale: { type: "string" },
    changesFromPegasus: { type: "array", items: { type: "string" } },
    models: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["model", "calls"],
        properties: {
          model: { type: "string", enum: ["seedance-2.0-reference-to-video", "kling-o3-video-edit"] },
          calls: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["callIndex", "prompt", "mediaSegments", "apiParameters", "audioHandling"],
              properties: {
                callIndex: { type: "integer" },
                sceneNumber: { type: ["integer", "null"] },
                prompt: { type: "string" },
                mediaSegments: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["type", "source", "role"],
                    properties: {
                      type: { type: "string", enum: ["video", "audio", "image"] },
                      source: { type: "string", enum: ["original", "avatar", "previous_generation"] },
                      startTime: { type: ["number", "null"] },
                      endTime: { type: ["number", "null"] },
                      role: { type: "string" },
                    },
                  },
                },
                apiParameters: {
                  type: "object",
                  additionalProperties: false,
                  required: ["quality", "aspect_ratio"],
                  properties: {
                    quality: { type: "string" },
                    duration: { type: ["number", "null"] },
                    aspect_ratio: { type: "string" },
                    generate_audio: { type: ["boolean", "null"] },
                    keep_audio: { type: ["boolean", "null"] },
                  },
                },
                audioHandling: { type: "string", enum: ["native_keep_audio", "ffmpeg_remux", "generated", "none"] },
                continuityFromCallIndex: { type: ["integer", "null"] },
                splitRationale: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
} as const;
