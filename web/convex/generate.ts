import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

// Executor — turns a stored Gemini plan into real generation calls (EvoLink), confirmed by Phase 0.
//  Pipeline B: one call per model, fired in parallel.
//  Pipeline A: one call per scene, chained sequentially per model (continuity via last-frame),
//              models run in parallel. Per-scene references (clip + avatar + prev-frame) are realized
//              from the plan's mediaSegments using the /api/ffmpeg route.
// NOTE: EvoLink fetches media by URL → needs a CLOUD Convex deployment (public getUrl()).
//       Set FFMPEG_URL (Convex env) to the deployed /api/ffmpeg for clips / last-frame / Seedance re-mux.

const EVOLINK = "https://api.evolink.ai/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findVideoUrl(obj: any): string | null {
  let found: string | null = null;
  const re = /^https?:\/\/[^\s"']+\.(mp4|mov|webm)(\?|$)/i;
  JSON.stringify(obj, (k, val) => {
    if (!found && typeof val === "string" && re.test(val)) found = val;
    return val;
  });
  return found;
}

export const runPlan = action({
  args: { planId: v.id("geminiPlans") },
  handler: async (ctx, args): Promise<{ created: number }> => {
    const plan = (await ctx.runQuery(internal.geminiPlans.getInternal, {
      id: args.planId,
    })) as Doc<"geminiPlans"> | null;
    if (!plan) throw new Error("plan not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const full = plan.fullPlan as any;
    const isPipelineA = full.pipeline === "A";

    let created = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of full.models) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = [...m.calls].sort((a: any, b: any) => a.callIndex - b.callIndex);
      let firstGenId: Id<"generations"> | null = null;
      for (const c of calls) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mediaRefs = (c.mediaSegments ?? []).map((s: any) => ({
          type: s.type as "image" | "video" | "audio",
          fileUrl: s.source + (s.startTime != null && s.endTime != null ? ` ${s.startTime}-${s.endTime}s` : ""),
          role: s.role,
        }));
        const genId: Id<"generations"> = await ctx.runMutation(internal.generations.createInternal, {
          sourceVideoId: plan.sourceVideoId,
          pipeline: full.pipeline,
          model: m.model,
          userPrompt: plan.userPrompt,
          geminiPlanId: args.planId,
          geminiPlanCallIndex: c.callIndex,
          translatedPrompt: c.prompt,
          mediaReferencesSent: mediaRefs,
          apiParameters: { ...c.apiParameters, audioHandling: c.audioHandling },
          sceneNumber: c.sceneNumber ?? undefined,
          splitPointRationale: c.splitRationale ?? undefined,
        });
        if (firstGenId === null) firstGenId = genId;
        // Pipeline B: fire every call now. Pipeline A: fire only the first; the rest chain on completion.
        if (!isPipelineA) await ctx.scheduler.runAfter(0, internal.generate.executeCall, { generationId: genId });
        created++;
      }
      if (isPipelineA && firstGenId) await ctx.scheduler.runAfter(0, internal.generate.executeCall, { generationId: firstGenId });
    }
    return { created };
  },
});

// Fire a single existing generation row (e.g. "re-run this tile", or fire one scene for testing).
export const fireGeneration = action({
  args: { generationId: v.id("generations") },
  handler: async (ctx, args): Promise<void> => {
    await ctx.scheduler.runAfter(0, internal.generate.executeCall, { generationId: args.generationId });
  },
});

