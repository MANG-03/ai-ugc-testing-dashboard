"""
OCR self-verification pass — the automatic "judge" that replaces human review.

Runs EasyOCR on a ProPainter (or any) OUTPUT video, but ONLY inside the caption band
(so product labels / wall text elsewhere don't trigger false flags). Reports every frame
where confident caption-like text SURVIVED, grouped into time ranges. That list is what the
escalation logic acts on: residual → ProPainter pass 2 → VOID composite.

Run:
  tests/captions/.venv/bin/python -m modal run tests/captions/modal_verify.py \
      --video /path/out.mp4 --band-lo 0.647 --band-hi 0.787
"""
import modal

app = modal.App("glyph-verify")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("easyocr==1.7.2", "opencv-python-headless", "numpy<2")
)
model_vol = modal.Volume.from_name("easyocr-models", create_if_missing=True)


@app.function(image=image, gpu="T4", timeout=1800, volumes={"/root/.EasyOCR": model_vol})
def verify(video_bytes: bytes, band_lo: float, band_hi: float, conf: float, min_height: float):
    import os, subprocess, tempfile
    import cv2
    import numpy as np
    import easyocr

    tmp = tempfile.mkdtemp()
    src = os.path.join(tmp, "v.mp4")
    with open(src, "wb") as f:
        f.write(video_bytes)
    fdir = os.path.join(tmp, "f"); os.makedirs(fdir, exist_ok=True)
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", src],
        capture_output=True, text=True)
    num, den = r.stdout.strip().split("/"); fps = float(num) / float(den)
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src,
        os.path.join(fdir, "%05d.png"), "-y"], check=True)
    frames = sorted(os.listdir(fdir))
    N = len(frames)
    H, W = cv2.imread(os.path.join(fdir, frames[0])).shape[:2]

    reader = easyocr.Reader(["en"], gpu=True, verbose=False)

    flagged = []  # (frame_idx, time_s, text, conf)
    for i, fn in enumerate(frames):
        img = cv2.imread(os.path.join(fdir, fn))
        for poly, text, c in reader.readtext(img, text_threshold=0.6, low_text=0.3):
            if c < conf or sum(ch.isalnum() for ch in text) < 2:
                continue
            pts = np.array(poly, dtype=np.int32).reshape(-1, 2)
            y0, y1 = pts[:, 1].min(), pts[:, 1].max()
            if (y1 - y0) / H < min_height:
                continue
            cy = ((y0 + y1) / 2) / H
            if band_lo <= cy <= band_hi:  # residual text INSIDE the caption band
                flagged.append((i, round(i / fps, 2), text, round(float(c), 2)))
                break  # one hit per frame is enough

    # group consecutive flagged frames into ranges
    ranges = []
    if flagged:
        idxs = [f[0] for f in flagged]
        start = prev = idxs[0]
        for k in idxs[1:]:
            if k - prev <= 2:  # allow 1-frame gaps
                prev = k
            else:
                ranges.append((start / fps, prev / fps)); start = prev = k
        ranges.append((start / fps, prev / fps))

    return {"frames": N, "fps": fps, "flagged_count": len(flagged),
            "flagged": flagged[:60], "ranges": [(round(a, 2), round(b, 2)) for a, b in ranges]}


@app.local_entrypoint()
def main(video: str, band_lo: float = 0.15, band_hi: float = 0.90,
         conf: float = 0.4, min_height: float = 0.030, json_out: str = ""):
    with open(video, "rb") as f:
        vb = f.read()
    res = verify.remote(vb, band_lo, band_hi, conf, min_height)
    print(f"\n=== VERIFY {video} ===")
    print(f"frames={res['frames']} fps={res['fps']:.2f}  residual frames flagged: {res['flagged_count']}")
    if res["flagged_count"] == 0:
        print("✅ CLEAN — no caption-band text survived (OCR-verified)")
    else:
        print(f"⚠ RESIDUAL in time ranges: {res['ranges']}")
        for fr, t, txt, c in res["flagged"][:20]:
            print(f"   frame {fr} @ {t}s  '{txt}' (conf {c})")
    if json_out:
        import json
        with open(json_out, "w") as f:
            json.dump({"flagged_count": res["flagged_count"], "ranges": res["ranges"],
                       "frames": res["frames"]}, f)
