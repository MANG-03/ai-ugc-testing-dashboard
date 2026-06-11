import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Echoes data model (spec §6). JSON audit blobs use v.any() so we can store
// the full Pegasus output / Gemini plan verbatim without lossy reshaping.

export default defineSchema({
  // Collaborators — lightweight, password-gated identities (no real auth). A "workspace"
  // is just a display name; everything a person uploads is owned by their workspace.
  workspaces: defineTable({
    username: v.string(), // display name (as first entered)
    usernameLower: v.optional(v.string()), // normalized key for case-insensitive match
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_username", ["username"])
    .index("by_usernameLower", ["usernameLower"]),

  sourceVideos: defineTable({
    workspaceId: v.optional(v.id("workspaces")), // owner (null = legacy / original)
    fileName: v.string(),
    storageId: v.id("_storage"),
    uploadedAt: v.number(),
    duration: v.optional(v.number()), // seconds
    thumbnailId: v.optional(v.id("_storage")),
    // Pegasus TBM decomposition (the "what")
    pegasusStatus: v.optional(
      v.union(
        v.literal("idle"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    pegasusAnalysis: v.optional(v.any()), // the segment_definitions result, verbatim
    pegasusError: v.optional(v.string()),
    pegasusTaskId: v.optional(v.string()),
    // Gemini generation plan (the "how") — populated in a later phase
    geminiGenerationPlan: v.optional(v.any()),
  })
    .index("by_uploadedAt", ["uploadedAt"])
    .index("by_workspace", ["workspaceId"]),

  geminiPlans: defineTable({
    sourceVideoId: v.id("sourceVideos"),
    pipeline: v.union(v.literal("A"), v.literal("B")),
    userPrompt: v.string(),
    pegasusAnalysisUsed: v.optional(v.any()),
    promptSkillsUsed: v.optional(v.any()),
    geminiInstruction: v.optional(v.string()), // the full planning prompt sent to Gemini
    fullPlan: v.any(),
    planRationale: v.optional(v.string()),
    modelsPlanned: v.array(v.string()),
    totalCallsPlanned: v.number(),
    avatarStorageIds: v.optional(v.array(v.id("_storage"))), // Pipeline A avatar references
    createdAt: v.number(),
  }).index("by_sourceVideo", ["sourceVideoId"]),

  generations: defineTable({
    sourceVideoId: v.id("sourceVideos"),
    pipeline: v.union(v.literal("A"), v.literal("B")),
    model: v.string(), // "seedance-2.0-reference-to-video" | "kling-o3-video-edit"
    endpoint: v.optional(v.string()),
    userPrompt: v.string(),
    geminiPlanId: v.optional(v.id("geminiPlans")),
    geminiPlanCallIndex: v.optional(v.number()),
    promptSkillVersion: v.optional(v.number()),
    translatedPrompt: v.optional(v.string()),
    mediaReferencesSent: v.optional(
      v.array(
        v.object({
          type: v.union(v.literal("image"), v.literal("video"), v.literal("audio")),
          fileUrl: v.string(),
          role: v.string(),
        }),
      ),
    ),
    apiParameters: v.optional(v.any()),
    pegasusContext: v.optional(v.any()),
    sceneNumber: v.optional(v.number()),
    splitPointRationale: v.optional(v.string()),
    outputStorageId: v.optional(v.id("_storage")),
    outputStatus: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    costEstimate: v.optional(v.number()),
    generationTime: v.optional(v.number()),
    createdAt: v.number(),
    notes: v.optional(v.string()),
    rating: v.optional(v.number()),
  })
    .index("by_sourceVideo", ["sourceVideoId"])
    .index("by_status", ["outputStatus"])
    .index("by_plan", ["geminiPlanId"]),

  promptSkills: defineTable({
    modelId: v.string(),
    skillName: v.string(),
    content: v.string(),
    version: v.number(),
    isActive: v.boolean(),
    createdAt: v.number(),
  }).index("by_model", ["modelId"]),

  experiments: defineTable({
    name: v.string(),
    pipeline: v.union(v.literal("A"), v.literal("B")),
    sourceVideoId: v.id("sourceVideos"),
    generationIds: v.array(v.id("generations")),
    createdAt: v.number(),
    notes: v.optional(v.string()),
  }).index("by_sourceVideo", ["sourceVideoId"]),
});
