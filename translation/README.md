# Translation / Dubbing

Translates and dubs short-form UGC videos into other languages — the speech is translated and
re-voiced so the video "speaks" the target language.

> **Status — read this first.** Unlike the caption-removal pipeline, translation does **not** have
> a runnable script yet. It was produced through the **Higgsfield platform (via its MCP tools)**,
> which is interactively authenticated and not scriptable headless. This folder documents the
> working process and ships sample outputs so the quality and approach are clear; productionizing
> it into the app means wiring up **Higgsfield's REST API** (see "Productionization" below).

---

## What works

The core AI video models we use elsewhere (Seedance, Kling, etc.) **do not translate** — they
generate/edit video but have no built-in speech-translation + voice path. **Higgsfield** is the
tool that does: its dubbing / voice tooling translates the speech and re-voices it.

So the rule is: *"make this video speak language X"* → route to **Higgsfield**, not the
video-generation models.

---

## The process

1. **Input:** the source UGC video (with its original-language speech).
2. **Dub via Higgsfield:** submit the video to Higgsfield's dubbing/voice tool with the target
   language. It transcribes, translates, and re-voices the speech.
3. **Long videos — chunk + stitch:** longer clips are processed in **5–10 second segments** and
   then re-joined with **ffmpeg** (`concat`), the same stitching pattern used across our pipelines.
4. **Output:** the video dubbed into the target language.

This was run per-video, per-language. It is a small number of tool calls per video, not a
complex pipeline — the only real friction is the chunk+stitch for longer clips and the fact that
it currently runs through an interactive tool rather than an API.

---

## What's needed

| Need | What for |
|---|---|
| **Higgsfield account / access** | The dubbing + voice tooling that does the actual translation |
| **ffmpeg** | Stitching segmented long-video outputs back together |

Today this is the **Higgsfield MCP** (the claude.ai Higgsfield connector — interactive login).
There is **no API key in this repo**; nothing was scripted headless.

---

## Sample outputs

`samples/` contains one source video (an 11s clip) dubbed into four languages, so you can hear
the quality and confirm the approach:

| File | Language |
|---|---|
| `samples/sample_spanish.mp4` | Spanish |
| `samples/sample_french.mp4` | French |
| `samples/sample_hindi.mp4` | Hindi (non-Latin script) |
| `samples/sample_filipino.mp4` | Filipino |

The **full test set** — 5 source videos × {Spanish, French, Hindi, Filipino} ≈ 24 outputs — lives
in `tests/translation/` in the repo (~440 MB, deliberately not copied here to keep this folder
light for pulling). All came out as expected.

---

## Productionization (how to make this a real pipeline)

To integrate translation into the app as an automated step, replace the interactive MCP with
**Higgsfield's REST API**:

1. Get a **Higgsfield API key** and store it as `HIGGSFIELD_API_KEY` (env var / secret — never
   hardcode).
2. Build a driver that, per video: submits a dubbing job for each target language, polls for
   completion, downloads the result.
3. For long videos, reuse the **chunk-by-frame-then-ffmpeg-concat** pattern from the
   caption-removal and from-scratch scripts (cut on exact frame boundaries, not seconds).
4. Fan languages/videos out in parallel (watch the provider's concurrency / rate limits — the
   Seedance side rate-limited at ~13 concurrent jobs in our testing, so cap accordingly).

Reference for Higgsfield's API: https://higgsfield.ai (see their developer/API docs for the
current dubbing endpoint, request shape, and supported languages).

A driver was intentionally **not** written here because it couldn't be tested without a Higgsfield
API key — shipping an unverified script would be misleading. The process above + the working MCP
tooling is the honest, accurate hand-off.

---

## Limitations / notes

- **Chunking:** longer videos must be segmented and re-stitched; very long clips need care at the
  segment seams.
- **Interactive auth:** the current path needs a human Higgsfield login; it is not yet headless.
- **Lip-sync:** dubbing re-voices the audio; how tightly lips track the new language depends on
  Higgsfield's voice tooling, not on our pipeline.
