// dashboard/scenarios/tool-fixtures.ts — shared deterministic TOOL-CALLING
// fixtures for the tool-call scenario family.
//
// TOOL-CALLING BENCHMARKS: the bench engine's BenchProvider.generate is a
// plain single-prompt streaming transport (see core/types.ts:59-81) with no
// native tool schema channel — so the tool definitions are embedded INTO the
// prompt as a JSON schema block and the model is asked to answer with a raw
// JSON tool call. This measures exactly what a tool-calling probe needs:
//   - INSTRUCTION FOLLOWING: can the model emit syntactically valid JSON
//     matching the demanded schema instead of prose?
//   - LATENCY SHAPE: emitting a short structured payload keeps TTFT +
//     decode timing comparable to the summarization probe, while the fixed
//     schema block inflates the prompt (prefill) side.
//   - SELECTION / ARG FILLING: the variants differ in HOW MANY tools are
//     offered and how MANY arguments the chosen call must carry.
//
// Every fixture is a pure string build (no randomness) so the exact prompt
// is assertable in tests, and every model receives the identical payload —
// the same fixed-input convention as summarization.ts.
//
// STANDALONE: consumed only by the scenario modules in this folder. Adding
// another tool-call variant = one fixture builder here + one scenario file.

// The exact expected tool call for the weather fixture — exported so tests
// (and future scorers) can compare the model's answer against the canonical
// JSON deterministically.
export const WEATHER_EXPECTED_CALL =
    '{"name": "get_weather", "arguments": {"city": "Tokyo", "unit": "celsius"}}';

// The exact expected tool call for the calendar fixture (the parallel
// probe's primary tool) — canonical order: name first, arguments after.
export const CALENDAR_EXPECTED_CALL =
    '{"name": "create_event", "arguments": {"title": "Design review", "date": "2026-09-15", "time": "14:00"}}';

// The exact expected tool call for the shipment fixture (the narrow-args
// probe): all five required slots filled from the user request — enums
// lowercased per the schema, the weight as a bare number, the strict date.
export const SHIPMENT_EXPECTED_CALL =
    '{"name": "schedule_shipment", "arguments": {"carrier": "fedex", "service": "overnight", "weightKg": 3.5, "pickupDate": "2026-10-02", "address": "12 Orchard Lane, Springfield"}}';

// ── Fixture tool schemas ─────────────────────────────────────────────────────
// Rendered into the prompt as a compact JSON array. Field ORDER inside the
// objects is part of the prompt text (asserted exactly in tests), so keep
// these literals stable.

// The SINGLE-tool fixture: selection is trivial; the probe isolates
// structured-argument emission (2 required args + 1 enum'd optional).
export const WEATHER_TOOL = {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
        type: 'object',
        properties: {
            city: { type: 'string', description: 'City name, e.g. "Tokyo"' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' }
        },
        required: ['city', 'unit']
    }
};

// The PARALLEL fixture's first tool — the one the probe steers the model to
// call (title + ISO date + HH:MM time).
export const CALENDAR_TOOL = {
    name: 'create_event',
    description: 'Create a calendar event with a title, date and time.',
    parameters: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Event title' },
            date: { type: 'string', description: 'Event date as YYYY-MM-DD' },
            time: { type: 'string', description: 'Start time as HH:MM (24h)' }
        },
        required: ['title', 'date', 'time']
    }
};

// The PARALLEL fixture's decoy tools — padding the offered set so the model
// must DISCRIMINATE among three tools rather than echo the only one.
export const REMINDER_TOOL = {
    name: 'set_reminder',
    description: 'Schedule a one-off reminder that fires after a delay.',
    parameters: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'Reminder text' },
            delayMinutes: { type: 'number', description: 'Minutes from now' }
        },
        required: ['message', 'delayMinutes']
    }
};

export const SEARCH_TOOL = {
    name: 'web_search',
    description: 'Search the web and return the top results for a query.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The search query' },
            maxResults: { type: 'number', description: 'Maximum number of results to return' }
        },
        required: ['query', 'maxResults']
    }
};

// The NARROW-ARGS fixture's tool — FIVE required args with restrictive
// formats/enums, the arg-filling stress variant.
export const SHIPMENT_TOOL = {
    name: 'schedule_shipment',
    description: 'Book a parcel pickup with full shipping details.',
    parameters: {
        type: 'object',
        properties: {
            carrier: { type: 'string', enum: ['dhl', 'fedex', 'ups'], description: 'Carrier code' },
            service: { type: 'string', enum: ['standard', 'express', 'overnight'], description: 'Service level' },
            weightKg: { type: 'number', description: 'Parcel weight in kilograms' },
            pickupDate: { type: 'string', description: 'Pickup date as YYYY-MM-DD' },
            address: { type: 'string', description: 'Full pickup address, street and number included' }
        },
        required: ['carrier', 'service', 'weightKg', 'pickupDate', 'address']
    }
};

// ── The response contract (shared instruction suffix) ────────────────────────
// Identical across every tool variant so the variants differ ONLY in the
// offered tool set — latency deltas between scenarios are then attributable
// to schema size + arg count, not wording.

// JSON-only response demand (verbatim suffix of every tool prompt)
export const TOOL_RESPONSE_INSTRUCTION =
    'Respond with ONLY a single line of raw JSON — no markdown, no code fences, no commentary.';

// The exact per-variant instruction line that names the tool to call (the
// steering sentence differs per scenario; keeping it next to the fixtures
// makes prompt + expectation co-located and test-assertable).
export const weatherCallInstruction = 'The user asks about the weather in Tokyo.';
export const calendarCallInstruction =
    'The user says: "Set up a design review for September 15, 2026 at 2 in the afternoon."';
export const shipmentCallInstruction =
    'The user says: "Book an overnight FedEx pickup for a 3.5 kg parcel on October 2, 2026 at 12 Orchard Lane, Springfield."';

/**
 * Builds the exact prompt for one tool-calling iteration.
 *
 * Shape (deterministic, newline-exact):
 *   # Tools (JSON array of the offered schemas)
 *   <json>
 *   <call instruction — which tool to invoke for the user's request>
 *   Call the correct tool and fill ALL required arguments with concrete
 *   values from the user's message. <response contract>
 *
 * @param tools       - The offered tool schemas (rendered in array order).
 * @param instruction - The steering sentence naming the tool to call.
 */
export const buildToolPrompt = (tools: Array<Record<string, unknown>>, instruction: string): string =>
    [
        '# Tools',
        JSON.stringify(tools),
        instruction,
        'Call the correct tool and fill ALL required arguments with concrete values from the user\'s message. ' + TOOL_RESPONSE_INSTRUCTION
    ].join('\n');

// The three prebuilt canonical prompts (each scenario embeds one of these so
// the fixtures and the scenario spec stay in lockstep).
export const WEATHER_PROMPT = buildToolPrompt([WEATHER_TOOL], weatherCallInstruction);
export const CALENDAR_PROMPT = buildToolPrompt(
    [CALENDAR_TOOL, REMINDER_TOOL, SEARCH_TOOL],
    calendarCallInstruction
);
export const SHIPMENT_PROMPT = buildToolPrompt([SHIPMENT_TOOL], shipmentCallInstruction);
