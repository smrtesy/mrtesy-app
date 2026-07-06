/**
 * smrtVoice — shared TypeScript types.
 *
 * DB row shapes match supabase/migrations/*_smrtvoice_schema.sql exactly.
 * Voice Engine API shapes match voice-engine/src/voice_engine/models/*.py.
 */

// ============================================================
// Database row types
// ============================================================

export interface Character {
  id: string;
  org_id: string;
  created_by: string;
  name: string;
  display_name: string | null;
  description: string | null;
  notes: string | null;
  resemble_voice_id: string | null;
  voice_status: "none" | "training" | "ready";
  resemble_model: string;
  chatterbox_sample_path: string | null;
  language: "he" | "en";
  voice_type: "rapid" | "pro";
  age_group: "child" | "teen" | "adult" | "elderly" | null;
  age_years: number | null;
  gender: "male" | "female" | "neutral" | null;
  default_exaggeration: number;
  default_pitch: number;
  default_pace: "slow" | "normal" | "fast";
  personality_prompt: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VoiceProfile {
  id: string;
  org_id: string;
  character_id: string;
  created_by: string;
  profile_name: string;
  exaggeration: number;
  pitch: number;
  speaking_pace: "slow" | "normal" | "fast";
  resemble_prompt: string | null;
  context: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export type ProjectStatus =
  | "draft"
  | "parsed"
  | "ready"
  | "queued"
  | "processing"
  | "audio_ready"
  | "completed"
  | "archiving"
  | "archived"
  | "failed";

export interface Project {
  id: string;
  org_id: string;
  created_by: string;
  name: string;
  description: string | null;
  code: string | null;
  code_prefix: string | null;
  language: "he" | "en";
  google_doc_id: string | null;
  google_doc_url: string | null;
  google_doc_tab_id: string | null;
  google_doc_tab_title: string | null;
  script_imported_at: string | null;
  generation_mode: "sts" | "tts";
  input_recording_path: string | null;
  status: ProjectStatus;
  gdrive_target_folder_id: string | null;
  gdrive_target_folder_url: string | null;
  total_lines: number;
  completed_lines: number;
  failed_lines: number;
  total_cost_usd: number;
  total_duration_seconds: number;
  archive_gdrive_folder_id: string | null;
  archive_gdrive_folder_url: string | null;
  archived_at: string | null;
  audio_ready_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Script {
  id: string;
  org_id: string;
  project_id: string;
  created_by: string;
  seq: number;
  code: string;
  name: string | null;
  language: "he" | "en";
  google_doc_id: string | null;
  google_doc_url: string | null;
  google_doc_tab_id: string | null;
  google_doc_tab_title: string | null;
  script_imported_at: string | null;
  generation_mode: "sts" | "tts";
  input_recording_path: string | null;
  status: ProjectStatus;
  total_lines: number;
  completed_lines: number;
  failed_lines: number;
  total_cost_usd: number;
  total_duration_seconds: number;
  archive_gdrive_folder_id: string | null;
  archive_gdrive_folder_url: string | null;
  archived_at: string | null;
  audio_ready_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScriptSpeaker {
  id: string;
  org_id: string;
  script_id: string;
  speaker_name: string;
  character_id: string | null;
  resemble_voice_id: string | null;
  skip: boolean;
  created_at: string;
  updated_at: string;
}

export type LineStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

export interface ScriptLine {
  id: string;
  org_id: string;
  script_id: string;
  line_number: number;
  scene_title: string | null;
  speaker_name: string;
  character_id: string | null;
  text_raw: string;
  text_clean: string;
  text_pointed: string | null;
  text_for_tts: string | null;
  tts_body: string | null;
  tags: Array<{ tag: string; type?: string; source?: string }>;
  directions: string[];
  llm_processed: boolean;
  llm_processed_at: string | null;
  emotion: string | null;
  emotion_source: "script" | "llm" | "none" | null;
  emotion_profile_id: string | null;
  resemble_prompt: string | null;
  resemble_request: Record<string, unknown> | null;
  final_exaggeration: number | null;
  final_pitch: number | null;
  final_pace: string | null;
  final_model: string | null;
  input_audio_path: string | null;
  output_audio_path: string | null;
  output_duration_seconds: number | null;
  status: LineStatus;
  attempt_count: number;
  error_message: string | null;
  generation_cost_usd: number | null;
  approved: boolean;
  redo_requested: boolean;
  redo_reason: string | null;
  redo_instructions: string | null;
  redone_at: string | null;
  created_at: string;
  updated_at: string;
  // Computed by the lines endpoint (not a column): how many takes this line has.
  take_count?: number;
}

export interface LineTake {
  id: string;
  org_id: string;
  line_id: string;
  script_id: string | null;
  text_used: string | null;
  model: string | null;
  output_audio_path: string;
  duration_seconds: number | null;
  cost_usd: number | null;
  created_at: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  org_id: string;
  project_id: string;
  script_id: string | null;
  created_by: string;
  job_type:
    | "parse_script"
    | "preprocess_lines"
    | "generate_audio"
    | "regenerate_line"
    | "archive_project";
  voice_engine_job_id: string | null;
  adapter: "resemble" | "chatterbox_local" | "chatterbox_runpod";
  status: JobStatus;
  progress: number;
  result: Record<string, unknown> | null;
  error_message: string | null;
  total_cost_usd: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PronunciationEntry {
  id: string;
  org_id: string;
  created_by: string;
  original_word: string;
  // A PHONETIC RESPELLING sent to Resemble verbatim — Hebrew respelling or a
  // Latin transliteration, chosen per-word. Never niqqud.
  pronounced_as: string;
  language: "he" | "en";
  category: "general" | "chabad" | "name" | "theophilic_name" | "place" | "foreign";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  id: string;
  org_id: string;
  monthly_budget_usd: number;
  budget_warning_threshold: number;
  budget_block_threshold: number;
  default_adapter: "resemble" | "chatterbox_local" | "chatterbox_runpod";
  default_resemble_model: string | null;
  default_llm_model: string | null;
  archive_after_days: number;
  archive_auto_enabled: boolean;
  gdrive_archive_folder_id: string | null;
  gdrive_archive_folder_url: string | null;
  project_folder_template: string;
  audio_file_template: string;
  postprocess_enabled: boolean;
  postprocess_compress: boolean;
  postprocess_speed: number;
  notify_on_completion: boolean;
  notify_on_budget_warn: boolean;
  notify_via_whatsapp: boolean;
  sample_text: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Voice Engine API types
// ============================================================

export interface CreateJobRequest {
  org_id: string;
  project_id: string;
  user_id?: string;
  script_id?: string;
  speaker_map?: Record<
    string,
    {
      resemble_voice_id: string;
      model?: string | null;
      language?: string;
      character_id?: string | null;
      character_name?: string | null;
      description?: string | null;
    }
  >;
  job_type: "generate_audio" | "regenerate_line" | "parse_script";
  adapter?: "resemble" | "chatterbox_local" | "chatterbox_runpod";
  mode: "sts" | "tts";
  google_doc_id?: string;
  google_oauth_token?: string;
  google_doc_tab_id?: string;
  google_doc_tab_title?: string;
  input_audio_url?: string;
  llm_model?: string;
  code?: string;
  line_numbers?: number[];
  // Notation-agnostic per-org pronunciation lexicon (Hebrew or Latin
  // replacements, applied verbatim by voice-engine).
  pronunciation?: Array<{ word: string; replacement: string; language: string }>;
  // regenerate_line only: verbatim per-line text edits sent to voice-engine.
  line_overrides?: Array<{ line_number: number; text_for_tts: string }>;
  // regenerate_line only: line numbers to re-run through the LLM (fresh tone).
  reprocess_line_numbers?: number[];
  postprocess_enabled?: boolean;
  postprocess_compress?: boolean;
  postprocess_speed?: number;
  callback_url: string;
  callback_secret?: string;
  characters?: Array<{ name: string; resemble_voice_id?: string }>;
}

export interface CreateJobResponse {
  job_id: string;
  status: "queued";
  estimated_seconds: number | null;
}

export interface GetJobResponse {
  job_id: string;
  status: JobStatus;
  progress: number;
  lines_completed: number;
  lines_total: number;
  lines_failed: number;
  started_at: string | null;
  completed_at: string | null;
  estimated_remaining_seconds: number | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
}

export interface ParsedScript {
  total_lines: number;
  scenes: string[];
  speakers: string[];
  warnings: string[];
  preview: Array<{ line: number; speaker: string; text: string }>;
}

export interface WebhookPayload {
  event_type: string;
  org_id: string;
  project_id: string;
  job_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// ============================================================
// API request/response types
// ============================================================

export interface CreateProjectRequest {
  name: string;
  description?: string;
  code?: string;
  language: "he" | "en";
  google_doc_url: string;
  google_doc_tab_id?: string;
  google_doc_tab_title?: string;
  generation_mode?: "sts" | "tts";
}

export interface CreateCharacterRequest {
  name: string;
  display_name?: string;
  description?: string;
  language?: "he" | "en";
  voice_type?: "rapid" | "pro";
  age_group?: "child" | "teen" | "adult" | "elderly";
  age_years?: number;
  gender?: "male" | "female" | "neutral";
  personality_prompt?: string;
}

export interface CreateVoiceProfileRequest {
  character_id: string;
  profile_name: string;
  exaggeration: number;
  pitch: number;
  speaking_pace: "slow" | "normal" | "fast";
  resemble_prompt?: string;
  context?: string;
  is_default?: boolean;
}

export interface UpdateLineRequest {
  text_clean?: string;
  text_for_tts?: string;
  character_id?: string;
  emotion_profile_id?: string;
  final_exaggeration?: number;
  final_pitch?: number;
  final_pace?: "slow" | "normal" | "fast";
  status?: LineStatus;
  approved?: boolean;
}
