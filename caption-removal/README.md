# Caption Removal Pipeline

Removes burned-in captions (text baked into the video pixels) from short-form vertical videos
without damaging faces, bodies, product labels, or real background text. Self-verifying and
adaptive — it checks its own output with OCR and only escalates on the frames that need it.

This folder is a self-contained hand-off of the working pipeline so it can be integrated into the
app. It is **not** wired into the Convex/Next app — it runs standalone on cloud GPUs (Modal).

---

## What it does

Input: a video with burned-in captions. Output: the same video with the captions cleanly removed.

It works by:
1. **OCR** finds the caption text on every frame and a "caption-band" filter isolates only the
   caption region (so product names / wall text are preserved).
2. A precise **glyph-level mask** is built covering only the caption letters.
3. **ProPainter** (flow-based video inpainting) rebuilds just those pixels — it copies real
   surrounding pixels, so everything not masked is untouched.
4. The result is **re-OCR'd to verify**. If any caption text survived, it escalates — only on the
   flagged frames — first with a second ProPainter pass, then (rarely) a **VOID** diffusion fill
   for frames with no clean reference. No human review needed.

---

## Prerequisites & API keys

| Need | What for | How to get it |
|---|---|---|
| **Modal account** | Runs all the GPU compute (OCR on L4, ProPainter on A100) | https://modal.com → `pip install modal` → `modal token new` |
| **fal.ai API key** | Only the rare VOID escalation step (diffusion inpaint) | https://fal.ai → dashboard → API key |

Set the fal key as a **Modal secret** (never hardcode it):

```bash
modal secret create fal FAL_KEY=<your-fal-key>
```

For running the standalone `components/void_composite.py` locally, instead set it as an env var:
`export FAL_KEY=<your-fal-key>`.

> **Cost:** Modal bills per-second of GPU use. Typical clip is a few cents. L4 ≈ $0.80/hr,
> A100 ≈ $2.10/hr — billed only while a job runs (no idle cost unless you pre-warm the pools).

---

## Setup

```bash
pip install modal
modal token new                       # one-time auth
modal secret create fal FAL_KEY=xxxx  # for the VOID step
```

The pipeline self-provisions everything else: the Modal image clones ProPainter and installs all
Python deps on first run, and model weights are cached in Modal Volumes (`propainter-weights`,
`easyocr-models`), which are created automatically.

---

## How to run

```bash
modal run pipeline/modal_pipeline.py --video "/path/to/input.mp4" --out "/path/to/output.mp4"
```

First run is slower (cold-start: pulls the GPU image, downloads model weights). Subsequent runs
reuse the warm pools.

---

## Architecture

One Modal app, three compute tiers running in parallel — each job matched to the cheapest GPU
that can do it:

```
 CPU orchestrator (Cleaner) ── coordinates, builds masks (numpy), composites, ffmpeg. No GPU.
        │
        ├── ocr_batch  (L4 pool)   — parallel OCR. Frames fanned out in small batches.
        │                             mask = every frame; verify = every 2nd frame.
        ├── pp_chunk   (A100 pool) — parallel ProPainter. Frame-exact chunks, one per container.
        └── VOID (fal, external)   — diffusion fill, only the rare hard path.
```

Adaptive, OCR-gated flow (each escalation runs ONLY on the shrinking flagged window):

```
normalize → mask → ProPainter pass 1 → OCR verify
                          └─ residual? → segmented ProPainter pass 2 → verify
                                              └─ residual? → VOID composite → verify
```

**Why split GPUs:** OCR is light (L4 is plenty, ~⅓ the cost of an A100); ProPainter is heavy
compute + memory (needs A100). Running many cheap L4 containers in parallel beats one expensive
GPU for the OCR fan-out. Use **A100, not H100** — H100s are scarce on Modal and cold-start badly.

---

## Files in this folder

| Path | Role |
|---|---|
| `pipeline/modal_pipeline.py` | **The pipeline.** Self-contained consolidated app — run this. |
| `components/modal_mask.py` | Standalone OCR glyph-mask generator (band detection + glyph extraction). Reference / debugging. |
| `components/modal_verify.py` | Standalone OCR "judge" — flags surviving caption text in the band. Reference. |
| `components/modal_propainter.py` | Standalone ProPainter harness on Modal (A100). Reference. |
| `components/void_composite.py` | Standalone VOID escalation — windowed diffusion fill + feathered composite. Reference. |
| `METHOD.md` | Deep-dive on the method: approaches tried, why each stage exists, gotchas, timing. |

The pipeline folds the components' logic into one app; the `components/` files are kept for
reference and isolated testing.

---

## Performance (measured, warm, 720×1280)

| Case | Time |
|---|---|
| Common (clean after pass 1) | **~3–4 min** |
| Hard (escalates through VOID) | **~7–8 min** |

ProPainter is the floor (~63% of the time). The pipeline is throughput-optimized: Modal
auto-scales the pools, so a batch of N videos streams through in parallel.

**Cold-start note:** the first job after idle warms the GPU pools (~minutes, mostly the ProPainter
image pull). Within a batch only the first video pays it. For production, fire a pool warm-up at
job start (in parallel with earlier app steps) so it's hidden — captions are a once-per-source step.

---

## Integration notes

- The entrypoint is `modal_pipeline.py::main(video, out)`. To call it from the app, either shell
  out to `modal run …`, or import the Modal functions and call `.remote()` from your backend.
- Input must be a standard mp4. The pipeline normalizes to 30fps CFR internally.
- It's **stateless** per video — safe to fan many out concurrently.
- The only external dependency is fal (VOID), hit only on hard clips; everything else is on Modal.

---

## Limitations

- Captions over **complex moving geometry** (a caption sitting on a moving hand/product reveal)
  are the hard case — handled by the VOID escalation, which introduces ~1s of mild softness on
  the patched window only.
- The OCR caption-band filter assumes captions occupy a consistent vertical band (true for
  TikTok/Reels style). Wildly roaming captions would need the band logic relaxed.
- English OCR by default (`easyocr.Reader(["en"])`). Add languages in `ocr_batch` if needed.
