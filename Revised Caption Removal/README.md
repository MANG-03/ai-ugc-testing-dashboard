# Revised Caption Removal

A pipeline that removes **burned-in captions** (TikTok/Reels-style subtitle text baked into the pixels)
from short vertical videos, while **preserving everything else** — the people, their faces, the
microphone, product bottles, and the background.

It is designed for the hard case that defeats most tools: **captions sitting on a busy, moving
surface** (e.g. a printed graphic t-shirt), where classic inpainters smear.

> **Status (read this first):** This works very well on relatively *static* footage (talking-head with
> the caption over a chest/shirt). It does **not** yet generalize to very *dynamic* footage — see
> **Known Limitations**. This is a working prototype, not a finished product.

---

## How it works (3 steps)

1. **Locate the caption box.** Run OCR on a *sample* of frames (not every frame) to find the one
   screen region where captions consistently sit. Captions are screen-fixed, so they cluster at one
   spot; the moving mic/products scatter and are ignored. Output: a single **fixed rectangle** (locked
   X/Y/W/H) that is turned **on for the whole video**.
2. **Inpaint the box.** Send the video + the fixed-box mask to **LTX-2.3 video inpainting** on
   **fal.ai** (`fal-ai/ltx-2.3-quality/inpaint`, mask convention: WHITE = regenerate). LTX regenerates
   the box region on every frame — removing the caption and reconstructing what's behind it.
3. **Mask-only composite with a fade.** Keep **every original pixel** and replace **only** the box
   region with LTX's output, blended with a **soft gaussian fade** at the box edges. This preserves the
   original quality everywhere except the caption strip and hides the box seam. Then re-mux the
   original audio.

The mask location runs on a **Modal L4 GPU** (EasyOCR). The inpaint runs on **fal.ai**. Everything else
is `ffmpeg`.

---

## Why it's built this way (hard-won lessons — so you don't repeat them)

- **ProPainter (flow-based inpainting) smears captions on busy/moving backgrounds.** It copies pixels
  and needs a clean reference; where the caption always covers a busy surface, it ghosts/garbles. We
  replaced it with **LTX-2.3**, which is *generative* and reconstructs the surface. (Bria
  `video-erase-object` on Replicate also works but is $ and 5s-capped; Kling `kling-o3-video-edit` on
  EvoLink removes captions in one prompt-driven call but is a full regenerator with drift.)
- **Per-frame OCR masks WANDER.** A mask drawn wherever OCR finds text each frame drifts onto the
  moving mic/product text, and LTX then re-paints (and *melts*) those objects. **A fixed box locks the
  position** so the mask can't chase the mic, and because the box sits at the caption spot (not where
  the products are held), the products are never re-painted → no smear.
- **Use LTX's output only inside the mask.** LTX subtly re-renders the *whole* frame; if you use its
  full frame, the whole video looks softer. The **mask-only composite** keeps the pristine original
  everywhere but the caption.
- **Fade the box edges.** A hard-edged box shows a visible rectangle where LTX's tone differs slightly
  from the original. A soft gaussian feather blends it away.
- **OCR is only needed to *locate* the box, not per frame.** Since the box is fixed and always-on, you
  only OCR a handful of sampled frames to find where captions sit. This is `boxmask_v4.py` and takes
  seconds instead of minutes.

---

## Requirements

- **Python 3.10+** with the Modal CLI: `pip install modal` then `modal token new` (authenticate once).
- **fal.ai account** + API key. Export it: `export FAL_KEY=...` (the scripts read `FAL_KEY` from the
  environment — no key is hardcoded).
- **ffmpeg** and **ffprobe** on your PATH.
- Internet access to Modal (OCR GPU) and fal.ai (LTX inpaint).
- First run auto-creates a Modal Volume `easyocr-models` (caches the EasyOCR weights).

