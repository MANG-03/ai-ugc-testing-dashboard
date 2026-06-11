import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";

// Tiles for a source video (newest first), with resolved output URLs.
export const listForSourceVideo = query({
  args: { sourceVideoId: v.id("sourceVideos") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("generations")
      .withIndex("by_sourceVideo", (q) => q.eq("sourceVideoId", args.sourceVideoId))
      .order("desc")
      .collect();
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        outputUrl: r.outputStorageId ? await ctx.storage.getUrl(r.outputStorageId) : null,
      })),
    );
  },
});

// All generations (newest first) with output URL + source filename — for the History view.
export const listAll = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("generations").order("desc").collect();
    const wsName = new Map((await ctx.db.query("workspaces").collect()).map((w) => [w._id, w.username]));
    const out = await Promise.all(
      rows.map(async (r) => {
        const sv = await ctx.db.get(r.sourceVideoId);
        const workspaceId = sv?.workspaceId ?? null;
        return {
          ...r,
          outputUrl: r.outputStorageId ? await ctx.storage.getUrl(r.outputStorageId) : null,
          sourceFileName: sv?.fileName ?? "—",
          workspaceId,
          ownerName: workspaceId ? wsName.get(workspaceId) ?? "—" : "Original",
        };
      }),
    );
    return args.workspaceId ? out.filter((r) => r.workspaceId === args.workspaceId) : out;
  },
});

// Stop a run: delete not-yet-started ("pending") generations so the Pipeline A chain
// has no next row to fire (and any already-scheduled call bails on the missing row).
export const cancelPending = mutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("generations")
      .withIndex("by_status", (q) => q.eq("outputStatus", "pending"))
      .collect();
    for (const g of pending) await ctx.db.delete(g._id);
    return { cancelled: pending.length };
  },
});

// Delete pending calls at/after a given call index for a plan (race-free single-scene firing,
// or partial cancel). Leaves earlier/in-progress calls untouched.
export const cancelPlanCallsFrom = mutation({
  args: { geminiPlanId: v.id("geminiPlans"), fromCallIndex: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("generations")
      .withIndex("by_plan", (q) => q.eq("geminiPlanId", args.geminiPlanId))
      .collect();
    let deleted = 0;
    for (const g of rows) {
      if ((g.geminiPlanCallIndex ?? 0) >= args.fromCallIndex && g.outputStatus === "pending") {
        await ctx.db.delete(g._id);
        deleted++;
      }
    }
    return { deleted };
  },
});

// Keep only one call of a plan (delete the other pending ones) — used to fire a single scene.
export const keepOnlyCall = mutation({
  args: { geminiPlanId: v.id("geminiPlans"), keepCallIndex: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("generations")
      .withIndex("by_plan", (q) => q.eq("geminiPlanId", args.geminiPlanId))
      .collect();
    let kept: string | null = null;
    for (const g of rows) {
      if (g.geminiPlanCallIndex === args.keepCallIndex) kept = g._id;
      else if (g.outputStatus === "pending") await ctx.db.delete(g._id);
    }
    return { kept };
  },
});

export const setRating = mutation({
  args: { id: v.id("generations"), rating: v.number() },
  handler: async (ctx, args) => ctx.db.patch(args.id, { rating: args.rating }),
});

export const setNotes = mutation({
  args: { id: v.id("generations"), notes: v.string() },
  handler: async (ctx, args) => ctx.db.patch(args.id, { notes: args.notes }),
});

// ── internal (used by the executor) ──────────────────────────

export const createInternal = internalMutation({
  args: {
    sourceVideoId: v.id("sourceVideos"),
    pipeline: v.union(v.literal("A"), v.literal("B")),
    model: v.string(),
    userPrompt: v.string(),
    geminiPlanId: v.id("geminiPlans"),
    geminiPlanCallIndex: v.number(),
    translatedPrompt: v.string(),
    mediaReferencesSent: v.optional(
      v.array(v.object({ type: v.union(v.literal("image"), v.literal("video"), v.literal("audio")), fileUrl: v.string(), role: v.string() })),
    ),
    apiParameters: v.any(),
    sceneNumber: v.optional(v.number()),
    splitPointRationale: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    ctx.db.insert("generations", { ...args, outputStatus: "pending", createdAt: Date.now() }),
});

export const getInternal = internalQuery({
  args: { id: v.id("generations") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});

// Find the generation row for a specific plan call (used for Pipeline A continuity chaining).
export const findCallInternal = internalQuery({
  args: { geminiPlanId: v.id("geminiPlans"), model: v.string(), callIndex: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("generations")
      .withIndex("by_plan", (q) => q.eq("geminiPlanId", args.geminiPlanId))
      .collect();
    return rows.find((r) => r.model === args.model && r.geminiPlanCallIndex === args.callIndex) ?? null;
  },
});

export const updateInternal = internalMutation({
  args: {
    id: v.id("generations"),
    outputStatus: v.optional(v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"))),
    outputStorageId: v.optional(v.id("_storage")),
    costEstimate: v.optional(v.number()),
    generationTime: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    await ctx.db.patch(id, patch);
  },
});
