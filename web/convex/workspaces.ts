import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Shared access password — gate to keep the link semi-private. Overridable via the
// ACCESS_PASSWORD Convex env var; defaults to "UGC".
const PASSWORD = () => process.env.ACCESS_PASSWORD ?? "UGC";

// Sign in with a display name + the shared password. Creates the workspace on first use
// (so identity survives a browser-cache wipe — it lives in Convex, not localStorage).
export const signIn = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const username = args.username.trim();
    if (!username) throw new Error("Please enter a name.");
    if (args.password !== PASSWORD()) throw new Error("Wrong password.");

    const now = Date.now();
    const lower = username.toLowerCase();
    // case-insensitive match so "armaan" and "Armaan" are the same workspace
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_usernameLower", (q) => q.eq("usernameLower", lower))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
      return { id: existing._id, username: existing.username };
    }
    const id = await ctx.db.insert("workspaces", { username, usernameLower: lower, createdAt: now, lastSeenAt: now });
    return { id, username };
  },
});

// All collaborators (for the People nav), newest-active first.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const ws = await ctx.db.query("workspaces").collect();
    return ws
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((w) => ({ id: w._id, username: w.username, createdAt: w.createdAt, lastSeenAt: w.lastSeenAt }));
  },
});

export const get = query({
  args: { id: v.id("workspaces") },
  handler: async (ctx, args) => {
    const w = await ctx.db.get(args.id);
    return w ? { id: w._id, username: w.username } : null;
  },
});

export const remove = mutation({
  args: { id: v.id("workspaces") },
  handler: async (ctx, args) => { await ctx.db.delete(args.id); },
});

// Backfill usernameLower on existing workspaces (one-time, for case-insensitive sign-in).
export const backfillLower = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("workspaces").collect();
    let n = 0;
    for (const w of all) {
      if (!w.usernameLower) { await ctx.db.patch(w._id, { usernameLower: w.username.toLowerCase() }); n++; }
    }
    return n;
  },
});

// One-time backfill: assign every legacy (un-owned) source video to a workspace.
export const claimUnowned = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("sourceVideos").collect();
    let n = 0;
    for (const sv of all) {
      if (!sv.workspaceId) { await ctx.db.patch(sv._id, { workspaceId: args.workspaceId }); n++; }
    }
    return n;
  },
});
