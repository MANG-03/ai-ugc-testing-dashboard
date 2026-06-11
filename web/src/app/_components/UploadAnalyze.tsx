"use client";

import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { UploadCloud, Sparkles, Loader2, ChevronDown, ChevronRight, Pencil, Check, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useWorkspace } from "./WorkspaceProvider";

export function UploadAnalyze() {
  const { me } = useWorkspace();
  const videos = useQuery(api.sourceVideos.list, { workspaceId: me.id });

  return (
    <div className="space-y-7">
      <Dropzone />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink-700">
          Source videos{" "}
          {videos && <span className="font-normal text-ink-400">· {videos.length}</span>}
        </h2>
        {videos === undefined ? (
          <p className="text-sm text-ink-400">Loading…</p>
        ) : videos.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center text-sm text-ink-400">
            No videos yet. Upload one above to get started.
          </p>
        ) : (
          <div className="space-y-3">
            {videos.map((v) => (
              <VideoCard key={v._id} video={v} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Dropzone() {
  const { me } = useWorkspace();
  const generateUploadUrl = useMutation(api.sourceVideos.generateUploadUrl);
  const createSourceVideo = useMutation(api.sourceVideos.createSourceVideo);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (const file of Array.from(files)) {
          const duration = await readDuration(file).catch(() => undefined);
          const postUrl = await generateUploadUrl();
          const res = await fetch(postUrl, {
            method: "POST",
            headers: { "Content-Type": file.type || "video/mp4" },
            body: file,
          });
          if (!res.ok) throw new Error(`upload failed (${res.status})`);
          const { storageId } = await res.json();
          await createSourceVideo({ fileName: file.name, storageId, duration, workspaceId: me.id });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [generateUploadUrl, createSourceVideo, me.id],
  );

  return (
    <div>
      <div
        onClick={() => !busy && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
        className={
          "group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 text-center transition " +
          (dragOver
            ? "border-brand-500 bg-brand-50"
            : "border-line bg-surface hover:border-brand-300 hover:bg-brand-50/40")
        }
      >
        <div className="flex size-14 items-center justify-center rounded-full bg-brand-100 text-brand-600 transition group-hover:bg-brand-200">
          {busy ? <Loader2 className="size-6 animate-spin" /> : <UploadCloud className="size-6" />}
        </div>
        <p className="mt-4 text-base font-semibold text-ink-900">
          {busy ? "Uploading…" : "Upload a source TikTok"}
        </p>
        <p className="mt-1 text-sm text-ink-500">Drag &amp; drop, or click to choose · MP4 / MOV · vertical 9:16</p>
        <span className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition group-hover:bg-brand-700">
          <UploadCloud className="size-4" /> Upload Video
        </span>
        <input ref={inputRef} type="file" accept="video/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function VideoCard({ video }: { video: any }) {
  const analyze = useAction(api.pegasus.analyze);
  const updateScenes = useMutation(api.sourceVideos.updatePegasusScenes);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [draft, setDraft] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const status: string = video.pegasusStatus ?? "idle";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scenes: any[] = video.pegasusAnalysis?.scenes ?? [];
  const isProcessing = running || status === "processing";

  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      await analyze({ sourceVideoId: video._id as Id<"sourceVideos"> });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const startEdit = () => {
    setDraft(scenes.map(normalizeScene));
    setEditing(true);
    setExpanded(true);
  };
  const editField = (sceneIdx: number, key: string, value: string) =>
    setDraft((d) => d.map((s, i) => (i === sceneIdx ? { ...s, metadata: { ...s.metadata, [key]: value } } : s)));
  const save = async () => {
    setSaving(true);
    try {
      await updateScenes({ id: video._id as Id<"sourceVideos">, scenes: draft });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className="flex gap-5 p-4">
        {video.fileUrl ? (
          <video src={video.fileUrl} controls className="h-48 w-auto shrink-0 rounded-xl bg-black" />
        ) : (
          <div className="h-48 w-27 shrink-0 rounded-xl bg-canvas" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink-900">{video.fileName}</p>
              <p className="mt-0.5 text-xs text-ink-400">
                {video.duration ? `${video.duration.toFixed(1)}s` : "duration unknown"} ·{" "}
                {new Date(video.uploadedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                {video.pegasusAnalysis?.editedAt && <span className="ml-1 text-brand-600">· edited</span>}
              </p>
            </div>
            <StatusBadge status={status} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={run}
              disabled={isProcessing || editing}
              className={
                "inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 " +
                (status === "completed"
                  ? "border border-line bg-surface text-ink-700 hover:bg-canvas"
                  : "bg-brand-600 text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700")
              }
            >
              {isProcessing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {status === "completed" ? "Re-run Pegasus" : isProcessing ? "Analyzing…" : "Run Pegasus Analysis"}
            </button>
            {status === "completed" && scenes.length > 0 && !editing && (
              <>
                <button
                  onClick={() => setExpanded((x) => !x)}
                  className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700"
                >
                  {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  {scenes.length} scene{scenes.length === 1 ? "" : "s"}
                </button>
                <button
                  onClick={startEdit}
                  className="inline-flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-900"
                >
                  <Pencil className="size-3.5" /> Correct analysis
                </button>
              </>
            )}
            {editing && (
              <div className="flex items-center gap-2">
                <button
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save corrections
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-500 hover:bg-canvas"
                >
                  <X className="size-4" /> Cancel
                </button>
              </div>
            )}
          </div>

          {(err || (status === "failed" && video.pegasusError)) && (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err ?? video.pegasusError}</p>
          )}
        </div>
      </div>

      {status === "completed" && expanded && scenes.length > 0 && (
        <div className="border-t border-line bg-canvas/60 p-4">
          {editing ? (
            <div className="space-y-3">
              <p className="text-xs text-ink-500">
                Fix anything Pegasus misread (e.g. on-screen text). Your corrections become the source of truth fed to Gemini.
              </p>
              {draft.map((s, i) => (
                <EditableSceneRow key={i} index={i} scene={s} onField={(k, v) => editField(i, k, v)} />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {scenes.map((s, i) => (
                <SceneRow key={i} index={i} scene={s} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const EDIT_FIELDS: { key: string; label: string; long?: boolean }[] = [
  { key: "scene_description", label: "Scene description", long: true },
  { key: "characters", label: "Characters", long: true },
  { key: "on_screen_text", label: "On-screen text" },
  { key: "dialogue_transcript", label: "Dialogue (attributed)", long: true },
  { key: "delivery_style", label: "Delivery" },
  { key: "shot_type", label: "Shot type" },
  { key: "camera_movement", label: "Camera movement" },
  { key: "subject_framing", label: "Subject framing" },
  { key: "subject_appearance", label: "Subject appearance", long: true },
  { key: "background_description", label: "Background", long: true },
  { key: "lighting", label: "Lighting" },
  { key: "audio_atmosphere", label: "Audio atmosphere" },
  { key: "scene_purpose", label: "Scene purpose" },
];

function EditableSceneRow({
  index,
  scene,
  onField,
}: {
  index: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene: any;
  onField: (key: string, value: string) => void;
}) {
  const m = scene.metadata ?? {};
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-md bg-brand-600 font-mono text-[11px] font-semibold text-white">
          {index + 1}
        </span>
        {scene.start_time != null && scene.end_time != null && (
          <span className="font-mono text-xs text-ink-400">
            {Number(scene.start_time).toFixed(1)}s – {Number(scene.end_time).toFixed(1)}s
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {EDIT_FIELDS.map((f) => (
          <label key={f.key} className={f.long ? "sm:col-span-2" : ""}>
            <span className="mb-0.5 block text-[11px] font-medium text-ink-400">{f.label}</span>
            {f.long ? (
              <textarea
                value={m[f.key] ?? ""}
                onChange={(e) => onField(f.key, e.target.value)}
                rows={2}
                className="w-full resize-none rounded-lg border border-line bg-canvas/50 p-2 text-sm text-ink-900 focus:border-brand-400 focus:bg-surface focus:outline-none"
              />
            ) : (
              <input
                value={m[f.key] ?? ""}
                onChange={(e) => onField(f.key, e.target.value)}
                className="w-full rounded-lg border border-line bg-canvas/50 p-2 text-sm text-ink-900 focus:border-brand-400 focus:bg-surface focus:outline-none"
              />
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeScene(s: any) {
  const meta = s.metadata ? { ...s.metadata } : { ...s };
  delete meta.start_time;
  delete meta.end_time;
  delete meta.start;
  delete meta.end;
  return {
    start_time: s.start_time ?? s.start ?? null,
    end_time: s.end_time ?? s.end ?? null,
    metadata: meta,
  };
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; dot: string }> = {
    idle: { cls: "bg-canvas text-ink-500", dot: "bg-ink-400" },
    processing: { cls: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
    completed: { cls: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
    failed: { cls: "bg-red-50 text-red-700", dot: "bg-red-500" },
  };
  const s = map[status] ?? map.idle;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.cls}`}>
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SceneRow({ index, scene }: { index: number; scene: any }) {
  const m = scene.metadata ?? scene;
  const start = scene.start_time ?? scene.start;
  const end = scene.end_time ?? scene.end;
  const fields: [string, string | undefined][] = [
    ["Characters", m.characters],
    ["Dialogue", m.dialogue_transcript],
    ["Delivery", m.delivery_style],
    ["Camera", m.camera_movement],
    ["Framing", m.subject_framing],
    ["Appearance", m.subject_appearance],
    ["Background", m.background_description],
    ["Lighting", m.lighting],
    ["Audio", m.audio_atmosphere],
    ["On-screen text", m.on_screen_text],
    ["Purpose", m.scene_purpose],
  ];
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-md bg-brand-600 font-mono text-[11px] font-semibold text-white">
          {index + 1}
        </span>
        {start != null && end != null && (
          <span className="font-mono text-xs text-ink-400">
            {Number(start).toFixed(1)}s – {Number(end).toFixed(1)}s
          </span>
        )}
        {m.shot_type && (
          <span className="ml-auto rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
            {m.shot_type}
          </span>
        )}
      </div>
      {m.scene_description && <p className="mt-2 text-sm leading-relaxed text-ink-700">{m.scene_description}</p>}
      <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {fields
          .filter(([, val]) => val && String(val).toLowerCase() !== "none" && String(val).toLowerCase() !== "no dialogue")
          .map(([label, val]) => (
            <div key={label} className="flex gap-1.5 text-xs">
              <dt className="shrink-0 font-medium text-ink-400">{label}:</dt>
              <dd className="text-ink-700">{val}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

function readDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(el.src);
      resolve(el.duration);
    };
    el.onerror = () => reject(new Error("could not read video metadata"));
    el.src = URL.createObjectURL(file);
  });
}
