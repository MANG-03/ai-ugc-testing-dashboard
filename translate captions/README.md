# Translate Captions

Take a short vertical UGC video, **translate/dub it into another language**, and add **new captions in
that language that exactly match the dubbed audio** — colloquial, verbatim, and word-timed for
TikTok-style display.

This is the stage that runs **after** caption *removal* (see the separate "Revised Caption Removal"
folder). Input here is a clean, caption-free video; output is a dubbed + re-captioned video.

> **Status:** Working prototype, verified on clip 6954 (English → Spanish). The dub + captions match
> and the captions are genuinely colloquial. Known rough edge: the Higgsfield dub can sound *fast* —
> see **Known Limitations**.

---

## What did we do?

A two-part pipeline:

1. **Video translation (dubbing):** run the clean video through **Higgsfield's MCP `dubbing` tool** →
   it translates the speech, synthesizes a target-language voice, and **lip-syncs** the mouth to the
   new audio. Output: a dubbed, lip-synced video.
2. **Captions:** **transcribe the dubbed audio** with a word-level ASR (fal **ElevenLabs Scribe**),
   then burn short TikTok-style caption groups onto the video, timed to each word.

The whole point: **the captions come from the dub's own audio**, so they can never disagree with what
is actually spoken.

---

## Why did we do it?

- **To repurpose one video into many languages** (dub + matching on-screen captions).
- **To kill caption↔audio drift.** If you translate the captions *separately* from the dub, the two
  translations diverge — the audio says one word ("increíble") and the caption shows another
  ("genial"). By transcribing the dub itself and using that as the caption text, the caption is
  *literally* what was said → **zero drift by construction.**
- **Colloquial fidelity comes for free.** Whatever natural/casual register the dub chose is inherited
  verbatim by the captions (e.g. Spanish "como que lo desordeno con agua" — casual, not formal).
- **Why Higgsfield for the dub:** it's the option that actually **lip-syncs** the mouth to the new
  language. (See "Preferred method" for the tradeoff we accepted.)

---

## What's the structure? (pipeline)

```
clean video (captions removed)
        │
        ▼
[1] Higgsfield MCP dubbing ────────────►  dubbed + lip-synced video (target language)
        │
        ▼
[2] ffmpeg: extract dub audio
        │
        ▼
[3] transcribe dub audio (word-level)  ──  fal Scribe (default)  |  Modal Whisper (no-fal fallback)
        │
        ▼
[4] group into 2–3 word TikTok chunks (by word timing + punctuation)
        │
        ▼
[5] burn captions (PIL renders PNGs → ffmpeg `overlay`)  ──────►  final dubbed + captioned video
```

Steps 2–5 are automated by `run_captions.sh`. Step 1 (Higgsfield dub) is done through the MCP
connector (see "How to run").

---

## Where are the API keys needed?

| Step | Service | Auth | Notes |
|---|---|---|---|
| **Dub** | **Higgsfield** | The Higgsfield **MCP connector** (authenticated inside the Claude client) | No raw key in any script — it's the MCP session. 18 target languages. |
| **Transcribe (default)** | **fal** (ElevenLabs Scribe) | `FAL_KEY` env var | Same key as the caption-removal LTX pipeline. ~$0.008/min. 99 languages. |
| **Transcribe (fallback)** | **Modal** (Whisper) | `modal` CLI auth (`modal token new`) | **No fal needed** — use when the fal balance is exhausted. |
| **Burn captions** | none | — | Local `ffmpeg` + Python `PIL`. |
| *(Alt dub, optional)* | **fal** (ElevenLabs Dubbing) | `FAL_KEY` env var | `eleven_dub.py` — see "Preferred method". |

**No API keys are hardcoded** — every script reads `FAL_KEY` from the environment. (Historical note:
an old fal key was compromised earlier in this project; rotate keys and never commit a real one.)

---

## Video translation

Two viable engines; they make **opposite tradeoffs**:

