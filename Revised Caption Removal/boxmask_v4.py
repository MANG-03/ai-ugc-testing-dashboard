"""
Fixed-box caption mask v4 — SAMPLED. OCR is used ONLY to LOCATE the caption box, not per-frame.
  1. Sample ~n_samp frames spread across the whole video.
  2. OCR just those -> in-band detections. The caption sits at a CONSISTENT screen row across samples
     (dominant cy cluster); the moving mic/products scatter across rows -> excluded by taking the
     dominant band.
  3. Fix ONE box at that location (locked X/Y/W/H) and turn it ON for the whole video (always-on).
No per-frame OCR -> mask generation goes from minutes to seconds. (Separate from v3, which is kept.)

Run: tests/captions/.venv/bin/python -m modal run /tmp/boxmask_v4.py --video <in> --out <mask> [--overlay <ov>]
"""
import modal

app = modal.App("boxmask-v4")
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("opencv-python-headless", "numpy<2", "easyocr==1.7.2")
)
ocrw = modal.Volume.from_name("easyocr-models", create_if_missing=True)


@app.function(image=image, gpu="L4", timeout=900, volumes={"/root/.EasyOCR": ocrw})
def boxmask(vbytes: bytes, band_lo: float, band_hi: float, cx_lo: float, cx_hi: float,
            pad: int, n_samp: int, band_tol: float, want_overlay: bool):
    import os, subprocess, glob, cv2, numpy as np, easyocr
    for d in ("/tmp/s", "/tmp/f", "/tmp/m", "/tmp/ov"):
        os.makedirs(d, exist_ok=True)
    open("/tmp/v.mp4", "wb").write(vbytes)
    # total frame count + dims (probe one frame)
    N = int(subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
             "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", "/tmp/v.mp4"],
             capture_output=True, text=True).stdout.strip())
    S = max(1, N // n_samp)
    # extract ONLY sampled frames (every Sth) for OCR
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", "/tmp/v.mp4",
                    "-vf", f"select=not(mod(n\\,{S}))", "-vsync", "0", "/tmp/s/%05d.png", "-y"], check=True)
    samp = sorted(glob.glob("/tmp/s/*.png"))
    H, W = cv2.imread(samp[0]).shape[:2]
    reader = easyocr.Reader(["en"], gpu=True, verbose=False)

    dets = []  # (x0,y0,x1,y1,cy)
    for fp in samp:
        for poly, text, conf in reader.readtext(cv2.imread(fp), text_threshold=0.3, low_text=0.3, mag_ratio=2.0):
            if conf < 0.3 or sum(c.isalnum() for c in text) < 2:
                continue
            pts = np.array(poly, dtype=np.int32).reshape(-1, 2)
            x0, y0 = int(pts[:, 0].min()), int(pts[:, 1].min()); x1, y1 = int(pts[:, 0].max()), int(pts[:, 1].max())
            cx = ((x0 + x1) / 2) / W; cy = ((y0 + y1) / 2) / H
            if not (band_lo <= cy <= band_hi and cx_lo <= cx <= cx_hi): continue
            if (y1 - y0) < 0.018 * H: continue
            dets.append((x0, y0, x1, y1, cy))
    print(f"[boxmask-v4] OCR'd {len(samp)} sampled frames (every {S}th of {N}) -> {len(dets)} in-band dets", flush=True)

    def blank_all():
        for k in range(N): cv2.imwrite(f"/tmp/m/{k+1:05d}.png", np.zeros((H, W), np.uint8))
    if not dets:
        blank_all()
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", "/tmp/m/%05d.png",
                        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "/tmp/out.mp4", "-y"], check=True)
        return {"mask": open("/tmp/out.mp4", "rb").read(), "overlay": b"", "box": None}

    # dominant caption ROW: histogram cy, take the peak cluster (captions consistent; mic scatters)
    cys = np.array([d[4] for d in dets])
    hist, edges = np.histogram(cys, bins=24, range=(band_lo, band_hi)); pk = int(np.argmax(hist))
    c = (edges[pk] + edges[pk + 1]) / 2
    near = cys[np.abs(cys - c) <= band_tol]
    c = float(near.mean()) if len(near) else c
    keep = [d for d in dets if abs(d[4] - c) <= band_tol]
    print(f"[boxmask-v4] dominant caption row cy~{c:.3f}; {len(keep)}/{len(dets)} dets in band", flush=True)

    kx0 = np.array([d[0] for d in keep]); ky0 = np.array([d[1] for d in keep])
    kx1 = np.array([d[2] for d in keep]); ky1 = np.array([d[3] for d in keep])
    bx0 = max(0, int(np.percentile(kx0, 2)) - pad); by0 = max(0, int(np.percentile(ky0, 2)) - pad)
    bx1 = min(W, int(np.percentile(kx1, 98)) + pad); by1 = min(H, int(np.percentile(ky1, 98)) + pad)
    box = (bx0, by0, bx1, by1)
    print(f"[boxmask-v4] FIXED BOX x[{bx0}-{bx1}] y[{by0}-{by1}] (cx {bx0/W:.2f}-{bx1/W:.2f}, cy {by0/H:.2f}-{by1/H:.2f})", flush=True)

    # always-on mask over the whole video (no per-frame OCR)
    m1 = np.zeros((H, W), np.uint8); cv2.rectangle(m1, (bx0, by0), (bx1, by1), 255, -1)
    for k in range(N): cv2.imwrite(f"/tmp/m/{k+1:05d}.png", m1)
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", "/tmp/m/%05d.png",
                    "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "/tmp/out.mp4", "-y"], check=True)
    ovb = b""
    if want_overlay:
        # overlay the fixed box on the sampled frames for a quick visual check
        for i, fp in enumerate(samp):
            img = cv2.imread(fp); red = np.zeros_like(img); red[..., 2] = m1
            cv2.imwrite(f"/tmp/ov/{i+1:05d}.png", cv2.addWeighted(img, 1.0, red, 0.45, 0))
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "6", "-i", "/tmp/ov/%05d.png",
                        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "/tmp/ov.mp4", "-y"], check=True)
        ovb = open("/tmp/ov.mp4", "rb").read()
    return {"mask": open("/tmp/out.mp4", "rb").read(), "overlay": ovb, "box": box}


@app.local_entrypoint()
def main(video: str, out: str, overlay: str = "", band_lo: float = 0.40, band_hi: float = 0.76,
         cx_lo: float = 0.15, cx_hi: float = 0.85, pad: int = 22, n_samp: int = 50, band_tol: float = 0.06):
    r = boxmask.remote(open(video, "rb").read(), band_lo, band_hi, cx_lo, cx_hi, pad, n_samp, band_tol, bool(overlay))
    open(out, "wb").write(r["mask"]); print(f"SAVED mask {out}  box={r['box']}")
    if overlay and r["overlay"]:
        open(overlay, "wb").write(r["overlay"]); print(f"SAVED overlay {overlay}")
