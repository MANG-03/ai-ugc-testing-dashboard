# Caption Removal Pipeline — How It Works

_Last updated: 2026-06-23_

A self-verifying, adaptive pipeline that removes burned-in captions from TikTok-style
vertical videos (720×1280) **without** damaging the rest of the frame — faces, bodies,
product labels, and background text are all preserved. Validated on the @based street-interview
and product clips (11–56s).

---

## 1. TL;DR

**Find the caption with OCR → mask only the caption letters → inpaint just those pixels with
ProPainter → OCR the result to check it worked → escalate only where text survived.**

Three ideas make it work:
1. **Glyph-level mask** — we mask the actual letters, not a box, so the inpainter only rebuilds
   text pixels and leaves everything else bit-for-bit identical.
2. **Caption-band detection** — captions sit at one consistent vertical position across the
   whole clip; product labels and wall text don't. We auto-detect that band and ignore text
   outside it, so product names and background text survive.
3. **OCR as the judge** — after each inpainting pass we re-run OCR on the *output*. If text
   still shows, we escalate; if it's clean, we stop. No human review needed.

---

## 2. The problem

These captions are **burned into the pixels** — there's no subtitle track to strip. Naive
approaches fail:
- **Generative re-gen (Seedance, etc.)** redraws the captions back or mangles the scene.
- **Off-the-shelf erasers (Bria, Replicate text-removers)** are mediocre/smeary.
- **Cropping** destroys the framing; **ffmpeg delogo/box** smears on a moving subject.

The only thing that works cleanly is **mask-based video inpainting** with a precise mask.

---

## 3. The pipeline (stage by stage)

Every stage is **gated by an OCR verify** — we only run a stage if the previous output still
has caption text. Most clips stop early.

```
 0. Normalize → 30fps constant frame rate
 1. OCR build mask        (every frame, GPU)         ── identifies caption band + glyph mask
 2. ProPainter pass 1                                 ── inpaint the caption pixels
 3. OCR VERIFY  ── clean? ─► STOP
        │ residual
 4. ProPainter pass 2  (only the flagged window)      ── clears faint motion "ghosts"
 5. OCR VERIFY  ── clean? ─► STOP
        │ residual
 6. VOID composite     (only the flagged window)      ── fixes frames ProPainter can't
 7. OCR VERIFY  ── report CLEAN / flagged-for-review
```

### Stage 0 — Normalize
`ffmpeg -r 30` to a constant frame rate. Variable-frame-rate clips cause frame-count
mismatches between the video and its mask (which breaks inpainting). Source and mask must have
identical frame counts throughout.

### Stage 1 — OCR glyph mask (the precise mask)
Run EasyOCR on **every frame** (GPU makes this affordable), then:
- **Caption-vs-incidental filter:** a detection counts as a caption only if it's confident,
  multi-character, **big** (caption font is large; product/wall text is small), and roughly
  centered.
- **Caption-band detection:** histogram the vertical positions of all caption candidates across
  the whole video, find the dominant cluster (the caption row), and keep only text within a tight
  band of it. This auto-adapts per video and is what makes product labels / background text
  survive. (e.g. on one clip it found the band at screen-height 0.51–0.65 and correctly ignored a
  product label at 0.78.)
- **Glyph extraction:** inside the kept boxes, color-threshold the actual white/yellow letter
  strokes, drop solid non-text blobs, dilate 2px to catch the outline/anti-alias halo, and
  union ±1 frame to kill single-frame flicker.

Output: a per-frame mask where white = "this is caption, rebuild it." Everything else is black
and will be left untouched.

### Stage 2 — ProPainter (the inpainter)
ProPainter is a **flow-based** video inpainter: it fills a masked hole by finding those pixels in
other frames (via optical flow) and copying them in. Because it **preserves every non-masked
pixel exactly**, the output is sharp and only the caption region changes. Run in **frame-exact
chunks** (≈5s each) for memory; chunk boundaries are seamless precisely because non-masked
pixels are untouched.

