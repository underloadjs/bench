// core/provider.test.ts — SSE parsing tests for the OpenAI-compatible
// transport, focused on the STREAMING FORMAT contract:
//
//   Reasoning models (GLM / deepseek style `delta.reasoning_content`,
//   OpenRouter style `delta.reasoning`) stream their chain of thought FIRST
//   and only emit `delta.content` once thinking finishes. The transport must:
//     - fire onUpdate on the FIRST chunk of EITHER kind (that first signal is
//       the runner's TTFT — measuring at the first `content` chunk bills the
//       whole thinking phase into TTFT/prefill);
//     - accumulate answer text and reasoning text SEPARATELY (reasoning must
//       never leak into `content`, which conversation replays resend);
//     - map the snake_case usage trailer onto the bench usage shape.
//
// The fetch primitive is injected (fetchImpl) so every test streams a fixed
// SSE frame set through an in-memory ReadableStream — fully deterministic.
import { describe, expect, it } from 'vitest';
import { createHttpProvider } from './provider';
import type { BenchGeneration } from './types';

// Builds a Response whose body streams the given SSE frames through a
// ReadableStream (same plumbing as src/App.test.tsx)
const sseResponse = (frames: string): Response =>
    new Response(
        new ReadableStream({
            start: (controller) => {
                controller.enqueue(new TextEncoder().encode(frames));
                controller.close();
            }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );

// Installs a fetch stub answering the completion POST with the given frames
const stubStream = (frames: string) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return sseResponse(frames);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
};

// The provider under test, bound to the stub transport
const makeProvider = (fetchImpl: typeof fetch) => createHttpProvider('test/model', { baseUrl: 'http://mock.local/v1', fetchImpl });

describe('createHttpProvider streamCompletion', () => {
    it('separates reasoning from content and signals TTFT on the FIRST chunk of either kind', async () => {
        // GLM/deepseek wire format: role-only delta → reasoning_content
        // chunks → content chunks → usage trailer → [DONE]
        const frames = [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":" harder"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" here"}}],"usage":{"prompt_tokens":3,"completion_tokens":9,"total_tokens":12}}\n\n',
            'data: [DONE]\n\n'
        ].join('');
        const { fetchImpl } = stubStream(frames);
        const provider = makeProvider(fetchImpl);

        const chunks: string[] = [];
        const generation: BenchGeneration = await provider.generate('hello', (chunk) => chunks.push(chunk));

        // Answer and chain-of-thought land in SEPARATE fields — reasoning
        // must never leak into `content` (conversation replays resend it)
        expect(generation.content).toBe('Answer here');
        expect(generation.reasoning).toBe('let me think harder');

        // onUpdate fired for BOTH kinds, in stream order — the FIRST call is
        // the reasoning chunk, which is what makes TTFT measure the true
        // first token instead of the first answer token
        expect(chunks).toEqual(['let me think', ' harder', 'Answer', ' here']);

        // Usage trailer mapped snake_case → camelCase
        expect(generation.usage).toEqual({ promptTokens: 3, completionTokens: 9, totalTokens: 12 });
    });

    it('understands the OpenRouter-style `reasoning` field the same way', async () => {
        const frames = [
            'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"final"}}]}\n\n',
            'data: [DONE]\n\n'
        ].join('');
        const { fetchImpl } = stubStream(frames);
        const provider = makeProvider(fetchImpl);

        const chunks: string[] = [];
        const generation = await provider.generate('hello', (chunk) => chunks.push(chunk));

        expect(generation.content).toBe('final');
        expect(generation.reasoning).toBe('pondering');
        expect(chunks).toEqual(['pondering', 'final']);
    });

    it('leaves plain content-only streams unchanged (no reasoning field)', async () => {
        const frames = [
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
            'data: [DONE]\n\n'
        ].join('');
        const { fetchImpl, calls } = stubStream(frames);
        const provider = makeProvider(fetchImpl);

        const chunks: string[] = [];
        const generation = await provider.generate('hello', (chunk) => chunks.push(chunk));

        expect(generation.content).toBe('hello world');
        // No reasoning key at all when the stream carried none
        expect('reasoning' in generation).toBe(false);
        expect(chunks).toEqual(['hello', ' world']);

        // The request went to the base URL's chat/completions with stream +
        // usage opt-in (the completion routing contract)
        expect(calls.length).toBe(1);
        expect(calls[0].url).toBe('http://mock.local/v1/chat/completions');
        expect(calls[0].body).toEqual(
            expect.objectContaining({ model: 'test/model', stream: true, stream_options: { include_usage: true } })
        );
    });
});
