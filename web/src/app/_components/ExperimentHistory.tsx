"use client";

import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { Play, Pause, RotateCcw, GitCompare, Check, X, FileText, Paperclip, Star, Film, AudioLines, Image as ImageIcon, ExternalLink, Layers } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { MODELS, ALL_MODEL_IDS, type ModelId } from "../../../convex/models";

export function ExperimentHistory({ workspaceId, readOnly }: { workspaceId?: Id<"workspaces">; readOnly?: boolean }) {
  const all = useQuery(api.generations.listAll, workspaceId ? { workspaceId } : {});
  const [detail, setDetail] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<"all" | "A" | "B">("all");
  const [model, setModel] = useState<"all" | ModelId>("all");
  const [status, setStatus] = useState<"all" | "completed" | "processing" | "failed">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);

  const rows = useMemo(
    () =>
      (all ?? []).filter(
        (r) =>
          (pipeline === "all" || r.pipeline === pipeline) &&
          (model === "all" || r.model === model) &&
          (status === "all" || r.outputStatus === status),
      ),
    [all, pipeline, model, status],
  );

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 3 ? cur : [...cur, id]));

  const selectedRows = (all ?? []).filter((r) => selected.includes(r._id) && r.outputUrl);

  if (all === undefined) return <p className="text-sm text-ink-400">Loading…</p>;

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select label="Pipeline" value={pipeline} onChange={(v) => setPipeline(v as typeof pipeline)} options={[["all", "All"], ["B", "V2V Edit"], ["A", "Full Regen"]]} />
        <Select
          label="Model"
          value={model}
          onChange={(v) => setModel(v as typeof model)}
          options={[["all", "All models"], ...ALL_MODEL_IDS.map((id) => [id, MODELS[id].label] as [string, string])]}
        />
        <Select label="Status" value={status} onChange={(v) => setStatus(v as typeof status)} options={[["all", "All"], ["completed", "Completed"], ["processing", "Processing"], ["failed", "Failed"]]} />
        <span className="ml-auto text-xs text-ink-400">{rows.length} result{rows.length === 1 ? "" : "s"}</span>
        {selected.length >= 2 && (
          <button
            onClick={() => setComparing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700"
          >
            <GitCompare className="size-4" /> Compare {selected.length}
          </button>
        )}
      </div>

      {comparing && selectedRows.length >= 2 && (
        <ComparePanel rows={selectedRows} onClose={() => setComparing(false)} />
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center text-sm text-ink-400">
          {workspaceId ? "No generations in this workspace yet." : "No generations match these filters."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((r) => (
            <HistoryCard key={r._id} row={r} selected={selected.includes(r._id)} onToggle={() => toggle(r._id)} onOpen={() => setDetail(r._id)} />
          ))}
        </div>
      )}

      {detail && (() => {
        const r = (all ?? []).find((x) => x._id === detail);
        return r ? <DetailModal row={r} readOnly={!!readOnly} onClose={() => setDetail(null)} /> : null;
      })()}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function HistoryCard({ row, selected, onToggle, onOpen }: { row: any; selected: boolean; onToggle: () => void; onOpen: () => void }) {
  const label = MODELS[row.model as ModelId]?.label ?? row.model;
  const canCompare = !!row.outputUrl;
  return (
    <div onClick={onOpen} className={"group cursor-pointer overflow-hidden rounded-xl border bg-surface shadow-sm transition hover:shadow-md " + (selected ? "border-brand-400 ring-2 ring-brand-200" : "border-line hover:border-brand-300")}>
      <div className="relative bg-black/[0.03]">
        {row.outputUrl ? (
          <video src={row.outputUrl} className="aspect-[9/16] w-full object-cover" muted />
        ) : (
          <div className="flex aspect-[9/16] items-center justify-center text-xs text-ink-400">{row.outputStatus}</div>
        )}
        {canCompare && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={
              "absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md border text-white transition " +
              (selected ? "border-brand-500 bg-brand-600" : "border-white/60 bg-black/40 hover:bg-black/60")
            }
            title="Select to compare"
          >
            {selected && <Check className="size-4" />}
          </button>
        )}
      </div>
      <div className="space-y-1 p-2">
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">{label}</span>
          <span className="rounded bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-ink-500">{row.pipeline}</span>
          {row.rating ? <span className="ml-auto text-[10px] text-brand-600">★ {row.rating}</span> : null}
        </div>
        <p className="truncate text-[11px] text-ink-400">{row.sourceFileName}{row.ownerName ? ` · ${row.ownerName}` : ""}</p>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DetailModal({ row, readOnly, onClose }: { row: any; readOnly: boolean; onClose: () => void }) {
  const setRating = useMutation(api.generations.setRating);
  const setNotes = useMutation(api.generations.setNotes);
  const [notes, setNotesLocal] = useState<string>(row.notes ?? "");
  const plan = useQuery(api.geminiPlans.get, row.geminiPlanId ? { id: row.geminiPlanId as Id<"geminiPlans"> } : "skip");
  const label = MODELS[row.model as ModelId]?.label ?? row.model;
  const assets: { type: string; fileUrl: string; role: string }[] = row.mediaReferencesSent ?? [];
  const prompt = row.translatedPrompt || row.userPrompt;
  const params = row.apiParameters;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm">
      <div onClick={(e) => e.stopPropagation()} className="flex h-[86vh] max-h-[820px] w-full max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
        {/* video — fills the preview height; the pane hugs its width (no black margins) */}
        <div className="flex shrink-0 items-center justify-center bg-neutral-950">
          {row.outputUrl ? <video src={row.outputUrl} controls className="h-full w-auto object-contain" style={{ maxWidth: "46vw" }} /> : <div className="flex h-full w-44 items-center justify-center text-sm text-neutral-500">{row.outputStatus}</div>}
        </div>
        {/* details */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-line p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700">{label}</span>
                <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-500">Pipeline {row.pipeline}</span>
                {row.sceneNumber != null && <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-500">scene {row.sceneNumber}</span>}
                {row.ownerName && <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-500">by {row.ownerName}</span>}
              </div>
              <p className="mt-1 truncate text-xs text-ink-400">{row.sourceFileName}{row.costEstimate ? ` · ${Math.round(row.costEstimate)} cr` : ""}</p>
            </div>
            <button onClick={onClose} className="rounded-md p-1.5 text-ink-400 hover:bg-canvas hover:text-ink-900"><X className="size-4" /></button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {prompt && (
              <Section icon={<FileText className="size-3.5" />} title="Prompt sent">
                <p className="whitespace-pre-wrap rounded-lg bg-canvas p-3 text-xs leading-relaxed text-ink-700">{prompt}</p>
                {row.userPrompt && row.translatedPrompt && row.userPrompt !== row.translatedPrompt && (
                  <details className="mt-2"><summary className="cursor-pointer text-[11px] text-ink-400">Original user prompt</summary><p className="mt-1 whitespace-pre-wrap rounded-lg bg-canvas p-3 text-xs text-ink-500">{row.userPrompt}</p></details>
                )}
              </Section>
            )}

            {assets.length > 0 && (
              <Section icon={<Paperclip className="size-3.5" />} title={`Assets provided · ${assets.length}`}>
                <div className="space-y-1.5">
                  {assets.map((a, i) => {
                    const isUrl = /^https?:\/\//.test(a.fileUrl || "");
                    const Icon = a.type === "video" ? Film : a.type === "audio" ? AudioLines : ImageIcon;
                    return (
                      <div key={i} className="flex items-center gap-2.5 rounded-lg border border-line bg-canvas p-2">
                        {isUrl ? (
                          a.type === "video" ? (
                            <video src={`${a.fileUrl}#t=0.5`} preload="metadata" muted playsInline className="size-10 shrink-0 rounded bg-neutral-900 object-cover" />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={a.fileUrl} alt={a.role} className="size-10 shrink-0 rounded object-cover" />
                          )
                        ) : (
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon className="size-4.5" /></span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-ink-700">{a.role}</div>
                          <div className="truncate text-[11px] text-ink-400">{a.type}{!isUrl && a.fileUrl ? ` · ${a.fileUrl}` : ""}</div>
                        </div>
                        {isUrl && (
                          <a href={a.fileUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-md p-1.5 text-ink-400 transition hover:bg-surface hover:text-brand-600"><ExternalLink className="size-3.5" /></a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            {params && (
              <Section icon={<FileText className="size-3.5" />} title="API parameters">
                <pre className="overflow-x-auto rounded-lg bg-canvas p-3 text-[11px] leading-relaxed text-ink-700">{JSON.stringify(params, null, 2)}</pre>
              </Section>
            )}

            {plan && (
              <Section icon={<Layers className="size-3.5" />} title="Behind the scenes — what each layer fed in">
                <div className="space-y-2">
                  {plan.planRationale && (
                    <div className="rounded-lg bg-canvas p-3 text-xs text-ink-700"><span className="font-medium text-ink-500">Gemini planner rationale: </span>{plan.planRationale}</div>
                  )}
                  <details className="overflow-hidden rounded-lg border border-line bg-canvas">
                    <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-ink-600">Full Gemini planning prompt (Pegasus + skills + intent embedded)</summary>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-line p-3 text-[10px] leading-relaxed text-ink-700">{plan.geminiInstruction || "(not captured for this earlier plan — re-run to record it)"}</pre>
                  </details>
                  <details className="overflow-hidden rounded-lg border border-line bg-canvas">
                    <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-ink-600">Pegasus analysis — the structured “what” it grounded Gemini with</summary>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-line p-3 text-[10px] leading-relaxed text-ink-700">{JSON.stringify(plan.pegasusAnalysisUsed ?? {}, null, 2)}</pre>
                  </details>
                </div>
              </Section>
            )}

            <Section icon={<Star className="size-3.5" />} title="Rating & notes">
              <div className="mb-2 flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} disabled={readOnly} onClick={() => setRating({ id: row._id, rating: n })} className={"transition " + (readOnly ? "cursor-default" : "hover:scale-110")}>
                    <Star className={"size-5 " + ((row.rating ?? 0) >= n ? "fill-amber-400 text-amber-400" : "text-ink-400")} />
                  </button>
                ))}
              </div>
              {readOnly ? (
                row.notes ? <p className="whitespace-pre-wrap rounded-lg bg-canvas p-3 text-xs text-ink-700">{row.notes}</p> : <p className="text-xs text-ink-400">No notes.</p>
              ) : (
                <textarea value={notes} onChange={(e) => setNotesLocal(e.target.value)} onBlur={() => setNotes({ id: row._id, notes })} placeholder="Add notes…" rows={3} className="w-full resize-none rounded-lg border border-line bg-canvas p-2 text-xs focus:border-brand-400 focus:bg-surface focus:outline-none" />
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{icon}{title}</div>
      {children}
    </div>
  );
}

function ComparePanel({ rows, onClose }: { rows: any[]; onClose: () => void }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const all = (fn: (v: HTMLVideoElement) => void) => refs.current.forEach((v) => v && fn(v));
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink-700">Comparison · {rows.length}</h2>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => all((v) => v.play())} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700"><Play className="size-3.5" /> Play all</button>
          <button onClick={() => all((v) => v.pause())} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-canvas"><Pause className="size-3.5" /> Pause</button>
          <button onClick={() => all((v) => { v.currentTime = 0; })} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-canvas"><RotateCcw className="size-3.5" /> Restart</button>
          <button onClick={onClose} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-400 hover:text-ink-900">Close</button>
        </div>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
        {rows.map((r, i) => (
          <div key={r._id} className="space-y-1">
            <video ref={(el) => { refs.current[i] = el; }} src={r.outputUrl} controls className="w-full rounded-lg bg-black" />
            <p className="text-center text-xs font-medium text-ink-700">{MODELS[r.model as ModelId]?.label ?? r.model}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-xs text-ink-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm shadow-sm focus:border-brand-400 focus:outline-none"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}
