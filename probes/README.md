# Echoes — Phase 0 Probes

Throwaway scripts that turn the remaining unknowns into recorded facts **before** we build the real app.
No UI, no database — each makes one real API call and prints what came back. Plain Node 22, **no `npm install`**.

## Setup
1. Open `.env.local` and paste your two keys:
   - `EVOLINK_API_KEY`
   - `TWELVELABS_API_KEY`
2. (Optional) Replace `SAMPLE_VIDEO_URL` with a **public** URL to a short (3–10s) vertical TikTok clip **with audio**.
   The default is a public ~15s sample so things run out of the box. (Kling requires 3–10.05s — see probe 4.)

## Run (from this folder)
```bash
npm run probe:tbm        # 1 · Twelve Labs Pegasus TBM — timestamped scene data
npm run probe:gemini     # 2 · EvoLink Gemini — which content-part shape makes it watch a video  ← #1 unknown
npm run probe:seedance   # 3 · EvoLink Seedance V2V — does generate_audio:false keep source audio?
npm run probe:kling      # 4 · EvoLink Kling O3 edit — source-video param + keep_audio            ← #2 unknown
npm run probe:remux      # 5 · Local FFmpeg extract→overlay (only needed if probe 3 was silent)
```
(Equivalently: `node --env-file=.env.local 02-gemini-video.mjs`.)

## What each answers
| # | Probe | Records | Why it can't be web-researched |
|---|-------|---------|--------------------------------|
| 1 | TBM | working `video` field shape; where timestamped data lives | low risk — confirms the spec |
| 2 | Gemini video | the exact video content-part JSON | **only behind the authenticated API** |
| 3 | Seedance V2V | silent vs audio-preserved output → re-mux needed? | it's a runtime **behavior**, not documented |
| 4 | Kling O3 edit | source-video param name + keep_audio | EvoLink doesn't publish the edit body |
| 5 | FFmpeg re-mux | that extract→overlay works locally | sanity check of the one FFmpeg step |

## Notes
- Probes 3 & 4 make **real billable** generation calls (kept tiny: 480p, 5s). EvoLink also bills the input video's duration.
- Outputs download to `out/` (gitignored) for `ffprobe` audio inspection.
- Several probes try multiple shapes and log each — the error bodies are the point; they reveal the real field names.
- If a model id is rejected, the live catalog may use a slightly different string (e.g. `2.0` vs `2-0`); override via env (`GEMINI_MODEL`, `SEEDANCE_EDIT_MODEL`, `KLING_EDIT_MODEL`).
