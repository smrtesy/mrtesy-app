-- smrtVoice: multi-provider voices — 'resemble' (default) or 'minimax'.
--
-- Why: Resemble bills $2/month per rapid voice for as long as the voice exists,
-- used or not. A MiniMax voice is cloned once via fal (fal-ai/minimax/voice-clone,
-- $1.50 one-time) and carries NO standing fee; synthesis is billed per character
-- (speech-2.8-hd $0.10 / 1k chars). MiniMax also ranked first for Hebrew in the
-- community TTS comparison the video-lab voice research relied on.
--
-- The provider is a property of the VOICE, not of the script: a MiniMax
-- custom_voice_id can only render on MiniMax models, so buildSpeakerMap forces
-- a minimax-* model for these voices regardless of the script/org model choice
-- (the script-level model keeps governing Resemble voices only).

ALTER TABLE smrtvoice_characters
  ADD COLUMN IF NOT EXISTS voice_provider text NOT NULL DEFAULT 'resemble'
    CHECK (voice_provider IN ('resemble', 'minimax'));

COMMENT ON COLUMN smrtvoice_characters.voice_provider IS
  'Which TTS provider holds this character''s cloned voice. resemble = Resemble AI (rapid→ultra clone, $2/mo per voice while it exists); minimax = MiniMax via fal (one-time $1.50 clone, no monthly fee, resemble_voice_id then stores the MiniMax custom_voice_id).';