| | **Higgsfield dubbing (MCP)** | **ElevenLabs dubbing (fal, `eleven_dub.py`)** |
|---|---|---|
| Translate + voice | ✅ | ✅ |
| **Lip-sync** (mouth matches new language) | ✅ **yes** (Kling/lipsync-2 under the hood) | ❌ no (audio swap only; mouth still moves in the source language) |
| Languages | 18 | 90+ |
| Pacing control | ❌ none (black box) | ⚠️ better — Dubbing v2 is "sync-aware" (measured calmer: 249 vs 284 wpm) |
| Script / register / dialect control | ❌ none | ❌ none on the fal wrapper (only ElevenLabs' *direct* API has manual/script mode) |
| Params exposed | `video_id` + `target_language` only | `video_url` + `target_lang` (+ `num_speakers`) |
| Key | Higgsfield MCP | `FAL_KEY` |

Both are **black boxes** for the actual translation text — neither lets you edit the wording, and the
underlying translation LLM is undisclosed.

## Our preferred method of video translation

**Higgsfield dubbing (via the MCP `dubbing` tool).** Chosen because it's the one that **lip-syncs** —
the mouth moves in the target language, which matters for believable talking-head UGC. ElevenLabs'
dub sounds better-paced but leaves the lips moving in the *original* language.

**Tradeoff we accepted:** Higgsfield gives **zero control** over the translation — you can't touch the
wording, register, dialect, or speed, and the dub can sound rushed (Spanish is ~25% longer than
English but must fit the same runtime → the TTS speeds up). If pacing/register control ever becomes a
must-have, the escape hatch is: **own the translation** (LLM translate + *compress* the script) → feed
it to ElevenLabs' *direct* API for voice → add a separate lip-sync pass. That's more moving parts, so
for now we stay on Higgsfield for its built-in lip-sync.

## Video translation captions

**Principle: transcribe the dub, don't re-translate.** The caption text is the ASR transcript of the
dubbed audio, so it always equals what's spoken (colloquial + zero drift).

- **Primary transcriber — fal ElevenLabs Scribe v2** (`transcribe_scribe.py`): 99 languages,
  word-level timestamps + speaker diarization, ~$0.008/min, same `FAL_KEY`. Faithful/verbatim.
- **Fallback — Modal Whisper** (`whisper_modal.py`): faster-whisper `large-v3` on Modal, word
  timestamps, **needs no fal** (use when the fal balance is out — that's what happened during the
  prototype).
- **Do NOT use a generic LLM (e.g. Gemini) to "caption"** — LLMs tend to paraphrase/normalize, which
  reintroduces the exact drift we're avoiding.
- **Burn — `burn_captions.py`:** groups words into 2–3 word chunks (breaks on pauses/punctuation),
  renders each as a bold white + black-outline PNG with PIL, and composites via ffmpeg's `overlay`
  filter. This deliberately avoids `libass`/`drawtext` because the test machine's ffmpeg had neither —
  only `overlay` is required.

---

## Files in this folder

| File | Role |
|---|---|
| `run_captions.sh` | **Start here (captions step).** Extract dub audio → transcribe → burn. `ENGINE=scribe` (default) or `ENGINE=whisper`. |
| `transcribe_scribe.py` | fal Scribe transcription → words JSON. Env: `FAL_KEY`, `AUDIO`, `OUT`, `LANG_CODE` (e.g. `spa`). |
| `whisper_modal.py` | Modal Whisper transcription (no fal). `python -m modal run whisper_modal.py --audio a.mp3 --out words.json --lang es`. |
| `burn_captions.py` | Render + burn caption groups via PIL + ffmpeg `overlay` (no libass needed). Env: `WORDS`, `VIDEO`, `OUT`, optional `MAXW`/`POS`/`GAP`. |
| `eleven_dub.py` | **Alternative dubber** — ElevenLabs dubbing on fal (better pacing, **no lip-sync**). Env: `FAL_KEY`, `SRC`, `OUT`, `LANG_CODE` (e.g. `es`). |

---

## How to run

**Step 1 — Dub (Higgsfield, via the MCP connector in Claude):**
1. `media_upload` (filename + `video/mp4`) → get an `upload_url` + `media_id`; `PUT` the video bytes to `upload_url`.
2. `media_confirm` (`type: video`, the `media_id`).
3. `dubbing` (`video_id: <media_id>`, `target_language: "spa"`).
4. Poll `job_status` (`sync: true`) until `completed`; download the `results.rawUrl` video → e.g. `dub.mp4`.

**Step 2 — Captions (local):**
```bash
export FAL_KEY=your_key
./run_captions.sh dub.mp4 final.mp4 spa          # fal Scribe
# or, if fal is out of balance:
ENGINE=whisper ./run_captions.sh dub.mp4 final.mp4 es   # Modal Whisper (note: 2-letter code)
```
Output `final.mp4` = dubbed, lip-synced video with matching target-language captions.

*(Language codes differ per engine: Scribe uses ISO-639-3-ish like `spa`; Whisper uses 2-letter `es`.)*

---

## Known limitations & status

- **Dub pacing is fast (Higgsfield).** Measured on 6954: **284 wpm / 6.2 words-per-sec** in speech vs
  normal conversational ~150 wpm. Inherent to fitting a longer translation into a fixed runtime, and
  **uncontrollable via Higgsfield**. ElevenLabs' dub was calmer (249 wpm) but doesn't lip-sync. Real
  fix = own+compress the translation (see "Preferred method").
- **18-language cap** on Higgsfield MCP dubbing (vs 90+/99 on the ElevenLabs paths).
- **Caption burn uses PIL+overlay** because the test box's ffmpeg lacked `libass`/`drawtext`. On a box
  with libass you could switch to ASS subtitles for easier **word-by-word karaoke highlighting**.
- **Diarization not yet used for styling** — both speakers get the same caption style/position. Scribe
  returns `speaker_id`, so per-speaker color/position is a straightforward add.
- **fal balance** ran out mid-prototype (dub + Scribe both bill fal); the Whisper fallback exists
  precisely for that. Top up fal, or use `ENGINE=whisper`.
- Verified end-to-end on 6954 EN→ES: dub + colloquial Spanish captions matched the audio.
