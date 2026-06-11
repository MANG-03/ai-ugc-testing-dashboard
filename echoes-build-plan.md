# Echoes — Phased Build Plan & Risk Register

> Companion to `echoes-spec.md`. Produced after researching the real APIs (EvoLink, Twelve Labs, Seedance/Kling/Wan, Convex).
> **Principle: de-risk the unknowns with throwaway probes BEFORE building the real pipeline.** Several spec assumptions were wrong (see Risk Register). Do not write the full orchestration layer until Phase 0 probes pass.

---

## Decisions (locked)
- **Orchestration LLM:** Gemini via **EvoLink** (`/v1/chat/completions`), multimodal video format found by Phase 0 probe.
- **Generation providers:** **EvoLink — one key confirmed to cover gen + V2V edit for both models.** Seedance edit = `seedance-2.0-reference-to-video` (body documented). Kling edit = `kling-o3-video-edit` (capability confirmed, exact body via live probe). Keep a thin provider abstraction with **fal.ai (Kling O3) as a fallback** only if EvoLink's Kling edit body proves unworkable.
- **Models:** **Seedance 2.0 + Kling O3 only.** Wan cut (fabricated).
- **FFmpeg:** none, except one optional local re-mux for the Seedance audio path. Never in Convex.

## Phase 0 — RESULTS (recorded from live probes, 2026-06-06)

Probes run against real keys with a 9.5s vertical TikTok sample. 4 of 5 fully verified; 2 generation outputs blocked only by EvoLink account credits.

