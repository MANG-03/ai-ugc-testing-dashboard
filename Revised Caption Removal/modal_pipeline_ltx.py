"""
Caption-removal pipeline — LTX-2.3 inpaint (fal) variant.

Same architecture as modal_pipeline.py but the inpaint ENGINE is LTX-2.3 inpaint
(fal-ai/ltx-2.3-quality/inpaint) instead of ProPainter, and the mask is a SOLID
DILATED BOX over each in-band OCR caption detection (LTX regenerates white regions,
so solid boxes beat the glyph mask on white-text-over-busy-graphic — the on-shirt case).

Preserved from the original: OCR + caption-band detection (build_mask returns band),
the verifier with the static-filter, _cluster, _multi_splice, and the verify->re-mask->
targeted re-paint->repeat round loop. LTX runs on fal from the CPU orchestrator (no GPU
inpaint pool). ocr_batch (L4) stays for masking + verify.

Run: tests/captions/.venv/bin/python -m modal run tests/captions/modal_pipeline_ltx.py \
        --video "<src>" --out "<dest>"
"""
import modal

app = modal.App("caption-ltx")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .pip_install(
        "opencv-python-headless", "scipy", "scikit-image", "imageio",
        "imageio-ffmpeg", "numpy<2", "easyocr==1.7.2",
    )
)
ocrw = modal.Volume.from_name("easyocr-models", create_if_missing=True)
FAL_KEY = os.environ.get("FAL_KEY", "")  # <-- set your own fal.ai key via the FAL_KEY env var

# LTX inpaint config (confirmed working params from /tmp/ltx_inpaint.py + live schema)
LTX_ENDPOINT = "https://queue.fal.run/fal-ai/ltx-2.3-quality/inpaint"
LTX_PROMPT = "natural clean background, no text, no captions, no letters."
LTX_NEG = "text, caption, subtitle, letters, words, watermark, logo overlay"
LTX_CHUNK = 300      # frames per LTX call (num_frames cap ~481; keep tail >= LTX_MIN_TAIL)
LTX_MIN_TAIL = 48    # never emit a chunk smaller than this — fold it into the previous one
LTX_POLL_GAP = 5     # seconds between status polls
LTX_POLL_MAX = 480   # max poll ticks per job -> 40 min wall-clock ceiling (chunks run concurrently)

# ── parallel OCR worker (L4 pool) ────────────────────────────────────────────
_reader = None
def _get_reader():
    global _reader
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(["en"], gpu=True, verbose=False)
    return _reader


@app.function(image=image, gpu="L4", timeout=1200, scaledown_window=600,
              max_containers=6,
              volumes={"/root/.EasyOCR": ocrw})
def ocr_batch(video_bytes: bytes, f0: int, f1: int, stride: int, pad: int):
    """OCR frames [f0,f1) (every `stride`th) -> [(gidx,x0,y0,x1,y1,text,conf,H,W)]."""
    import os, subprocess, tempfile, cv2, numpy as np
    d = tempfile.mkdtemp()
    open(f"{d}/v.mp4", "wb").write(video_bytes)
    sel = f"select=between(n\\,{f0}\\,{f1-1}),setpts=N/30/TB"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", f"{d}/v.mp4", "-vf", sel,
                    "-r", "30", "-frames:v", str(f1-f0), f"{d}/%05d.png", "-y"], check=True)
    reader = _get_reader()
    frames = sorted(os.listdir(d)); frames = [f for f in frames if f.endswith(".png")]
    out = []
    for li, fn in enumerate(frames):
        gi = f0 + li
        if gi % stride != 0:
            continue
        img = cv2.imread(f"{d}/{fn}"); H, W = img.shape[:2]
        for poly, text, conf in reader.readtext(img, text_threshold=0.3, low_text=0.3, mag_ratio=2.0):
            pts = np.array(poly, dtype=np.int32).reshape(-1, 2)
            x0 = int(max(0, pts[:, 0].min() - pad)); y0 = int(max(0, pts[:, 1].min() - pad))
            x1 = int(pts[:, 0].max() + pad); y1 = int(pts[:, 1].max() + pad)
            out.append((gi, x0, y0, x1, y1, text, float(conf), H, W))
    return out


