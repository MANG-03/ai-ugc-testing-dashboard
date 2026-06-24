#!/usr/bin/env python3
"""
VOID-composite escalation — the final step of the auto caption-removal loop.

For the SHORT range the OCR verifier flagged as ProPainter-failure, run VOID (diffusion)
on a small window covering it, then composite ONLY the caption-patch pixels (inside the
mask, feathered) onto the otherwise-crisp ProPainter output. VOID's softness is confined to
a ~1s patch; the rest of the video stays ProPainter-sharp.

Pipeline: window-extract -> VOID (fal) -> resample to 30fps/frame-exact -> mask-feather
composite onto ProPainter output -> splice back -> remux audio.

Usage:
  .venv/bin/python void_composite.py \
     --cfr /tmp/v5_cfr.mp4 --pp /Users/.../v5_clean_pass2.mp4 --mask /tmp/v5_cloud_textmask.mp4 \
     --flag-start 3.6 --flag-end 4.33 --out /Users/.../v5_void_final.mp4 \
     --prompt "..."
"""
import os, sys, argparse, subprocess, tempfile, time, json, urllib.request
import cv2
import numpy as np

FAL_KEY = os.environ["FAL_KEY"]  # export FAL_KEY=<your fal.ai key> before running — never hardcode
VALID = [69, 77, 85, 93, 101, 109, 117, 125, 133, 141, 149, 157, 165, 173, 181, 189, 197]

