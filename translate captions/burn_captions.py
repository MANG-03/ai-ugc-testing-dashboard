"""Burn TikTok-style caption groups onto a video WITHOUT libass/drawtext.
Render each caption group to a transparent PNG with PIL (bold white + black outline), then composite
with ffmpeg's `overlay` filter, timed to the ASR word timings. Works even on ffmpeg builds that lack
libass and drawtext (only `overlay` is required).
Env: WORDS (scribe/whisper json), VIDEO (dub video), OUT, [MAXW=3], [POS=0.60], [GAP=0.5]."""
import os, json, subprocess
from PIL import Image, ImageDraw, ImageFont

WORDS = os.environ["WORDS"]; VIDEO = os.environ["VIDEO"]; OUT = os.environ["OUT"]
MAXW = int(os.environ.get("MAXW", "3"))          # max words per caption group
POS = float(os.environ.get("POS", "0.60"))       # vertical position (fraction of height)
GAP = float(os.environ.get("GAP", "0.5"))        # break a group when the pause to the next word exceeds this

# first bold font that exists (macOS / Linux)
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]
FONT = next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)
if not FONT:
    raise SystemExit("No bold font found — edit FONT_CANDIDATES with a valid .ttf path")

def dims(p):
    o = subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=p=0:s=x",p],capture_output=True,text=True).stdout.strip()
    return tuple(int(x) for x in o.split("x"))
W, H = dims(VIDEO); CY = int(H * POS)

resp = json.load(open(WORDS))
words = [w for w in resp["words"] if w.get("type") == "word"]

# group into short caption chunks (break on max words, big pause, or sentence punctuation)
groups, cur = [], []
for w in words:
    if cur:
        prev = cur[-1]
        if len(cur) >= MAXW or (w["start"] - prev["end"]) > GAP or prev["text"][-1:] in ".!?":
            groups.append(cur); cur = []
    cur.append(w)
if cur: groups.append(cur)

os.makedirs("/tmp/cap_pngs", exist_ok=True)
events = []
for i, g in enumerate(groups):
    start = g[0]["start"]; end = g[-1]["end"] + 0.12
    if i+1 < len(groups): end = min(end, groups[i+1][0]["start"] - 0.01)
    if end <= start: end = start + 0.3
    txt = " ".join(w["text"] for w in g).upper()
    size = 62
    while size > 30:
        font = ImageFont.truetype(FONT, size)
        bb = font.getbbox(txt, stroke_width=6)
        if (bb[2]-bb[0]) <= W*0.92: break
        size -= 2
    img = Image.new("RGBA", (W, H), (0,0,0,0)); d = ImageDraw.Draw(img)
    d.text((W//2, CY), txt, font=font, fill=(255,255,255,255),
           stroke_width=6, stroke_fill=(0,0,0,255), anchor="mm")
    p = f"/tmp/cap_pngs/g{i:03d}.png"; img.save(p)
    events.append((p, start, end))
print(f"{len(events)} caption PNGs rendered ({len(words)} words)", flush=True)

inputs = ["-i", VIDEO]
for p,_,_ in events: inputs += ["-i", p]
fc = []; prev = "[0:v]"
for i,(p,s,e) in enumerate(events):
    lbl = f"[v{i}]"; fc.append(f"{prev}[{i+1}:v]overlay=0:0:enable='between(t,{s:.3f},{e:.3f})'{lbl}"); prev = lbl
cmd = ["ffmpeg","-nostdin","-v","error", *inputs, "-filter_complex", ";".join(fc),
       "-map", prev, "-map", "0:a:0?", "-c:v","libx264","-crf","16","-pix_fmt","yuv420p","-c:a","copy", OUT, "-y"]
subprocess.run(cmd, check=True)
print(f"SAVED {OUT}", flush=True)
