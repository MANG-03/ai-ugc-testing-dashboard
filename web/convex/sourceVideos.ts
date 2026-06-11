import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";

// ── Upload flow ────────────────────────────────────────────────
// 1. client calls generateUploadUrl → POSTs bytes → gets storageId
// 2. client calls createSourceVideo with the storageId

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const createSourceVideo = mutation({
  args: {
    fileName: v.string(),
    storageId: v.id("_storage"),
    duration: v.optional(v.number()),
    workspaceId: v.optional(v.id("workspaces")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("sourceVideos", {
      workspaceId: args.workspaceId,
      fileName: args.fileName,
      storageId: args.storageId,
      duration: args.duration,
      uploadedAt: Date.now(),
      pegasusStatus: "idle",
    });
  },
});

// ── Reads (with resolved storage URLs for the UI) ──────────────

export const list = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    let videos = await ctx.db
      .query("sourceVideos")
      .withIndex("by_uploadedAt")
      .order("desc")
      .collect();
    if (args.workspaceId) videos = videos.filter((vid) => vid.workspaceId === args.workspaceId);
    return Promise.all(
      videos.map(async (v) => ({
        ...v,
        fileUrl: await ctx.storage.getUrl(v.storageId),
        thumbnailUrl: v.thumbnailId ? await ctx.storage.getUrl(v.thumbnailId) : null,
      })),
    );
  },
});

export const get = query({
  args: { id: v.id("sourceVideos") },
  handler: async (ctx, args) => {
    const video = await ctx.db.get(args.id);
    if (!video) return null;
    return {
      ...video,
      fileUrl: await ctx.storage.getUrl(video.storageId),
      thumbnailUrl: video.thumbnailId
        ? await ctx.storage.getUrl(video.thumbnailId)
        : null,
    };
  },
});

// ── Internal helpers for the Pegasus action ────────────────────

// Human-in-the-loop correction: overwrite the Pegasus scenes (e.g. fix a misread
// on-screen word) BEFORE the analysis is fed to Gemini planning. Becomes source of truth.
export const updatePegasusScenes = mutation({
  args: { id: v.id("sourceVideos"), scenes: v.array(v.any()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("source video not found");
    const existing = (doc.pegasusAnalysis as Record<string, unknown> | undefined) ?? {};
    await ctx.db.patch(args.id, {
      pegasusAnalysis: { ...existing, scenes: args.scenes, editedAt: Date.now() },
    });
  },
});

// DEV ONLY — inject a Pegasus analysis without calling Twelve Labs, so the Gemini
// planner can be tested on a local deployment (where real Pegasus can't fetch localhost URLs).
export const devSetPegasus = mutation({
  args: { id: v.id("sourceVideos"), analysis: v.any() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { pegasusStatus: "completed", pegasusAnalysis: args.analysis });
  },
});

export const getInternal = internalQuery({
  args: { id: v.id("sourceVideos") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});

export const getStorageUrl = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => ctx.storage.getUrl(args.storageId),
});

export const setPegasusStatus = internalMutation({
  args: {
    id: v.id("sourceVideos"),
    status: v.union(
      v.literal("idle"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    taskId: v.optional(v.string()),
    analysis: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { pegasusStatus: args.status };
    if (args.taskId !== undefined) patch.pegasusTaskId = args.taskId;
    if (args.analysis !== undefined) patch.pegasusAnalysis = args.analysis;
    if (args.error !== undefined) patch.pegasusError = args.error;
    await ctx.db.patch(args.id, patch);
  },
});
