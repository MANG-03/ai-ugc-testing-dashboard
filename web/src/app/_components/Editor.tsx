"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { Play, Pause, Scissors, Trash2, Download, Plus, Loader2, ZoomIn, ZoomOut, Film, Volume2, ArrowLeft, FolderPlus, Clapperboard, Check, Pencil } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { MODELS, type ModelId } from "../../../convex/models";

type Clip = {
  id: string; url: string; label: string; color: string;
  srcDur: number; inPoint: number; outPoint: number;
  start: number; track: number; w: number; h: number;
};
type Seg = { url: string; inP: number; outP: number; tStart: number };

const VTRACKS = 3, ATRACKS = 3, TRACK_H = 44, RULER_H = 24, FPS = 30;
const COLORS = ["bg-brand-500", "bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-rose-500"];
const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
let counter = 0;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const len = (c: Clip) => c.outPoint - c.inPoint;
const fmt = (s: number) => { s = Math.max(0, s); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 1000)).padStart(3, "0")}`; };

const VIDEO_ROWS = [2, 1, 0], AUDIO_ROWS = [0, 1, 2];
const videoRowTop = (track: number) => VIDEO_ROWS.indexOf(track) * TRACK_H;
const audioRowTop = (track: number) => (VIDEO_ROWS.length + AUDIO_ROWS.indexOf(track)) * TRACK_H;
const TRACK_AREA_H = (VTRACKS + ATRACKS) * TRACK_H;

// ── Project files (browser-local; clips reference persistent Convex URLs) ──
type Project = { id: string; name: string; clips: Clip[]; proj: { w: number; h: number }; updatedAt: number; createdAt: number };
const PKEY = "echoes.editor.projects.v1";
const loadProjects = (): Project[] => { if (typeof window === "undefined") return []; try { return JSON.parse(localStorage.getItem(PKEY) || "[]"); } catch { return []; } };
const writeProjects = (ps: Project[]) => { try { localStorage.setItem(PKEY, JSON.stringify(ps)); } catch {} };
const upsertProject = (p: Project) => { const ps = loadProjects(); const i = ps.findIndex((x) => x.id === p.id); if (i >= 0) ps[i] = p; else ps.unshift(p); writeProjects(ps); };
const removeProject = (id: string) => writeProjects(loadProjects().filter((p) => p.id !== id));
const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "p" + Date.now());
const relTime = (t: number) => { const s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; };

function EditorWorkspace({ project, onClose }: { project: Project; onClose: () => void }) {
  const available = useQuery(api.generations.listAll, {});
  const [clips, setClips] = useState<Clip[]>(project.clips ?? []);
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [selIds, setSelIds] = useState<string[]>([]);
  const [selGap, setSelGap] = useState<{ track: number; start: number; end: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [splitMode, setSplitMode] = useState(false);
  const [snapX, setSnapX] = useState<number | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [pps, setPps] = useState(60);
  const [mediaW, setMediaW] = useState(240);
  const [activeUrl, setActiveUrl] = useState<string | null>(null); // which preloaded clip is visible
  const [proj, setProj] = useState(project.proj ?? { w: 9, h: 16 });
  const [scrollW, setScrollW] = useState(800);
  const [exporting, setExporting] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [drag, setDrag] = useState<{ g: any; x: number; y: number; drop: { start: number; track: number } | null } | null>(null);

  const vidMap = useRef<Map<string, HTMLVideoElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const segRef = useRef(0);
  const scheduleRef = useRef<Seg[]>([]);
  const clipsRef = useRef<Clip[]>([]);
  const playingRef = useRef(false);
  const ppsRef = useRef(pps);
  const playheadRef = useRef(0);
  const rafRef = useRef(0);
  const selIdsRef = useRef<string[]>([]);
  const selGapRef = useRef<{ track: number; start: number; end: number } | null>(null);
  const togglePlayRef = useRef<() => void>(() => {});
  const stepRef = useRef<(d: number) => void>(() => {});
  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { ppsRef.current = pps; }, [pps]);
  useEffect(() => { playheadRef.current = playhead; }, [playhead]);
  useEffect(() => { selIdsRef.current = selIds; }, [selIds]);
  useEffect(() => { selGapRef.current = selGap; }, [selGap]);

  const projRef = useRef(proj);
  const nameRef = useRef(name);
  useEffect(() => { projRef.current = proj; }, [proj]);
  useEffect(() => { nameRef.current = name; }, [name]);
  // autosave (debounced) whenever the timeline / name changes
  const firstSaveRef = useRef(true);
  useEffect(() => {
    if (firstSaveRef.current) { firstSaveRef.current = false; return; }
    setSaving(true);
    const t = setTimeout(() => { upsertProject({ ...project, name, clips, proj, updatedAt: Date.now() }); setSaving(false); }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, proj, name]);
  // flush the latest state when leaving the editor (back / navigation)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { upsertProject({ ...project, name: nameRef.current, clips: clipsRef.current, proj: projRef.current, updatedAt: Date.now() }); }, []);

  const completed = (available ?? []).filter((g) => g.outputStatus === "completed" && g.outputUrl);
  const sources = Array.from(new Map(completed.map((g) => [g.sourceVideoId as string, g.sourceFileName as string])).entries());
  const shownClips = sourceFilter === "all" ? completed : completed.filter((g) => g.sourceVideoId === sourceFilter);
  const timelineEnd = clips.reduce((m, c) => Math.max(m, c.start + len(c)), 0);
  const contentSec = Math.max(timelineEnd + 2, scrollW / pps);
  const contentW = contentSec * pps;
  const tickStep = TICK_STEPS.find((s) => s * pps >= 64) ?? 60;
  const ticks = Math.ceil(contentSec / tickStep) + 1;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScrollW(el.clientWidth));
    ro.observe(el); setScrollW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { if (!e.ctrlKey) return; e.preventDefault(); setPps((p) => clamp(Math.round(p * (1 - e.deltaY * 0.01)), 3, 1500)); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const topAt = useCallback((t: number, list = clipsRef.current) => {
    const cover = list.filter((c) => c.start <= t + 1e-4 && t < c.start + len(c) - 1e-4);
    return cover.length ? cover.reduce((a, b) => (b.track >= a.track ? b : a)) : null;
  }, []);

  const elFor = (url?: string) => (url ? vidMap.current.get(url) ?? null : null);
  const setProjFrom = (el: HTMLVideoElement) => { if (el.videoWidth) setProj((p) => (p.w === el.videoWidth && p.h === el.videoHeight ? p : { w: el.videoWidth, h: el.videoHeight })); };

  // Flatten the timeline into ordered, topmost-wins segments to play back.
  const buildSchedule = (cl: Clip[]): Seg[] => {
    if (!cl.length) return [];
    const bounds = new Set<number>([0]);
    cl.forEach((c) => { bounds.add(c.start); bounds.add(c.start + len(c)); });
    const ts = [...bounds].sort((a, b) => a - b);
    const raw: Seg[] = [];
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 < 0.02) continue;
      const top = topAt((t0 + t1) / 2, cl);
      if (top) raw.push({ url: top.url, inP: top.inPoint + (t0 - top.start), outP: top.inPoint + (t1 - top.start), tStart: t0 });
    }
    const merged: Seg[] = [];
    for (const s of raw) {
      const last = merged[merged.length - 1];
      if (last && last.url === s.url && Math.abs(last.outP - s.inP) < 0.002 && Math.abs(last.tStart + (last.outP - last.inP) - s.tStart) < 0.002) last.outP = s.outP;
      else merged.push({ ...s });
    }
    return merged;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scheduleRef.current = buildSchedule(clips); }, [clips]);

  const segIndexAt = (t: number) => {
    const sc = scheduleRef.current;
    for (let i = 0; i < sc.length; i++) if (t < sc[i].tStart + (sc[i].outP - sc[i].inP) - 1e-4) return i;
    return -1;
  };
  // show a still frame at time t — every clip is already mounted & preloaded, so this is instant
  const showAt = (t: number) => {
    const sc = scheduleRef.current;
    if (!sc.length) return;
    let i = segIndexAt(t);
    if (i < 0) i = sc.length - 1;
    const seg = sc[i], el = elFor(seg.url);
    if (!el) return;
    try { el.currentTime = seg.inP + Math.max(0, t - seg.tStart); } catch {}
    setProjFrom(el);
    setActiveUrl(seg.url);
  };

  const advanceSeg = () => {
    const sc = scheduleRef.current, ni = segRef.current + 1;
    if (ni >= sc.length) { elFor(sc[segRef.current]?.url)?.pause(); setPlaying(false); playingRef.current = false; cancelAnimationFrame(rafRef.current); return; }
    const old = elFor(sc[segRef.current]?.url), seg = sc[ni], el = elFor(seg.url);
    if (el) { try { el.currentTime = seg.inP; } catch {} setProjFrom(el); el.play().catch(() => {}); }
    if (old && old !== el) old.pause();
    segRef.current = ni; setActiveUrl(seg.url);
  };

  const tickRef = useRef<() => void>(() => {});
  const tick = () => {
    const sc = scheduleRef.current, seg = sc[segRef.current], el = elFor(seg?.url);
    if (el && seg) {
      const ph = seg.tStart + (el.currentTime - seg.inP);
      setPlayhead(ph);
      if (el.currentTime >= seg.outP - 0.05) advanceSeg();
      const s = scrollRef.current;
      if (s) { const x = ph * ppsRef.current; if (x < s.scrollLeft || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = x - s.clientWidth / 2; }
    }
    if (playingRef.current) rafRef.current = requestAnimationFrame(() => tickRef.current());
  };
  useEffect(() => { tickRef.current = tick; });

  const startPlay = (t: number) => {
    const sc = scheduleRef.current;
    if (!sc.length) return;
    let i = segIndexAt(t);
    if (i < 0) { i = 0; t = sc[0].tStart; }
    segRef.current = i;
    const seg = sc[i], el = elFor(seg.url);
    if (!el) return;
    try { el.currentTime = seg.inP + Math.max(0, t - seg.tStart); } catch {}
    setProjFrom(el); el.play().catch(() => {}); setActiveUrl(seg.url);
    setPlaying(true); playingRef.current = true;
    cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(() => tickRef.current());
  };
  const togglePlay = () => {
    if (clips.length === 0) return;
    if (playing) { vidMap.current.forEach((v) => v.pause()); setPlaying(false); playingRef.current = false; cancelAnimationFrame(rafRef.current); }
    else startPlay(playhead >= timelineEnd - 0.05 ? 0 : playhead);
  };
  useEffect(() => { togglePlayRef.current = togglePlay; });
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const stepFrame = (dir: number) => { const end = clipsRef.current.reduce((m, c) => Math.max(m, c.start + len(c)), 0); const t = clamp(playheadRef.current + dir / FPS, 0, end); setPlayhead(t); if (!playingRef.current) showAt(t); };
  useEffect(() => { stepRef.current = stepFrame; });

  // refresh / clear the preview when the timeline changes
  useEffect(() => {
    if (clips.length === 0) {
      vidMap.current.forEach((v) => v.pause());
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlayhead(0);
      setPlaying(false);
      setActiveUrl(null);
    } else {
      showAt(playheadRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.length]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addClip = (g: any, atStart?: number, atTrack?: number) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      const dur = probe.duration && isFinite(probe.duration) ? probe.duration : 5;
      setClips((cur) => {
        const track = atTrack ?? 0;
        const start = atStart ?? cur.filter((c) => c.track === track).reduce((m, c) => Math.max(m, c.start + len(c)), 0);
        return [...cur, { id: `k${counter++}`, url: g.outputUrl, label: `${MODELS[g.model as ModelId]?.label ?? g.model} · sc${g.sceneNumber ?? "–"}`, color: COLORS[(g.sceneNumber ?? cur.length) % COLORS.length], srcDur: dur, inPoint: 0, outPoint: dur, start, track, w: probe.videoWidth || 9, h: probe.videoHeight || 16 }];
      });
    };
    probe.src = g.outputUrl;
  };

  // click-and-hold a media tile → drag onto the timeline (or click to append)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const startMediaDrag = (g: any) => (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const overTimeline = (x: number, y: number) => {
      const el = scrollRef.current; if (!el) return null;
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      const start = Math.max(0, (x - r.left + el.scrollLeft) / ppsRef.current);
      const row = Math.floor((y - r.top - RULER_H) / TRACK_H);
      return { start, track: row >= 0 && row < VTRACKS ? VIDEO_ROWS[row] : 0 };
    };
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) moved = true;
      if (moved) setDrag({ g, x: ev.clientX, y: ev.clientY, drop: overTimeline(ev.clientX, ev.clientY) });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (!moved) { addClip(g); return; }
      const drop = overTimeline(ev.clientX, ev.clientY);
      if (drop) addClip(g, drop.start, drop.track);
    };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const dragClip = (id: string) => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    e.preventDefault(); e.stopPropagation();
    setSelIds((prev) => (prev.includes(id) ? prev : [id]));
    const c0 = clipsRef.current.find((c) => c.id === id)!;
    const clipLen = len(c0);
    const sx = e.clientX, sy = e.clientY, sStart = c0.start, sTrack = c0.track;
    const onMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - sx) / ppsRef.current;
      const dTrack = -Math.round((ev.clientY - sy) / TRACK_H);
      const raw = Math.max(0, sStart + dt);
      // magnetic snap: leading/trailing edge to 0 or any other clip's edges
      const thr = 8 / ppsRef.current;
      const edges = [0, ...clipsRef.current.filter((c) => c.id !== id).flatMap((c) => [c.start, c.start + len(c)])];
      let ns = raw, bestD = thr, snapped = false;
      for (const ed of edges) {
        if (Math.abs(raw - ed) < bestD) { bestD = Math.abs(raw - ed); ns = ed; snapped = true; }
        if (Math.abs(raw + clipLen - ed) < bestD) { bestD = Math.abs(raw + clipLen - ed); ns = ed - clipLen; snapped = true; }
      }
      ns = Math.max(0, ns);
      setSnapX(snapped ? ns * ppsRef.current : null);
      setClips((cur) => cur.map((c) => (c.id !== id ? c : { ...c, start: ns, track: clamp(sTrack + dTrack, 0, VTRACKS - 1) })));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); setSnapX(null); showAt(playhead); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const trim = (id: string, edge: "in" | "out") => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const c0 = clipsRef.current.find((c) => c.id === id)!;
    const sx = e.clientX, sIn = c0.inPoint, sOut = c0.outPoint, sStart = c0.start;
    const onMove = (ev: PointerEvent) => {
      const d = (ev.clientX - sx) / ppsRef.current;
      setClips((cur) => cur.map((c) => {
        if (c.id !== id) return c;
        if (edge === "in") { const ni = clamp(sIn + d, 0, c.outPoint - 0.1); return { ...c, inPoint: ni, start: Math.max(0, sStart + (ni - sIn)) }; }
        return { ...c, outPoint: clamp(sOut + d, c.inPoint + 0.1, c.srcDur) };
      }));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); showAt(playhead); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const startScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const move = (clientX: number) => {
      const el = scrollRef.current!; const rect = el.getBoundingClientRect();
      const t = clamp((clientX - rect.left + el.scrollLeft) / ppsRef.current, 0, timelineEnd);
      setPlayhead(t); if (!playingRef.current) showAt(t);
    };
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const splitClipAt = (clip: Clip, atTime: number) => {
    const localOut = clip.inPoint + (atTime - clip.start);
    if (localOut <= clip.inPoint + 0.05 || localOut >= clip.outPoint - 0.05) return;
    setClips((cur) => {
      const i = cur.findIndex((c) => c.id === clip.id);
      if (i < 0) return cur;
      const n = [...cur];
      n.splice(i, 1, { ...clip, outPoint: localOut }, { ...clip, id: `k${counter++}`, inPoint: localOut, start: atTime });
      return n;
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const k = e.key.toLowerCase();
      if (e.code === "Space") { e.preventDefault(); togglePlayRef.current(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); stepRef.current(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); stepRef.current(1); }
      else if (k === "c") setSplitMode(true);
      else if (k === "v") setSplitMode(false);
      else if (e.key === "Backspace" || e.key === "Delete") {
        if (selGapRef.current) {
          e.preventDefault();
          const g = selGapRef.current, w = g.end - g.start;
          setClips((cur) => cur.map((c) => (c.track === g.track && c.start >= g.end - 1e-4 ? { ...c, start: c.start - w } : c)));
          setSelGap(null);
        } else if (selIdsRef.current.length) {
          e.preventDefault();
          const ids = selIdsRef.current;
          setClips((cur) => cur.filter((c) => !ids.includes(c.id)));
          setSelIds([]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const snip = (clip: Clip) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = scrollRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    splitClipAt(clip, (e.clientX - rect.left + el.scrollLeft) / ppsRef.current);
  };

  // resize the Media | Preview split
  const dragDivider = (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX, sW = mediaW;
    const onMove = (ev: PointerEvent) => setMediaW(clamp(sW + (ev.clientX - sx), 160, 700));
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  // marquee select: drag on empty timeline to rubber-band multiple clips
  const startMarquee = (e: React.PointerEvent) => {
    if (splitMode || drag) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
    let moved = false;
    setSelIds([]); setSelGap(null);
    const onMove = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left, y1 = ev.clientY - rect.top;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) > 4) moved = true;
      if (!moved) return;
      setMarquee({ x0, y0, x1, y1 });
      const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
      setSelIds(clipsRef.current.filter((c) => {
        const cx0 = c.start * ppsRef.current, cx1 = (c.start + len(c)) * ppsRef.current, cy0 = videoRowTop(c.track), cy1 = cy0 + TRACK_H;
        return cx0 < maxX && cx1 > minX && cy0 < maxY && cy1 > minY;
      }).map((c) => c.id));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); setMarquee(null);
      if (moved) return;
      // a plain click on empty space → select the gap (empty span between clips) under the cursor
      const row = Math.floor(y0 / TRACK_H);
      if (row < 0 || row >= VTRACKS) return;
      const track = VIDEO_ROWS[row];
      const t = x0 / ppsRef.current;
      const onTrack = clipsRef.current.filter((c) => c.track === track);
      if (onTrack.some((c) => c.start <= t && t < c.start + len(c))) return; // clicked inside a clip
      const next = onTrack.filter((c) => c.start > t).sort((a, b) => a.start - b.start)[0];
      if (!next) return; // trailing empty space, not a gap
      const prevEnd = onTrack.filter((c) => c.start + len(c) <= t).reduce((m, c) => Math.max(m, c.start + len(c)), 0);
      if (next.start - prevEnd > 0.05) setSelGap({ track, start: prevEnd, end: next.start });
    };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const exportVideo = async () => {
    if (clips.length === 0) return;
    setExporting(true); setError(null); setExportUrl(null);
    try {
      const bounds = new Set<number>([0]);
      clips.forEach((c) => { bounds.add(c.start); bounds.add(c.start + len(c)); });
      const ts = [...bounds].sort((a, b) => a - b);
      const segs: { url: string; start: number; end: number }[] = [];
      for (let i = 0; i < ts.length - 1; i++) {
        const t0 = ts[i], t1 = ts[i + 1];
        if (t1 - t0 < 0.05) continue;
        const top = topAt((t0 + t1) / 2);
        if (top) segs.push({ url: top.url, start: top.inPoint + (t0 - top.start), end: top.inPoint + (t1 - top.start) });
      }
      if (!segs.length) throw new Error("nothing to export");
      const res = await fetch("/api/ffmpeg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "compose", width: proj.w, height: proj.h, clips: segs }) });
      if (!res.ok) throw new Error((await res.json()).error ?? `export failed (${res.status})`);
      setExportUrl(URL.createObjectURL(await res.blob()));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  };

  const dropInfo = drag?.drop ?? null;
  const timelineUrls = Array.from(new Set(clips.map((c) => c.url)));

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Project bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line pb-2.5">
        <button onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm font-medium text-ink-700 transition hover:bg-canvas"><ArrowLeft className="size-4" /> Projects</button>
        <div className="flex items-center gap-1 rounded-lg px-1 hover:bg-canvas">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-64 rounded-md bg-transparent px-1.5 py-1 text-sm font-semibold focus:outline-none" />
          <Pencil className="size-3 shrink-0 text-ink-400" />
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-400">{saving ? <><Loader2 className="size-3 animate-spin" /> Saving…</> : <><Check className="size-3 text-emerald-500" /> Saved</>}</span>
      </div>

      {/* Top: Media panel + Preview monitor (resizable split) */}
      <div className="flex min-h-0 flex-1 items-stretch gap-2">
        {/* Media panel */}
        <aside style={{ width: mediaW }} className="flex shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Media</span>
            {sources.length > 0 && (
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="ml-auto max-w-[140px] rounded-md border border-line bg-canvas px-1.5 py-1 text-[11px] focus:border-brand-400 focus:outline-none">
                <option value="all">All ({completed.length})</option>
                {sources.map(([id, name]) => (
                  <option key={id} value={id}>{(name ?? "").slice(0, 18)} ({completed.filter((g) => g.sourceVideoId === id).length})</option>
                ))}
              </select>
            )}
          </div>
          {available === undefined ? (
            <p className="p-3 text-sm text-ink-400">Loading…</p>
          ) : shownClips.length === 0 ? (
            <p className="m-3 rounded-xl border border-dashed border-line p-4 text-center text-xs text-ink-400">No clips.</p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-wrap content-start gap-2 overflow-y-auto p-2.5">
              {shownClips.map((g) => (
                <div
                  key={g._id}
                  onPointerDown={startMediaDrag(g)}
                  title="Click to add · click-and-hold to drag onto the timeline"
                  className="group w-28 shrink-0 cursor-grab touch-none select-none overflow-hidden rounded-lg border border-line bg-surface transition hover:border-brand-300 hover:shadow-sm active:cursor-grabbing"
                >
                  <div className="relative aspect-video bg-neutral-900">
                    <video src={`${g.outputUrl}#t=0.5`} preload="metadata" muted className="pointer-events-none h-full w-full object-contain" />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
                      <span className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-1.5 py-0.5 text-[9px] font-medium text-white"><Plus className="size-2.5" /> Add</span>
                    </div>
                  </div>
                  <p className="truncate px-1.5 py-1 text-[9px] text-ink-500">{MODELS[g.model as ModelId]?.label ?? g.model} · sc{g.sceneNumber ?? "–"}</p>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* resize handle */}
        <div onPointerDown={dragDivider} title="Drag to resize" className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center">
          <div className="h-14 w-1 rounded-full bg-line transition group-hover:bg-brand-400" />
        </div>

        {/* Preview — light, seamless surface; the clip renders at its own dimensions (no black box) */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-canvas">
          <div className="flex items-center border-b border-line px-3 py-2"><span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Preview</span></div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
            {clips.length === 0 && <p className="text-sm text-ink-400">Add a clip to the timeline to preview it here</p>}
            {/* one preloaded video per distinct timeline clip — always ready, so cuts are instant */}
            {timelineUrls.map((url) => (
              <video
                key={url}
                ref={(el) => { if (el) vidMap.current.set(url, el); else vidMap.current.delete(url); }}
                src={url} preload="auto" playsInline
                className="absolute inset-3 h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] object-contain"
                style={{ opacity: activeUrl === url ? 1 : 0 }}
              />
            ))}
          </div>
        </section>
      </div>

      {/* Transport */}
      <div className="flex flex-wrap items-center gap-2.5">
        <button onClick={togglePlay} disabled={clips.length === 0} className="inline-flex size-9 items-center justify-center rounded-full bg-brand-600 text-white disabled:opacity-40">{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</button>
        <span className="font-mono text-xs text-ink-500">{fmt(playhead)} / {fmt(timelineEnd)}</span>
        <button onClick={() => setSplitMode((s) => !s)} disabled={clips.length === 0} className={"inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 " + (splitMode ? "border-brand-300 bg-brand-50 text-brand-700" : "border-line text-ink-700 hover:bg-canvas")}><Scissors className="size-4" /> Split{splitMode ? " · on" : ""}</button>
        {selIds.length > 0 && <button onClick={() => { const ids = selIds; setClips((cur) => cur.filter((c) => !ids.includes(c.id))); setSelIds([]); }} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"><Trash2 className="size-4" /> Delete{selIds.length > 1 ? ` (${selIds.length})` : ""}</button>}
        {selGap && <button onClick={() => { const g = selGap, w = g.end - g.start; setClips((cur) => cur.map((c) => (c.track === g.track && c.start >= g.end - 1e-4 ? { ...c, start: c.start - w } : c))); setSelGap(null); }} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-canvas"><Trash2 className="size-4" /> Close gap</button>}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setPps((p) => clamp(Math.round(p / 1.4), 3, 1500))} className="rounded-md border border-line p-1.5 text-ink-500 hover:bg-canvas"><ZoomOut className="size-4" /></button>
          <span className="w-12 text-center font-mono text-[10px] text-ink-400">{pps}px/s</span>
          <button onClick={() => setPps((p) => clamp(Math.round(p * 1.4), 3, 1500))} className="rounded-md border border-line p-1.5 text-ink-500 hover:bg-canvas"><ZoomIn className="size-4" /></button>
          {exportUrl && <a href={exportUrl} download="echoes-edit.mp4" className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700"><Download className="size-4" /> Download</a>}
          <button onClick={exportVideo} disabled={exporting || clips.length === 0} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700 disabled:opacity-40">{exporting ? <Loader2 className="size-4 animate-spin" /> : <Film className="size-4" />} {exporting ? "Exporting…" : "Export"}</button>
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Timeline panel — fixed height; inner content scrolls */}
      <div className="flex shrink-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm" style={{ height: TRACK_AREA_H + RULER_H + 2 }}>
        <div className="shrink-0 border-r border-line bg-canvas" style={{ width: 38 }}>
          <div style={{ height: RULER_H }} />
          {VIDEO_ROWS.map((tk) => (<div key={"v" + tk} style={{ height: TRACK_H }} className="flex items-center justify-center border-t border-line text-[10px] font-semibold text-ink-500">V{tk + 1}</div>))}
          {AUDIO_ROWS.map((tk) => (<div key={"a" + tk} style={{ height: TRACK_H }} className="flex items-center justify-center gap-0.5 border-t border-line text-[10px] font-semibold text-ink-400"><Volume2 className="size-3" />{tk + 1}</div>))}
        </div>
        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto">
          <div className="relative" style={{ width: contentW, height: TRACK_AREA_H + RULER_H }}>
            <div onPointerDown={startScrub} className="sticky top-0 z-10 cursor-pointer bg-canvas" style={{ height: RULER_H }}>
              {Array.from({ length: ticks }).map((_, i) => { const t = i * tickStep; return (<div key={i} className="absolute top-0 h-full border-l border-line" style={{ left: t * pps }}><span className="ml-1 text-[9px] tabular-nums text-ink-400">{tickStep < 1 ? `${t.toFixed(2)}` : `${t}s`}</span></div>); })}
            </div>
            <div
              className="relative" style={{ height: TRACK_AREA_H }}
              onPointerDown={startMarquee}
              onPointerMove={(e) => {
                if (!splitMode) { if (hoverT !== null) setHoverT(null); return; }
                const el = scrollRef.current; if (!el) return;
                const r = el.getBoundingClientRect();
                setHoverT(clamp((e.clientX - r.left + el.scrollLeft) / pps, 0, contentSec));
              }}
              onPointerLeave={() => setHoverT(null)}
            >
              {Array.from({ length: VTRACKS + ATRACKS }).map((_, i) => (<div key={i} className={"absolute w-full border-t border-line " + (i >= VTRACKS ? "bg-canvas/40" : "")} style={{ top: i * TRACK_H, height: TRACK_H }} />))}
              {Array.from({ length: ticks }).map((_, i) => (<div key={i} className="absolute top-0 border-l border-line/60" style={{ left: i * tickStep * pps, height: TRACK_AREA_H }} />))}
              {clips.map((c) => (
                <div key={c.id}>
                  <div
                    onPointerDown={splitMode ? snip(c) : dragClip(c.id)}
                    onClick={(e) => { e.stopPropagation(); setSelGap(null); if (!splitMode) setSelIds((prev) => e.shiftKey ? (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]) : [c.id]); }}
                    className={"group absolute flex flex-col justify-between overflow-hidden rounded-md text-white " + (splitMode ? "cursor-crosshair " : "cursor-grab active:cursor-grabbing ") + c.color + (selIds.includes(c.id) ? " ring-2 ring-ink-900" : "")}
                    style={{ left: c.start * pps, width: Math.max(6, len(c) * pps), top: videoRowTop(c.track) + 3, height: TRACK_H - 6 }}
                  >
                    <div data-handle="in" onPointerDown={trim(c.id, "in")} className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-ew-resize bg-black/30 opacity-0 group-hover:opacity-100" />
                    <div data-handle="out" onPointerDown={trim(c.id, "out")} className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-ew-resize bg-black/30 opacity-0 group-hover:opacity-100" />
                    <span className="truncate px-2 pt-1 text-[10px] font-medium">{c.label}</span>
                    <span className="px-2 pb-0.5 font-mono text-[8px] opacity-80">{len(c).toFixed(2)}s</span>
                  </div>
                  <div className={"pointer-events-none absolute flex items-center gap-1 overflow-hidden rounded-md px-2 opacity-80 " + c.color} style={{ left: c.start * pps, width: Math.max(6, len(c) * pps), top: audioRowTop(c.track) + 6, height: TRACK_H - 12 }}>
                    <Volume2 className="size-3 shrink-0 text-white/90" /><div className="h-2 flex-1 rounded-sm bg-white/30" />
                  </div>
                </div>
              ))}
              {/* drop indicator while dragging a media tile onto the timeline */}
              {dropInfo && (
                <>
                  <div className="pointer-events-none absolute z-30 rounded bg-brand-500/15" style={{ left: 0, top: videoRowTop(dropInfo.track) + 1, width: contentW, height: TRACK_H - 2 }} />
                  <div className="pointer-events-none absolute z-30 w-0.5 rounded bg-brand-500" style={{ left: dropInfo.start * pps, top: videoRowTop(dropInfo.track), height: TRACK_H }} />
                </>
              )}
              {/* magnetic snap guide */}
              {snapX !== null && <div className="pointer-events-none absolute top-0 z-30 w-px bg-brand-500" style={{ left: snapX, height: TRACK_AREA_H }} />}
              {/* marquee selection rectangle */}
              {marquee && <div className="pointer-events-none absolute z-40 rounded-sm border border-brand-500 bg-brand-500/10" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
              {/* selected gap */}
              {selGap && (
                <div className="pointer-events-none absolute z-30 flex items-center justify-center rounded border-2 border-dashed border-brand-400 bg-brand-500/10" style={{ left: selGap.start * pps, top: videoRowTop(selGap.track) + 2, width: Math.max(2, (selGap.end - selGap.start) * pps), height: TRACK_H - 4 }}>
                  <span className="rounded bg-brand-600 px-1 text-[8px] font-medium text-white">gap</span>
                </div>
              )}
              {/* grey cut-preview line while Split is armed */}
              {splitMode && hoverT !== null && (
                <div className="pointer-events-none absolute top-0 z-30 w-px bg-ink-400" style={{ left: hoverT * pps, height: TRACK_AREA_H }}>
                  <Scissors className="absolute -left-[7px] -top-[14px] size-3.5 text-ink-400" />
                </div>
              )}
              <div className="pointer-events-none absolute -top-[24px] z-20 w-px bg-ink-900" style={{ left: playhead * pps, height: TRACK_AREA_H + RULER_H }}>
                <div className="absolute -left-[5px] -top-[1px] size-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-ink-900" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="shrink-0 text-xs text-ink-400">Drag a tile onto the timeline · drag to move (snaps to edges) · drag-select to multi-select · click a gap then Backspace to close it · <span className="font-medium text-ink-500">C</span> = split, <span className="font-medium text-ink-500">V</span> = cursor · Space play/pause · pinch to zoom · Backspace to delete.</p>

      {/* floating drag ghost */}
      {drag && (
        <div className="pointer-events-none fixed z-50 w-24 overflow-hidden rounded-md border-2 border-brand-400 shadow-xl" style={{ left: drag.x + 10, top: drag.y + 10 }}>
          <div className="aspect-video bg-neutral-900"><video src={`${drag.g.outputUrl}#t=0.5`} muted className="h-full w-full object-contain" /></div>
        </div>
      )}
    </div>
  );
}

function ProjectPicker({ onOpen }: { onOpen: (p: Project) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setProjects(loadProjects()); }, []);

  const create = () => {
    const now = Date.now();
    const p: Project = { id: newId(), name: newName.trim() || "Untitled project", clips: [], proj: { w: 9, h: 16 }, updatedAt: now, createdAt: now };
    upsertProject(p);
    setCreating(false); setNewName("");
    onOpen(p);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Projects</h2>
          <p className="text-sm text-ink-500">Open a saved timeline or start a new one.</p>
        </div>
        {!creating && <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition hover:bg-brand-700"><FolderPlus className="size-4" /> New Project</button>}
      </div>

      {creating && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-surface p-3">
          <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") { setCreating(false); setNewName(""); } }} placeholder="Project name" className="flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm focus:border-brand-400 focus:outline-none" />
          <button onClick={create} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">Create</button>
          <button onClick={() => { setCreating(false); setNewName(""); }} className="rounded-lg border border-line px-3 py-2 text-sm text-ink-700 hover:bg-canvas">Cancel</button>
        </div>
      )}

      {projects.length === 0 ? (
        <button onClick={() => setCreating(true)} className="flex w-full flex-col items-center rounded-2xl border border-dashed border-line p-10 text-center transition hover:border-brand-300 hover:bg-surface">
          <Clapperboard className="mb-2 size-8 text-ink-400" />
          <p className="text-sm text-ink-500">No projects yet — create one to start editing.</p>
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {projects.map((p) => (
            <div key={p.id} className="group flex items-center gap-3 rounded-xl border border-line bg-surface p-3 transition hover:border-brand-300 hover:shadow-sm">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Clapperboard className="size-5" /></div>
              <button onClick={() => onOpen(p)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="text-[11px] text-ink-400">{p.clips.length} clip{p.clips.length === 1 ? "" : "s"} · edited {relTime(p.updatedAt)}</div>
              </button>
              <button onClick={() => { if (confirm(`Delete “${p.name}”? This can't be undone.`)) { removeProject(p.id); setProjects(loadProjects()); } }} title="Delete" className="rounded-md p-1.5 text-ink-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"><Trash2 className="size-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Editor() {
  const [open, setOpen] = useState<Project | null>(null);
  if (!open) return <ProjectPicker onOpen={setOpen} />;
  return <EditorWorkspace key={open.id} project={open} onClose={() => setOpen(null)} />;
}
