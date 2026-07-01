"""LTX-2.3 inpaint + FADE composite, parameterized via env (VIDEO, MASK, AUDIO_SRC, OUT).
Chunk video+mask, submit all to fal, poll concurrently, concat, then MASK-ONLY composite with a
SOFT GRADIENT FADE (gblur) so the fixed box blends into the original. Remux audio."""
import os, json, time, subprocess, urllib.request
from concurrent.futures import ThreadPoolExecutor

FK = os.environ["FAL_KEY"]
VIDEO = os.environ["VIDEO"]; MASK = os.environ["MASK"]
AUDIO_SRC = os.environ["AUDIO_SRC"]; OUT = os.environ["OUT"]
CH = 300
PROMPT = "natural clean background, no text, no captions, no letters, no subtitles"

def sh(a): return subprocess.run(a, capture_output=True, text=True).stdout.strip()
def nframes(p): return int(sh(["ffprobe","-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames","-of","csv=p=0",p]))
def dims(p): return sh(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=p=0:s=x",p])

def fal(method, url, body=None, raw=None, ct="application/json"):
    for attempt in range(6):
        try:
            r = urllib.request.Request(url, method=method); r.add_header("Authorization", f"Key {FK}")
            if raw is not None: r.add_header("Content-Type", ct); d = raw
            elif body is not None: r.add_header("Content-Type","application/json"); d = json.dumps(body).encode()
            else: d = None
            return urllib.request.urlopen(r, d, timeout=180)
        except Exception:
            if attempt == 5: raise
            time.sleep(2**attempt)

def up(path, name):
    init = json.loads(fal("POST","https://rest.alpha.fal.ai/storage/upload/initiate",body={"file_name":name,"content_type":"video/mp4"}).read())
    fal("PUT", init["upload_url"], raw=open(path,"rb").read(), ct="video/mp4"); return init["file_url"]

W, H = (int(x) for x in dims(VIDEO).split("x"))
N = nframes(VIDEO); print(f"{VIDEO}: {N} frames {W}x{H}", flush=True)
bounds = [(s, min(N, s+CH)) for s in range(0, N, CH)]
if len(bounds) > 1 and bounds[-1][1]-bounds[-1][0] < 40:
    bounds[-2] = (bounds[-2][0], bounds[-1][1]); bounds.pop()
print("chunks:", bounds, flush=True)

def submit(i_se):
    i,(s,e) = i_se; cnt = e-s
    sel = f"select=between(n\\,{s}\\,{e-1}),setpts=N/30/TB"
    vp, mp = f"/tmp/lf_v{i}.mp4", f"/tmp/lf_m{i}.mp4"
    subprocess.run(["ffmpeg","-nostdin","-v","error","-i",VIDEO,"-vf",sel,"-r","30","-frames:v",str(cnt),"-an",vp,"-y"],check=True)
    subprocess.run(["ffmpeg","-nostdin","-v","error","-i",MASK,"-vf",sel,"-r","30","-frames:v",str(cnt),"-pix_fmt","yuv420p",mp,"-y"],check=True)
    vu, mu = up(vp,f"v{i}.mp4"), up(mp,f"m{i}.mp4")
    body = {"video_url":vu,"mask_video_url":mu,"prompt":PROMPT,
            "negative_prompt":"text, caption, subtitle, letters, words, watermark",
            "num_frames":cnt,"frames_per_second":30,"video_quality":"high",
            "num_inference_steps":20,"video_strength":1.0,"generate_audio":False,"enable_prompt_expansion":False}
    sub = json.loads(fal("POST","https://queue.fal.run/fal-ai/ltx-2.3-quality/inpaint",body=body).read())
    print(f"chunk {i} submitted", flush=True)
    return i, cnt, sub["status_url"], sub["response_url"]

with ThreadPoolExecutor(max_workers=5) as ex:
    subs = list(ex.map(submit, list(enumerate(bounds))))

def poll_dl(t):
    i, cnt, su, ru = t
    for _ in range(400):
        time.sleep(6)
        try: st = json.loads(fal("GET", su).read())
        except Exception: continue
        s = str(st.get("status","")).upper()
        if s == "COMPLETED":
            out = json.loads(fal("GET", ru).read())
            u = (out.get("video") or {}).get("url") or out.get("videos",[{}])[0].get("url")
            raw = f"/tmp/lf_out{i}.mp4"; open(raw,"wb").write(urllib.request.urlopen(u,timeout=240).read())
            norm = f"/tmp/lf_norm{i}.mp4"
            subprocess.run(["ffmpeg","-nostdin","-v","error","-i",raw,"-vf",f"scale={W}:{H},setsar=1","-r","30","-frames:v",str(cnt),"-c:v","libx264","-crf","14","-pix_fmt","yuv420p","-an",norm,"-y"],check=True)
            print(f"chunk {i} done", flush=True); return i, norm
        if s in ("FAILED","ERROR"): print(f"chunk {i} FAILED", flush=True); return i, None
    return i, None

with ThreadPoolExecutor(max_workers=5) as ex:
    res = sorted(ex.map(poll_dl, subs))
parts = [p for _,p in res if p]
with open("/tmp/lf_concat.txt","w") as f:
    for p in parts: f.write(f"file '{p}'\n")
subprocess.run(["ffmpeg","-nostdin","-v","error","-f","concat","-safe","0","-i","/tmp/lf_concat.txt","-c:v","libx264","-crf","14","-pix_fmt","yuv420p","/tmp/lf_ltxfull.mp4","-y"],check=True)
print(f"ltx concat: {nframes('/tmp/lf_ltxfull.mp4')}f", flush=True)

# FADE composite: mask-only, soft gaussian feather so the fixed box blends into the original
subprocess.run(["ffmpeg","-nostdin","-v","error","-i",VIDEO,"-i","/tmp/lf_ltxfull.mp4","-i",MASK,
    "-filter_complex",
    f"[2:v]format=gray,scale={W}:{H},gblur=sigma=11[m];[1:v]scale={W}:{H},setsar=1[ltx];[ltx][m]alphamerge[fg];[0:v][fg]overlay=format=auto[v]",
    "-map","[v]","-c:v","libx264","-crf","14","-pix_fmt","yuv420p","/tmp/lf_comp.mp4","-y"],check=True)
subprocess.run(["ffmpeg","-nostdin","-v","error","-i","/tmp/lf_comp.mp4","-i",AUDIO_SRC,
    "-map","0:v:0","-map","1:a:0?","-c:v","copy","-c:a","aac","-shortest",OUT,"-y"],check=True)
print(f"SAVED {OUT} ({nframes(OUT)}f)", flush=True)
