"use client";

import { useState, useMemo } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { Wand2, Loader2, ChevronDown, ChevronRight, Film, AudioLines, Play, Star, Plus, X, Sparkles, MessageSquare } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { MODELS, ALL_MODEL_IDS, type ModelId } from "../../../convex/models";
import { useWorkspace } from "./WorkspaceProvider";

export function GenerationStudio() {
  const { me } = useWorkspace();
  const videos = useQuery(api.sourceVideos.list, { workspaceId: me.id });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => videos?.find((v) => v._id === selectedId) ?? videos?.[0] ?? null,
    [videos, selectedId],
  );

  if (videos === undefined) return <p className="text-sm text-ink-400">Loading…</p>;
  if (videos.length === 0)
    return (
      <p className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center text-sm text-ink-400">
        Upload and analyze a video first in the Upload &amp; Analyze tab.
      </p>
    );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-ink-700">Source</label>
        <div className="relative">
          <select
            value={selected?._id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            className="appearance-none rounded-lg border border-line bg-surface py-2 pl-3 pr-9 text-sm font-medium shadow-sm focus:border-brand-400 focus:outline-none"
          >
            {videos.map((v) => (
              <option key={v._id} value={v._id}>
                {v.fileName} {v.pegasusStatus === "completed" ? "✓" : `· ${v.pegasusStatus}`}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
        </div>
      </div>

      {selected && <Studio key={selected._id} video={selected} />}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Studio({ video }: { video: any }) {
  const planAction = useAction(api.gemini.plan);
  const generateUploadUrl = useMutation(api.sourceVideos.generateUploadUrl);
  const existingPlan = useQuery(api.geminiPlans.getForSourceVideo, {
    sourceVideoId: video._id as Id<"sourceVideos">,
  });

  const [pipeline, setPipeline] = useState<"A" | "B">("B");
  const [models, setModels] = useState<ModelId[]>([...ALL_MODEL_IDS]);
  const [prompt, setPrompt] = useState("");
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatars, setAvatars] = useState<{ id: Id<"_storage">; preview: string }[]>([]);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const pegasusReady = video.pegasusStatus === "completed";
  const scenes: unknown[] = video.pegasusAnalysis?.scenes ?? [];

  const toggleModel = (id: ModelId) =>
    setModels((cur) => (cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id]));

  const uploadAvatars = async (files: FileList | null) => {
    if (!files?.length) return;
    setAvatarBusy(true);
    try {
      for (const file of Array.from(files)) {
        const postUrl = await generateUploadUrl();
        const res = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        const { storageId } = await res.json();
        setAvatars((cur) => [...cur, { id: storageId as Id<"_storage">, preview: URL.createObjectURL(file) }]);
      }
    } finally {
      setAvatarBusy(false);
    }
  };

  const send = async () => {
    setError(null);
    if (!prompt.trim()) return setError("Enter an edit / regeneration instruction.");
    if (models.length === 0) return setError("Select at least one model.");
    setPlanning(true);
    try {
      await planAction({
        sourceVideoId: video._id as Id<"sourceVideos">,
        pipeline,
        userPrompt: prompt.trim(),
        modelIds: models,
        avatarStorageIds: avatars.length ? avatars.map((a) => a.id) : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
      {/* Left: source + pegasus summary */}
      <aside className="space-y-3">
        {video.fileUrl && <video src={video.fileUrl} controls className="w-full rounded-xl bg-black" />}
        <div className="rounded-xl border border-line bg-surface p-3.5 text-sm shadow-sm">
          <p className="truncate font-semibold text-ink-900">{video.fileName}</p>
          <p className="mt-0.5 text-xs text-ink-400">
            {video.duration ? `${video.duration.toFixed(1)}s` : "duration unknown"}
          </p>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="text-ink-500">Pegasus</span>
            {pegasusReady ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                {scenes.length} scene{scenes.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                {video.pegasusStatus} — analyze first
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* Center: composer + plan */}
      <div className="space-y-5">
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg bg-canvas p-0.5 text-sm">
              {(["B", "A"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPipeline(p)}
                  className={
                    "rounded-md px-3 py-1.5 font-medium transition " +
                    (pipeline === p ? "bg-surface text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-700")
                  }
                >
                  {p === "B" ? "V2V Edit" : "Full Regen"}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              {ALL_MODEL_IDS.map((id) => (
                <button
                  key={id}
                  onClick={() => toggleModel(id)}
                  className={
                    "rounded-full border px-3 py-1.5 text-sm font-medium transition " +
                    (models.includes(id)
                      ? "border-brand-300 bg-brand-50 text-brand-700"
                      : "border-line text-ink-500 hover:bg-canvas")
                  }
                >
                  {MODELS[id].label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-ink-400">Avatar refs</span>
            {avatars.map((a, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.preview} alt="" className="size-12 rounded-lg object-cover ring-1 ring-line" />
                <button
                  onClick={() => setAvatars((cur) => cur.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-ink-900 p-0.5 text-white"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            <label className="flex size-12 cursor-pointer items-center justify-center rounded-lg border border-dashed border-line text-ink-400 transition hover:border-brand-300 hover:text-brand-600">
              {avatarBusy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => uploadAvatars(e.target.files)} />
            </label>
          </div>

          {pipeline === "A" && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Pipeline A generates one clip per scene and chains continuity (last frame → next scene). Add avatar
              reference(s) above for the new character.
            </p>
          )}

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              pipeline === "B"
                ? "Describe the edit — e.g. Change the subject's black t-shirt to a bright red hoodie"
                : "Describe the regeneration — e.g. Recreate this with a new avatar, same script and pacing"
            }
            rows={3}
            className="mt-3 w-full resize-none rounded-xl border border-line bg-canvas/50 p-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-400 focus:bg-surface focus:outline-none"
          />

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-400">{prompt.length} chars</span>
            <div className="flex items-center gap-3">
              {error && <span className="text-sm text-red-600">{error}</span>}
              {!pegasusReady && <span className="text-xs text-amber-600">Run Pegasus first</span>}
              <button
                onClick={send}
                disabled={planning || !pegasusReady}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition hover:bg-brand-700 disabled:opacity-40"
              >
                {planning ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                {planning ? "Planning…" : "Plan with Gemini"}
              </button>
            </div>
          </div>
        </div>

        {existingPlan && <PlanView plan={existingPlan} />}
        <ResultTiles sourceVideoId={video._id as Id<"sourceVideos">} />
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PlanView({ plan }: { plan: any }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const full = plan.fullPlan as any;
  const runPlan = useAction(api.generate.runPlan);
  const refinePlan = useAction(api.gemini.refinePlan);
  const [running, setRunning] = useState(false);
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const changes: string[] = full.changesFromPegasus ?? [];

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await runPlan({ planId: plan._id as Id<"geminiPlans"> });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const refine = async () => {
    if (!feedback.trim()) return;
    setRefining(true);
    setError(null);
    try {
      await refinePlan({ planId: plan._id as Id<"geminiPlans">, feedback: feedback.trim() });
      setFeedback("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefining(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink-700">
          Review plan{" "}
          <span className="font-normal text-ink-400">
            · pipeline {full.pipeline} · {plan.totalCallsPlanned} call{plan.totalCallsPlanned === 1 ? "" : "s"}
          </span>
        </h2>
        <button
          onClick={run}
          disabled={running || refining}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition hover:bg-brand-700 disabled:opacity-40"
        >
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {running ? "Dispatching…" : "Submit & Run"}
        </button>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {changes.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
            <Sparkles className="size-3.5" /> Gemini corrected {changes.length} thing{changes.length === 1 ? "" : "s"} Pegasus missed
          </div>
          <ul className="space-y-1 text-sm text-ink-700">
            {changes.map((c, i) => (
              <li key={i} className="flex gap-1.5"><span className="text-amber-600">•</span><span>{c}</span></li>
            ))}
          </ul>
        </div>
      )}
      {full.planRationale && (
        <p className="rounded-xl border border-line bg-brand-50/50 p-3 text-sm leading-relaxed text-ink-700">
          {full.planRationale}
        </p>
      )}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {full.models.map((m: any) => (
        <div key={m.model} className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <Film className="size-4 text-brand-600" />
            <span className="text-sm font-semibold text-ink-900">
              {MODELS[m.model as ModelId]?.label ?? m.model}
            </span>
            <span className="text-xs text-ink-400">
              {m.calls.length} call{m.calls.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-3 p-4">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {m.calls.map((c: any) => (
              <div key={c.callIndex} className="rounded-xl border border-line bg-canvas/40 p-3.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-md bg-brand-600 px-1.5 py-0.5 font-mono font-semibold text-white">
                    call {c.callIndex}
                  </span>
                  {c.sceneNumber != null && <Chip>scene {c.sceneNumber}</Chip>}
                  <Chip>{c.apiParameters.quality}</Chip>
                  <span className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 font-medium text-ink-500 ring-1 ring-line">
                    <AudioLines className="size-3" /> {c.audioHandling}
                  </span>
                  {c.continuityFromCallIndex != null && <Chip>↩ from call {c.continuityFromCallIndex}</Chip>}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-ink-900">{c.prompt}</p>
                {c.mediaSegments?.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-ink-500">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {c.mediaSegments.map((s: any, i: number) => (
                      <li key={i}>
                        • {s.type} ({s.source})
                        {s.startTime != null && s.endTime != null ? ` ${s.startTime}–${s.endTime}s` : ""} — {s.role}
                      </li>
                    ))}
                  </ul>
                )}
                {c.splitRationale && <p className="mt-1 text-xs italic text-ink-400">{c.splitRationale}</p>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Human-in-the-loop gate: chat-refine before running */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink-700"><MessageSquare className="size-4 text-brand-600" /> Refine with Gemini</div>
        <p className="mb-2.5 text-xs text-ink-400">Caught something off? Tell Gemini — e.g. &ldquo;he applies the mousse first, then the cream — re-watch and fix the order.&rdquo; It re-watches the video and reworks the plan above. Hit <span className="font-medium text-ink-500">Submit &amp; Run</span> when it&rsquo;s right.</p>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
          placeholder="Your feedback for Gemini…"
          className="w-full resize-none rounded-xl border border-line bg-canvas/50 p-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-400 focus:bg-surface focus:outline-none"
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={refine}
            disabled={refining || running || !feedback.trim()}
            className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-1.5 text-sm font-medium text-ink-700 transition hover:bg-canvas disabled:opacity-40"
          >
            {refining ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
            {refining ? "Re-watching & reworking…" : "Ask Gemini to revise"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-surface px-2 py-0.5 font-medium text-ink-500 ring-1 ring-line">{children}</span>
  );
}

function ResultTiles({ sourceVideoId }: { sourceVideoId: Id<"sourceVideos"> }) {
  const tiles = useQuery(api.generations.listForSourceVideo, { sourceVideoId });
  if (!tiles || tiles.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-ink-700">
        Results <span className="font-normal text-ink-400">· {tiles.length}</span>
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {tiles.map((t) => (
          <TileCard key={t._id} tile={t} />
        ))}
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TileCard({ tile }: { tile: any }) {
  const setRating = useMutation(api.generations.setRating);
  const [expanded, setExpanded] = useState(false);
  const status: string = tile.outputStatus;
  const modelLabel = MODELS[tile.model as ModelId]?.label ?? tile.model;

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <span className="rounded-md bg-brand-50 px-2 py-0.5 font-medium text-brand-700">{modelLabel}</span>
        <span className="rounded-md bg-canvas px-1.5 py-0.5 font-medium text-ink-500">{tile.pipeline}</span>
        {tile.sceneNumber != null && <span className="text-ink-400">scene {tile.sceneNumber}</span>}
        <span className="text-ink-400">call {tile.geminiPlanCallIndex}</span>
        <TileStatus status={status} className="ml-auto" />
      </div>

      <div className="bg-black/[0.03]">
        {tile.outputUrl ? (
          <video src={tile.outputUrl} controls className="mx-auto max-h-80 w-auto" />
        ) : (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-ink-400">
            {status === "failed" ? (
              <p className="px-4 text-center text-sm text-red-600">{tile.notes ?? "Generation failed"}</p>
            ) : (
              <>
                <Loader2 className="size-6 animate-spin" />
                <p className="text-sm">{status === "pending" ? "Queued…" : "Generating… (a few minutes)"}</p>
              </>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between text-xs text-ink-400">
          <span>
            {tile.costEstimate != null ? `${tile.costEstimate} credits` : "—"}
            {tile.generationTime != null ? ` · ${Math.round(tile.generationTime)}s` : ""}
          </span>
          <StarRating value={tile.rating ?? 0} onChange={(r) => setRating({ id: tile._id, rating: r })} />
        </div>
        {tile.notes && status !== "failed" && <p className="text-xs text-amber-600">{tile.notes}</p>}

        <button
          onClick={() => setExpanded((x) => !x)}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Audit trail
        </button>

        {expanded && (
          <dl className="space-y-2 rounded-lg bg-canvas/60 p-3 text-xs">
            <Field label="User prompt" value={tile.userPrompt} />
            <Field label="Translated prompt" value={tile.translatedPrompt} />
            {tile.splitPointRationale && <Field label="Split rationale" value={tile.splitPointRationale} />}
            <div>
              <dt className="font-medium text-ink-400">API parameters</dt>
              <dd>
                <pre className="mt-0.5 overflow-x-auto rounded bg-surface p-2 font-mono text-[11px] text-ink-700 ring-1 ring-line">
                  {JSON.stringify(tile.apiParameters, null, 2)}
                </pre>
              </dd>
            </div>
            {tile.mediaReferencesSent?.length > 0 && (
              <div>
                <dt className="font-medium text-ink-400">Media references sent</dt>
                <dd className="mt-0.5 space-y-0.5 text-ink-700">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {tile.mediaReferencesSent.map((m: any, i: number) => (
                    <div key={i}>• {m.type} · {m.fileUrl} — {m.role}</div>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="font-medium text-ink-400">{label}</dt>
      <dd className="text-ink-700">{value}</dd>
    </div>
  );
}

function TileStatus({ status, className = "" }: { status: string; className?: string }) {
  const map: Record<string, string> = {
    pending: "bg-canvas text-ink-500",
    processing: "bg-amber-50 text-amber-700",
    completed: "bg-emerald-50 text-emerald-700",
    failed: "bg-red-50 text-red-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 font-medium ${map[status] ?? map.pending} ${className}`}>{status}</span>
  );
}

function StarRating({ value, onChange }: { value: number; onChange: (r: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} onClick={() => onChange(n)} className="text-ink-400 transition hover:scale-110">
          <Star className={"size-3.5 " + (n <= value ? "fill-brand-500 text-brand-500" : "text-ink-400")} />
        </button>
      ))}
    </div>
  );
}
