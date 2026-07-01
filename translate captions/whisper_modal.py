"""Transcribe audio with faster-whisper on Modal (word-level timestamps). No fal needed.
Output JSON matches the Scribe shape so burn_pil.py can consume it directly."""
import modal, json

app = modal.App("whisper-es")
image = (modal.Image.debian_slim(python_version="3.11")
         .apt_install("ffmpeg")
         .pip_install("faster-whisper==1.0.3", "requests", "huggingface_hub"))
vol = modal.Volume.from_name("whisper-models", create_if_missing=True)


@app.function(image=image, cpu=8.0, memory=8192, timeout=1800, volumes={"/cache": vol})
def transcribe(audio_bytes: bytes, lang: str):
    open("/tmp/a.mp3", "wb").write(audio_bytes)
    from faster_whisper import WhisperModel
    model = WhisperModel("large-v3", device="cpu", compute_type="int8", download_root="/cache/wx")
    vol.commit()
    segments, info = model.transcribe("/tmp/a.mp3", language=lang, word_timestamps=True, vad_filter=True)
    words, full = [], []
    for seg in segments:
        full.append(seg.text)
        for w in (seg.words or []):
            words.append({"text": w.word.strip(), "start": float(w.start), "end": float(w.end), "type": "word"})
    print(f"[whisper] {len(words)} words, lang={info.language}", flush=True)
    return {"words": words, "text": "".join(full), "language_code": info.language}


@app.local_entrypoint()
def main(audio: str, out: str, lang: str = "es"):
    r = transcribe.remote(open(audio, "rb").read(), lang)
    open(out, "w").write(json.dumps(r, ensure_ascii=False))
    print(f"SAVED {out}  ({len(r['words'])} words)")
    print("TEXT:", r["text"][:400])
