import { v } from "convex/values";
import { query, internalMutation, internalQuery } from "./_generated/server";

export const getInternal = internalQuery({
  args: { id: v.id("geminiPlans") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});

export const insertPlanInternal = internalMutation({
  args: {
    sourceVideoId: v.id("sourceVideos"),
    pipeline: v.union(v.literal("A"), v.literal("B")),
    userPrompt: v.string(),
    pegasusAnalysisUsed: v.optional(v.any()),
    promptSkillsUsed: v.optional(v.any()),
    geminiInstruction: v.optional(v.string()),
    fullPlan: v.any(),
    planRationale: v.optional(v.string()),
    modelsPlanned: v.array(v.string()),
    totalCallsPlanned: v.number(),
    avatarStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const planId = await ctx.db.insert("geminiPlans", {
      ...args,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.sourceVideoId, { geminiGenerationPlan: args.fullPlan });
    return planId;
  },
});

// In-place update from the human-in-the-loop refine step.
export const updatePlanInternal = internalMutation({
  args: {
    id: v.id("geminiPlans"),
    fullPlan: v.any(),
    planRationale: v.optional(v.string()),
    totalCallsPlanned: v.number(),
    modelsPlanned: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      fullPlan: args.fullPlan,
      planRationale: args.planRationale,
      totalCallsPlanned: args.totalCallsPlanned,
      modelsPlanned: args.modelsPlanned,
    });
    const plan = await ctx.db.get(args.id);
    if (plan) await ctx.db.patch(plan.sourceVideoId, { geminiGenerationPlan: args.fullPlan });
  },
});

export const getForSourceVideo = query({
  args: { sourceVideoId: v.id("sourceVideos") },
  handler: async (ctx, args) => {
    const plans = await ctx.db
      .query("geminiPlans")
      .withIndex("by_sourceVideo", (q) => q.eq("sourceVideoId", args.sourceVideoId))
      .order("desc")
      .collect();
    return plans[0] ?? null;
  },
});

export const get = query({
  args: { id: v.id("geminiPlans") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});
