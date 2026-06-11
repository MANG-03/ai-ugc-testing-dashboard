# Echoes: Video Regeneration Engine — Build Spec

## 1. Context & Thinking

Echoes is a video regeneration engine. The core idea is to take existing TikTok videos that have crossed a virality threshold (e.g. 100K+ views) and either recreate them from scratch with a new avatar/character, or make targeted edits to the original video (swap the person's t-shirt, change hair color, replace the avatar) while keeping everything else identical — the voice, the pacing, the composition, the narrative.

We've done extensive research into the current landscape of video understanding models and video generation models. Here's the reasoning behind the architecture.

### Why API-direct instead of platforms like Higgsfield, Arcads, or HeyGen

Platforms like Higgsfield, Arcads, and HeyGen are UI-first products designed for manual one-off generation. They wrap the same underlying models (Seedance 2.0, Kling 3.0, etc.) but abstract away the API parameters. For our use case — a programmatic pipeline that needs to fire specific endpoints with precise parameter control, compare outputs across multiple models, and eventually run at scale — we need direct API access.

The underlying model weights are the same regardless of provider. A 480p Seedance 2.0 generation with identical prompt and references produces identical quality whether called through Higgsfield or through EvoLink. The difference is control, cost, and which endpoints are exposed. Platforms don't expose V2V editing endpoints consistently, and they don't let you control parameters like `keep_audio`, `generate_audio`, resolution, or duration at the API level.

### Why EvoLink as the unified provider

EvoLink (https://evolink.ai) provides a unified API key that covers multiple model families — Seedance 2.0, Kling 3.0, Wan 2.7, Veo 3.1, Gemini, Claude, GPT, and 120+ others. Switching models is a one-parameter change in the request body. This means we can run parallel experiments across generation models without managing separate API keys, SDKs, or billing accounts for each.

EvoLink also supports real human face generation for Seedance 2.0, which the default ByteDance API blocks. This matters because our clients provide their own video content and may want avatars based on real people.

EvoLink's Gemini integration supports multimodal video input — you can feed video files and audio streams directly into the Gemini context window for analysis. This means EvoLink can serve both the orchestration/understanding layer (Gemini 3.1 Pro for video analysis and generation planning) and the generation layer (Seedance/Kling/Wan for video production) under one API key.

### Why Twelve Labs Pegasus 1.5 as a separate integration

Pegasus 1.5 is Twelve Labs' proprietary video understanding model. No unified API provider (including EvoLink) carries it. It must be accessed through Twelve Labs' own API at https://api.twelvelabs.io.

Pegasus 1.5 is purpose-built for a specific capability called Time Based Metadata Extraction (TBM). You define a custom JSON schema and Pegasus returns structured, timestamped metadata across the full video. It outperforms Gemini 3.1 Pro by 13.1% on temporal segmentation quality, and unlike general-purpose models, it reliably produces valid, schema-conformant JSON on complex content.

For Pipeline A (full video regeneration), Pegasus gives us the precise scene-by-scene structural blueprint that generation models need. For Pipeline B (targeted edits), Pegasus helps us understand what's in the video before we describe edits to the V2V model, giving us better prompt context.

One critical constraint: Pegasus TBM mode does NOT accept a separate text prompt alongside the schema. The schema field descriptions themselves serve as the instructions. This means the schema design is the prompt.

---

## 2. The Two Pipelines

### Pipeline A: Full Video Regeneration

**Use case:** A client's TikTok goes viral. We want to recreate the same format, script, and structure as an entirely new AI-generated video with a different avatar/character.

**Flow:**
1. Source video is uploaded to the dashboard
2. **Pegasus 1.5** decomposes the video using a TBM schema designed for our use case (scenes, dialogue, shot types, camera movement, subject actions, lighting, pacing, narrative beats). Pegasus handles the **"what"** — what is in this video, moment by moment, with precise timestamps.
3. The Pegasus decomposition output is displayed in the dashboard for review
4. User uploads avatar reference images (the new character to appear in the video)
5. **Gemini 3.1 Pro** receives the original video (multimodal input) + the Pegasus TBM output + knowledge of each generation model's constraints. Gemini handles the **"how"** — it produces a **generation plan** for each target model. Specifically, Gemini:
   - Understands each model's duration limits (e.g. 15 seconds max for Seedance, whatever Kling O3 and Wan 2.7 support)
   - Determines how many API calls are needed per model for the full video (a 40-second video might need 3 calls for Seedance but 2 for Kling if Kling supports longer clips)
   - Picks intelligent split points based on the actual video content — splitting at natural pauses in dialogue, at scene transitions, at moments where the subject turns away from camera — not at arbitrary duration boundaries
   - For each planned call, writes the actual model-specific prompt using that model's preferred format and prompting conventions (Seedance's `@Image1`/`@Video1` syntax, Kling's `@Element1` syntax, Wan's format)
   - Specifies which audio and video segments to extract (with exact timestamps) for each call
   - Sets model-specific parameters (resolution, duration, aspect ratio, `keep_audio` for Kling, `generate_audio: false` for Seedance, etc.)
   - Handles continuity planning: which reference from the previous generation to pass into the next call for scene-to-scene consistency
6. The generation plan is displayed in the dashboard for review (optional — user can inspect what Gemini planned before executing)
7. The orchestration layer executes the generation plan: extracts media segments via FFmpeg, fires all API calls per the plan
8. Results populate as visual tiles in the dashboard with full audit trail, including the generation plan itself

**What this validates:** Whether the Pegasus → Gemini orchestration → video generation chain actually produces usable recreations of the original format. This tests both the decomposition quality and Gemini's ability to intelligently plan generation workflows across model constraints.

**Why Gemini 3.1 sits between Pegasus and generation (not code logic):**
Pegasus tells us what's in the video. But Pegasus doesn't know anything about generation model constraints. Simple code logic could do duration math (if scene > 15s, split at 15s), but it can't make intelligent decisions about WHERE to split. Gemini can see the actual video AND understand the model constraints, so it picks optimal split points: at a natural pause, at a breath between sentences, at a camera cut — not mid-word or mid-gesture. Gemini also replaces the need for a separate prompt translation layer, because it writes model-specific prompts as part of the generation plan, with full video context informing the prompts.

### Pipeline B: Targeted Video Editing (V2V)

**Use case:** A client's TikTok goes viral. We want to repost the exact same video but change one thing — the avatar, the t-shirt color, the hairstyle — while keeping everything else identical (voice, motion, composition, audio).

**Flow:**
1. Source video is uploaded to the dashboard
2. **Pegasus 1.5** analyzes the video to provide context (what's in the video, who's in it, what they're wearing, the setting). This analysis gives us a record of what the source video contained and provides rich context for the edit.
3. User types an edit instruction (e.g. "Change the subject's white t-shirt to black")
4. **Gemini 3.1 Pro** receives the original video + the Pegasus analysis + the user's edit instruction + knowledge of each model's V2V editing constraints. Gemini produces a **V2V edit plan** for each target model:
   - Translates the edit instruction into each model's V2V format (Seedance prompt syntax, Kling O3 `@Element` syntax, Wan format)
   - For Seedance: flags that audio must be extracted separately via FFmpeg and re-overlaid post-generation (since Seedance lacks `keep_audio`)
   - For Kling O3: includes `keep_audio: true` in the plan
   - If the source video exceeds a model's duration limit, plans how to split the V2V edit into multiple calls with continuity between them
   - Enriches the edit prompt with Pegasus context (e.g. the user says "change the t-shirt" — Gemini knows from Pegasus that the subject is wearing a "white crew neck with a small logo on the left chest" and writes a more precise edit instruction)
5. The orchestration layer executes the edit plan: handles FFmpeg extraction where needed, fires V2V edit calls to Seedance 2.0, Kling O3 Edit, and Wan 2.7 in parallel
6. Results populate as visual tiles with full audit trail, including the edit plan

**Critical model differences for Pipeline B:**
- **Kling O3 Edit** has an explicit `keep_audio` parameter that preserves the original audio track natively. This is the cleanest path for edits where audio must be preserved.
- **Seedance 2.0 V2V** does NOT have a keep-audio option. It either generates new audio (`generate_audio: true`) or outputs silent video (`generate_audio: false`). To preserve original audio, the pipeline must: extract audio via FFmpeg → run V2V edit with `generate_audio: false` → re-overlay original audio via FFmpeg.
- **Wan 2.7 V2V** — audio preservation behavior needs to be verified during testing.

**What this validates:** Which model produces the most faithful edits (cleanest element swap, best motion preservation, best audio handling) for TikTok-style UGC content.

---

## 3. Model Capabilities Summary

### Video Understanding & Orchestration Models

| Model | Provider | Purpose | Key Capability |
|-------|----------|---------|----------------|
| Pegasus 1.5 | Twelve Labs | Structured video decomposition (the "what") | Time Based Metadata Extraction with custom JSON schema. Processes videos up to 2 hours. 13.1% better segmentation than Gemini 3.1 Pro. Returns timestamped, structured scene data. |
| Gemini 3.1 Pro | Google (via EvoLink) | Generation planning & orchestration (the "how") | Natively multimodal — processes video + audio + text together. Receives Pegasus output + original video and produces a generation plan: how many API calls per model, where to split, what prompts to use in each model's format, what media to extract. Also handles prompt translation — writes model-specific prompts as part of the plan, replacing the need for a separate prompt adapter layer. |

### Video Generation / Editing Models

| Model | Provider | V2V Edit | Keep Audio | Max Duration | Resolutions | Reference Inputs |
|-------|----------|----------|------------|-------------|-------------|-----------------|
| Seedance 2.0 | ByteDance (via EvoLink) | Yes | No (generates new or silent) | 15 sec | 480p, 720p, 1080p (standard only) | Up to 9 images, 3 videos, 3 audio. 12 total max. |
| Kling O3 Edit | Kuaishou (via EvoLink) | Yes | Yes (`keep_audio` param) | 15 sec | Up to 1080p | Up to 4 elements with multi-angle references |
| Wan 2.7 | Alibaba (via EvoLink) | Yes (editing variant) | Needs verification | Varies | Varies | Reference video + prompt |

### Pricing (iteration tier — lowest cost)

| Model | Tier | Resolution | Cost/second |
|-------|------|-----------|-------------|
| Seedance 2.0 | Fast | 480p | $0.074/sec |
| Seedance 2.0 | Fast | 720p | $0.161/sec |
| Kling 3.0 | Standard | — | ~$0.084-$0.126/sec |
| Wan 2.7 | — | — | ~$0.07/sec |

**Default iteration settings:** 480p (or lowest available), Fast tier, shortest viable duration. We are optimizing for speed and cost during the testing phase, not final output quality.

---

## 4. Gemini 3.1 Orchestration & Prompt Translation

This is the central intelligence of the pipeline. Each video generation model has different prompting conventions, reference syntax, prompt engineering best practices, and technical constraints. Gemini 3.1 Pro handles all of this as part of producing the generation plan.

### The Problem

- **Seedance 2.0** uses `@Image1`, `@Video1`, `@Audio1` syntax to reference uploaded media. It responds well to cinematic director-style prompts with explicit camera, lighting, and action descriptions. Max 15 seconds per generation. No `keep_audio`. `first_frame_url` is mutually exclusive with `reference_images`.
- **Kling O3 Edit** uses `@Element1` references with a multi-element system where each element can have frontal + angle reference images. It has a Chain of Thought reasoning system that analyzes prompts before generating. Has `keep_audio` parameter. Max prompt length 2500 characters.
- **Wan 2.7** has its own reference and prompt conventions. Constraints to be verified during implementation.

A single user prompt like "Change the subject's white t-shirt to black" needs to become three different, model-optimized API calls — each with different syntax, different media handling, and different parameter flags.

### The Solution: Gemini 3.1 as Planning Agent

Instead of a lightweight per-model prompt adapter, Gemini 3.1 Pro acts as the orchestration brain. For every generation request, Gemini receives:

1. **The original video** (multimodal input — Gemini watches it)
2. **The Pegasus TBM output** (structured scene data with timestamps)
3. **The user's intent** (their natural language prompt or edit instruction)
4. **Model prompt skills** — stored documents that encode each model's prompting best practices, reference syntax, formatting preferences, and technical constraints. These are derived from official prompting guides and fed to Gemini as context.
5. **User-uploaded references** (avatar images, style references, etc.)

Gemini produces a **structured generation plan** (JSON) that contains, for each target model:
- How many API calls are needed (based on video duration vs model's max duration)
- For each call: the exact prompt in that model's format, the media segments to extract (with timestamps), the API parameters, and continuity instructions
- Audio handling instructions (FFmpeg extraction needed? `keep_audio` flag? re-overlay step?)
- Split point rationale (why Gemini chose to split at this particular moment)

The orchestration layer then executes this plan mechanically — it doesn't make creative decisions, it just runs the calls Gemini specified.

### Model Prompt Skills (stored reference documents)

Even though Gemini handles the prompt writing, it needs reference material about each model's conventions. These are stored as editable documents in the `promptSkills` table so we can iterate on them without code changes.

Each prompt skill document should contain:
- The model's reference syntax (`@Image1` vs `@Element1` vs whatever Wan uses)
- Prompt structure best practices from official guides
- Known constraints (max characters, mutually exclusive parameters, content filter sensitivities)
- Example prompts that work well for this model
- Anti-patterns (what NOT to do)

Gemini reads the relevant prompt skill document(s) as part of its context when producing the generation plan.

### What gets stored per generation (the audit trail)

Every generation must record:
- **User prompt**: The raw text the user typed in the dashboard
- **Pegasus analysis**: The full TBM decomposition that informed the generation
- **Gemini generation plan**: The complete plan Gemini produced, including its reasoning for split points, prompt choices, and parameter decisions
- **Model prompt skill version**: Which version of the prompt skill document Gemini used as reference
- **Translated prompt**: The exact prompt Gemini wrote for this specific API call
- **Media references sent**: Exact images, video clips, and audio files that were included in the API call, stored as viewable assets
- **API parameters**: Resolution, duration, aspect ratio, model tier, any model-specific flags (e.g. `keep_audio`, `generate_audio`)
- **Model used**: Which model and which endpoint (e.g. `seedance-2.0/video-edit` vs `kling-o3/edit`)
- **Pipeline**: Whether this was Pipeline A or Pipeline B
- **Output**: The generated video file
- **Metadata**: Timestamp, cost (if available), generation duration, status

This audit trail is essential. Future team members should be able to open the dashboard, see a generation tile, and understand exactly what was sent, why, and what came back — without needing to look at code or logs.

---

## 5. Technical Architecture

### Stack

- **Frontend**: Next.js (local development server)
- **Database**: Convex (for persistent storage of generations, media assets, prompts, audit trails)
- **Media storage**: Convex file storage for uploaded source videos, reference images, and generated output videos
- **APIs**:
  - EvoLink API (Seedance 2.0, Kling O3, Wan 2.7, Gemini 3.1 Pro) — single API key for both the Gemini orchestration layer AND all generation models
  - Twelve Labs API (Pegasus 1.5) — separate API key
- **Media processing**: FFmpeg (for audio extraction, video splitting by timestamp, audio overlay for Seedance V2V workaround, final video concatenation)

### API Key Configuration

The dashboard should have a settings/configuration panel where the user inputs:
- EvoLink API key (covers Gemini 3.1 Pro + all generation models)
- Twelve Labs API key (covers Pegasus 1.5)

Keys should be stored locally (environment variables or local encrypted storage), never hardcoded.

### System Architecture Flow

```
┌──────────────────────────────────────────────────────────────┐
│                      DASHBOARD (Next.js)                      │
│                                                               │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Upload   │  │ Chat / Prompt│  │ Generation Tiles        │  │
│  │ Panel    │  │ Input        │  │ (results grid)          │  │
│  └────┬─────┘  └──────┬───────┘  └────────────────────────┘  │
│       │               │                                       │
│       ▼               ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                 ORCHESTRATION LAYER                       │ │
│  │                                                          │ │
│  │  1. Receive user prompt + uploaded media                  │ │
│  │  2. Run Pegasus 1.5 TBM decomposition (Twelve Labs API)  │ │
│  │  3. Send video + Pegasus output + user prompt +           │ │
│  │     model prompt skills to Gemini 3.1 Pro (EvoLink API)  │ │
│  │  4. Gemini returns structured generation plan per model   │ │
│  │  5. Display plan for review (optional)                    │ │
│  │  6. Execute plan:                                         │ │
│  │     a. Extract media segments via FFmpeg per plan          │ │
│  │     b. Fire async generation calls per plan (EvoLink API) │ │
│  │  7. Poll for results                                      │ │
│  │  8. Post-process (e.g. FFmpeg audio overlay for Seedance) │ │
│  │  9. Store everything in Convex                            │ │
│  │ 10. Display results as tiles                              │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌───────────────┐ ┌──────────────┐
   │ Twelve Labs │ │   EvoLink     │ │   Convex DB  │
   │ (Pegasus)   │ │ (Gemini 3.1 + │ │  (Storage)   │
   │             │ │  Seedance +   │ │              │
   │             │ │  Kling O3 +   │ │              │
   │             │ │  Wan 2.7)     │ │              │
   └─────────────┘ └───────────────┘ └──────────────┘
```

---

## 6. Convex Data Model

### `sourceVideos` table
- `id`: Auto-generated
- `fileName`: Original filename
- `fileUrl`: Convex storage URL
- `uploadedAt`: Timestamp
- `pegasusAnalysis`: JSON — the full Pegasus TBM decomposition output
- `geminiGenerationPlan`: JSON — the full Gemini 3.1 generation plan (how many calls per model, split points, prompts, parameters)
- `duration`: Video duration in seconds
- `thumbnail`: Extracted frame as thumbnail

### `generations` table
- `id`: Auto-generated
- `sourceVideoId`: Reference to sourceVideos
- `pipeline`: "A" or "B"
- `model`: String (e.g. "seedance-2.0", "kling-o3-edit", "wan-2.7")
- `endpoint`: The specific API endpoint used
- `userPrompt`: Raw text the user typed
- `geminiPlanId`: Reference to the Gemini generation plan that produced this call
- `geminiPlanCallIndex`: Which call in the plan this generation corresponds to (e.g. "call 2 of 3 for seedance-2.0")
- `promptSkillVersion`: Which version of the model's prompt skill document Gemini referenced
- `translatedPrompt`: The exact prompt Gemini wrote for this specific API call
- `mediaReferencesSent`: Array of { type: "image" | "video" | "audio", fileUrl: string, role: string }
- `apiParameters`: JSON — resolution, duration, aspect_ratio, tier, model-specific flags
- `pegasusContext`: JSON — the Pegasus decomposition data that informed this generation
- `sceneNumber`: For Pipeline A, which scene this generation corresponds to
- `splitPointRationale`: Gemini's explanation for why it split here (if applicable)
- `outputVideoUrl`: Convex storage URL for the generated video
- `outputStatus`: "pending" | "processing" | "completed" | "failed"
- `costEstimate`: Estimated cost based on duration × per-second rate
- `generationTime`: How long the API call took
- `createdAt`: Timestamp
- `notes`: Optional user notes on quality
- `rating`: Optional quality rating (1-5)

### `geminiPlans` table
- `id`: Auto-generated
- `sourceVideoId`: Reference to sourceVideos
- `pipeline`: "A" or "B"
- `userPrompt`: The user's original prompt/instruction
- `pegasusAnalysisUsed`: Reference to the Pegasus TBM output used
- `promptSkillsUsed`: JSON — which prompt skill versions were fed to Gemini for each model
- `fullPlan`: JSON — the complete structured generation plan Gemini produced
- `planRationale`: Gemini's reasoning for split points, call counts, and prompt choices
- `modelsPlanned`: Array of model IDs included in this plan
- `totalCallsPlanned`: Total number of API calls across all models
- `createdAt`: Timestamp

### `promptSkills` table
- `id`: Auto-generated
- `modelId`: Which model this skill is for
- `skillName`: Descriptive name (e.g. "Seedance 2.0 V2V Edit Skill")
- `content`: The full prompt skill document — model's prompting best practices, reference syntax, constraints, example prompts, anti-patterns. This is what gets fed to Gemini 3.1 as context when producing generation plans.
- `version`: Version number for tracking iterations
- `isActive`: Boolean — which version is currently in use
- `createdAt`: Timestamp

### `experiments` table (for grouping related generations)
- `id`: Auto-generated
- `name`: User-defined experiment name (e.g. "Street interview t-shirt swap test")
- `pipeline`: "A" or "B"
- `sourceVideoId`: Reference
- `generationIds`: Array of generation IDs in this experiment
- `createdAt`: Timestamp
- `notes`: Observations and conclusions

---

## 7. UI Specifications

### Layout

The dashboard has four main views:

#### 7.1 Upload & Analyze View
- Large drop zone for uploading source TikTok videos
- Once uploaded, a "Run Pegasus Analysis" button triggers decomposition
- Analysis results display as a structured, readable breakdown: scene-by-scene with timestamps, descriptions, shot types, dialogue, etc.
- Pegasus analysis is stored and associated with the source video
- Once Pegasus analysis is complete, the "Generate" flow in the Generation Studio becomes available

#### 7.2 Generation Studio View
This is the main workspace. It has:

- **Left panel**: Source video player + Pegasus analysis summary + uploaded reference media (avatar images, etc.)
- **Center panel**: Chat-style prompt input with:
  - Text input bar
  - File upload buttons for images and video (multimodal input)
  - Pipeline selector: "Pipeline A: Full Regen" / "Pipeline B: V2V Edit"
  - Model selector: Checkboxes for which models to fire (Seedance 2.0, Kling O3 Edit, Wan 2.7). All can be selected for parallel comparison.
  - A "Send" button that triggers the Gemini planning step, then executes the plan
- **Right panel**: Generation tiles grid (see below)

When the user hits "Send":
1. A "Planning" state appears showing that Gemini 3.1 is producing the generation plan
2. Optionally, the plan is shown briefly (e.g. "Gemini planned 3 calls for Seedance, 2 for Kling, 3 for Wan" with expand to see full plan details)
3. Execution begins automatically — tiles start populating as results come back

#### 7.3 Generation Tiles
Each generation appears as a tile containing:
- **Video player**: The generated output (or a loading spinner while processing)
- **Model badge**: Which model produced this (color-coded)
- **Pipeline badge**: "A" or "B"
- **Scene/call badge**: If multiple calls were needed, shows "Scene 1 of 3" or "Call 2 of 3"
- **Expand button**: Click to see full audit trail:
  - User prompt (what you typed)
  - Gemini generation plan (the full plan for this model, with reasoning)
  - Translated prompt (the exact prompt Gemini wrote for this specific call)
  - Prompt skill version (which model prompt skill document Gemini referenced)
  - Media references sent (thumbnails of images/videos/audio sent to the model)
  - API parameters (resolution, duration, tier, model-specific flags)
  - Pegasus context (the scene decomposition data)
  - Split point rationale (if this is part of a multi-call sequence, why Gemini chose to split here)
  - Cost estimate
  - Generation time
- **Rating buttons**: Quick quality rating (1-5 stars) for tracking which models perform best
- **Notes field**: Free-text for observations

Tiles should populate in real-time as results come back. Since we're firing 3 models in parallel, tiles appear as each model completes (they won't all finish at the same time). For Pipeline A where a model needs multiple calls (e.g. 3 scenes), those calls execute sequentially per model (because of continuity chaining) but the models themselves run in parallel.

#### 7.4 Experiment History View
- List of all past experiments, filterable by pipeline, model, date
- Click into any experiment to see the source video, all generation tiles, and notes
- Comparison mode: Select 2-3 tiles and view their outputs side-by-side with synced playback

---

## 8. Pegasus TBM Schema

The schema we send to Pegasus 1.5 should be designed to extract everything needed for both pipelines. Here is the recommended schema based on Pegasus documentation and our generation model requirements.

### Schema Definition

```json
{
  "id": "scenes",
  "description": "Segment the video into distinct scenes. A scene changes when there is a visible cut, a significant change in camera angle, a change in setting, or a shift in the subject's action. For each scene, extract detailed visual, audio, and narrative metadata.",
  "fields": [
    {
      "name": "scene_description",
      "type": "string",
      "description": "A detailed description of what is happening visually in this scene. Include the subject's actions, body language, gestures, facial expressions, and any objects or people they interact with."
    },
    {
      "name": "dialogue_transcript",
      "type": "string",
      "description": "The exact words spoken during this scene. If no one is speaking, write 'no dialogue'."
    },
    {
      "name": "delivery_style",
      "type": "string",
      "description": "How the dialogue is delivered: tone of voice, pacing, energy level, emotional quality. For example: 'upbeat and fast, comedic timing with pauses for effect' or 'calm and measured, serious tone'."
    },
    {
      "name": "shot_type",
      "type": "string",
      "description": "The primary camera framing used in this scene.",
      "enum": ["extreme_close_up", "close_up", "medium_close_up", "medium", "medium_wide", "wide", "extreme_wide"]
    },
    {
      "name": "camera_movement",
      "type": "string",
      "description": "How the camera moves during this scene. For example: 'static', 'slight handheld shake', 'panning left', 'tracking subject', 'zooming in slowly', 'POV movement'."
    },
    {
      "name": "subject_framing",
      "type": "string",
      "description": "Where the subject is positioned in the frame and what parts of them are visible. For example: 'center frame, shoulders up', 'left third, full body', 'right side, head and torso'."
    },
    {
      "name": "subject_appearance",
      "type": "string",
      "description": "What the subject looks like and is wearing. Include clothing colors, accessories, hair style, and any distinctive visual features."
    },
    {
      "name": "background_description",
      "type": "string",
      "description": "What is behind and around the subject. Include setting, objects, other people, depth of field, and how in or out of focus the background is."
    },
    {
      "name": "lighting",
      "type": "string",
      "description": "The lighting conditions in this scene. Include direction, quality (harsh/soft), color temperature (warm/cool/neutral), and any notable shadows or highlights."
    },
    {
      "name": "audio_atmosphere",
      "type": "string",
      "description": "Non-dialogue audio present in this scene: background music, ambient sounds, sound effects. Describe the mood and energy the audio creates."
    },
    {
      "name": "on_screen_text",
      "type": "string",
      "description": "Any text visible on screen during this scene: captions, subtitles, labels, watermarks, or overlay text. If none, write 'none'."
    },
    {
      "name": "scene_purpose",
      "type": "string",
      "description": "What narrative or structural role this scene plays in the overall video. For example: 'hook/attention grabber', 'context setup', 'main point delivery', 'call to action', 'transition', 'punchline'."
    }
  ]
}
```

### Pegasus API Parameters

```
model_name: "pegasus1.5"
analysis_mode: "time_based_metadata"
min_segment_duration: 2.0   # Minimum 2 seconds per scene
max_segment_duration: 15.0  # Cap at 15s to align with generation model limits
temperature: 0.2            # Low randomness for consistent structural output
max_tokens: 32768           # Default, increase if video is long
```

**Important:** The `prompt` parameter is NOT allowed with TBM mode. All instructions must be encoded in the schema's `description` fields. The quality of the decomposition output is entirely determined by how well the schema descriptions are written.

---

## 9. Model-Specific Prompt Skills

Each model needs a stored "prompt skill" — a system prompt that teaches the prompt translation LLM how to rewrite user prompts for that specific model. These skills should be editable in the dashboard so we can iterate on them.

### Initial prompt skills should be derived from these official guides:

**Seedance 2.0:**
- Official prompt guide: https://www.glbgpt.com/hub/seedance-2-0-omni-reference/
- RunDiffusion prompt guide: https://www.rundiffusion.com/seedance-2-0-prompt-guide
- Scenario complete guide: https://help.scenario.com/articles/7140699840-seedance-2-0-the-complete-guide
- Synclip prompt guide: https://synclip.ai/blog/seedance-2-prompt-guide
- Key syntax: `@Image1`, `@Video1`, `@Audio1` references. Director-style prompts with explicit camera, lighting, and action descriptions. `Shot 1:` / `Shot 2:` for multi-shot. V2V edit mode uses `@Video1` as source with natural language edit instructions.

**Kling O3 Edit:**
- Kling 3.0 complete guide: https://kling3.org/blog/kling-3-0-ai-video-generator-complete-guide
- Kling O3 Edit on Replicate: https://replicate.com/kwaivgi/kling-o3
- VEED Kling guide: https://www.veed.io/learn/kling-3-0-guide
- Key syntax: `@Element1` references with frontal + angle reference images. Multi-Elements mode for swapping, adding, deleting, restyling. `keep_audio` parameter for audio preservation. 2500 character prompt limit.

**Wan 2.7:**
- EvoLink Wan 2.7 page: https://evolink.ai (search Wan 2.7 in model catalog)
- Key: Reference video + text prompt for editing variants. Specific syntax and constraints should be researched from EvoLink's model documentation when setting up the prompt skill.

---

## 10. Pipeline-Specific API Call Patterns

### Pipeline B: V2V Edit

#### Seedance 2.0 V2V

1. Extract audio from source video via FFmpeg (because Seedance cannot preserve original audio)
2. Upload source video to accessible URL (or use Convex file URL)
3. Call Seedance V2V endpoint via EvoLink with:
   - `prompt`: Translated edit instruction
   - Source video as reference
   - `generate_audio: false` (silent output)
   - `resolution: "480p"` (iteration tier)
   - `duration: "auto"`
   - `aspect_ratio: "9:16"` (TikTok vertical)
4. When output returns, overlay extracted original audio via FFmpeg
5. Store final video with audio in Convex

#### Kling O3 Edit

1. Upload source video to accessible URL
2. If using element references (e.g. a new avatar image), prepare element with `frontal_image_url`
3. Call Kling O3 Edit endpoint via EvoLink with:
   - `prompt`: Translated edit instruction with `@Element1` references if applicable
   - Source video as input
   - `keep_audio: true` (preserves original audio natively)
   - Resolution and duration parameters per Kling's API spec
4. Store output in Convex (audio already included)

#### Wan 2.7 Edit

1. Upload source video to accessible URL
2. Call Wan 2.7 video edit endpoint via EvoLink with:
   - `prompt`: Translated edit instruction
   - Source video as reference
   - Parameters per Wan 2.7's API spec (research during implementation)
3. Verify whether original audio was preserved or needs FFmpeg overlay
4. Store output in Convex

### Pipeline A: Full Regeneration

For each scene extracted by Pegasus:

1. Extract the audio segment for that scene from the source video via FFmpeg (using Pegasus timestamps)
2. Prepare avatar reference images uploaded by the user
3. If this is scene 2+, extract the last frame of the previous generation as a continuity reference
4. Generate model-specific prompt from Pegasus scene data using the prompt adapter
5. Fire generation call with:
   - Avatar reference image(s)
   - Scene audio segment (as audio reference for lip-sync)
   - Original scene video clip (as composition/motion reference)
   - Previous generation clip (as continuity reference, if scene 2+)
   - Translated prompt
   - 480p, 9:16, duration matched to scene length (capped at 15s)
6. Store output in Convex with scene number and full audit trail
7. After all scenes complete, concatenate via FFmpeg into full video

**Note on Seedance 2.0 reference limits for Pipeline A:**
- 9 images max, 3 videos max (combined 15s), 3 audio max (combined 15s), 12 total
- Previous generation as video reference uses 1 of 3 video slots AND contributes to the 15s combined video duration cap
- If previous generation was 12s, only 3s of video reference budget remains for the original source clip reference — may need to trim

**Note on `first_frame` vs `reference_images` for Seedance 2.0:**
- These are MUTUALLY EXCLUSIVE. You cannot use `first_frame_url` and `reference_images` in the same call.
- For scene bridging, pass the previous scene's last frame as one of the 9 image reference slots (e.g. `@Image2`) rather than using the `first_frame_url` parameter. This keeps you in omni-reference mode where all other references work.

---

## 11. Documentation References

### EvoLink (Unified API Provider)
- Homepage & API access: https://evolink.ai
- Model catalog & pricing: https://evolink.ai/models
- Seedance 2.0 on EvoLink: https://evolink.ai/seedance-2-0
- Seedance 2.0 pricing breakdown: https://evolink.ai/blog/seedance-2-0-pricing-api-cost-guide
- Gemini model comparison: https://evolink.ai/collections/gemini
- Gemini 2.5 Flash (multimodal): https://evolink.ai/gemini-2-5-flash
- Gemini Omni video workflows: https://evolink.ai/gemini-omni
- Best AI video models pricing guide: https://evolink.ai/blog/best-ai-video-generation-models-2026-pricing-guide

### Twelve Labs (Pegasus 1.5)
- Homepage: https://www.twelvelabs.io
- Pegasus model documentation: https://docs.twelvelabs.io/docs/concepts/models/pegasus
- Segment videos guide (TBM how-to): https://docs.twelvelabs.io/docs/guides/segment-videos
- Pegasus 1.5 technical blog: https://www.twelvelabs.io/blog/introducing-pegasus-1-5
- API reference: https://docs.twelvelabs.io/api-reference/introduction
- Upload methods: https://docs.twelvelabs.io/docs/concepts/upload-methods
- Python SDK: https://pypi.org/project/twelvelabs/

### Seedance 2.0 (Prompting & Technical)
- fal.ai official GitHub API docs: https://github.com/fal-ai/seedance-2.0-api
- Segmind API docs (Standard): https://www.segmind.com/models/seedance-2.0
- Segmind API docs (Fast): https://www.segmind.com/models/seedance-2.0-fast
- WaveSpeedAI V2V Edit endpoint: https://wavespeed.ai/models/bytedance/seedance-2.0/video-edit
- Omni-reference prompt guide: https://www.glbgpt.com/hub/seedance-2-0-omni-reference/
- RunDiffusion prompt guide: https://www.rundiffusion.com/seedance-2-0-prompt-guide
- Scenario complete guide: https://help.scenario.com/articles/7140699840-seedance-2-0-the-complete-guide
- Synclip prompt guide: https://synclip.ai/blog/seedance-2-prompt-guide
- Seedance manual: https://www.seedvideo.net/docs/seedance-2-manual
- Error guide (all errors with fixes): https://blog.segmind.com/seedance-2-0-error-guide-every-error-explained-with-fixes/
- Content restriction workarounds: https://www.mindstudio.ai/blog/seedance-2-0-content-restrictions-workarounds
- Real human face rules: https://aividpipeline.com/blog/seedance-real-human-face-rules-2026
- fal.ai text-to-video docs: https://fal.ai/models/bytedance/seedance-2.0/text-to-video
- fal.ai reference-to-video docs: https://fal.ai/models/bytedance/seedance-2.0/reference-to-video
- Replicate Seedance docs: https://replicate.com/bytedance/seedance-2.0

### Kling O3 Edit
- Kling 3.0 complete guide: https://kling3.org/blog/kling-3-0-ai-video-generator-complete-guide
- Kling O1/O3 Edit on Replicate (O3 is the update to O1): https://replicate.com/kwaivgi/kling-o1
- Kling O1/O3 V2V on AIMLAPI: https://aimlapi.com/models/kling-video-o1-video-to-video-edit
- Atlas Cloud Kling collection: https://www.atlascloud.ai/collections/kling-v3
- VEED Kling 3.0 guide: https://www.veed.io/learn/kling-3-0-guide
- Kling motion control API: https://kie.ai/kling-3-motion-control

### Gemini 3.1 Pro (Orchestration & Video Understanding)
- Gemini 2.5 Pro model documentation (architecture reference): https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro
- EvoLink Gemini model comparison (all Gemini routes including 3.1): https://evolink.ai/collections/gemini
- EvoLink Gemini 2.5 Flash (multimodal video input confirmation): https://evolink.ai/gemini-2-5-flash
- Video understanding blog (Gemini multimodal capabilities): https://developers.googleblog.com/en/gemini-2-5-video-understanding/
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing

### Convex (Database)
- Documentation: https://docs.convex.dev
- File storage: https://docs.convex.dev/file-storage
- Next.js integration: https://docs.convex.dev/quickstart/nextjs

---

## 12. Open Questions for Implementation

1. **Wan 2.7 audio preservation**: Does Wan 2.7's video editing endpoint preserve original audio? This needs to be tested during the first round of API calls. If it doesn't, apply the same FFmpeg extract-overlay workaround as Seedance. This information should also be added to the Wan 2.7 prompt skill document so Gemini can plan accordingly.

2. **EvoLink endpoint mapping**: EvoLink uses a unified API format. The exact endpoint paths and parameter names for each model's V2V editing mode need to be confirmed from EvoLink's API documentation during implementation. The model parameter changes but the request shape may vary. Confirm how to call Gemini 3.1 Pro with multimodal video input through EvoLink's OpenAI-compatible endpoint.

3. **Media URL accessibility**: Generation models need publicly accessible URLs for reference media. Convex file storage URLs may or may not be directly accessible to external APIs. If not, a temporary signed URL or a media proxy may be needed.

4. **Prompt skill iteration**: The initial prompt skills will be rough. Plan for the skills to be editable from the dashboard UI so we can iterate without code changes. Version tracking in the `promptSkills` table supports A/B testing different prompt strategies. When a prompt skill is updated, Gemini's generation plans will automatically reflect the new guidance.

5. **Pegasus cost and rate limits**: Twelve Labs has rate limits and usage-based pricing. For heavy testing, confirm the plan tier and rate limits before running batch decompositions.

6. **Gemini generation plan format**: Define the exact JSON schema for the structured generation plan that Gemini 3.1 returns. This schema needs to be precise enough for the orchestration layer to execute mechanically — it should specify exact timestamps for FFmpeg extraction, exact prompts per call, exact parameter values, and exact media references. Test whether Gemini reliably produces valid, parseable JSON for this use case, and whether structured output mode is needed.

7. **Prompt length limits**: Kling O3 has a documented 2500 character prompt limit. Seedance's limit is not documented but should be tested. The prompt skill documents for each model should include these limits so Gemini enforces them when writing prompts as part of the generation plan.

8. **Gemini 3.1 Pro context window vs video length**: For long source videos, verify that Gemini 3.1 Pro can ingest the full video + the Pegasus JSON output + the prompt skills for all 3 models without exceeding context limits. Gemini's 1M+ token context should handle this, but test with real workloads.

9. **Sequential vs parallel execution**: For Pipeline A, Gemini's plan may specify sequential calls per model (for continuity chaining — scene 2 depends on scene 1's output). The orchestration layer needs to handle per-model sequential execution while running different models in parallel. E.g., Seedance scene 1 → Seedance scene 2 → Seedance scene 3 runs sequentially, but that whole chain runs in parallel with Kling's chain and Wan's chain.