ap = argparse.ArgumentParser()
ap.add_argument("--cfr", required=True)        # 30fps source
ap.add_argument("--pp", required=True)         # ProPainter output to patch
ap.add_argument("--mask", required=True)       # white=remove mask (same frames as cfr)
ap.add_argument("--flag-start", type=float, required=True)  # seconds
ap.add_argument("--flag-end", type=float, required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--prompt", default="A young man with curly dark hair wearing a black t-shirt, holding a white skincare product tube, indoor room with green plants and a large window, natural daylight. No text, no captions, no letters, no subtitles, no overlays.")
ap.add_argument("--feather", type=int, default=9)
args = ap.parse_args()

tmp = tempfile.mkdtemp(prefix="voidcomp_")
def ff(a): subprocess.run(["ffmpeg", "-nostdin", "-v", "error", *a], check=True)
def nframes(p): return int(subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames","-of","csv=p=0",p],capture_output=True,text=True).stdout.strip())

FPS = 30
N = nframes(args.cfr)
fs = int(round(args.flag_start * FPS)); fe = int(round(args.flag_end * FPS))
mid = (fs + fe) // 2
# choose a VOID window length that covers the flagged range, centered on it
need = fe - fs + 1
win_len = next((v for v in VALID if v >= need + 16), VALID[-1])
w0 = max(0, mid - win_len // 2); w1 = min(N, w0 + win_len); w0 = max(0, w1 - win_len)
print(f"flagged frames {fs}-{fe} ({need}); VOID window {w0}-{w1} ({w1-w0} frames, num_frames={win_len})")

# 1) extract the window from CFR (source) and build an INVERTED mask (VOID: black=remove)
ff(["-i", args.cfr, "-vf", f"select=between(n\\,{w0}\\,{w1-1}),setpts=N/30/TB", "-r", "30", "-frames:v", str(w1-w0), "-an", f"{tmp}/win_src.mp4", "-y"])
ff(["-i", args.mask, "-vf", f"select=between(n\\,{w0}\\,{w1-1}),setpts=N/30/TB,negate", "-r", "30", "-pix_fmt", "yuv420p", "-frames:v", str(w1-w0), "-an", f"{tmp}/win_maskinv.mp4", "-y"])

# 2) VOID on the window (fal)
def fal(method, url, body=None, raw=None, ctype="application/json"):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Key {FAL_KEY}")
    if raw is not None:
        req.add_header("Content-Type", ctype); data = raw
    elif body is not None:
        req.add_header("Content-Type", "application/json"); data = json.dumps(body).encode()
    else:
        data = None
    return urllib.request.urlopen(req, data)

def upload(path, name):
    init = json.loads(fal("POST", "https://rest.alpha.fal.ai/storage/upload/initiate",
                          body={"file_name": name, "content_type": "video/mp4"}).read())
    fal("PUT", init["upload_url"], raw=open(path, "rb").read(), ctype="video/mp4")
    return init["file_url"]

print("uploading window to fal…")
vu = upload(f"{tmp}/win_src.mp4", "win.mp4"); mu = upload(f"{tmp}/win_maskinv.mp4", "winmask.mp4")
print("submitting VOID…")
sub = json.loads(fal("POST", "https://queue.fal.run/fal-ai/void-video-inpainting",
                     body={"video_url": vu, "quad_mask_video_url": mu, "prompt": args.prompt,
                           "num_frames": win_len, "enable_pass2_refinement": True}).read())
status_url, response_url = sub["status_url"], sub["response_url"]
out_url = None
for _ in range(200):
    time.sleep(6)
    st = json.loads(fal("GET", status_url).read())
    if st["status"] == "COMPLETED":
        rd = json.loads(fal("GET", response_url).read()); out_url = rd["video"]["url"]; break
    if st["status"] == "FAILED": sys.exit("VOID failed: " + json.dumps(st)[:300])
if not out_url: sys.exit("VOID timed out")
open(f"{tmp}/void_raw.mp4", "wb").write(urllib.request.urlopen(out_url).read())
print("VOID done")

# 3) resample VOID output to EXACTLY win_len frames @ 30fps (it re-times to ~12fps)
ff(["-i", f"{tmp}/void_raw.mp4", "-vf", f"settb=AVTB,setpts=N/30/TB,fps=30", "-r", "30", "-frames:v", str(w1-w0), f"{tmp}/void_30.mp4", "-y"])

# 4) composite: inside the (feathered, dilated) caption mask -> VOID; else -> ProPainter output
def read_frames(p, a, b=None):
    cap = cv2.VideoCapture(p); fr = []
    idx = 0
    while True:
        ok, im = cap.read()
        if not ok: break
        if idx >= a and (b is None or idx < b): fr.append(im)
        idx += 1
    cap.release(); return fr

pp_frames = read_frames(args.pp, 0)               # full ProPainter output
void_frames = read_frames(f"{tmp}/void_30.mp4", 0)
mask_frames = read_frames(args.mask, w0, w1)      # white=remove, window slice
NPP = len(pp_frames)
print(f"pp={NPP} void={len(void_frames)} maskwin={len(mask_frames)}")

k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (args.feather, args.feather))
for j in range(min(len(void_frames), len(mask_frames))):
    gi = w0 + j
    if gi >= NPP: break
    m = cv2.cvtColor(mask_frames[j], cv2.COLOR_BGR2GRAY)
    _, m = cv2.threshold(m, 60, 255, cv2.THRESH_BINARY)
    m = cv2.dilate(m, k)
    mf = cv2.GaussianBlur(m, (args.feather*2+1, args.feather*2+1), 0).astype(np.float32) / 255.0
    mf = mf[..., None]
    vd = cv2.resize(void_frames[j], (pp_frames[gi].shape[1], pp_frames[gi].shape[0]))
    pp_frames[gi] = (pp_frames[gi] * (1 - mf) + vd * mf).astype(np.uint8)

# 5) write composited video, remux original audio
h, w = pp_frames[0].shape[:2]
vw = cv2.VideoWriter(f"{tmp}/comp.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 30, (w, h))
for fr in pp_frames: vw.write(fr)
vw.release()
ff(["-i", f"{tmp}/comp.mp4", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", f"{tmp}/comp_h264.mp4", "-y"])
ff(["-i", f"{tmp}/comp_h264.mp4", "-i", args.cfr, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-shortest", args.out, "-y"])
print(f"WROTE {args.out}")