Cost: the fal LTX inpaint is the only paid step. Rough estimate **~$0.10–$3.82 per ~33s video**
depending on fal's billing basis (per-MP-second vs per-output-frame) — **confirm the exact number in
your fal.ai dashboard** (balance before/after a run). Mask location on Modal L4 is cents.

---

## Files in this folder

| File | What it is |
|---|---|
| `run_pipeline.sh` | **Start here.** End-to-end: normalize → build mask → LTX inpaint + fade → output. |
| `boxmask_v4.py` | **Recommended mask.** Modal app. OCRs ~50 *sampled* frames to locate the caption box, then emits an always-on fixed-box mask video. Fast (seconds of OCR). |
| `boxmask_v3.py` | Alternate mask. OCRs *every* frame with a position-stability filter (moving mic/products are excluded, so the box is tighter). More accurate box but slow (~12 min OCR on a 43s clip). |
| `ltx_run_fade.py` | The inpaint+composite runner. Chunks video+mask into ≤300-frame pieces, submits all to fal LTX concurrently, concatenates, does the **mask-only fade composite**, and re-muxes the original audio. Parameterized via env: `VIDEO`, `MASK`, `AUDIO_SRC`, `OUT`, `FAL_KEY`. |
| `modal_pipeline_ltx.py` | **Alternate / more advanced variant.** A full Modal app with a *variable* box mask + LTX + an OCR-**verify loop** that re-detects residual caption frames and re-inpaints just those (best-so-far + window-persistence stop). Handles brief 1–2 frame "flash" captions that the fixed box can miss, but re-introduces the moving-object re-paint problem the fixed box solved. Reference; not the default. Run: `python -m modal run modal_pipeline_ltx.py --video <in> --out <out>`. |

---

## How to run

```bash
export FAL_KEY=your_fal_key
./run_pipeline.sh input.mp4 output.mp4
```

Or the three steps manually:

```bash
# 1) normalize to 30fps CFR
ffmpeg -i input.mp4 -r 30 -c:v libx264 -crf 18 -pix_fmt yuv420p -an cfr.mp4

# 2) locate + build the fixed-box mask (Modal L4)
python -m modal run boxmask_v4.py --video cfr.mp4 --out mask.mp4          # add --overlay ov.mp4 to eyeball the box

# 3) LTX inpaint + fade composite + audio
FAL_KEY=... VIDEO=cfr.mp4 MASK=mask.mp4 AUDIO_SRC=input.mp4 OUT=output.mp4 python ltx_run_fade.py
```

**Always eyeball the mask overlay first** (`--overlay ov.mp4` in step 2) — it's free and confirms the
box landed on the captions (and not on a mic/product) before you spend on the LTX run.

---

## Parameters / tunables

**`boxmask_v4.py` / `boxmask_v3.py`** (`--flag` on the `modal run`):
- `--band_lo 0.40 --band_hi 0.76` — vertical search range for the caption row (fraction of height). The
  dominant cluster inside this becomes the box's Y.
- `--cx_lo 0.15 --cx_hi 0.85` — horizontal search range.
- `--pad 22` — pixels of margin around the detected caption extent. Needs to be ≥ the composite feather
  so the fade doesn't expose caption edges.
- `--n_samp 50` (v4 only) — how many frames to sample for OCR.

**`ltx_run_fade.py`** (edit the constants near the top):
- `CH = 300` — frames per fal chunk (chunks run concurrently).
- `num_inference_steps = 20`, `video_quality = "high"`, `video_strength = 1.0` — LTX quality knobs.
  Lowering `video_strength` makes LTX change the box *less* (keeps more original) — reduces smear on
  dynamic content but risks leaving faint caption.
- The composite feather is `gblur=sigma=11` in the final `ffmpeg` filter — raise it for a softer fade.

---

## Known limitations & current status

- **Works well:** static/talking-head footage. On the reference clip `6954` (man in a graphic
  Pulp-Fiction shirt) the captions come off cleanly — including the ones *on the busy shirt* — the mic
  and product bottles are preserved, and quality/dimensions are untouched.