# ── CPU orchestrator ─────────────────────────────────────────────────────────
@app.cls(image=image, timeout=3600, memory=32768)
class Cleaner:
    def _nframes(self, p):
        import subprocess
        return int(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", p],
                capture_output=True, text=True).stdout.strip())

    def _ocr_all(self, video, N, stride, pad=6, batch=32):
        """Fan out OCR over [0,N) in parallel batches; aggregate -> {gidx:[(box,text,conf)]}, (H,W)."""
        vb = open(video, "rb").read()
        args = []
        f = 0
        while f < N:
            args.append((vb, f, min(N, f + batch), stride, pad)); f += batch
        dets = {}; HW = None
        for res in ocr_batch.starmap(args):
            for (gi, x0, y0, x1, y1, text, conf, H, W) in res:
                HW = (H, W); dets.setdefault(gi, []).append((x0, y0, x1, y1, text, conf))
        return dets, HW

    def _ok(self, d, W, H, P):
        x0, y0, x1, y1, text, conf = d
        cy = ((y0 + y1) / 2) / H
        if conf < P["conf"] or sum(c.isalnum() for c in text) < 2: return False, cy
        if (y1 - y0) / H < P["min_height"]: return False, cy
        cx = ((x0 + x1) / 2) / W
        return (P["cx_lo"] <= cx <= P["cx_hi"] and P["cy_lo"] <= cy <= P["cy_hi"]), cy

    @staticmethod
    def _iou(a, b):
        ix0, iy0 = max(a[0], b[0]), max(a[1], b[1]); ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
        iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0); inter = iw * ih
        if inter == 0: return 0.0
        ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / ua if ua > 0 else 0.0

    def build_mask(self, cfr, work, P, N):
        """PRECISION caption mask (v2): in-band OCR boxes -> POSITION-STABILITY filter (keep a det only
        if it overlaps a det at ~the same spot in >= stab_min of the +/-K neighbour frames — captions
        are screen-fixed, mic/products/shirt-graphic MOVE so they drop) -> TEMPORAL-FILL (union the kept
        mask over +/-tfill to cover OCR misses). Returns (mask_path, band); band is for the verifier."""
        import os, subprocess, cv2, numpy as np
        fdir = f"{work}/f"; mdir = f"{work}/m"; os.makedirs(mdir, exist_ok=True); os.makedirs(fdir, exist_ok=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", cfr, f"{fdir}/%05d.png", "-y"], check=True)
        frames = sorted(os.listdir(fdir)); H, W = cv2.imread(f"{fdir}/{frames[0]}").shape[:2]
        dets_v, _ = self._ocr_all(cfr, N, 1, P["pad"])
        # caption band from the histogram of valid in-band detection centers (used by the verifier)
        all_cy = [self._ok(d, W, H, P)[1] for i in dets_v for d in dets_v[i] if self._ok(d, W, H, P)[0]]
        if all_cy:
            hist, edges = np.histogram(all_cy, bins=24, range=(0, 1)); pk = int(np.argmax(hist))
            c = (edges[pk] + edges[pk + 1]) / 2
            near = [x for x in all_cy if abs(x - c) <= P["band_tol"]]
            if near: c = float(np.mean(near))
            band = (c - P["band_tol"], c + P["band_tol"])
        else:
            band = (0.0, 1.0)

        # 1) in-band valid detection boxes per frame (v2 gates: fixed band/cx + min height)
        blo, bhi = P["v2_band_lo"], P["v2_band_hi"]; cxlo, cxhi = P["v2_cx_lo"], P["v2_cx_hi"]
        dets = [[] for _ in range(N)]
        for i in range(N):
            for d in dets_v.get(i, []):
                x0, y0, x1, y1, text, conf = d
                if conf < 0.25 or sum(ch.isalnum() for ch in text) < 2: continue
                cx = ((x0 + x1) / 2) / W; cy = ((y0 + y1) / 2) / H
                if not (blo <= cy <= bhi and cxlo <= cx <= cxhi): continue
                if (y1 - y0) < 0.018 * H: continue
                dets[i].append((x0, y0, x1, y1))

        # 2) position-stability filter
        K = P["v2_K"]; iou_thr = P["v2_iou"]; stab_min = P["v2_stab"]
        stable = [[] for _ in range(N)]; nkept = ndrop = 0
        for k in range(N):
            for d in dets[k]:
                cnt = 0
                for j in range(max(0, k - K), min(N, k + K + 1)):
                    if j == k: continue
                    if any(self._iou(d, e) >= iou_thr for e in dets[j]): cnt += 1
                if cnt >= stab_min: stable[k].append(d); nkept += 1
                else: ndrop += 1

        # 3) render per-frame stable mask, then temporal-fill (union over +/-tfill)
        bpad = P["box_pad"]; tfill = P["v2_tfill"]
        raw = []
        for k in range(N):
            m = np.zeros((H, W), np.uint8)
            for (x0, y0, x1, y1) in stable[k]:
                cv2.rectangle(m, (max(0, x0 - bpad), max(0, y0 - bpad)),
                              (min(W, x1 + bpad), min(H, y1 + bpad)), 255, -1)
            raw.append(m)
        for k in range(N):
            m = raw[k].copy()
            for j in range(max(0, k - tfill), min(N, k + tfill + 1)):
                m = cv2.bitwise_or(m, raw[j])
            cv2.imwrite(f"{mdir}/{frames[k]}", m)
        print(f"[mask-v2] {N} frames | kept {nkept} stable, dropped {ndrop} moving (mic/products)", flush=True)
        mask = f"{work}/mask.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", f"{mdir}/%05d.png",
                        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", mask, "-y"], check=True)
        return mask, band

    # ── static-text rejection ────────────────────────────────────────────────
    _SR = dict(gx=12, gy=24, pos_frac=0.30, diversity=0.45, min_alnum=3,
               rec_frames=5, rec_span=120)

    @staticmethod
    def _ntext(t):
        return "".join(c.lower() for c in t if c.isalnum())

    def _static_filter(self, dets, band, P, HW, frame_ids):
        from collections import defaultdict
        if not HW or not frame_ids:
            return set(), set()
        H, W = HW; SR = self._SR; nf = len(frame_ids)
        cell_frames = defaultdict(set); cell_texts = defaultdict(list); txt_frames = defaultdict(set)
        for i in frame_ids:
            for d in dets.get(i, []):
                ok, cy = self._ok(d, W, H, P)
                if not (ok and band[0] <= cy <= band[1]):
                    continue
                nt = self._ntext(d[4])
                if len(nt) < SR["min_alnum"]:
                    continue
                cx = (d[0] + d[2]) / 2 / W
                cell = (min(SR["gx"] - 1, int(cx * SR["gx"])), min(SR["gy"] - 1, int(cy * SR["gy"])))
                cell_frames[cell].add(i); cell_texts[cell].append(nt); txt_frames[nt].add(i)
        static_cells = {c for c, fs in cell_frames.items()
                        if len(fs) >= SR["pos_frac"] * nf
                        and len(set(cell_texts[c])) / len(cell_texts[c]) <= SR["diversity"]}
        static_texts = {t for t, fs in txt_frames.items()
                        if len(fs) >= SR["rec_frames"] and (max(fs) - min(fs)) >= SR["rec_span"]}
        return static_cells, static_texts

    def _verify_moving(self, dets, band, P, HW, frame_ids, stride):
        """POSITION-STABILITY gate for the verifier (mirrors build_mask's filter, on verify frames):
        a real caption is screen-FIXED (its box sits at ~the same spot across neighbour verify frames,
        even as the word changes); the BASED mic/bottle text MOVES (box drifts). Return the set of
        (frame, box) detections that are MOVING -> these must NOT be flagged (they're products, not
        captions), so the flagged count doesn't falsely spike and trip the regression guard."""
        if not HW or not frame_ids:
            return set()
        H, W = HW
        order = sorted(frame_ids); pos = {f: k for k, f in enumerate(order)}
        Kn = P["v2_K"]; iou_thr = P["v2_iou"]; stab = P["v2_stab"]
        # collect in-band valid boxes per verify frame
        fboxes = {}
        for i in frame_ids:
            bl = []
            for d in dets.get(i, []):
                ok, cy = self._ok(d, W, H, P)
                if ok and band[0] <= cy <= band[1] and len(self._ntext(d[4])) >= self._SR["min_alnum"]:
                    bl.append((d[0], d[1], d[2], d[3]))
            if bl: fboxes[i] = bl
        moving = set()
        for i in fboxes:
            k = pos[i]
            for box in fboxes[i]:
                cnt = 0
                for kk in range(max(0, k - Kn), min(len(order), k + Kn + 1)):
                    j = order[kk]
                    if j == i: continue
                    if any(self._iou(box, e) >= iou_thr for e in fboxes.get(j, [])):
                        cnt += 1
                if cnt < stab:                      # not screen-fixed -> moving product/mic text
                    moving.add((i, box))
        return moving

    def verify(self, video, band, P, stride=1):
        # stride=1: OCR EVERY frame so the verifier sees brief / odd-frame caption flashes that a
        # stride=2 (every-other-frame) verify would skip. ~2x the verify OCR cost (+~65s/pass).
        N = self._nframes(video)
        dets, HW = self._ocr_all(video, N, stride, P["pad"])
        if not HW: return [], [], {}, None
        H, W = HW; frame_ids = sorted(dets)
        static_cells, static_texts = self._static_filter(dets, band, P, HW, frame_ids)
        moving = self._verify_moving(dets, band, P, HW, frame_ids, stride)
        SR = self._SR; flagged = []
        for i in frame_ids:
            for d in dets[i]:
                ok, cy = self._ok(d, W, H, P)
                if not (ok and band[0] <= cy <= band[1]):
                    continue
                nt = self._ntext(d[4])
                if len(nt) < SR["min_alnum"]:
                    continue
                if (i, (d[0], d[1], d[2], d[3])) in moving:   # moving product/mic text -> not a caption
                    continue
                cx = (d[0] + d[2]) / 2 / W
                cell = (min(SR["gx"] - 1, int(cx * SR["gx"])), min(SR["gy"] - 1, int(cy * SR["gy"])))
                if cell in static_cells or nt in static_texts:
                    continue
                flagged.append((i, round(i / 30, 2))); break
        if flagged:
            fi = [f[0] for f in flagged]; fset = set(fi)
            flagged = [f for f in flagged
                       if (f[0] - stride in fset) or (f[0] - 2 * stride in fset)
                       or (f[0] + stride in fset) or (f[0] + 2 * stride in fset)]
        ranges = []
        if flagged:
            idx = [f[0] for f in flagged]; s = p = idx[0]
            for k in idx[1:]:
                if k - p <= stride + 1: p = k
                else: ranges.append((s / 30, p / 30)); s = p = k
            ranges.append((s / 30, p / 30))
        return flagged, ranges, dets, HW

    # ── LTX inpaint engine (fal) ─────────────────────────────────────────────
    def _fal(self, method, url, body=None, raw=None, ct="application/json"):
        import json, time, urllib.request, urllib.error
        if raw is not None:
            data = raw; hdr_ct = ct
        elif body is not None:
            data = json.dumps(body).encode(); hdr_ct = "application/json"
        else:
            data = None; hdr_ct = None
        # retry transient fal errors (403/429/5xx + transient network) with exponential backoff.
        # the 403 we hit was a transient throttle on storage/initiate deep into a long run, not auth.
        last = None
        for attempt in range(6):
            req = urllib.request.Request(url, method=method)
            req.add_header("Authorization", f"Key {FAL_KEY}")
            if hdr_ct is not None: req.add_header("Content-Type", hdr_ct)
            try:
                return urllib.request.urlopen(req, data, timeout=300)
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (403, 408, 429, 500, 502, 503, 504) and attempt < 5:
                    time.sleep(2 * (2 ** attempt)); continue
                raise
            except (urllib.error.URLError, TimeoutError) as e:
                last = e
                if attempt < 5:
                    time.sleep(2 * (2 ** attempt)); continue
                raise
        raise last

    def _fal_up(self, path, name):
        import json
        init = json.loads(self._fal("POST", "https://rest.alpha.fal.ai/storage/upload/initiate",
                                    body={"file_name": name, "content_type": "video/mp4"}).read())
        self._fal("PUT", init["upload_url"], raw=open(path, "rb").read(), ct="video/mp4")
        return init["file_url"]

    @staticmethod
    def _find_mp4(o):
        if isinstance(o, str): return o if ".mp4" in o else None
        if isinstance(o, list):
            for x in o:
                r = Cleaner._find_mp4(x)
                if r: return r
        if isinstance(o, dict):
            for x in o.values():
                r = Cleaner._find_mp4(x)
                if r: return r
        return None

    def _ltx_submit(self, src_path, mask_path, nframes):
        """Upload src+mask and POST the LTX inpaint job. Returns (status_url, response_url)."""
        import json
        vu = self._fal_up(src_path, "s.mp4"); mu = self._fal_up(mask_path, "m.mp4")
        body = {
            "video_url": vu, "mask_video_url": mu,
            "prompt": LTX_PROMPT, "negative_prompt": LTX_NEG,
            "num_frames": nframes, "frames_per_second": 30,
            "video_quality": "high", "num_inference_steps": 20,
            "video_strength": 1.0, "generate_audio": False,
            "enable_prompt_expansion": False,
        }
        sub = json.loads(self._fal("POST", LTX_ENDPOINT, body=body).read())
        return sub["status_url"], sub["response_url"]

    def _ltx_poll_all(self, jobs, out_paths, tag=""):
        """Poll a list of submitted LTX jobs CONCURRENTLY (round-robin) until each completes,
        then download to its out_path. jobs[i]=(status_url,response_url). LTX_POLL_MAX*LTX_POLL_GAP
        is the per-job wall-clock ceiling. Returns out_paths in order."""
        import json, time, urllib.request
        pending = {i: jobs[i] for i in range(len(jobs))}
        out_url = {}; ticks = 0
        while pending and ticks < LTX_POLL_MAX:
            time.sleep(LTX_POLL_GAP); ticks += 1
            done = []
            for i, (su, ru) in pending.items():
                try:
                    st = json.loads(self._fal("GET", su).read())
                except Exception:
                    continue
                s = st.get("status")
                if s == "COMPLETED":
                    # the response fetch can transiently 500 even after COMPLETED (fal-side blip).
                    # don't kill the run — leave the chunk pending and re-fetch on a later tick.
                    try:
                        resp = json.loads(self._fal("GET", ru).read())
                    except Exception as e:
                        print(f"[ltx] {tag} chunk {i} COMPLETED but response fetch failed ({e!r}); retrying", flush=True)
                        continue
                    out_url[i] = self._find_mp4(resp); done.append(i)
                elif s in ("FAILED", "ERROR"):
                    raise RuntimeError(f"LTX failed (chunk {i}): {json.dumps(st)[:400]}")
            for i in done:
                pending.pop(i)
                print(f"[ltx] {tag} chunk {i} completed (poll tick {ticks})", flush=True)
        if pending:
            raise RuntimeError(f"LTX timeout: chunks {sorted(pending)} after {ticks*LTX_POLL_GAP}s")
        for i, u in out_url.items():
            for attempt in range(6):
                try:
                    open(out_paths[i], "wb").write(urllib.request.urlopen(u, timeout=300).read()); break
                except Exception:
                    if attempt == 5: raise
                    time.sleep(2 * (2 ** attempt))
        return out_paths

    def _chunk_bounds(self, f0, f1):
        """Split [f0,f1) into <=LTX_CHUNK pieces, folding a too-small tail into the prior chunk."""
        bounds = []; a = f0
        while a < f1:
            b = min(f1, a + LTX_CHUNK)
            if 0 < (f1 - b) < LTX_MIN_TAIL:   # tail would be tiny -> absorb remainder into this chunk
                b = f1
            bounds.append((a, b)); a = b
        return bounds

    def _cut(self, video, a, b, out, mask=False):
        import subprocess
        sel = f"select=between(n\\,{a}\\,{b-1}),setpts=N/30/TB"
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", video, "-vf", sel, "-r", "30",
               "-frames:v", str(b - a)]
        if mask: cmd += ["-pix_fmt", "yuv420p"]
        else: cmd += ["-an"]
        cmd += [out, "-y"]
        subprocess.run(cmd, check=True)
        return out

    def _composite(self, orig_cut, ltx_raw, mask_cut, cnt, out):
        """MASK-ONLY COMPOSITE: keep EVERY original pixel, replace ONLY the caption-region pixels with
        LTX's fill (feathered mask edge). Output stays the original WxH at full quality — no stretch,
        no quality loss outside the caption. Re-pins LTX to the exact frame count / 30fps first."""
        import subprocess
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", orig_cut, "-i", ltx_raw, "-i", mask_cut,
            "-filter_complex",
            f"[0:v]scale={self._W}:{self._H},setsar=1[orig];"
            f"[2:v]format=gray,scale={self._W}:{self._H},boxblur=3:1[m];"
            f"[1:v]settb=AVTB,setpts=N/30/TB,fps=30,scale={self._W}:{self._H},setsar=1[ltx];"
            f"[ltx][m]alphamerge[fg];[orig][fg]overlay=format=auto[v]",
            "-map", "[v]", "-r", "30", "-frames:v", str(cnt),
            "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", out, "-y"], check=True)
        return out

    def _ltx_run_chunks(self, src_path, mask_path, bounds, work, tag):
        """Cut each (a,b) window from src+mask, submit ALL to fal, poll concurrently, then MASK-ONLY
        COMPOSITE each LTX output over the original cut (keep original quality, replace only captions).
        Returns the list of composited per-chunk mp4 paths (in order)."""
        jobs = []; raw_out = []; cuts = []; src_cuts = []; mask_cuts = []
        for j, (a, b) in enumerate(bounds):
            vp = self._cut(src_path, a, b, f"{work}/lv_{tag}_{j}.mp4")
            mp = self._cut(mask_path, a, b, f"{work}/lm_{tag}_{j}.mp4", mask=True)
            jobs.append(self._ltx_submit(vp, mp, b - a))
            raw_out.append(f"{work}/lo_{tag}_{j}.mp4"); cuts.append((a, b))
            src_cuts.append(vp); mask_cuts.append(mp)
            print(f"[ltx] {tag} chunk {j} [{a},{b}) submitted", flush=True)
        self._ltx_poll_all(jobs, raw_out, tag)
        parts = []
        for j, (a, b) in enumerate(cuts):
            comp = f"{work}/lcomp_{tag}_{j}.mp4"
            self._composite(src_cuts[j], raw_out[j], mask_cuts[j], b - a, comp)
            parts.append(comp)
        return parts

    def ltx_inpaint(self, video_path, mask_path, work, tag):
        """Full-video LTX inpaint: chunk into <=LTX_CHUNK pieces, run all on fal concurrently, concat."""
        import subprocess
        N = self._nframes(video_path)
        bounds = self._chunk_bounds(0, N)
        parts = self._ltx_run_chunks(video_path, mask_path, bounds, work, tag)
        listf = f"{work}/lc_{tag}.txt"; open(listf, "w").write("\n".join(f"file '{p}'" for p in parts))
        out = f"{work}/{tag}.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", listf,
                        "-c:v", "libx264", "-crf", "18", out, "-y"], check=True)
        return out

    def _cluster(self, ranges, N, gap=20, pad=20):
        spans = sorted((int(rs * 30), int(re * 30)) for (rs, re) in ranges)
        merged = []
        for a, b in spans:
            if merged and a - merged[-1][1] <= gap: merged[-1] = (merged[-1][0], max(merged[-1][1], b))
            else: merged.append((a, b))
        final = []
        for a, b in merged:
            a, b = max(0, a - pad), min(N, b + pad + 1)
            if final and a <= final[-1][1]: final[-1] = (final[-1][0], max(final[-1][1], b))
            else: final.append((a, b))
        return final

    def _multi_splice(self, base, inserts, work, tag):
        import subprocess
        N = self._nframes(base); inserts = sorted(inserts); parts = []; cur = 0
        for ii, (f0, f1, pf) in enumerate(inserts):
            if f0 > cur:
                seg = f"{work}/ms_{tag}_{ii}.mp4"
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", base, "-vf",
                    f"select=between(n\\,{cur}\\,{f0-1}),setpts=N/30/TB", "-r", "30", "-frames:v", str(f0 - cur),
                    "-c:v", "libx264", "-crf", "18", seg, "-y"], check=True); parts.append(seg)
            parts.append(pf); cur = max(cur, f1)
        if cur < N:
            seg = f"{work}/ms_{tag}_end.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", base, "-vf",
                f"select=between(n\\,{cur}\\,{N-1}),setpts=N/30/TB", "-r", "30", "-frames:v", str(N - cur),
                "-c:v", "libx264", "-crf", "18", seg, "-y"], check=True); parts.append(seg)
        listf = f"{work}/ms_{tag}.txt"; open(listf, "w").write("\n".join(f"file '{p}'" for p in parts))
        out = f"{work}/ms_{tag}_out.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", listf,
                        "-c:v", "libx264", "-crf", "18", out, "-y"], check=True)
        return out

    def _remask_window(self, source, work, dets, band, P, HW, fsf, fef, tag):
        """Build a SOLID-BOX mask just for [fsf,fef] from the verify `dets` (residual caption boxes),
        POSITION-STABILITY filtered (same idea as build_mask) so the moving BASED mic/bottle text in
        the window is NOT re-masked/re-painted, then temporally unioned + dilated. Returns (src_cut,
        mask_cut, a, b) where [a,b) is the padded window."""
        import os, subprocess, cv2, numpy as np
        if not HW:
            return None
        H, W = HW; bpad = P["box_pad"]; pad = 5
        a = max(0, fsf - pad); b = min(self._nframes(source), fef + pad + 1)
        # per-frame in-band boxes from dets. NO stability filter here: verify (with its moving-text
        # gate) already vetted that these windows hold a real caption, and product text is already
        # excluded from `flagged`, so a window only exists because of a genuine caption. We want FULL
        # coverage of that caption (stability-filtering a short window drops real caption boxes that
        # OCR'd in only a couple frames -> under-covers -> the caption survives, as seen at 18s/26s).
        boxes = {}
        for i in range(a, b):
            for d in dets.get(i, []):
                ok, cy = self._ok(d, W, H, P)
                if ok and band[0] <= cy <= band[1]:
                    boxes.setdefault(i, []).append((d[0], d[1], d[2], d[3]))
        # temporal union over the window -> single box mask (covers detection dropouts)
        union = np.zeros((H, W), np.uint8)
        for i in range(a, b):
            for (x0, y0, x1, y1) in boxes.get(i, []):
                cv2.rectangle(union, (max(0, x0 - bpad), max(0, y0 - bpad)),
                              (min(W, x1 + bpad), min(H, y1 + bpad)), 255, -1)
        if union.max() == 0:
            return None
        union = cv2.dilate(union, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
        mdir = f"{work}/rm_{tag}"; os.makedirs(mdir, exist_ok=True)
        for k in range(b - a):
            cv2.imwrite(f"{mdir}/{k+1:05d}.png", union)
        mcut = f"{work}/rmask_{tag}.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", f"{mdir}/%05d.png",
                        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", mcut, "-y"], check=True)
        scut = self._cut(source, a, b, f"{work}/rsrc_{tag}.mp4")
        return scut, mcut, a, b

    def ltx_windows(self, source, base, work, tag, windows, dets, band, P, HW):
        """TARGETED re-paint: for each flagged window, build a residual-box mask and cut the window
        from source. Run ALL windows' chunks on fal concurrently, reassemble each window, splice
        the results into `base` via _multi_splice."""
        import subprocess
        # 1) build per-window cuts (src + residual-box mask), record absolute bounds
        wins = []  # (a, b, scut, mcut)
        for wi, (f0, f1) in enumerate(windows):
            rm = self._remask_window(source, work, dets, band, P, HW, f0, f1, f"{tag}_{wi}")
            if rm is None:
                continue
            scut, mcut, a, b = rm
            wins.append((a, b, scut, mcut))
        if not wins:
            return base
        # 2) flatten into chunks across ALL windows (sub-chunk windows > LTX_CHUNK)
        bounds = []; owner = []  # bounds[k]=(rel_a,rel_b) into the window cut; owner[k]=win index
        cut_srcs = []; cut_masks = []
        for wi, (a, b, scut, mcut) in enumerate(wins):
            for (sa, sb) in self._chunk_bounds(0, b - a):
                cut_srcs.append(self._cut(scut, sa, sb, f"{work}/wv_{tag}_{wi}_{sa}.mp4"))
                cut_masks.append(self._cut(mcut, sa, sb, f"{work}/wm_{tag}_{wi}_{sa}.mp4", mask=True))
                bounds.append((sa, sb)); owner.append(wi)
        # 3) submit all chunks, poll concurrently
        jobs = [self._ltx_submit(cut_srcs[k], cut_masks[k], bounds[k][1] - bounds[k][0])
                for k in range(len(bounds))]
        for k in range(len(jobs)):
            print(f"[ltx] window-chunk {tag}_{owner[k]} submitted", flush=True)
        raw = [f"{work}/wso_{tag}_{k}.mp4" for k in range(len(jobs))]
        self._ltx_poll_all(jobs, raw, tag)
        # 4) MASK-ONLY COMPOSITE each chunk over its original cut, then reassemble per window in order
        per_win = {}
        for k in range(len(raw)):
            sa, sb = bounds[k]
            comp = f"{work}/wcomp_{tag}_{k}.mp4"
            self._composite(cut_srcs[k], raw[k], cut_masks[k], sb - sa, comp)
            per_win.setdefault(owner[k], []).append((sa, comp))
        inserts = []
        for wi, (a, b, scut, mcut) in enumerate(wins):
            parts = [p for _, p in sorted(per_win.get(wi, []))]
            if len(parts) == 1:
                merged = parts[0]
            else:
                listf = f"{work}/wsc_{tag}_{wi}.txt"; open(listf, "w").write("\n".join(f"file '{p}'" for p in parts))
                merged = f"{work}/wmrg_{tag}_{wi}.mp4"
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", listf,
                                "-c:v", "libx264", "-crf", "18", merged, "-y"], check=True)
            inserts.append((a, b, merged))
            print(f"[ltx] window {tag}_{wi} [{a},{b}) re-painted", flush=True)
        return self._multi_splice(base, inserts, work, tag)

    @modal.method()
    def clean(self, video_bytes: bytes, prompt: str = ""):
        import traceback
        try:
            return self._impl(video_bytes, prompt)
        except Exception as e:
            print("PIPELINE_ERROR:", repr(e)); traceback.print_exc(); raise

    def _impl(self, video_bytes, prompt):
        import os, subprocess, time, shutil
        work = "/tmp/work"; shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
        self.P = dict(pad=6, conf=0.3, min_height=0.030, cx_lo=0.08, cx_hi=0.92,
                      cy_lo=0.15, cy_hi=0.90, band_tol=0.07, box_pad=10,
                      # v2 precision-mask params (position-stability + temporal-fill)
                      v2_band_lo=0.46, v2_band_hi=0.72, v2_cx_lo=0.20, v2_cx_hi=0.80,
                      v2_K=4, v2_iou=0.25, v2_stab=4, v2_tfill=2)
        T = {}; t0 = time.time()
        def mark(k): T[k] = round(time.time() - t0, 1); print(f"[stage] {k} @ {T[k]}s", flush=True)

        src = f"{work}/src.mp4"; open(src, "wb").write(video_bytes); cfr = f"{work}/cfr.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src, "-r", "30", "-c:v", "libx264",
                        "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", cfr, "-y"], check=True)
        mark("normalize")
        N = self._nframes(cfr)
        # native dims for the mask-only composite (keep original size, no stretch)
        import subprocess as _sp
        wh = _sp.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                      "stream=width,height", "-of", "csv=p=0:s=x", cfr],
                     capture_output=True, text=True).stdout.strip().split("x")
        self._W, self._H = int(wh[0]), int(wh[1])
        print(f"[dims] {self._W}x{self._H}", flush=True)
        mask, band = self.build_mask(cfr, work, self.P, N); mark("mask")

        out = self.ltx_inpaint(cfr, mask, work, "ltx1"); mark("ltx1")
        # ── TARGETED verify loop: re-LTX only the windows the verifier still flags.
        # BEST-SO-FAR: a re-paint round can bump the raw verify count (LTX sometimes renders faint
        # OCR-readable texture in the regenerated region), so we DON'T treat a count bump as terminal
        # and lose the gains. We keep the output with the FEWEST flagged frames, re-paint the residual
        # windows each round, and STOP on a true STALL (the same residual windows persist with no net
        # reduction for 2 rounds) or when clean. We then emit the BEST output, not the last.
        MAX_ROUNDS = 4
        best_out = out; best_cnt = None; best_ranges = []
        prev_winset = None; stall = 0; status = "clean_after_pass1"
        ranges = []
        for rnd in range(1, MAX_ROUNDS + 1):
            flagged, ranges, dets, HW = self.verify(out, band, self.P); mark(f"verify{rnd}")
            cnt = len(flagged)
            print(f"[loop] round {rnd}: {cnt} frames flagged in {len(ranges)} windows", flush=True)
            if best_cnt is None or cnt < best_cnt:
                best_cnt = cnt; best_out = out; best_ranges = ranges
            if cnt == 0:
                status = "clean_after_pass1" if rnd == 1 else "clean"; break
            clusters = self._cluster(ranges, N)
            # stall guard on WINDOW PERSISTENCE (not raw count): if the same residual windows keep
            # coming back and we've made no improvement, more rounds won't help -> stop.
            winset = frozenset((f0 // 30, f1 // 30) for (f0, f1) in clusters)
            improved = (cnt < (best_cnt if rnd == 1 else prev_cnt)) if rnd > 1 else True
            if rnd > 1 and winset == prev_winset and not improved:
                stall += 1
            else:
                stall = 0
            if stall >= 2:
                status = f"stalled:{best_ranges}"; print("[loop] residual windows persist -> stopping", flush=True); break
            prev_winset = winset; prev_cnt = cnt
            print(f"[loop] round {rnd}: re-LTX {len(clusters)} window(s)", flush=True)
            try:
                out = self.ltx_windows(cfr, out, work, f"r{rnd}", clusters, dets, band, self.P, HW)
            except Exception as e:
                # never lose the run to a transient fal/LTX error mid-loop — keep best-so-far.
                status = f"partial_after_r{rnd-1}:{repr(e)[:120]}"
                print(f"[loop] re-paint round {rnd} failed ({e!r}) -> emitting best-so-far", flush=True)
                break
            mark(f"round{rnd}")
        else:
            flagged, ranges, dets, HW = self.verify(out, band, self.P); mark("verify_final")
            if best_cnt is None or len(flagged) < best_cnt:
                best_cnt = len(flagged); best_out = out; best_ranges = ranges
            status = "clean" if not best_cnt else f"capped:{best_ranges}"

        print(f"[loop] emitting best output: {best_cnt} flagged frames", flush=True)
        final = f"{work}/final.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", best_out, "-i", cfr, "-map", "0:v:0",
                        "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-shortest", final, "-y"], check=True)
        mark("total")
        return {"video": open(final, "rb").read(), "timing": T, "band": band,
                "residual_ranges": best_ranges, "status": status}


@app.local_entrypoint()
def main(video: str, out: str):
    import time
    vb = open(video, "rb").read(); t0 = time.time()
    res = Cleaner().clean.remote(vb)
    open(out, "wb").write(res["video"])
    print("\n==== TIMING (in-container, s) ====")
    for k, v in res["timing"].items():
        print(f"  {k:12s} {v}")
    print(f"  status: {res['status']}  band: {res['band']}")
    print(f"==== TOTAL round-trip: {time.time()-t0:.1f}s ====")
