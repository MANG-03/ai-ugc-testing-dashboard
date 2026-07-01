"""Transcribe audio with fal ElevenLabs Scribe v2 (verbatim + word-level timestamps).
Writes a words JSON that burn_captions.py consumes directly.
Env: FAL_KEY, AUDIO, OUT (json path), LANG (Scribe language_code, default 'spa')."""
import os, json, time, urllib.request

FK = os.environ["FAL_KEY"]; AUDIO = os.environ["AUDIO"]; OUT = os.environ["OUT"]
LANG = os.environ.get("LANG_CODE", "spa")

def fal(method, url, body=None, raw=None, ct="application/json"):
    for a in range(6):
        try:
            r = urllib.request.Request(url, method=method); r.add_header("Authorization", f"Key {FK}")
            if raw is not None: r.add_header("Content-Type", ct); d = raw
            elif body is not None: r.add_header("Content-Type", "application/json"); d = json.dumps(body).encode()
            else: d = None
            return urllib.request.urlopen(r, d, timeout=180)
        except Exception:
            if a == 5: raise
            time.sleep(2**a)

init = json.loads(fal("POST", "https://rest.alpha.fal.ai/storage/upload/initiate",
                      body={"file_name": "a.mp3", "content_type": "audio/mpeg"}).read())
fal("PUT", init["upload_url"], raw=open(AUDIO, "rb").read(), ct="audio/mpeg")
sub = json.loads(fal("POST", "https://queue.fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2",
                     body={"audio_url": init["file_url"], "language_code": LANG,
                           "diarize": True, "tag_audio_events": False}).read())
su, ru = sub["status_url"], sub["response_url"]
for _ in range(200):
    time.sleep(3)
    s = str(json.loads(fal("GET", su).read()).get("status", "")).upper()
    if s == "COMPLETED": break
    if s in ("FAILED", "ERROR"): raise SystemExit("scribe failed")
resp = json.loads(fal("GET", ru).read())
open(OUT, "w").write(json.dumps(resp, ensure_ascii=False))
n = len([w for w in resp["words"] if w.get("type") == "word"])
print(f"SAVED {OUT}  ({n} words, lang={resp.get('language_code')})")
print("TEXT:", resp.get("text", "")[:300])
