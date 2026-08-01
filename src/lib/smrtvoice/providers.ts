// The two voice providers smrtVoice can render with, and the mapping from a
// model id to its provider.
//
// Provider is a property of the VOICE (a MiniMax custom_voice_id only renders on
// MiniMax; a Resemble voice id only on Resemble), but the model id also encodes
// the provider by prefix — this is the same rule the voice engine routes on
// (voice-engine api/voices.py: a "minimax-*" model → the MiniMax fal adapter,
// everything else → Resemble). Keep this the single source of that mapping on
// the frontend so the casting UI and the model picker agree; the backend mirrors
// the same one-liner as `isMiniMaxModel` in server/.../smrtvoice/routes.ts.

export type VoiceProvider = "resemble" | "minimax";

/** The provider a model id belongs to. null/"" (inherit org default) → resemble. */
export function providerForModel(model?: string | null): VoiceProvider {
  return model && model.toLowerCase().startsWith("minimax") ? "minimax" : "resemble";
}
