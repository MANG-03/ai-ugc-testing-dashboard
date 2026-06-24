"""
Cloud (Modal) glyph-mask generator — runs EasyOCR on a GPU so it's fast enough for
EVERY-frame OCR (no missed words) with ZERO load on the local Mac.

Generates the same glyph-level caption mask as make-glyph-mask-v3.py, plus
caption-vs-incidental-text discrimination (won't erase product labels / wall text).

Setup (one time):
  tests/captions/.venv/bin/modal setup     # browser auth, creates token

Run:
  tests/captions/.venv/bin/modal run tests/captions/modal_mask.py \
      --video /tmp/clip_cfr.mp4 --out-prefix /tmp/glyph_cloud --ocr-stride 1

Outputs <out_prefix>_textmask.mp4 (feed to ProPainter) and <out_prefix>_debug.mp4.
"""
import modal

app = modal.App("glyph-mask")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("easyocr==1.7.2", "opencv-python-headless", "numpy<2")
)

# Cache the EasyOCR model weights between calls so they don't re-download.
model_vol = modal.Volume.from_name("easyocr-models", create_if_missing=True)


@app.function(image=image, gpu="T4", timeout=1800, volumes={"/root/.EasyOCR": model_vol})
def generate_mask(video_bytes: bytes, p: dict) -> dict:
    import os, subprocess, tempfile
    import cv2
    import numpy as np
    import easyocr

    tmp = tempfile.mkdtemp()
    src = os.path.join(tmp, "src.mp4")
    with open(src, "wb") as f:
        f.write(video_bytes)
    fdir = os.path.join(tmp, "f"); mdir = os.path.join(tmp, "m"); ddir = os.path.join(tmp, "d")
    for d in (fdir, mdir, ddir):
        os.makedirs(d, exist_ok=True)

    # fps
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", src],
        capture_output=True, text=True)
    num, den = r.stdout.strip().split("/")
    fps = float(num) / float(den)

    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src,
        os.path.join(fdir, "%05d.png"), "-y"], check=True)
    frames = sorted(os.listdir(fdir))
    N = len(frames)
    H0, W0 = cv2.imread(os.path.join(fdir, frames[0])).shape[:2]

    reader = easyocr.Reader(["en"], gpu=True, verbose=False)

    PAD = p["pad"]; CONF = p["conf"]; MINH = p["min_height"]
    CXL, CXH, CYL, CYH = p["cx_lo"], p["cx_hi"], p["cy_lo"], p["cy_hi"]
    WHITE = p["white"]; CHROMA = p["chroma"]; MINBLOB = p["minblob"]; DIL = p["dilate"]
    stride = max(1, p["ocr_stride"]); TW = p["temporal"]
    SOLID_THRESH = p.get("solid_thresh", 0.55)   # >this fill ratio = solid object, not text
    SOLID_MIN_AREA = p.get("solid_min_area", 1200)  # px; below this, keep even if solid (letter dots)
    MAX_H_FRAC = p.get("max_h_frac", 0.075)      # component taller than this frac of frame H = object

    def detect(img):
        h, w = img.shape[:2]
        out = []
        for poly, text, conf in reader.readtext(img, text_threshold=0.6, low_text=0.3):
            pts = np.array(poly, dtype=np.int32).reshape(-1, 2)
            x0 = int(max(0, pts[:, 0].min() - PAD)); y0 = int(max(0, pts[:, 1].min() - PAD))
            x1 = int(min(w, pts[:, 0].max() + PAD)); y1 = int(min(h, pts[:, 1].max() + PAD))
            out.append((x0, y0, x1, y1, text, float(conf)))
        return out

    BAND_TOL = p.get("band_tol", 0.07)

    def passes_basic(det):
        """conf + multi-char + big + within coarse position window. Returns (ok, cy)."""
        x0, y0, x1, y1, text, conf = det
        cy = ((y0 + y1) / 2) / H0
        if conf < CONF or sum(c.isalnum() for c in text) < 2:
            return False, cy
        if (y1 - y0) / H0 < MINH:
            return False, cy  # small -> product/wall text
        cx = ((x0 + x1) / 2) / W0
        if not (CXL <= cx <= CXH and CYL <= cy <= CYH):
            return False, cy
        return True, cy

    # Pass A: detect all keyframes, gather candidate vertical positions.
    keyframes = sorted(set(list(range(0, N, stride)) + [N - 1]))
    kf_dets = {}
    all_cy = []
    for i in keyframes:
        img = cv2.imread(os.path.join(fdir, frames[i]))
        kf_dets[i] = detect(img)
        for d in kf_dets[i]:
            ok, cy = passes_basic(d)
            if ok:
                all_cy.append(cy)

    # CAPTION-BAND DETECTION: the real captions cluster at ONE consistent vertical
    # row (they appear in most frames); product/wall text sits elsewhere & is transient.
    # Find the densest cy cluster and keep only text in that band -> rejects the
    # product label that happens to be big+centered but at a different height.
    if all_cy:
        hist, edges = np.histogram(all_cy, bins=24, range=(0.0, 1.0))
        pk = int(np.argmax(hist))
        center = (edges[pk] + edges[pk + 1]) / 2
        near = [c for c in all_cy if abs(c - center) <= BAND_TOL]
        if near:
            center = float(np.mean(near))
        band_lo, band_hi = center - BAND_TOL, center + BAND_TOL
    else:
        band_lo, band_hi = 0.0, 1.0
    print(f"caption band: cy in [{band_lo:.3f}, {band_hi:.3f}] from {len(all_cy)} candidates")

    # Pass B: keep boxes that pass basic gates AND fall in the caption band.
    kf_boxes = {}
    for i in keyframes:
        boxes = []
        for d in kf_dets[i]:
            ok, cy = passes_basic(d)
            if ok and band_lo <= cy <= band_hi:
                boxes.append((d[0], d[1], d[2], d[3]))
        kf_boxes[i] = boxes

    def boxes_for(i):
        prev_k = max([k for k in keyframes if k <= i], default=keyframes[0])
        next_k = min([k for k in keyframes if k >= i], default=keyframes[-1])
        return kf_boxes.get(prev_k, []) + kf_boxes.get(next_k, [])

    def build_glyph(img, boxes):
        h, w = img.shape[:2]
        if not boxes:
            return np.zeros((h, w), np.uint8)
        region = np.zeros((h, w), np.uint8)
        for (x0, y0, x1, y1) in boxes:
            cv2.rectangle(region, (x0, y0), (x1, y1), 255, -1)
        b, g, r_ = cv2.split(img.astype(np.int16))
        mn = np.minimum(np.minimum(b, g), r_); mx = np.maximum(np.maximum(b, g), r_)
        white = ((mn > WHITE) & ((mx - mn) < CHROMA)).astype(np.uint8) * 255
        yellow = ((r_ > 150) & (g > 150) & (b < 130)).astype(np.uint8) * 255
        glyph = cv2.bitwise_and(cv2.bitwise_or(white, yellow), region)
        n, lbl, stats, _ = cv2.connectedComponentsWithStats(glyph, connectivity=8)
        clean = np.zeros((h, w), np.uint8)
        for ci in range(1, n):
            area = stats[ci, cv2.CC_STAT_AREA]
            if area < MINBLOB:
                continue
            cw = int(stats[ci, cv2.CC_STAT_WIDTH]); ch = int(stats[ci, cv2.CC_STAT_HEIGHT])
            solidity = area / max(1, cw * ch)
            # Reject SOLID white blobs (a product tube / hand entering the caption
            # band): high fill + large area, OR taller than any caption letter.
            # Text strokes are THIN (low solidity) so letters survive at any size.
            if (solidity > SOLID_THRESH and area > SOLID_MIN_AREA) or (ch > MAX_H_FRAC * h):
                continue
            clean[lbl == ci] = 255
        glyph = cv2.morphologyEx(clean, cv2.MORPH_CLOSE,
                                 cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
        if DIL > 0:
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (DIL * 2 + 1, DIL * 2 + 1))
            glyph = cv2.bitwise_and(cv2.dilate(glyph, k), region)
        return glyph

    raw = [build_glyph(cv2.imread(os.path.join(fdir, frames[i])), boxes_for(i)) for i in range(N)]

    for i in range(N):
        m = raw[i].copy()
        for d in range(1, TW + 1):
            if i - d >= 0: m = cv2.bitwise_or(m, raw[i - d])
            if i + d < N: m = cv2.bitwise_or(m, raw[i + d])
        cv2.imwrite(os.path.join(mdir, frames[i]), m)
        img = cv2.imread(os.path.join(fdir, frames[i]))
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(img, cnts, -1, (0, 0, 255), 1)
        cv2.imwrite(os.path.join(ddir, frames[i]), img)

    mask_out = os.path.join(tmp, "mask.mp4"); dbg_out = os.path.join(tmp, "dbg.mp4")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", f"{fps}",
        "-i", os.path.join(mdir, "%05d.png"), "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "18", "-pix_fmt", "yuv420p", mask_out, "-y"], check=True)
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-framerate", f"{fps}",
        "-i", os.path.join(ddir, "%05d.png"), "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "20", "-pix_fmt", "yuv420p", dbg_out, "-y"], check=True)
    with open(mask_out, "rb") as f: mask_bytes = f.read()
    with open(dbg_out, "rb") as f: dbg_bytes = f.read()
    return {"mask": mask_bytes, "debug": dbg_bytes, "frames": N, "keyframes": len(keyframes),
            "band": [round(band_lo, 3), round(band_hi, 3)]}


