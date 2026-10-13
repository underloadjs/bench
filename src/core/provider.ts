// core/provider.ts — OpenAI-compatible provider client for the bench engine.
//
// The bench fleet is DISCOVERED, not hardcoded: the dashboard asks the local
// inference provider's catalog endpoint (GET {provider}/v1/models) which
// models exist, then benchmarks any of them through the OpenAI-compatible
// chat-completions endpoint (POST {provider}/v1/chat/completions).
//
// DEPLOYMENT CONTEXT (mirrors distribution/chat-assistant/src/api/config.ts):
// the provider is a SEPARATE service listening on the PROVIDER port. Every
// runtime endpoint under /providers/private declares
// `port: LOCAL_AREA_NETWORK_PROVIDER_PORT`
// (runtime/endpoint/provider/private/models/service-route.ts:36,
// .../chat-completion/service-route.ts:7), so the base origin is assembled
// from LOCAL_AREA_NETWORK_HOST_NAME + LOCAL_AREA_NETWORK_PROVIDER_PORT —
// NOT the database port and not a static-host-relative path.
//
// Credentials never live here: the provider injects them server-side, so the
// browser sends no Authorization header (same pattern as
// distribution/chat-assistant/src/api/provider.ts:101-128).

import { LOCAL_AREA_NETWORK_HOST_NAME, LOCAL_AREA_NETWORK_PROVIDER_PORT } from '@config/environment';

// Assembled provider origin: http://<LAN host>:<PROVIDER port>. The provider
// service owns the /providers/private/v1 route prefix
// (runtime/endpoint/provider/private/constant.ts BASE_URL), so the model
// catalog lives at {origin}/providers/private/v1/models and streaming
// completions at {origin}/providers/private/v1/chat/completions.
export const DEFAULT_PROVIDER_HOST = LOCAL_AREA_NETWORK_HOST_NAME;
export const DEFAULT_PROVIDER_PORT = LOCAL_AREA_NETWORK_PROVIDER_PORT;
export const DEFAULT_PROVIDER_ORIGIN = `http://${DEFAULT_PROVIDER_HOST}:${DEFAULT_PROVIDER_PORT}`;
// Full default base URL — the exact route prefix BASE_URL in
// runtime/endpoint/provider/private/constant.ts publishes.
export const DEFAULT_PROVIDER_URL = `${DEFAULT_PROVIDER_ORIGIN}/providers/private/v1`;

// One entry of the OpenAI-compatible /models catalog; only `id` is consumed
// by the bench (it is the routing key sent back as `model` on completions).
export type ProviderModel = {
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
    context_length?: number;
};

// Envelope returned by GET {provider}/models
// (runtime/endpoint/provider/private/models/service-route.ts:15-32).
export type ProviderModelsResponse = {
    object: 'list';
    data: ProviderModel[];
};

// Normalize a base URL: strip trailing slashes so `${base}/models` can never
// double up ('http://h:5500/v1/' + 'models' → '…v1//models').
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

// Read a server error body when available, with a deterministic status
// fallback (mirrors distribution/chat-assistant/src/api/provider.ts:68-76).
const errorMessage = async (response: Response, fallback: string): Promise<string> => {
    try {
        const data = await response.json();
        if (typeof data?.error === 'string' && data.error.length > 0) return data.error;
    } catch {
        // Non-JSON error body → the status-based fallback below still applies.
    }
    return `${fallback} (HTTP ${response.status})`;
};

/**
 * Fetches the model list from the provider's OpenAI-compatible catalog
 * (GET {baseUrl}/models). This list IS the bench fleet: every returned id is
 * a benchmarkable model, and the id is the exact `model` routing key the
 * chat-completions route expects.
 *
 * @param baseUrl - Provider base (defaults to the LAN provider origin).
 */
export async function fetchProviderModels(baseUrl: string = DEFAULT_PROVIDER_URL): Promise<ProviderModel[]> {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, { method: 'GET' });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to fetch provider models'));
    }
    const data = (await response.json()) as Partial<ProviderModelsResponse>;
    if (!Array.isArray(data.data)) {
        throw new Error('Provider models response did not include a data list');
    }
    return data.data;
}