export const executeCall = internalAction({
  args: { generationId: v.id("generations"), continuityFrameStorageId: v.optional(v.id("_storage")) },
  handler: async (ctx, args): Promise<void> => {
    const apiKey = process.env.EVOLINK_API_KEY;
    const ffmpegUrl = process.env.FFMPEG_URL;
    const gen = (await ctx.runQuery(internal.generations.getInternal, {
      id: args.generationId,
    })) as Doc<"generations"> | null;
    if (!gen) return;

    const fail = (msg: string) =>
      ctx.runMutation(internal.generations.updateInternal, {
        id: args.generationId,
        outputStatus: "failed",
        notes: `⚠ ${msg}`.slice(0, 500),
      });

    // helpers
    const ffmpeg = async (op: string, params: Record<string, unknown>): Promise<Blob> => {
      if (!ffmpegUrl) throw new Error("FFMPEG_URL not set on the Convex deployment");
      const res = await fetch(ffmpegUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, ...params }),
      });
      if (!res.ok) throw new Error(`ffmpeg ${op} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return res.blob();
    };
    const storeUrl = async (blob: Blob): Promise<string> => {
      const sid = await ctx.storage.store(blob);
      const url = await ctx.storage.getUrl(sid);
      if (!url) throw new Error("failed to resolve stored URL");
      return url;
    };

    try {
      if (!apiKey) throw new Error("EVOLINK_API_KEY not set on the Convex deployment");
      await ctx.runMutation(internal.generations.updateInternal, { id: args.generationId, outputStatus: "processing" });

      // plan + this call
      const plan = (await ctx.runQuery(internal.geminiPlans.getInternal, {
        id: gen.geminiPlanId!,
      })) as Doc<"geminiPlans"> | null;
      if (!plan) throw new Error("plan missing");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const full = plan.fullPlan as any;
      const isA = full.pipeline === "A";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const modelPlan = full.models.find((m: any) => m.model === gen.model);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call = modelPlan?.calls.find((c: any) => c.callIndex === gen.geminiPlanCallIndex);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segments: any[] = call?.mediaSegments ?? [];

      const source = (await ctx.runQuery(internal.sourceVideos.getInternal, {
        id: gen.sourceVideoId,
      })) as Doc<"sourceVideos"> | null;
      if (!source) throw new Error("source video missing");
      const sourceUrl = await ctx.storage.getUrl(source.storageId);
      if (!sourceUrl) throw new Error("could not resolve source video URL");

      const isKling = gen.model === "kling-o3-video-edit";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = gen.apiParameters as any;

      // --- realize references from the plan's media segments ---
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const origVid = segments.find((s) => s.source === "original" && s.type === "video");
      const hasScene = origVid?.startTime != null && origVid?.endTime != null;
      // Clamp the scene window to the model's max clip length (Seedance 15s, Kling 10s)
      const maxLen = isKling ? 10 : 15;
      const sceneStart = hasScene ? Number(origVid.startTime) : 0;
      const sceneEnd = hasScene ? Math.min(Number(origVid.endTime), sceneStart + maxLen) : 0;

      // video reference: per-scene clip for BOTH pipelines when the plan gave a scene window.
      // Pipeline A splits by Pegasus scene; Pipeline B also chunks long sources into ≤maxLen clips
      // (Gemini plans the ranges) — without this, Pipeline B sends the whole source and EvoLink
      // rejects anything over its 30s duration cap.
      let videoRefUrl = sourceUrl;
      let audioOverlayUrl = sourceUrl;
      if (hasScene && ffmpegUrl) {
        videoRefUrl = await storeUrl(await ffmpeg("clip", { videoUrl: sourceUrl, start: sceneStart, end: sceneEnd }));
        audioOverlayUrl = await storeUrl(await ffmpeg("clip", { videoUrl: sourceUrl, start: sceneStart, end: sceneEnd, audioOnly: true }));
      }

      // image references: avatars + (scene 2+) previous-generation last frame
      const imageUrls: string[] = [];
      for (const sid of plan.avatarStorageIds ?? []) {
        const u = await ctx.storage.getUrl(sid);
        if (u) imageUrls.push(u);
      }
      if (args.continuityFrameStorageId) {
        const u = await ctx.storage.getUrl(args.continuityFrameStorageId);
        if (u) imageUrls.push(u);
      }

      // --- build EvoLink body ---
      const body: Record<string, unknown> = {
        model: gen.model,
        prompt: gen.translatedPrompt,
        video_urls: [videoRefUrl],
        aspect_ratio: p.aspect_ratio ?? "9:16",
        quality: p.quality ?? (isKling ? "720p" : "480p"),
      };
      if (imageUrls.length) body.image_urls = imageUrls;
      // Seedance lip-sync: silent-output + re-mux drifts (its lips aren't built from the words).
      // Instead, for Pipeline A, pass the scene audio as a reference and let Seedance CO-GENERATE
      // synced audio (Higgsfield-style) so lips track the speech by construction.
      const seedanceAudioDriven = !isKling && isA && hasScene && !!ffmpegUrl;
      if (isKling) {
        body.keep_audio = p.keep_audio ?? true;
      } else {
        // EvoLink requires an INTEGER duration — round whatever the plan provided or the scene length.
        const rawDur = p.duration ?? (hasScene ? sceneEnd - sceneStart : 5);
        body.duration = Math.min(15, Math.max(4, Math.round(Number(rawDur))));
        if (seedanceAudioDriven) {
          // Co-generate audio + synced lips in one pass. The video reference clip retains the
          // original audio, and the prompt carries the attributed dialogue, so Seedance has what it
          // needs without a separate audio_urls file (EvoLink rejected the m4a as invalid).
          body.generate_audio = true;
        } else {
          body.generate_audio = false; // Pipeline B: silent → re-mux original audio
        }
      }

      // --- fire + poll ---
      const start = Date.now();
      const createRes = await fetch(`${EVOLINK}/videos/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const createText = await createRes.text();
      if (!createRes.ok) throw new Error(`create failed (${createRes.status}): ${createText.slice(0, 300)}`);
      const createdJson = JSON.parse(createText);
      const taskId: string = createdJson.id ?? createdJson.task_id ?? createdJson.taskId;
      if (!taskId) throw new Error(`no task id: ${createText.slice(0, 200)}`);
      const reservedCredits: number | undefined = createdJson.usage?.credits_reserved;

      const deadline = Date.now() + 9 * 60 * 1000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let finalJson: any = null;
      while (Date.now() < deadline) {
        await sleep(5000);
        const pollRes = await fetch(`${EVOLINK}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        const pollText = await pollRes.text();
        const poll = JSON.parse(pollText);
        const status = String(poll.status ?? "").toLowerCase();
        if (["completed", "succeeded", "success", "done"].includes(status)) { finalJson = poll; break; }
        if (["failed", "error", "cancelled"].includes(status)) throw new Error(`generation ${status}: ${pollText.slice(0, 300)}`);
      }
      if (!finalJson) throw new Error("generation timed out");

      const outUrl: string | null = finalJson.results?.[0] ?? findVideoUrl(finalJson);
      if (!outUrl) throw new Error("no output URL in response");
      const credits: number | undefined = finalJson.usage?.credits_used ?? reservedCredits;
      const generationTime = (Date.now() - start) / 1000;

      // --- audio handling + ingest ---
      let outputStorageId: Id<"_storage">;
      if (!seedanceAudioDriven && p.audioHandling === "ffmpeg_remux" && ffmpegUrl) {
        // Pipeline B Seedance: silent output → overlay the exact original audio.
        outputStorageId = await ctx.storage.store(await ffmpeg("remux", { sourceUrl: audioOverlayUrl, silentUrl: outUrl }));
      } else {
        // Kling (native audio) or Seedance audio-driven (output already has co-generated, synced audio).
        const dl = await fetch(outUrl);
        if (!dl.ok) throw new Error(`output download failed (${dl.status})`);
        outputStorageId = await ctx.storage.store(await dl.blob());
        if (!seedanceAudioDriven && p.audioHandling === "ffmpeg_remux" && !ffmpegUrl) {
          await ctx.runMutation(internal.generations.updateInternal, {
            id: args.generationId,
            notes: "⚠ silent output — set FFMPEG_URL to overlay original audio",
          });
        }
      }

      await ctx.runMutation(internal.generations.updateInternal, {
        id: args.generationId,
        outputStatus: "completed",
        outputStorageId,
        costEstimate: credits,
        generationTime,
      });

      // --- Pipeline A continuity: chain the next scene with this output's last frame ---
      if (isA) {
        const next = (await ctx.runQuery(internal.generations.findCallInternal, {
          geminiPlanId: gen.geminiPlanId!,
          model: gen.model,
          callIndex: gen.geminiPlanCallIndex! + 1,
        })) as Doc<"generations"> | null;
        if (next) {
          let frameStorageId: Id<"_storage"> | undefined;
          if (ffmpegUrl) {
            try {
              const outputUrl = await ctx.storage.getUrl(outputStorageId);
              if (outputUrl) frameStorageId = await ctx.storage.store(await ffmpeg("lastframe", { videoUrl: outputUrl }));
            } catch {
              /* continuity frame is best-effort */
            }
          }
          await ctx.scheduler.runAfter(0, internal.generate.executeCall, {
            generationId: next._id,
            continuityFrameStorageId: frameStorageId,
          });
        }
      }
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
    }
  },
});
