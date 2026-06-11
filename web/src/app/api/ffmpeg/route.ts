import { spawnSync } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";

export const runtime = "nodejs";
export const maxDuration = 120;

// Single media-processing endpoint. Body: { op, ...params }.
//  - remux:     { sourceUrl, silentUrl }            → mp4 (source audio over silent video)
//  - lastframe: { videoUrl }                        → png (last frame, for scene continuity)
//  - clip:      { videoUrl, start, end, audioOnly } → mp4 trim (or m4a if audioOnly)
//  - compose:   { clips: [{ url, start, end }] }     → mp4 (trim each + concat, normalized 9:16)
export async function POST(request: Request) {
  if (!ffmpegPath) return Response.json({ error: "ffmpeg binary unavailable" }, { status: 500 });
  const body = await request.json();
  const op: string = body.op;
  const id = randomUUID();
  const tmp = (suffix: string) => join(tmpdir(), `${id}-${suffix}`);
  const cleanup: string[] = [];

  const fetchTo = async (url: string, suffix: string) => {
    const path = tmp(suffix);
    const buf = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${suffix} failed (${r.status})`);
      return r.arrayBuffer();
    });
    await writeFile(path, Buffer.from(buf));
    cleanup.push(path);
    return path;
  };
  const run = (args: string[]) => {
    const r = spawnSync(ffmpegPath as string, ["-y", "-loglevel", "error", ...args], { maxBuffer: 1 << 27 });
    if (r.status !== 0) {
      const detail = r.error?.message ?? r.stderr?.toString() ?? `exit ${r.status}`;
      throw new Error(`ffmpeg ${op} failed: ${detail.slice(0, 300)}`);
    }
  };

  try {
    if (op === "remux") {
      const silent = await fetchTo(body.silentUrl, "silent.mp4");
      const source = await fetchTo(body.sourceUrl, "source.mp4");
      const out = tmp("out.mp4");
      cleanup.push(out);
      run(["-i", silent, "-i", source, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-shortest", out]);
      return file(await readFile(out), "video/mp4");
    }
    if (op === "lastframe") {
      const video = await fetchTo(body.videoUrl, "in.mp4");
      const out = tmp("frame.png");
      cleanup.push(out);
      run(["-sseof", "-1", "-i", video, "-frames:v", "1", "-q:v", "2", out]);
      return file(await readFile(out), "image/png");
    }
    if (op === "clip") {
      const video = await fetchTo(body.videoUrl, "in.mp4");
      const start = Number(body.start ?? 0);
      const end = Number(body.end ?? 0);
      const dur = Math.max(0.1, end - start);
      if (body.audioOnly) {
        const out = tmp("clip.m4a");
        cleanup.push(out);
        run(["-ss", String(start), "-t", String(dur), "-i", video, "-vn", "-c:a", "aac", out]);
        return file(await readFile(out), "audio/mp4");
      }
      const out = tmp("clip.mp4");
      cleanup.push(out);
      run(["-ss", String(start), "-t", String(dur), "-i", video, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", out]);
      return file(await readFile(out), "video/mp4");
    }
    if (op === "compose") {
      const clips: { url: string; start?: number; end?: number }[] = body.clips ?? [];
      if (clips.length === 0) return Response.json({ error: "no clips" }, { status: 400 });
      const inputs: string[] = [];
      for (let i = 0; i < clips.length; i++) {
        const p = await fetchTo(clips[i].url, `comp${i}.mp4`);
        const s = Math.max(0, Number(clips[i].start ?? 0));
        const d = Math.max(0.05, Number(clips[i].end ?? 0) - s);
        inputs.push("-ss", String(s), "-t", String(d), "-i", p);
      }
      const out = tmp("composed.mp4");
      cleanup.push(out);
      // project resolution follows the imported video (client passes it); default 720x1280
      const W = Math.max(16, Math.round(Number(body.width) || 720));
      const H = Math.max(16, Math.round(Number(body.height) || 1280));
      const norm = clips
        .map((_, i) =>
          `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}];[${i}:a]aresample=48000[a${i}]`,
        )
        .join(";");
      const concat = clips.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${clips.length}:v=1:a=1[v][a]`;
      run([...inputs, "-filter_complex", `${norm};${concat}`, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", out]);
      return file(await readFile(out), "video/mp4");
    }
    return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    await Promise.allSettled(cleanup.map((p) => unlink(p)));
  }
}

function file(buf: Buffer, type: string) {
  return new Response(new Uint8Array(buf), { status: 200, headers: { "Content-Type": type } });
}