// Shared streaming completion: POSTs the message list to the
// OpenAI-compatible chat-completions endpoint and parses the SSE frames.
// Both generate() (single user prompt) and generateConversation() (full
// history) funnel through here — the only difference is the messages array.
const streamCompletion = async (
    doFetch: typeof fetch,
    baseUrl: string,
    model: string,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    onUpdate?: (chunk: string) => void,
    signal?: AbortSignal
): Promise<import('./types').BenchGeneration> => {
    // SSE request — stream: true mirrors
    // distribution/chat-assistant/src/api/provider.ts:115-128.
    const response = await doFetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Cancellation: the run's signal aborts the request mid-stream —
        // reader.read() rejects and the error propagates to the runner,
        // which maps it to the canonical 'cancelled' run error.
        signal,
        body: JSON.stringify({
            model,
            stream: true,
            // OpenAI-compatible providers omit usage from streamed
            // responses unless explicitly opted in — request it so
            // the bench reports real token counts when available.
            stream_options: { include_usage: true },
            messages
        })
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response, `Bench completion failed for ${model}`));
    }
    if (!response.body) {
        throw new Error('Bench completion returned no stream body');
    }

    // SSE parse loop (mirrors the reader loop in
    // library/cloud/src/agents/lightning-agent.ts:149-167):
    // decode incrementally, keep the partial tail so frames split
    // across network chunks are reassembled before parsing.
    //
    // STREAMING FORMAT (reasoning models): GLM/deepseek-style providers
    // stream the chain of thought in `delta.reasoning_content` (OpenRouter
    // style: `delta.reasoning`) FIRST, and only emit `delta.content` once
    // thinking finishes. Those reasoning chunks are real OUTPUT tokens:
    //   - the FIRST chunk of either kind is the true TTFT signal (measuring
    //     at the first `content` chunk bills the whole thinking phase into
    //     TTFT/prefill — observed as a bogus 58s TTFT with 0.4 tok/s
    //     prefill while the network tab showed streaming immediately);
    //   - they belong to the DECODE phase, so `onUpdate` fires for them too
    //     (live received-counter + decode window both start at the right
    //     moment);
    //   - they are accumulated separately in `reasoning` (NOT in `content`)
    //     so conversation replays (growing-context) stay pure continuations.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const raw of lines) {
                const line = raw.trim();
                // The producer emits only `data:` frames; blank
                // separators are skipped.
                if (!line.startsWith('data:')) continue;
                const data = line.slice('data:'.length).trim();
                if (data.length === 0 || data === '[DONE]') continue;
                const parsed = JSON.parse(data) as {
                    choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>;
                    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
                    error?: { message?: unknown };
                };
                // Mid-stream failure frames arrive without [DONE]
                // (runtime/endpoint/provider/private/chat-completion
                // catch-all) — reject so the runner records the error.
                if (parsed.error) {
                    const message = parsed.error.message;
                    throw new Error(typeof message === 'string' && message.length > 0 ? message : 'Provider stream terminated');
                }
                const delta = parsed.choices?.[0]?.delta;
                if (delta) {
                    // Accumulate answer vs chain-of-thought independently (a
                    // delta may legally carry both) and signal the runner on
                    // EITHER kind — the first signal of any kind is TTFT.
                    const contentChunk = typeof delta.content === 'string' ? delta.content : '';
                    const reasoningChunk =
                        typeof delta.reasoning_content === 'string'
                            ? delta.reasoning_content
                            : typeof delta.reasoning === 'string'
                              ? delta.reasoning
                              : '';
                    if (contentChunk.length > 0) {
                        content += contentChunk;
                        onUpdate?.(contentChunk);
                    }
                    if (reasoningChunk.length > 0) {
                        reasoning += reasoningChunk;
                        onUpdate?.(reasoningChunk);
                    }
                }
                // Final usage chunk (stream_options include_usage)
                if (parsed.usage) {
                    usage = {
                        // OpenAI wire format is snake_case; the bench
                        // usage shape is camelCase.
                        promptTokens: typeof parsed.usage.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : undefined,
                        completionTokens: typeof parsed.usage.completion_tokens === 'number' ? parsed.usage.completion_tokens : undefined,
                        totalTokens: typeof parsed.usage.total_tokens === 'number' ? parsed.usage.total_tokens : undefined
                    };
                }
            }
        }
    } catch (reason: unknown) {
        // Abandon the body so the connection never dangles on failure
        await reader.cancel().catch(() => undefined);
        throw reason;
    }

    return {
        content,
        // Reasoning text only when the stream actually carried some — plain
        // models keep the exact same generation shape as before
        ...(reasoning.length > 0 ? { reasoning } : {}),
        model,
        usage
    };
};

/**
 * Builds a streaming BenchProvider bound to a specific model id on the
 * OpenAI-compatible chat-completions endpoint. Streams the SSE frames and
 * invokes `onUpdate` per content delta so the bench engine records TTFT.
 * Also exposes `generateConversation` — the same transport driven with a
 * full message history (the growing-context scenario's continuation form).
 *
 * Injected deps (fetch/sleep) exist purely for deterministic tests — the
 * defaults are the real global fetch and the no-op instant resolve.
 *
 * @param model   - The catalog model id (routing key for the provider).
 * @param options - { baseUrl? } — provider base, defaults to the LAN origin.
 */
export const createHttpProvider = (
    model: string,
    options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}
): import('./types').BenchProvider => {
    const baseUrl = options.baseUrl ?? DEFAULT_PROVIDER_URL;
    const doFetch = options.fetchImpl ?? fetch;

    return {
        model,
        generate: async (prompt: string, onUpdate?: (chunk: string) => void, signal?: AbortSignal) =>
            // Single-prompt form: one user message wraps the prompt
            streamCompletion(doFetch, baseUrl, model, [{ role: 'user', content: prompt }], onUpdate, signal),
        generateConversation: async (messages, onUpdate?: (chunk: string) => void, signal?: AbortSignal) =>
            // Conversation form: the FULL accumulated history is resent every
            // call — strict continuation for per-lane prefix reuse
            streamCompletion(doFetch, baseUrl, model, messages, onUpdate, signal)
    };
};
