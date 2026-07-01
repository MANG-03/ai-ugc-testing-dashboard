"""
Fixed-position box caption mask (v3). The mask no longer chases per-frame OCR positions (which
drift to the moving mic/bottle and cause LTX to repaint the wrong areas -> warping). Instead:
  1. OCR all frames -> in-band detections -> keep the STABLE (screen-fixed) ones = the captions.
  2. Compute ONE FIXED BOX = the screen region those stable captions occupy (robust percentile
     bounds, padded). This box is LOCKED in X/Y/W/H for the whole video.
  3. Per frame, turn the box ON only when a detection actually overlaps that fixed box (a caption
     is present there) — NOT based on where OCR found text. Temporal-fill +/-tfill.
So the mask is always at the caption spot, never the mic/bottle/arm, and LTX only repaints that strip.

Run: tests/captions/.venv/bin/python -m modal run /tmp/boxmask_v3.py --video <in> --out <mask> [--overlay <ov>]
"""
import modal

app = modal.App("boxmask-v3")
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("opencv-python-headless", "numpy<2", "easyocr==1.7.2")
)
ocrw = modal.Volume.from_name("easyocr-models", create_if_missing=True)


@app.function(image=image, gpu="L4", timeout=1800, volumes={"/root/.EasyOCR": ocrw})
def boxmask(vbytes: bytes, band_lo: float, band_hi: float, cx_lo: float, cx_hi: float,
            pad: int, kn: int, iou_thr: float, stab_min: int, tfill: int, want_overlay: bool):
    import os, subprocess, glob, cv2, numpy as np, easyocr
    for d in ("/tmp/f", "/tmp/m", "/tmp/ov"):
        os.makedirs(d, exist_ok=True)
    open("/tmp/v.mp4", "wb").write(vbytes)
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", "/tmp/v.mp4", "/tmp/f/%05d.png", "-y"], check=True)
    frames = sorted(glob.glob("/tmp/f/*.png")); N = len(frames)
    reader = easyocr.Reader(["en"], gpu=True, verbose=False)
    H, W = cv2.imread(frames[0]).shape[:2]

    # 1) collect in-band valid detection boxes per frame
    dets = [[] for _ in range(N)]
    for k, fp in enumerate(frames):
        for poly, text, conf in reader.readtext(cv2.imread(fp), text_threshold=0.3, low_text=0.3, mag_ratio=2.0):
            if conf < 0.25 or sum(c.isalnum() for c in text) < 2:
                continue
            pts = np.array(poly, dtype=np.int32).reshape(-1, 2)
            x0, y0 = int(pts[:, 0].min()), int(pts[:, 1].min()); x1, y1 = int(pts[:, 0].max()), int(pts[:, 1].max())
            cx = ((x0 + x1) / 2) / W; cy = ((y0 + y1) / 2) / H
            if not (band_lo <= cy <= band_hi and cx_lo <= cx <= cx_hi):
                continue
            if (y1 - y0) < 0.018 * H:
                continue
            dets[k].append((x0, y0, x1, y1))

    def iou(a, b):
        ix0, iy0 = max(a[0], b[0]), max(a[1], b[1]); ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
        iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0); inter = iw * ih
        if inter == 0: return 0.0
        ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / ua if ua > 0 else 0.0

    # 2) STABLE detections = screen-fixed (captions). These define the fixed box; movers (mic/bottle) excluded.
    stable = []
    for k in range(N):
        for d in dets[k]:
            cnt = sum(1 for j in range(max(0, k - kn), min(N, k + kn + 1)) if j != k
                      and any(iou(d, e) >= iou_thr for e in dets[j]))
            if cnt >= stab_min:
                stable.append(d)
    if not stable:
        # no captions found -> empty mask
        for k in range(N): cv2.imwrite(f"/tmp/m/{k+1:05d}.png", np.zeros((H, W), np.uint8))
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", "/tmp/m/%05d.png",
                        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "/tmp/out.mp4", "-y"], check=True)
        return {"mask": open("/tmp/out.mp4", "rb").read(), "overlay": b"", "box": None}

    # FIXED BOX = robust bounds of stable-caption positions (2nd..98th pct), padded, clamped
    sx0 = np.array([d[0] for d in stable]); sy0 = np.array([d[1] for d in stable])
    sx1 = np.array([d[2] for d in stable]); sy1 = np.array([d[3] for d in stable])
    bx0 = max(0, int(np.percentile(sx0, 2)) - pad); by0 = max(0, int(np.percentile(sy0, 2)) - pad)
    bx1 = min(W, int(np.percentile(sx1, 98)) + pad); by1 = min(H, int(np.percentile(sy1, 98)) + pad)
    fixed = (bx0, by0, bx1, by1)
    print(f"[boxmask-v3] FIXED BOX x[{bx0}-{bx1}] y[{by0}-{by1}] "
          f"(cx {bx0/W:.2f}-{bx1/W:.2f}, cy {by0/H:.2f}-{by1/H:.2f}) from {len(stable)} stable dets", flush=True)

    # 3) per-frame ON/OFF: box active only when a detection overlaps the fixed box (caption present there)
    active = [any(iou(d, fixed) > 0 for d in dets[k]) for k in range(N)]
    # temporal-fill the on/off (cover OCR misses)
    filled = [False] * N
    for k in range(N):
        filled[k] = any(active[j] for j in range(max(0, k - tfill), min(N, k + tfill + 1)))
    non = 0
    for k in range(N):
        m = np.zeros((H, W), np.uint8)
        if filled[k]:
            cv2.rectangle(m, (bx0, by0), (bx1, by1), 255, -1); non += 1
        cv2.imwrite(f"/tmp/m/{k+1:05d}.png", m)
        if want_overlay:
            img = cv2.imread(frames[k]); red = np.zeros_like(img); red[..., 2] = m
            cv2.imwrite(f"/tmp/ov/{k+1:05d}.png", cv2.addWeighted(img, 1.0, red, 0.45, 0))
    print(f"[boxmask-v3] box active on {non}/{N} frames", flush=True)
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", "/tmp/m/%05d.png",
                    "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "/tmp/out.mp4", "-y"], check=True)
    ovb = b""
    if want_overlay:
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", "30", "-i", "/tmp/ov/%05d.png",
                        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "/tmp/ov.mp4", "-y"], check=True)
        ovb = open("/tmp/ov.mp4", "rb").read()
    return {"mask": open("/tmp/out.mp4", "rb").read(), "overlay": ovb, "box": fixed}


@app.local_entrypoint()
def main(video: str, out: str, overlay: str = "", band_lo: float = 0.46, band_hi: float = 0.72,
         cx_lo: float = 0.20, cx_hi: float = 0.80, pad: int = 12, kn: int = 4, iou_thr: float = 0.25,
         stab_min: int = 4, tfill: int = 3):
    r = boxmask.remote(open(video, "rb").read(), band_lo, band_hi, cx_lo, cx_hi, pad, kn, iou_thr,
                       stab_min, tfill, bool(overlay))
    open(out, "wb").write(r["mask"]); print(f"SAVED mask {out}  box={r['box']}")
    if overlay and r["overlay"]:
        open(overlay, "wb").write(r["overlay"]); print(f"SAVED overlay {overlay}")