| Probe | Status | Recorded fact |
|---|---|---|
| 1 · Twelve Labs TBM | ✅ **works** | `POST /v1.3/analyze/tasks` (auth `x-api-key`), body `{ model_name:"pegasus1.5", analysis_mode:"time_based_metadata", video:{type:"url", url:<URL>}, response_format:{type:"segment_definitions", segment_definitions:[...]} }` → 202 `{task_id,status}`; poll `GET /analyze/tasks/{id}` `queued→processing→ready` (~16s); result top-level keyed by definition id → `[{start_time,end_time,metadata:{...}}]`. **URL must have a real `content-length`** (catbox's HEAD=0 → `video_file_broken`). |
| 2 · Gemini video | ✅ **works** | model **`gemini-3.1-pro-preview`** (bare `gemini-3.1-pro` = "no available service"). Video part: **`{type:"image_url", image_url:{url:"data:video/mp4;base64,<...>"}}`** — must be **inline base64 data URI** (remote URLs 400), part type is `image_url` not `video_url`. Returned accurate scene-by-scene description. |
| 3 · Seedance V2V | ✅ **works** | `POST /v1/videos/generations` body `{model:"seedance-2.0-reference-to-video", prompt (positional "video 1" refs), video_urls:[<URL>], duration, quality:"480p", aspect_ratio:"9:16", generate_audio:false}` → 200 task; poll `GET /tasks/{id}` `processing→completed` (~3.5 min for 5s@480p); output at `result_data[].url` on `files.evolink.ai`. **AUDIO: output is SILENT with `generate_audio:false`** → Seedance does NOT preserve source audio → **re-mux mandatory.** Respected `duration:5` (output 5.04s). Cost: 55.6 credits. |
| 4 · Kling O3 edit | ✅ **works** | model **`kling-o3-video-edit`**; source param **`video_urls`**; **`quality` 720p/1080p only — NO 480p**; `keep_audio:true` → **AUDIO PRESERVED (no FFmpeg).** ~4 min; output on `*.kechuangai.com` (signed/expiring URL). **`duration` IGNORED — output follows source length** (9.375s, not requested 5s) → bills full source length. Cost: ~81 credits. |
| 5 · FFmpeg re-mux | ✅ **works** | local extract (`-vn -acodec copy`) → overlay (`-c:v copy -c:a aac -shortest`) produces video+audio. Needed for the Seedance path only. |

**✅ Phase 0 COMPLETE — all 5 probes verified. No open unknowns.**

**Facts that change the build:**
- Media to **Gemini** = inline base64 (orchestration base64-encodes the video into the chat request; fine for short TikToks, ~20MB request ceiling).
- Media to **Seedance/Kling/Twelve Labs** = a **fetchable URL with a real `content-length`** → Convex `getUrl()` qualifies; some temp hosts (catbox HEAD=0) don't.
- **Audio:** Seedance path **needs the FFmpeg re-mux** (silent output); Kling path is **clean** (`keep_audio:true`). Confirmed empirically, not assumed.
- **Kling quirks:** min quality 720p (no 480p tier); `duration` ignored (output = source length). Per-model cost + tier handling required.
- Generation output URLs are **on third-party/expiring CDNs** (evolink.ai ~24h, kechuangai signed) → **ingest to Convex immediately** on completion.
- **Timing:** a 5s edit takes ~3.5–4 min → the poll/scheduler pattern is essential; no synchronous requests.
- **Cost reality (per-call, this account's credit units):** Seedance 5s@480p+9.5s input = 55.6; Kling ~9.5s@720p = 81.

## Confirmed API facts (build against these, not the spec's guesses)

### EvoLink (unified — Gemini + generation models)
- Base URL: `https://api.evolink.ai/v1/`  ·  Auth: `Authorization: Bearer <KEY>`  ·  OpenAI-SDK drop-in.
- **Chat / multimodal (Gemini):** `POST /v1/chat/completions`, `model` string selects family (`gemini-3.1-pro` or `gemini-3.1-pro-preview` — verify live). Multimodal via multi-part `content` arrays. Output text-only.
- **Video generation:** `POST /v1/videos/generations` → returns task `id`; poll `GET /v1/tasks/{task_id}` (or `callback_url` webhook). Result URLs expire ~24h → re-ingest to Convex immediately.
- Seedance body (confirmed): `model`, `prompt`, `duration` (4–15s, dflt 5), `quality` (`480p`/`720p`/`1080p`, dflt 720p), `aspect_ratio` (dflt 16:9), `generate_audio` (bool, dflt true).
- **V2V edit IS supported on EvoLink (one key).** Model IDs:
  - Seedance edit/extend: **`seedance-2.0-reference-to-video`** (+ `-fast-` variant). Body: `prompt` (positional refs "video 1"/"audio 1"), `image_urls[]` (0–9), `video_urls[]` (0–3, source goes here), `audio_urls[]` (0–3), `duration`, `quality`, `aspect_ratio`, `generate_audio`. Other Seedance IDs: `seedance-2.0-text-to-video`, `seedance-2-0-image-to-video` (note inconsistent `2.0`/`2-0` dotted-vs-dashed naming — verify literal string live).
  - Kling edit: **`kling-o3-video-edit`** (siblings: `kling-o3-text-to-video`, `-image-to-video`, `-reference-to-video`). Exact edit body (source-video param, `keep_audio`) NOT in public docs → live probe; likely mirrors Seedance `video_urls`. fal.ai O3 schema is the documented fallback.
- 💰 **EvoLink bills input reference-video duration ON TOP of output duration** — factor into cost estimates (V2V always sends a source video).
- ⚠️ **Two remaining live probes:** (a) Gemini chat multimodal video content-part JSON shape (only in authenticated playground — NOT public); (b) Kling O3 edit exact request body.

### Twelve Labs (Pegasus 1.5 — the "what")
- Base: `https://api.twelvelabs.io/v1.3`  ·  Auth: `x-api-key: <KEY>`  ·  Python SDK `twelvelabs` recommended.
- TBM flow (confirmed real): `client.analyze_async.tasks.create(video=..., model_name="pegasus1.5", analysis_mode="time_based_metadata", response_format=AsyncResponseFormat(type="segment_definitions", segment_definitions=[...]))` → poll `.retrieve(task_id)` until `status=="ready"` → `json.loads(task.result.data)` (keyed by definition id; each segment has `start_time`, `end_time`, `metadata`).
- Schema is **`segment_definitions`** (≤10 defs, ≤20 fields each; types string/boolean/number/integer/array + enum), NOT a raw JSON Schema. Field descriptions ARE the prompt.
- `min_segment_duration` (≥2.0) / `max_segment_duration` real & optional. No pre-indexing needed for Pegasus analysis. Video can be URL/asset/base64; up to 2h.
- ⚠️ `/gist` & `/summarize` were sunset **Feb 15 2026** (already past) — use `/analyze` only.

### Generation models
- **Seedance 2.0:** real via fal/Segmind/WaveSpeed (no direct ByteDance API). Modes: t2v, i2v, reference-to-video (omni `@Image1`/`@Video1`/`@Audio1`), V2V `video-edit`. Refs: 9 img / 3 vid / 3 audio / 12 total (confirmed). `first_frame_url` ⟂ `reference_images` (confirmed). **No `keep_audio`** — `generate_audio:false` preserves source audio on V2V. 15s max confirmed. Pricing provider-specific; spec's $0.074/$0.161 unconfirmed.
- **Kling O3:** CONFIRMED callable. Build against **fal.ai `fal-ai/kling-video/o3/pro/video-to-video/edit`** (only provider with a full OpenAPI schema). Fields: `prompt` (req, **maxLength 2500** — confirmed), `video_url` (req, .mp4/.mov, **3–10.05s**, 720–2160px, 24–60fps, ≤200MB), `image_urls[]` (`@ImageN`), `elements[]` (`frontal_image_url` + 1–3 `reference_image_urls`, `@ElementN`), **`keep_audio` bool dflt `true`** (native source-audio preservation — no FFmpeg on Kling path), `shot_type` const `"customize"`. Hard rule: `len(image_urls)+len(elements) ≤ 4`. Output duration/AR follow the source. ~$0.168/sec. (Segmind & Replicate also expose O3 but with different/looser param sets; Replicate uses `generate_audio`/`keep_original_sound`, not `keep_audio`.)
- **~~Wan 2.7~~ — CUT.** Verified fabricated: official Wan-Video GitHub / Wan-AI HF top out at **Wan 2.2**; "2.7" (and "2.6") don't exist as official releases; reseller "wan-2.7" endpoints have empty schemas. Real Wan 2.2 has **no free-text V2V edit endpoint** (closest is Animate-14B, reference-driven character transfer). **Dropped from the build.** Revisit only if a true Wan instruction-edit model ships.

### Convex
- `ctx.storage.getUrl(storageId)` → **public, no-auth, permanent** URL. Solves external-API media access natively (Open Q #3 resolved). Treat as bearer secret.
- Upload: `generateUploadUrl()` (mutation, 1h expiry) → client POST → `storageId`. Ingest external result: `ctx.storage.store(blob)` in an action.
- **Actions** = only place that can `fetch` external APIs. 10-min timeout, 64MB (512MB with `"use node"`). **No system FFmpeg.**
- Polling pattern: action fires job → `ctx.scheduler.runAfter` re-schedules itself to poll → ingest on completion. Crons for stuck-job sweeps. Workflow/Workpool component for >10-min durable pipelines.

---

## Risk Register (highest first)

| # | Risk | Why it matters | De-risk action (phase) |
|---|------|----------------|------------------------|
| R1 | ~~FFmpeg can't run in Convex~~ **DOWNGRADED** | FFmpeg never needed to be in Convex. For a local dashboard it runs as a plain local process (Next.js API route → system `ffmpeg` binary), result uploaded to Convex after. **Better: we aim to need *no* FFmpeg at all initially** (see "FFmpeg minimization" below). | No worker, no Convex constraint. Only add FFmpeg if a probe proves it's required. (deferred) |
| R2 | **EvoLink Gemini multimodal video content-part format unknown** | Blocks the entire "Gemini watches the video" planning step (both pipelines). | Phase 0 probe: try OpenAI-style `video_url`, Google-style `file_uri`/`inline_data`, and a hosted Convex URL. Find the format empirically against the live key. |
| R3 | ~~EvoLink V2V-edit unconfirmed~~ **RESOLVED — one key covers gen + edit.** | — | Seedance edit `seedance-2.0-reference-to-video` (body documented); Kling edit `kling-o3-video-edit` (body via live probe, fal.ai fallback). Provider abstraction retained for the Kling fallback only. |
| R4 | **Gemini JSON plan reliability** (Open Q #6) | Orchestration executes the plan mechanically — invalid JSON = broken run. | Phase 2: define a strict plan JSON schema, use structured-output/`response_format` if EvoLink supports it, validate with Zod, add a repair retry. |
| R5 | ~~Wan 2.7 may not exist~~ **RESOLVED — Wan 2.7 is fabricated, CUT from build.** | — | Ship **Seedance + Kling O3** only. |
| R6 | **Result URL expiry (24h EvoLink / transient)** | Lose outputs if not ingested. | Always `ctx.storage.store()` the result immediately on poll-complete. |
| R7 | **Long pipelines exceed 10-min action limit** | Pipeline A multi-scene chains + polling. | Self-rescheduling poll actions (each poll = fresh invocation) or Workpool component. |

---

## Architecture (corrected)

```
Next.js UI ──useQuery/useMutation──▶ Convex (DB + file storage + orchestration brain)
                                          │  actions: call Twelve Labs, EvoLink; scheduler: poll
                                          │  storage.getUrl() → public media URLs for external APIs
                                          ▼ (only if a probe proves FFmpeg is needed)
                                   Local FFmpeg (Next.js API route → system ffmpeg) → upload result to Convex
```
- **Convex** = database, file storage, orchestration + polling (actions/scheduler).
- **Next.js** = 4 views (reactive via Convex queries) + optional local FFmpeg API route.
- **No separate worker.** FFmpeg, if ever needed, is a local process whose output is uploaded to Convex.

### FFmpeg minimization (design decision — start with none)
The goal is to ship the testing phase with **zero FFmpeg**:
- **Pipeline B:** send the whole source video to the V2V model.
  - **Kling O3 path:** `keep_audio:true` natively preserves source audio → **zero FFmpeg.** (Confirmed.)
  - **Seedance path:** native preservation is NOT reliable (only WaveSpeed documents `generate_audio:false`=preserve; EvoLink/fal/Segmind unconfirmed, likely silent). The user's Higgsfield "keeps audio" experience is most likely reference-audio-guided regeneration or Higgsfield re-muxing, not API-native passthrough. → Use `generate_audio:false` **+ one local FFmpeg re-mux** (extract source audio once, overlay onto output) as the guaranteed-fidelity safety net. This is the single FFmpeg step in the whole build.
- **Pipeline A:** during testing, **skip final concat** — review each generated scene as its own tile. Gemini still watches the full video for planning.
- ⚠️ **Caveat (test, don't assume):** generation models cap reference *video* duration (Seedance: 3 videos / 15s combined). For source videos longer than that cap, you cannot pass the whole clip as a generation reference — Gemini gets the full video for planning, but a per-scene generation call may need a trimmed clip. If hit, that's the *one* place a local FFmpeg trim re-enters. Probe with a real >15s TikTok before deciding.

---

## Phases

### Phase 0 — Probes (throwaway scripts, no UI, no DB). **Gate before anything else.**
Goal: close the 2 remaining live unknowns + confirm each integration with real keys. Needs: EvoLink key, Twelve Labs key, one sample TikTok (incl. one >15s clip), one hosted video URL.
1. **Twelve Labs TBM** — `analyze_async` on a sample with a 2-field `segment_definitions`; confirm timestamped output. (Low risk — spec validated.)
2. **EvoLink Gemini multimodal video** (unknown #1) — send a hosted video + text to `/v1/chat/completions`; iterate content-part shapes (OpenAI `image_url`-style vs `video_url`-style vs file part) until it returns a description. **Record the exact working JSON.**
3. **EvoLink Seedance V2V edit** — `seedance-2.0-reference-to-video` with source in `video_urls`, `generate_audio:false`; confirm task lifecycle, result URL, and **what happens to source audio** (silent vs preserved). Determines if the re-mux is needed.
4. **EvoLink Kling O3 edit** (unknown #2) — `kling-o3-video-edit`; discover the source-video param name + whether `keep_audio` works. If unworkable, fall back to fal.ai `fal-ai/kling-video/o3/pro/video-to-video/edit` (documented schema).
5. **Local FFmpeg re-mux** — extract audio from source, overlay onto a generated clip, upload result to Convex. Only needed if probe 3 shows Seedance output is silent.
**Exit criteria:** probes 1–4 return usable output and their exact request/response shapes are documented here; decide whether probe 5 (re-mux) is required.

### Phase 1 — Foundation  🟡 SCAFFOLDED (in `web/`, Next 16 + Convex 1.40; pending `npx convex dev` login)
- ✅ Next.js app in `web/`; ConvexClientProvider wired in `layout.tsx`.
- ✅ Convex schema: all 5 tables (`sourceVideos`, `generations`, `geminiPlans`, `promptSkills`, `experiments`) with `storageId: v.id("_storage")`.
- ✅ Keys via Convex deployment env (`npx convex env set …`), not client/hardcoded. (Settings UI deferred.)
- ✅ Upload & Analyze view: drop zone → `generateUploadUrl` → store → `createSourceVideo`; "Run Pegasus Analysis" action (confirmed TBM shape, full §8 schema) → live scene breakdown. Thumbnail deferred.
- ✅ Verified: schema + functions deployed clean, frontend typechecks, UI serves (HTTP 200), upload→storage→functions work end-to-end.
- ⚠️ **Local vs cloud:** `convex dev` defaulted to a LOCAL deployment → `getUrl()` returns `127.0.0.1` URLs that external APIs can't fetch (proven: Pegasus would fail). **Pegasus/generation require a CLOUD deployment** (`npx convex login` then `npx convex dev`). Local is fine for UI work. Browser also loads localhost media fine, so the in-app player works locally.

### Phase 2 — Understanding + Planning (the brain)  ✅ DONE (verified locally)
- ✅ Pegasus TBM action (Phase 0 shape, full §8 schema) → `sourceVideos.pegasusAnalysis`; scene-by-scene UI.
- ✅ `promptSkills` seeded (Seedance + Kling O3, from confirmed facts), versioned/`isActive`, editable mutation (`saveVersion`).
- ✅ `models.ts` = confirmed-facts source of truth; `planSchema.ts` = zod + JSON-schema for the plan.
- ✅ Gemini planning action (`gemini.ts`, `"use node"`, base64 video) → strict plan JSON, zod-validated, **repair-retry** on failure → `geminiPlans`.
- ✅ Generation Studio UI: pipeline/model selectors, prompt composer, "Plan with Gemini", plan preview.
- ✅ **R4 RESOLVED** — local test produced a valid plan honoring every model constraint (Seedance 480p+remux, Kling 720p+keep_audio). Dev path (`devSetPegasus`) lets planning be tested locally without cloud Pegasus.

### Phase 3 — Execution (Pipeline B)  ✅ BUILT (deploy-tested)
- ✅ `generate.ts`: `runPlan` action (review-then-run gate → explicit "Run plan" button; whole plan at once) creates a `generations` row per call + schedules `executeCall` per call (parallel, self-polling). Per-call/per-model granularity intentionally deferred.
- ✅ `executeCall` internalAction: builds confirmed EvoLink body per model → `POST /v1/videos/generations` → poll `/tasks/{id}` → ingest result to Convex storage (R6). Kling `keep_audio:true` (native audio); Seedance `generate_audio:false` → re-mux via `/api/remux` (`REMUX_URL`) or store silent + flag if unset.
- ✅ `/api/remux` Next route (ffmpeg-static, node runtime): overlays source audio onto the silent Seedance clip.
- ✅ Generation tiles UI: real-time status, inline player, cost/credits + time, star rating, expandable audit trail (user prompt, translated prompt, API params, media refs, split rationale).
- ✅ **No Wan** (cut, R5).
- ⚠️ **Deploy-tested:** execution fetches the source video by URL → needs CLOUD Convex (public `getUrl()`). Set `REMUX_URL` (Convex env) to the deployed `/api/remux` for the Seedance audio path. Pipeline A multi-scene continuity = Phase 4.

### Phase 4 — Pipeline A (multi-scene regen)  ✅ BUILT (deploy-tested)
- ✅ Avatar-reference upload in the composer → stored on the plan → passed as image refs to generation.
- ✅ Per-scene reference realization from plan `mediaSegments`: scene clip + scene audio via `/api/ffmpeg` (`clip`).
- ✅ Continuity chaining: per-model **sequential** scene chains (last frame of scene N → image ref into N+1 via `/api/ffmpeg` `lastframe`), models run **in parallel** (Open Q #9). Seedance audio re-muxed per-scene; Kling `keep_audio`.
- ⚠️ Continuity is the one runtime piece with no probe — expect a round of iteration post-deploy. Final concat deferred (review per-scene tiles).

### Phase 5 — History, comparison, skills, polish  ✅ BUILT
- ✅ Experiment History view: filter by pipeline/model/status; side-by-side comparison (2–3) with synced play/pause/restart.
- ✅ Prompt Skills view: list active skills, edit content, save as new version (`saveVersion`).
- ✅ All 4 nav views live; hash-deep-linkable.

## DEPLOYED + smoke-tested (2026-06-06)
- ✅ **Convex prod:** `cheerful-whale-910.convex.cloud` (project `armaan-manji/echoes`). Schema + functions deployed; env set: `EVOLINK_API_KEY`, `TWELVELABS_API_KEY`, `FFMPEG_URL`; prompt skills seeded.
- ✅ **Vercel:** `armaan-manjis-projects/echoes-dashboard` → **https://echoes-dashboard-armaan-manjis-projects.vercel.app** (public; deployment protection disabled). `NEXT_PUBLIC_CONVEX_URL` set to the cloud deployment.
- ✅ **`FFMPEG_URL`** = `https://echoes-dashboard-armaan-manjis-projects.vercel.app/api/ffmpeg` (stable prod alias → survives redeploys).
- ✅ **End-to-end smoke test PASSED:** upload → Pegasus (24s) → Gemini plan → Seedance fired → completed (249s), output had **video+audio** (FFmpeg re-mux confirmed on Vercel). Cost 76.68 credits.
- ⏳ Not yet exercised on cloud: **Kling** path (low-risk, native `keep_audio`) and **Pipeline A continuity** (the flagged unproven piece) — testable now from the live UI.
- Notes: Vercel deploy doesn't need rebuild when `FFMPEG_URL` changes (Convex runtime env). Per-generation cost ≈ 55–81 credits.

---

## Immediate next step
Run **Phase 0 probes**. They need real EvoLink + Twelve Labs API keys and one sample TikTok video. Nothing else should be built until R2/R3 are resolved, because the Gemini multimodal format and the V2V provider choice change the shape of every downstream integration.
