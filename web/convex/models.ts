// Single source of truth for generation-model facts — all CONFIRMED by Phase 0 live probes.
// Used by the Gemini planner (as context) and the executor (to validate/clamp params).

export const GEMINI_MODEL = "gemini-3.1-pro-preview"; // bare "gemini-3.1-pro" is invalid

export type ModelId = "seedance-2.0-reference-to-video" | "kling-o3-video-edit";

export interface ModelSpec {
  id: ModelId;
  label: string;
  // generation params
  qualities: string[];
  defaultQuality: string;
  maxDurationSec: number; // hard cap per call
  durationConfigurable: boolean; // false ⇒ output follows source length
  promptMaxChars?: number;
  // audio
  audioParam: "generate_audio" | "keep_audio";
  // true ⇒ the model can preserve the source audio natively (no FFmpeg)
  nativeAudioPreservation: boolean;
  // reference inputs
  referenceSyntax: string;
  referenceLimits: string;
  sourceVideoParam: string; // request body field carrying the source video URL(s)
  notes: string[];
}

export const MODELS: Record<ModelId, ModelSpec> = {
  "seedance-2.0-reference-to-video": {
    id: "seedance-2.0-reference-to-video",
    label: "Seedance 2.0",
    qualities: ["480p", "720p"],
    defaultQuality: "480p",
    maxDurationSec: 15,
    durationConfigurable: true,
    audioParam: "generate_audio",
    nativeAudioPreservation: false, // PROVEN silent with generate_audio:false → needs FFmpeg re-mux
    referenceSyntax: 'Positional tags in the prompt: "video 1", "image 1", "audio 1" (→ video_urls[0], image_urls[0], audio_urls[0]).',
    referenceLimits: "Up to 9 images, 3 videos, 3 audio; 12 total.",
    sourceVideoParam: "video_urls",
    notes: [
      "generate_audio:false yields a SILENT output — original audio must be re-overlaid via FFmpeg.",
      "first_frame_url and reference_images are mutually exclusive.",
      "EvoLink bills input reference-video duration in addition to output duration.",
    ],
  },
  "kling-o3-video-edit": {
    id: "kling-o3-video-edit",
    label: "Kling O3",
    qualities: ["720p", "1080p"], // NO 480p
    defaultQuality: "720p",
    maxDurationSec: 10, // source must be ~3–10.05s; output follows source length
    durationConfigurable: false, // `duration` is ignored — output = source length
    promptMaxChars: 2500,
    audioParam: "keep_audio", // NOTE: actual EvoLink field is keep_original_sound (see notes); legacy enum kept for type-compat
    nativeAudioPreservation: true, // keep_original_sound:true preserves source audio (no FFmpeg)
    // CORRECTED (June 2026, doc-verified): syntax is <<<element_1>>> / <<<image_1>>>, NOT @Element1/@Image1.
    // IDENTITY swap = 2-call element workflow: (1) kling-custom-element creates a reusable subject and returns
    // an element_id; (2) pass model_params.element_list:[{element_id}] here and reference it as <<<element_1>>>
    // in the prompt. image_urls (referenced <<<image_1>>>) is only a STYLE channel → partial swap only.
    referenceSyntax: "Prompt refs: <<<element_1>>> (identity element) / <<<image_1>>> (style image). Elements created via kling-custom-element (frontal_image + refer_images[].image_url), referenced by element_id in model_params.element_list.",
    referenceLimits: "image_urls + elements ≤ 4 combined. Source video 3–10.05s, 720–2160px, 24–60fps. Element images ≥300px, aspect 1:2.5–2.5:1.",
    sourceVideoParam: "video_url", // STRING, singular (NOT video_urls — that is the O1 edit shape)
    notes: [
      "Audio param is keep_original_sound (default true) — preserves source audio natively, no FFmpeg. (NOT keep_audio.)",
      "Sound GENERATION is not supported when a video input is provided (original sound is kept, no new audio).",
      "IDENTITY swap needs the 2-call element workflow (kling-custom-element → element_list + <<<element_1>>>); image_urls alone only nudges identity (partial).",
      "Video-based elements are NOT supported for o3 edit — create the element with reference_type:\"image_refer\".",
      "first/last-frame editing NOT supported. Minimum quality 720p (no 480p). 1080p bills ×1.334.",
      "`duration` is ignored; output matches the source clip length. Prompt hard limit: 2500 characters.",
    ],
  },
};

export const ALL_MODEL_IDS = Object.keys(MODELS) as ModelId[];
