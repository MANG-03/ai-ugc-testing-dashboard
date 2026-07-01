"""Dub a video via fal ElevenLabs Dubbing v2 (sync-aware pacing). Env: FAL_KEY, SRC, OUT, LANG_CODE."""
import os, json, time, subprocess, urllib.request
FK = os.environ["FAL_KEY"]; SRC = os.environ["SRC"]; OUT = os.environ["OUT"]; LANG = os.environ.get("LANG_CODE", "es")

def fal(method, url, body=None, raw=None, ct="application/json"):
    for a in range(6):
        try:
            r = urllib.request.Request(url, method=method); r.add_header("Authorization", f"Key {FK}")
            if raw is not None: r.add_header("Content-Type", ct); d = raw
            elif body is not None: r.add_header("Content-Type", "application/json"); d = json.dumps(body).encode()
            else: d = None
            return urllib.request.urlopen(r, d, timeout=300)
        except Exception:
            if a == 5: raise
            time.sleep(2**a)

init = json.loads(fal("POST", "https://rest.alpha.fal.ai/storage/upload/initiate",
                      body={"file_name": "src.mp4", "content_type": "video/mp4"}).read())
fal("PUT", init["upload_url"], raw=open(SRC, "rb").read(), ct="video/mp4")
print("uploaded", flush=True)

body = {"video_url": init["file_url"], "target_lang": LANG}
sub = json.loads(fal("POST", "https://queue.fal.run/fal-ai/elevenlabs/dubbing", body=body).read())
su, ru = sub["status_url"], sub["response_url"]
print("submitted", sub.get("request_id", ""), flush=True)
for _ in range(300):
    time.sleep(6)
    st = json.loads(fal("GET", su).read())
    s = str(st.get("status", "")).upper()
    if s == "COMPLETED": break
    if s in ("FAILED", "ERROR"): raise SystemExit("dub failed: " + json.dumps(st)[:300])
out = json.loads(fal("GET", ru).read())
url = (out.get("video") or {}).get("url")
print("dub done:", url, flush=True)
open(OUT, "wb").write(urllib.request.urlopen(url, timeout=300).read())
print(f"SAVED {OUT} ({os.path.getsize(OUT)} bytes)", flush=True)