### Stage 3/5/7 — OCR verify (the judge, replaces human review)
Re-run OCR on the *output*, but **only inside the caption band** (so preserved product/wall text
doesn't false-trigger). It returns the exact frames + time-ranges where caption text still
survives. This is what makes the pipeline hands-off: it checks every frame, which a human
reviewer wouldn't.

### Stage 4 — ProPainter pass 2 (ghost cleanup, windowed)
On frames where the caption sits over **fast motion** (e.g. moving arms), ProPainter leaves a
faint **ghost** — the mask was right, it just couldn't fully rebuild. A second pass on an
already-mostly-clean frame removes it. Crucially, pass 2 runs **only on the still-flagged
window**, not the whole clip.

### Stage 6 — VOID composite (the hard-case fix, windowed)
Some frames are genuinely impossible for ProPainter: when a caption never moves, the pixels
**directly behind it are occluded in 100% of frames** — they were never filmed. ProPainter can
only *copy* from where it can see, so it can't rebuild them (e.g. a caption over a product being
revealed in-hand). **VOID** (Netflix's diffusion inpainter) *generates* plausible content
instead of copying, so it can. We run VOID on just the flagged window and **composite only the
caption-patch pixels** (feathered) onto the otherwise-sharp ProPainter output — so VOID's
softness is confined to a ~1s patch, not the whole video.

---

## 4. Adaptive escalation — why it's efficient

Each stage runs **only if OCR still sees text**, and each escalation works on a **shrinking set
of frames**:
- **Plain clip** (caption over a flat shirt): clean after **pass 1** → stop.
- **Ghost clip** (caption over motion): needs **pass 2** on a small window → stop.
- **Product-reveal clip**: needs **VOID** on a tiny window → done.

Validated both directions: clip `5580` stopped after pass 1 (clean); clip `6595` escalated all
the way (residual went 31 → 19 → 1 flagged frame, auto-detected).

---

## 5. Infrastructure — consolidated, one warm Modal app (`tests/captions/modal_pipeline.py`)

The whole pipeline runs as a single Modal app — **no cross-service round-trips**, everything on
one platform:

- **CPU orchestrator** (the `Cleaner` class — *no GPU*, so it's never billed idle): coordinates
  the stages, builds the glyph masks (cheap numpy), composites, runs ffmpeg.
- **`ocr_batch` — parallel OCR worker pool (L4):** frames are fanned out in small batches across
  many L4 containers and OCR'd **in parallel**, then aggregated. Mask = every frame; verify =
  every 2nd frame (sampled — residual always spans a range). Warm verify ≈ **8.5s**.
- **`pp_chunk` — parallel ProPainter worker pool (A100):** each frame-exact ≤5s chunk runs on its
  **own A100 concurrently**, so a 3-chunk pass completes in ~one chunk's wall-time. Self-hosted
  from github.com/sczhou/ProPainter; the mask is passed as a **directory of PNG frames**, not a
  video. (Use A100, not H100 — H100s are scarce on Modal and cold-start/queue badly.)
- **VOID:** Netflix VOID diffusion inpainter via fal.ai (the one external call, rare path).
- **Warm pools:** a 10-min scaledown window keeps workers hot, so within a batch only the *first*
  video pays a cold-start; the rest ride warm.

The heavy path is **GPU compute, not metered per-call APIs** — economical at scale.

---

## 6. Timing & throughput (measured warm, 720×1280)

Full hard-case run (`6595`, escalated through pass 2 + VOID, came out fully clean):

| Stage | Warm |
|---|---|
| Normalize | 2s |
| Mask (parallel OCR) | 54s* |
| Pass 1 (3 chunks ∥ A100) | 164s |
| Verify 1 (∥, stride-2) | 8s |
| Pass 2 (segmented window) | 132s |
| Verify 2 | 9s |
| VOID (window + composite) | 89s |
| Verify 3 | 9s |
| **Total** | **470s ≈ 7.8 min** |

- **Hard case: ~7.8 min** (was ~17.9 min on the old multi-service path — **−56%**).
- **Common case** (clean after pass 1): **~3.8 min** (~3 min with a pre-warmed OCR pool).
- **ProPainter is the floor** — pass 1 + pass 2 ≈ 296s = ~63% of the time. Only a faster
  (lower-quality) inpainter or lower resolution would change it; we've chosen not to trade quality.
- *The mask's 54s is just the *first* OCR call scaling the L4 pool from cold (verify did the same
  OCR in 8s once warm). Pre-warming the cheap L4 pool drops it to ~15s.

**We optimize for throughput, not single-video latency.** Modal auto-scales the worker pools, so
a batch of N videos streams through in parallel — limited by GPU capacity/cost, not serialization.

### Cold-start & the warm-up trigger (production)

Caption removal is a **once-per-source preprocessing step**, *not* once-per-variation. To make
"40 variations from one video," captions are removed **once** from the source, then the 40
variations branch off the clean version. The cold-start (mostly the multi-GB ProPainter **image
pull** per new container — paid once per container, then cached) only hits that single run.

**Fix — fire a `warm_pools()` trigger the moment the user clicks "start,"** in parallel with the
earlier pipeline steps (Pegasus analysis, planning). By the time the flow reaches "Remove
Captions," the L4 + A100 pools are already hot → **cold-start is fully hidden behind earlier
work**, so the user never feels it. (For 40 *distinct* sources, the one-time ~5–10 min pool
warm-up is amortized across all 40 → negligible.) Pre-warm the cheap L4 pool; do **not** keep
A100s always-on (too expensive idle).

---

## 7. Outputs / validation

- `5580` → clean after pass 1; caption removed, the "BASED" card he holds preserved.
- `6595` (product clip) → full escalation; caption removed, "CURL CREAM" product label
  preserved, residual auto-reduced 31 → 1 frame.
- Across the 5-clip sample set, captions removed cleanly; on-scene product/brand text preserved.

---

## 8. Known limitations (and how we handle them)

- **Caption over complex moving geometry** (legs, hands, product reveal): ProPainter smears or
  leaves a ghost → **pass 2** handles ghosts, **VOID composite** handles true failures. The OCR
  judge decides which is needed.
- **Single leftover frames:** the verify step flags them with exact timecodes, so even an
  imperfect result is *known*, not silently shipped — it can be flagged for review or re-escalated.

---

## 9. File reference (`tests/captions/`)

| File | Role |
|---|---|
| **`modal_pipeline.py`** | **The consolidated production pipeline** — CPU orchestrator + parallel L4 OCR pool + parallel A100 ProPainter pool + VOID. This is the one to run. |
| `modal_mask.py` | Standalone OCR glyph-mask generator (earlier single-GPU version) |
| `modal_verify.py` | Standalone OCR "judge" (earlier version) |
| `modal_propainter.py` | Standalone self-hosted ProPainter (validation harness) |
| `propainter-chunked.mjs` | Chunked ProPainter via Replicate (pre-consolidation path) |
| `void_composite.py` | Standalone VOID escalation (logic now folded into `modal_pipeline.py`) |
| `auto_clean.py` | Earlier multi-service orchestrator (superseded by `modal_pipeline.py`) |

## 10. TODO

- **`warm_pools()` trigger** (see §6 cold-start): fire pool warm-up at job start so it's hot by
  the time captioning runs. Pre-warm the cheap L4 OCR pool; warm A100 ProPainter on-demand-at-job-start
  (don't keep always-on).
- Pre-warm the L4 OCR pool to drop the mask step from 54s → ~15s.