- **Fails on very dynamic footage:** on the reference clip `9284` (fast movement, products rising into
  frame, background people) the always-on box forces LTX to regenerate a busy *moving* strip every
  frame, which it does badly → **green smears and garbled content**. The fixed box is only as good as
  LTX's ability to re-render whatever is inside it; on dynamic content that's poor. This is the main
  open problem. Candidate fixes (untested): tighter box (mask only the caption glyphs at the fixed
  position, not the whole strip); lower `video_strength`; or gate the box off during no-caption
  stretches.
- **Brief "flash" captions** (1–2 frames) can slip through the fixed box. The `modal_pipeline_ltx.py`
  verify-loop variant catches these but has the moving-object re-paint tradeoff.
- **`boxmask_v4` (sampled) vs `boxmask_v3` (per-frame):** v4 is ~10× faster but its box can come out
  *wider* because, without consecutive frames, it can't run the moving-object filter — so a product at
  the caption row can widen the box. v3 is tighter but slow. For most videos use v4 and check the
  overlay; use v3 if the box is too wide.
- **Timing:** ~15 minutes for a 33s clip (the fal LTX passes dominate wall-clock; an occasional fal
  chunk stalls and drags a run to ~25 min). Mask location is seconds (v4).
- **Cost:** see Requirements — confirm the exact fal $/run from the dashboard.

---

## Differences from the Original Pipeline

The **original** pipeline is `tests/captions/modal_pipeline.py` in the parent project.

**Original pipeline did:**
- **X — OCR *glyph* mask, every frame.** Built a per-frame mask of the actual caption letter shapes
  (color + edge cues) wherever OCR found text.
- **Y — ProPainter inpainting on a self-hosted Modal A100 GPU.** Flow-based video inpainting, chunked,
  with a targeted re-paint loop (verify → re-mask failed windows → re-ProPainter) and a Netflix **VOID**
  diffusion fallback for the hardest windows.
- **Z — OCR-verify loop with escalation.** Ran OCR on the output to find residual captions and
  re-processed only the flagged windows, escalating ProPainter→VOID.

**This revised pipeline does:**
- **A — OCR only to *locate* a fixed box.** OCR is used on a *sample* of frames purely to find *where*
  captions sit; then a single fixed rectangle is masked for the whole video. No per-frame glyph mask.
- **B — LTX-2.3 generative inpainting on fal.ai (external API).** No self-hosted GPU inpainting; the
  box is regenerated by LTX, which reconstructs busy/moving surfaces that ProPainter smeared.
- **C — Mask-only composite with a soft fade.** Only the box region of LTX's output is composited back
  over the pristine original, feathered — preserving original quality/dimensions everywhere else.

**Net differences:**
1. **Inpainter:** ProPainter (flow-based, self-hosted Modal A100) → **LTX-2.3 (generative, fal.ai API)**.
   This is what actually solved the caption-on-busy-shirt case ProPainter could not.
2. **Mask:** variable per-frame *glyph* mask that chased OCR (and wandered onto the mic/products) →
   **one fixed always-on box** that can't wander and avoids the mic/products by position.
3. **Compositing:** used the inpainter's full frame → **mask-only composite + fade**, so the rest of the
   video stays pixel-original and there's no visible seam.
4. **Verify loop:** the original leaned on a heavy OCR-verify + ProPainter/VOID escalation loop; the
   revised *default* (fixed box) drops the loop entirely for simplicity/stability (the
   `modal_pipeline_ltx.py` variant keeps an LTX verify-loop if you need residual-frame cleanup).
5. **Where the compute runs:** original inpainting was self-hosted on Modal GPUs; revised inpainting is
   an external fal.ai API call (Modal is now only used for the lightweight OCR box-location step).

The tradeoff: the revised pipeline is simpler, preserves quality better, and cracks the busy-shirt
case — but the always-on box's whole-strip re-render is not robust on very dynamic footage yet (see
Known Limitations), whereas the original's tighter glyph mask disturbed less of the frame.
