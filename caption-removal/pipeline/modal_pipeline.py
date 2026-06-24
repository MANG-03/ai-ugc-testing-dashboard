"""
Consolidated caption-removal pipeline — CPU orchestrator + parallel GPU worker pools.

Architecture:
  - Cleaner (CPU): coordinates, builds glyph masks (numpy), composites. No GPU, never idle.
  - ocr_batch  (L4 pool):  parallel OCR — frames fanned out in small batches. Mask=every frame,
                           verify=every 2nd frame. Warm pool (scaledown_window).
  - pp_chunk   (H100 pool): parallel ProPainter — frame-exact chunks, one per container.
  - VOID: fal (external), only on the rare hard path.

Adaptive, OCR-gated: normalize -> mask -> pp1 -> verify -> (residual) seg pp2 -> verify ->
(residual) VOID composite -> verify. Each escalation runs only on the flagged window.

Run: tests/captions/.venv/bin/python -m modal run tests/captions/modal_pipeline.py \
        --video "<src>" --out "<dest>"
"""
import os
import modal

app = modal.App("caption-cleaner")

# fal API key (for the rare VOID escalation path). Set it as a Modal secret named "fal"
# containing FAL_KEY=<your key>, created with:  modal secret create fal FAL_KEY=xxxx
# Never hardcode the key here.
fal_secret = modal.Secret.from_name("fal")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .run_commands(
        "git clone https://github.com/sczhou/ProPainter.git /ProPainter",
        "rm -rf /ProPainter/weights && mkdir -p /ProPainter/weights",
    )
    .pip_install(
        "torch==2.1.2", "torchvision==0.16.2", "opencv-python-headless", "scipy",
        "scikit-image", "imageio", "imageio-ffmpeg", "av", "einops", "timm",
        "matplotlib", "tqdm", "numpy<2", "easyocr==1.7.2",
    )
)
ppw = modal.Volume.from_name("propainter-weights", create_if_missing=True)
ocrw = modal.Volume.from_name("easyocr-models", create_if_missing=True)
# FAL_KEY is read from the environment inside the VOID step (provided by the `fal` Modal secret).

# ── parallel OCR worker (L4 pool) ────────────────────────────────────────────
_reader = None
def _get_reader():
    global _reader
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(["en"], gpu=True, verbose=False)
    return _reader


