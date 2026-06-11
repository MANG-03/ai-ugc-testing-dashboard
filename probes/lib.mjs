// Shared helpers for Phase 0 probes. Plain Node 22 (global fetch, --env-file). No deps.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

export const EVOLINK_BASE = "https://api.evolink.ai/v1";
export const TWELVELABS_BASE = "https://api.twelvelabs.io/v1.3";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function reqEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`\n✗ Missing env var ${name}. Add it to probes/.env.local and re-run.\n`);
    process.exit(1);
  }
  return v.trim();
}

export const optEnv = (name, fallback = "") => (process.env[name]?.trim() || fallback);

export function hr(label = "") {
  console.log("\n" + "─".repeat(64) + (label ? `\n${label}` : ""));
}

export function pretty(obj, max = 4000) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
}

// POST JSON to EvoLink, return { status, json, text }
export async function evolinkPost(path, body, key) {
  const res = await fetch(`${EVOLINK_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// Pull a task id out of a create response regardless of exact field naming
export function extractTaskId(json) {
  return json?.id || json?.task_id || json?.taskId || json?.data?.id || json?.data?.task_id || null;
}

// Poll EvoLink GET /tasks/{id} until terminal. Field names are unconfirmed → we log raw + sniff.
export async function evolinkPollTask(taskId, key, { intervalMs = 5000, maxMs = 360000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(`${EVOLINK_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const status = String(json?.status ?? json?.data?.status ?? "").toLowerCase();
    const secs = Math.round((Date.now() - start) / 1000);
    console.log(`  poll ${secs}s → http ${res.status} status="${status || "?"}"`);
    if (["completed", "succeeded", "success", "done", "failed", "error", "cancelled"].includes(status)) {
      return { status, json, text };
    }
    if (res.status >= 400) return { status: "http_error", json, text };
    await sleep(intervalMs);
  }
  return { status: "timeout", json: null, text: "" };
}

// Find a likely media URL anywhere in a nested response
export function findUrl(obj, ext = "(mp4|mov|webm|m4a|mp3|wav|jpg|png)") {
  let found = null;
  const re = new RegExp(`^https?:\\/\\/[^\\s\"']+\\.${ext}(\\?|$)`, "i");
  JSON.stringify(obj, (k, v) => {
    if (!found && typeof v === "string" && re.test(v)) found = v;
    return v;
  });
  return found;
}

// Download a URL to probes/out/<name>
export async function download(url, name) {
  mkdirSync("out", { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed http ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const path = `out/${name}`;
  writeFileSync(path, buf);
  return path;
}

// Use ffprobe to report whether a media file has an audio stream (+ basic info)
export function ffprobe(path) {
  const r = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,duration",
    "-of", "json", path,
  ], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, error: r.stderr || "ffprobe failed" };
  let info = {};
  try { info = JSON.parse(r.stdout); } catch {}
  const streams = info.streams || [];
  return {
    ok: true,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: streams.some((s) => s.codec_type === "video"),
    streams,
  };
}