@app.local_entrypoint()
def main(video: str, out_prefix: str, ocr_stride: int = 1, min_height: float = 0.030,
         dilate: int = 2, conf: float = 0.4, temporal: int = 1, band_tol: float = 0.07,
         cx_lo: float = 0.08, cx_hi: float = 0.92, cy_lo: float = 0.15, cy_hi: float = 0.90,
         solid_thresh: float = 0.55, solid_min_area: int = 1200, max_h_frac: float = 0.075):
    with open(video, "rb") as f:
        vb = f.read()
    params = dict(pad=6, conf=conf, min_height=min_height, cx_lo=cx_lo, cx_hi=cx_hi,
                  cy_lo=cy_lo, cy_hi=cy_hi, white=165, chroma=45, minblob=8,
                  dilate=dilate, ocr_stride=ocr_stride, temporal=temporal, band_tol=band_tol,
                  solid_thresh=solid_thresh, solid_min_area=solid_min_area, max_h_frac=max_h_frac)
    res = generate_mask.remote(vb, params)
    with open(f"{out_prefix}_textmask.mp4", "wb") as f:
        f.write(res["mask"])
    with open(f"{out_prefix}_debug.mp4", "wb") as f:
        f.write(res["debug"])
    import json
    with open(f"{out_prefix}_meta.json", "w") as f:
        json.dump({"band": res["band"], "frames": res["frames"]}, f)
    print(f"OK frames={res['frames']} keyframes={res['keyframes']} band={res['band']} -> {out_prefix}_textmask.mp4")