@app.function(image=image, gpu="L4", timeout=1200, scaledown_window=600,
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
        for poly, text, conf in reader.readtext(img, text_threshold=0.6, low_text=0.3):
            pts = np.array(poly, dtype=np.int32).reshape(-1, 2)
            x0 = int(max(0, pts[:, 0].min() - pad)); y0 = int(max(0, pts[:, 1].min() - pad))
            x1 = int(pts[:, 0].max() + pad); y1 = int(pts[:, 1].max() + pad)
            out.append((gi, x0, y0, x1, y1, text, float(conf), H, W))
    return out


# ── parallel ProPainter worker (H100 pool) ───────────────────────────────────
@app.function(image=image, gpu="A100", timeout=1800, memory=65536,
              scaledown_window=600, volumes={"/ProPainter/weights": ppw})
def pp_chunk(vbytes: bytes, mbytes: bytes) -> bytes:
    import os, subprocess, glob, shutil
    os.chdir("/ProPainter")
    open("in.mp4", "wb").write(vbytes); open("m.mp4", "wb").write(mbytes)
    shutil.rmtree("m_frames", ignore_errors=True); os.makedirs("m_frames")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", "m.mp4", "m_frames/%05d.png", "-y"], check=True)
    shutil.rmtree("results", ignore_errors=True)
    subprocess.run(["python", "inference_propainter.py", "--video", "in.mp4", "--mask", "m_frames",
                    "--output", "results", "--mask_dilation", "2", "--ref_stride", "10",
                    "--neighbor_length", "10", "--subvideo_length", "80", "--raft_iter", "20",
                    "--save_fps", "30", "--fp16"], check=True)
    o = glob.glob("results/**/inpaint_out.mp4", recursive=True)
    return open(o[0], "rb").read()


# ── CPU orchestrator ─────────────────────────────────────────────────────────
@app.cls(image=image, timeout=2400, memory=32768, secrets=[fal_secret])
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

    def build_mask(self, cfr, work, P, N):
        import os, subprocess, cv2, numpy as np
        fdir = f"{work}/f"; mdir = f"{work}/m"; os.makedirs(mdir, exist_ok=True); os.makedirs(fdir, exist_ok=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", cfr, f"{fdir}/%05d.png", "-y"], check=True)
        frames = sorted(os.listdir(fdir)); H, W = cv2.imread(f"{fdir}/{frames[0]}").shape[:2]
        dets, _ = self._ocr_all(cfr, N, 1, P["pad"])
        all_cy = [self._ok(d, W, H, P)[1] for i in dets for d in dets[i] if self._ok(d, W, H, P)[0]]
        if all_cy:
            hist, edges = np.histogram(all_cy, bins=24, range=(0, 1)); pk = int(np.argmax(hist))
            c = (edges[pk] + edges[pk + 1]) / 2
            near = [x for x in all_cy if abs(x - c) <= P["band_tol"]]
            if near: c = float(np.mean(near))
            band = (c - P["band_tol"], c + P["band_tol"])
        else:
            band = (0.0, 1.0)

        def glyph(img, boxes):
            if not boxes: return np.zeros((H, W), np.uint8)
            region = np.zeros((H, W), np.uint8)
            for (x0, y0, x1, y1) in boxes: cv2.rectangle(region, (x0, y0), (x1, y1), 255, -1)
            b, g, r = cv2.split(img.astype(np.int16))
            mn = np.minimum(np.minimum(b, g), r); mx = np.maximum(np.maximum(b, g), r)
            white = ((mn > 165) & ((mx - mn) < 45)).astype(np.uint8) * 255
            yellow = ((r > 150) & (g > 150) & (b < 130)).astype(np.uint8) * 255
            gp = cv2.bitwise_and(cv2.bitwise_or(white, yellow), region)
            n, lbl, st, _ = cv2.connectedComponentsWithStats(gp, connectivity=8)
            clean = np.zeros((H, W), np.uint8)
            for ci in range(1, n):
                a = st[ci, cv2.CC_STAT_AREA]
                if a < 8: continue
                cw = int(st[ci, cv2.CC_STAT_WIDTH]); ch = int(st[ci, cv2.CC_STAT_HEIGHT])
                if (a / max(1, cw * ch) > 0.55 and a > 1200) or (ch > 0.075 * H): continue
                clean[lbl == ci] = 255
            gp = cv2.morphologyEx(clean, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
            return cv2.bitwise_and(cv2.dilate(gp, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))), region)

        kf = {}
        for i in range(N):
            kf[i] = [(d[0], d[1], d[2], d[3]) for d in dets.get(i, [])
                     if (lambda ok, cy: ok and band[0] <= cy <= band[1])(*self._ok(d, W, H, P))]
        raw = [glyph(cv2.imread(f"{fdir}/{frames[i]}"), kf[i]) for i in range(N)]
        for i in range(N):
            m = raw[i].copy()
            if i > 0: m = cv2.bitwise_or(m, raw[i - 1])
            if i < N - 1: m = cv2.bitwise_or(m, raw[i + 1])
            cv2.imwrite(f"{mdir}/{frames[i]}", m)
        mask = f"{work}/mask.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", f"{mdir}/%05d.png",
                        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", mask, "-y"], check=True)
        return mask, band

    def verify(self, video, band, P, stride=2):
        N = self._nframes(video)
        dets, HW = self._ocr_all(video, N, stride, P["pad"])
        if not HW: return [], []
        H, W = HW; flagged = []
        for i in sorted(dets):
            for d in dets[i]:
                ok, cy = self._ok(d, W, H, P)
                if ok and band[0] <= cy <= band[1]:
                    flagged.append((i, round(i / 30, 2))); break
        ranges = []
        if flagged:
            idx = [f[0] for f in flagged]; s = p = idx[0]
            for k in idx[1:]:
                if k - p <= stride + 1: p = k
                else: ranges.append((s / 30, p / 30)); s = p = k
            ranges.append((s / 30, p / 30))
        return flagged, ranges

    def propaint(self, video, mask, work, tag, fstart=0, fend=None):
        import subprocess
        N = self._nframes(video); f0 = fstart; f1 = fend if fend is not None else N
        chunks = []; i = 0
        while f0 + i * 150 < f1:
            a = f0 + i * 150; b = min(f1, a + 150); cnt = b - a
            sel = f"select=between(n\\,{a}\\,{b-1}),setpts=N/30/TB"
            vp = f"{work}/cv_{tag}_{i}.mp4"; mp = f"{work}/cm_{tag}_{i}.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", video, "-vf", sel, "-r", "30",
                            "-frames:v", str(cnt), "-an", vp, "-y"], check=True)
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", mask, "-vf", sel, "-r", "30",
                            "-frames:v", str(cnt), "-pix_fmt", "yuv420p", mp, "-y"], check=True)
            chunks.append((open(vp, "rb").read(), open(mp, "rb").read())); i += 1
        results = list(pp_chunk.starmap(chunks))
        parts = []
        for j, rb in enumerate(results):
            p = f"{work}/cout_{tag}_{j}.mp4"; open(p, "wb").write(rb); parts.append(p)
        listf = f"{work}/cc_{tag}.txt"; open(listf, "w").write("\n".join(f"file '{p}'" for p in parts))
        out = f"{work}/{tag}.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", listf,
                        "-c:v", "libx264", "-crf", "18", out, "-y"], check=True)
        return out

    def _splice(self, base, insert, w0, w1, work, tag):
        import subprocess
        N = self._nframes(base); parts = []
        if w0 > 0:
            a = f"{work}/spa_{tag}.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", base, "-vf",
                f"select=between(n\\,0\\,{w0-1}),setpts=N/30/TB", "-r", "30", "-frames:v", str(w0),
                "-c:v", "libx264", "-crf", "18", a, "-y"], check=True); parts.append(a)
        parts.append(insert)
        if w1 < N:
            c = f"{work}/spc_{tag}.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", base, "-vf",
                f"select=between(n\\,{w1}\\,{N-1}),setpts=N/30/TB", "-r", "30", "-frames:v", str(N-w1),
                "-c:v", "libx264", "-crf", "18", c, "-y"], check=True); parts.append(c)
        listf = f"{work}/spl_{tag}.txt"; open(listf, "w").write("\n".join(f"file '{p}'" for p in parts))
        out = f"{work}/spliced_{tag}.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", listf,
                        "-c:v", "libx264", "-crf", "18", out, "-y"], check=True)
        return out

    def _void(self, cfr, ppout, mask, fs, fe, work, prompt):
        import subprocess, time, json, urllib.request, cv2, numpy as np
        VALID = [69, 77, 85, 93, 101, 109, 117, 125, 133, 141, 149, 157, 165, 173, 181, 189, 197]
        N = self._nframes(cfr); fsf = int(fs * 30); fef = int(fe * 30); mid = (fsf + fef) // 2
        need = fef - fsf + 1; win = next((v for v in VALID if v >= need + 16), VALID[-1])
        w0 = max(0, mid - win // 2); w1 = min(N, w0 + win); w0 = max(0, w1 - win)
        sel = f"select=between(n\\,{w0}\\,{w1-1}),setpts=N/30/TB"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", cfr, "-vf", sel, "-r", "30",
                        "-frames:v", str(w1-w0), "-an", f"{work}/wsrc.mp4", "-y"], check=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", mask, "-vf", sel + ",negate", "-r", "30",
                        "-pix_fmt", "yuv420p", "-frames:v", str(w1-w0), "-an", f"{work}/wmaskinv.mp4", "-y"], check=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", mask, "-vf", sel, "-r", "30",
                        "-frames:v", str(w1-w0), f"{work}/wmaskw.mp4", "-y"], check=True)
        fal_key = os.environ["FAL_KEY"]  # provided by the `fal` Modal secret
        def fal(method, url, body=None, raw=None, ct="application/json"):
            req = urllib.request.Request(url, method=method); req.add_header("Authorization", f"Key {fal_key}")
            if raw is not None: req.add_header("Content-Type", ct); data = raw
            elif body is not None: req.add_header("Content-Type", "application/json"); data = json.dumps(body).encode()
            else: data = None
            return urllib.request.urlopen(req, data)
        def up(path, name):
            init = json.loads(fal("POST", "https://rest.alpha.fal.ai/storage/upload/initiate",
                                  body={"file_name": name, "content_type": "video/mp4"}).read())
            fal("PUT", init["upload_url"], raw=open(path, "rb").read(), ct="video/mp4"); return init["file_url"]
        vu = up(f"{work}/wsrc.mp4", "s.mp4"); mu = up(f"{work}/wmaskinv.mp4", "m.mp4")
        if not prompt:
            prompt = "A person in an indoor room, natural daylight; natural skin, clothing and background. No text, no captions, no letters, no subtitles, no overlays."
        sub = json.loads(fal("POST", "https://queue.fal.run/fal-ai/void-video-inpainting",
            body={"video_url": vu, "quad_mask_video_url": mu, "prompt": prompt,
                  "num_frames": win, "enable_pass2_refinement": True}).read())
        su, ru = sub["status_url"], sub["response_url"]; out_url = None
        for _ in range(220):
            time.sleep(6); st = json.loads(fal("GET", su).read())
            if st["status"] == "COMPLETED": out_url = json.loads(fal("GET", ru).read())["video"]["url"]; break
            if st["status"] == "FAILED": raise RuntimeError("VOID failed")
        if not out_url: raise RuntimeError("VOID timeout")
        open(f"{work}/void_raw.mp4", "wb").write(urllib.request.urlopen(out_url).read())
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", f"{work}/void_raw.mp4",
                        "-vf", "settb=AVTB,setpts=N/30/TB,fps=30", "-r", "30", "-frames:v", str(w1-w0),
                        f"{work}/void30.mp4", "-y"], check=True)
        def rd(p):
            cap = cv2.VideoCapture(p); fr = []
            while True:
                ok, im = cap.read()
                if not ok: break
                fr.append(im)
            cap.release(); return fr
        pp = rd(ppout); vd = rd(f"{work}/void30.mp4"); mw = rd(f"{work}/wmaskw.mp4")
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        for j in range(min(len(vd), len(mw))):
            gi = w0 + j
            if gi >= len(pp): break
            m = cv2.cvtColor(mw[j], cv2.COLOR_BGR2GRAY); _, m = cv2.threshold(m, 60, 255, cv2.THRESH_BINARY); m = cv2.dilate(m, k)
            mf = (cv2.GaussianBlur(m, (19, 19), 0).astype(np.float32) / 255.0)[..., None]
            v = cv2.resize(vd[j], (pp[gi].shape[1], pp[gi].shape[0]))
            pp[gi] = (pp[gi] * (1 - mf) + v * mf).astype(np.uint8)
        h, w = pp[0].shape[:2]
        vw = cv2.VideoWriter(f"{work}/comp.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 30, (w, h))
        for fr in pp: vw.write(fr)
        vw.release()
        out = f"{work}/voidout.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", f"{work}/comp.mp4",
                        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out, "-y"], check=True)
        return out

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
        self.P = dict(pad=6, conf=0.4, min_height=0.030, cx_lo=0.08, cx_hi=0.92,
                      cy_lo=0.15, cy_hi=0.90, band_tol=0.07)
        T = {}; t0 = time.time()
        def mark(k): T[k] = round(time.time() - t0, 1); print(f"[stage] {k} @ {T[k]}s", flush=True)

        src = f"{work}/src.mp4"; open(src, "wb").write(video_bytes); cfr = f"{work}/cfr.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src, "-r", "30", "-c:v", "libx264",
                        "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", cfr, "-y"], check=True)
        mark("normalize")
        N = self._nframes(cfr)
        mask, band = self.build_mask(cfr, work, self.P, N); mark("mask")

        out = self.propaint(cfr, mask, work, "pp1"); mark("pp1")
        flagged, ranges = self.verify(out, band, self.P); mark("verify1")
        status = "clean_after_pass1"
        if flagged:
            fs = min(r[0] for r in ranges); fe = max(r[1] for r in ranges)
            w0 = max(0, int(fs * 30) - 45); w1 = min(N, int(fe * 30) + 45)
            win = self.propaint(out, mask, work, "pp2", w0, w1)
            out = self._splice(out, win, w0, w1, work, "pp2"); mark("pp2")
            flagged, ranges = self.verify(out, band, self.P); mark("verify2")
            status = "clean_after_pass2"
            if flagged:
                fs = min(r[0] for r in ranges); fe = max(r[1] for r in ranges)
                out = self._void(cfr, out, mask, fs, fe, work, prompt); mark("void")
                flagged, ranges = self.verify(out, band, self.P); mark("verify3")
                status = "clean_after_void" if not flagged else f"residual:{ranges}"

        final = f"{work}/final.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", out, "-i", cfr, "-map", "0:v:0",
                        "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-shortest", final, "-y"], check=True)
        mark("total")
        return {"video": open(final, "rb").read(), "timing": T, "band": band,
                "residual_ranges": ranges, "status": status}


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
