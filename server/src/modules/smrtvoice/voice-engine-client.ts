/**
 * Voice Engine HTTP Client
 *
 * Wraps every call from smrtesy → voice-engine (the Python service).
 * Auth is a static Bearer token; webhook payloads from voice-engine
 * back to us are HMAC-signed and verified by `verifyWebhookSignature`.
 */

import crypto from "node:crypto";

import type {
  CreateJobRequest,
  CreateJobResponse,
  GetJobResponse,
  ParsedScript,
} from "./types";

export class VoiceEngineError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "VoiceEngineError";
  }
}

class VoiceEngineClient {
  private baseUrl: string;
  private apiKey: string;
  private webhookSecret: string;
  private callbackBaseUrl: string;

  constructor() {
    this.baseUrl = (process.env.VOICE_ENGINE_URL ?? "").replace(/\/+$/, "");
    this.apiKey = process.env.VOICE_ENGINE_API_KEY ?? "";
    this.webhookSecret = process.env.VOICE_ENGINE_WEBHOOK_SECRET ?? "";
    this.callbackBaseUrl = (process.env.SMRTESY_PUBLIC_URL ?? "").replace(/\/+$/, "");

    // We intentionally don't throw at construction — the singleton is created
    // lazily on first call, so a missing var only fails the request that needs it.
  }

  private ensureConfigured(): void {
    if (!this.baseUrl) throw new VoiceEngineError("VOICE_ENGINE_URL is not set");
    if (!this.apiKey) throw new VoiceEngineError("VOICE_ENGINE_API_KEY is not set");
    if (!this.webhookSecret) throw new VoiceEngineError("VOICE_ENGINE_WEBHOOK_SECRET is not set");
  }

  /** Create a new job in voice-engine. */
  async createJob(
    request: Omit<CreateJobRequest, "callback_url" | "callback_secret">,
  ): Promise<CreateJobResponse> {
    this.ensureConfigured();
    if (!this.callbackBaseUrl) {
      throw new VoiceEngineError("SMRTESY_PUBLIC_URL is not set (needed for callback_url)");
    }

    const fullRequest: CreateJobRequest = {
      ...request,
      callback_url: `${this.callbackBaseUrl}/api/voice/webhook`,
      callback_secret: this.webhookSecret,
    };

    return this.request<CreateJobResponse>("POST", "/jobs", fullRequest);
  }

  async getJob(jobId: string): Promise<GetJobResponse> {
    return this.request<GetJobResponse>("GET", `/jobs/${jobId}`);
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.request<void>("POST", `/jobs/${jobId}/cancel`);
  }

  async parseScript(
    googleDocId: string,
    googleOauthToken?: string,
    tab?: { id?: string | null; title?: string | null },
  ): Promise<ParsedScript> {
    return this.request<ParsedScript>("POST", "/parse", {
      google_doc_id: googleDocId,
      google_oauth_token: googleOauthToken,
      google_doc_tab_id: tab?.id ?? undefined,
      google_doc_tab_title: tab?.title ?? undefined,
    });
  }

  /** List the tabs of a Google Doc so the UI can offer a language picker. */
  async listDocumentTabs(
    googleDocId: string,
    googleOauthToken?: string,
  ): Promise<{ tabs: Array<{ id: string; title: string }> }> {
    return this.request("POST", "/parse/tabs", {
      google_doc_id: googleDocId,
      google_oauth_token: googleOauthToken,
    });
  }

  /** Connected Resemble account + total voice count (no credit API exists). */
  async getResembleAccount(): Promise<{
    email: string | null;
    name: string | null;
    teams: number | null;
    total_voices: number;
    credits_available: number | null;
    billing_url: string;
  }> {
    return this.request("GET", "/voices/account");
  }

  /** List all voices on the Resemble account. */
  async listVoices(): Promise<{ voices: Array<Record<string, unknown>> }> {
    return this.request("GET", "/voices");
  }

  /** Delete a voice from the Resemble account. */
  async deleteVoice(voiceUuid: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/voices/${voiceUuid}`);
  }

  /** Synthesize a short preview clip with a voice (voice library). */
  async generateSample(
    voiceUuid: string,
    text: string,
    opts?: { language?: string; model?: string },
  ): Promise<{ audio_url: string; duration: number; cost: number }> {
    return this.request("POST", `/voices/${voiceUuid}/sample`, {
      text,
      language: opts?.language ?? "he",
      model: opts?.model ?? undefined,
    });
  }

  /** Poll a voice's readiness after a clone/upgrade. */
  async getVoiceStatus(
    voiceUuid: string,
  ): Promise<{ voice_uuid: string; name: string | null; status: string | null; dataset: string | null }> {
    return this.request("GET", `/voices/${voiceUuid}/status`);
  }

  async createVoiceClone(params: {
    sample_url?: string;
    sample_urls?: string[];
    name: string;
    voice_type?: "rapid" | "pro";
    language?: string;
  }): Promise<{ voice_id: string; status: string }> {
    return this.request("POST", "/voices/clone", {
      // Prefer the multi-part list (each part is split into <=12s clips
      // server-side); fall back to a single sample for the legacy path.
      sample_audio_urls: params.sample_urls ?? undefined,
      sample_audio_url: params.sample_url ?? undefined,
      voice_name: params.name,
      voice_type: params.voice_type ?? "rapid",
      language: params.language ?? "he",
    });
  }

  /**
   * Verify a webhook signature on incoming requests from voice-engine.
   * Rejects payloads older than 5 minutes (replay protection).
   */
  verifyWebhookSignature(
    payload: string,
    signature: string,
    timestamp: string,
  ): boolean {
    if (!this.webhookSecret) return false;
    if (!signature || !timestamp) return false;

    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);
    if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > 300) {
      return false;
    }

    const expected = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.ensureConfigured();

    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetails: unknown;
      try {
        errorDetails = JSON.parse(errorText);
      } catch {
        errorDetails = errorText;
      }
      throw new VoiceEngineError(
        `Voice Engine request failed: ${response.status} ${response.statusText}`,
        response.status,
        errorDetails,
      );
    }

    return (await response.json()) as T;
  }
}

let _client: VoiceEngineClient | null = null;

export function getVoiceEngineClient(): VoiceEngineClient {
  if (!_client) {
    _client = new VoiceEngineClient();
  }
  return _client;
}
