/**
 * Wire-level tests: loopback enforcement, the bearer key, the routes, the exact
 * SSE frames Hermes parses (docs/HERMES-CLIENT-FACTS.md §3, §9), and the
 * log-scrub invariant.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EXPOSED_MODEL_IDS } from '../src/models.js';
import { loadConfig } from '../src/config.js';
import { LOG_ALLOWED_FIELDS } from '../src/log.js';
import type { FakeProgram } from '../src/fake.js';
import { buildFakePolicyProgram } from '../src/fake.js';
import { MCP_SERVER_NAME } from '../src/tool-mirror.js';
import { TEST_KEY, assistantToolCall, postSse, rawRequest, startHttpBridge, toolResult, userMessage, waitFor, type HttpBridge } from './harness.js';
import type { OpenAiChunk } from '../src/openai-types.js';

const bridges: HttpBridge[] = [];
async function bridge(options: Parameters<typeof startHttpBridge>[0] = {}): Promise<HttpBridge> {
  const started = await startHttpBridge(options);
  bridges.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(entry => entry.close()));
});

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Return the current time.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

function baseRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5',
    messages: [{ role: 'system', content: 'You are Hermes.' }, userMessage('hello')],
    ...extra,
  };
}

describe('loopback and auth', () => {
  it('serves /healthz without a key and only {ok:true}', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    const response = await rawRequest(port, { method: 'GET', path: '/healthz' });
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
  });

  it('refuses a missing key with 401 CLAUDE_BRIDGE_UNAUTHORIZED', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    const response = await rawRequest(port, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseRequest()),
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('CLAUDE_BRIDGE_UNAUTHORIZED');
  });

  it('refuses a short or wrong key with 401', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    for (const key of ['short', 'x'.repeat(60), `${TEST_KEY}x`, TEST_KEY.slice(0, -1)]) {
      const response = await rawRequest(port, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(baseRequest()),
      });
      expect(response.status, `key ${key}`).toBe(401);
    }
    // A token that is not a bearer token at all is refused too.
    const basic = await rawRequest(port, {
      headers: { 'content-type': 'application/json', authorization: `Basic ${TEST_KEY}` },
      body: JSON.stringify(baseRequest()),
    });
    expect(basic.status).toBe(401);
  });

  it('refuses a non-loopback Host header with 403', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    for (const host of ['example.com', '10.0.0.5:8123', 'evil.localhost.com', '0.0.0.0']) {
      const response = await rawRequest(port, {
        headers: { host, 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify(baseRequest()),
      });
      expect(response.status, `host ${host}`).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe('CLAUDE_BRIDGE_FORBIDDEN_HOST');
    }
    // Loopback hosts (with or without a port) are served.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, '[::1]:1']) {
      const response = await rawRequest(port, {
        headers: { host, 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify(baseRequest({ stream: false })),
      });
      expect(response.status, `host ${host}`).toBe(200);
    }
  });

  it('refuses Host lookalikes that merely contain a loopback name', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    // Every one of these was either accepted by the old substring test or is a
    // standard smuggling shape: none of them IS the loopback host.
    for (const host of [
      '127.0.0.1:8801@evil.com',
      '[::1].attacker.com',
      '127.0.0.1.evil.com',
      'localhost.attacker.com',
      '::1',
      '127.0.0.1:8801 evil.com',
      '127.0.0.1/path',
      '[::1]evil.com',
      '0.0.0.0',
    ]) {
      const response = await rawRequest(port, {
        headers: { host, 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify(baseRequest()),
      });
      expect(response.status, `host ${host}`).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe('CLAUDE_BRIDGE_FORBIDDEN_HOST');
      // The refusal names the header, never echoes more than the value itself.
      expect(response.body).toContain('Host header');
    }
  });

  it('refuses a non-loopback Origin with 403', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    const response = await rawRequest(port, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_KEY}`,
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify(baseRequest()),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('CLAUDE_BRIDGE_FORBIDDEN_HOST');

    const ok = await rawRequest(port, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_KEY}`,
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify(baseRequest()),
    });
    expect(ok.status).toBe(200);
  });

  it('refuses Origin lookalikes too, including a sandboxed `null` origin', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    for (const origin of [
      'http://127.0.0.1:8801@evil.com',
      'http://localhost.attacker.com',
      'http://127.0.0.1.evil.com',
      'http://evil.com@127.0.0.1',
      'null',
      'file:///tmp/x',
    ]) {
      const response = await rawRequest(port, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}`, origin },
        body: JSON.stringify(baseRequest()),
      });
      expect(response.status, `origin ${origin}`).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe('CLAUDE_BRIDGE_FORBIDDEN_HOST');
      expect(response.body).toContain('Origin header');
    }
  });

  it('lists the exposed model ids on GET /v1/models', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    const response = await rawRequest(port, {
      method: 'GET',
      path: '/v1/models',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe('list');
    expect(body.data.map((entry: { id: string }) => entry.id)).toEqual([...EXPOSED_MODEL_IDS]);
  });

  it('404s unknown routes and 405s wrong methods', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    const notFound = await rawRequest(port, {
      method: 'GET',
      path: '/v1/nope',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(notFound.status).toBe(404);
    const wrongMethod = await rawRequest(port, {
      method: 'GET',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(wrongMethod.status).toBe(405);
  });
});

describe('the SSE stream Hermes parses', () => {
  it('emits well-formed chat.completion.chunk frames and the [DONE] sentinel', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'Hello over the wire.' }]] });
    const result = await postSse(port, baseRequest({ stream: true, stream_options: { include_usage: true } }));

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/event-stream');
    // Every frame is `data: <payload>`; the sentinel comes last.
    for (const frame of result.frames.slice(0, -1)) expect(frame).toMatch(/^data: \{/);
    expect(result.frames.at(-1)).toBe('data: [DONE]');
    expect(result.sawDone).toBe(true);
    expect(result.raw.endsWith('data: [DONE]\n\n')).toBe(true);

    const chunks = result.chunks as OpenAiChunk[];
    for (const chunk of chunks) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(typeof chunk.id).toBe('string');
      expect(typeof chunk.created).toBe('number');
      expect(chunk.model).toBe('claude-sonnet-5');
      expect(Array.isArray(chunk.choices)).toBe(true);
    }
    expect(result.text).toBe('Hello over the wire.');

    // Hermes requires a non-null finish_reason on the terminal choice chunk.
    const terminal = chunks.filter(chunk => chunk.choices.length > 0 && chunk.choices[0]?.finish_reason !== null);
    expect(terminal).toHaveLength(1);
    expect(['stop', 'tool_calls', 'length', 'content_filter']).toContain(terminal[0]?.choices[0]?.finish_reason);

    // The choiceless usage chunk.
    const usageChunk = chunks.find(chunk => chunk.usage !== undefined);
    expect(usageChunk?.choices).toEqual([]);
    expect(typeof usageChunk?.usage?.prompt_tokens).toBe('number');
    expect(typeof usageChunk?.usage?.completion_tokens).toBe('number');
    expect(typeof usageChunk?.usage?.total_tokens).toBe('number');
  });

  it('streams tool_calls deltas that reassemble exactly as Hermes does', async () => {
    const program: FakeProgram = [
      [{ kind: 'toolCalls', calls: [{ name: `mcp__${MCP_SERVER_NAME}__get_time`, args: { zone: 'UTC' } }] }],
      [{ kind: 'toolEcho' }],
    ];
    const { port } = await bridge({ program });
    const result = await postSse(port, baseRequest({ tools: TOOLS, stream: true }));

    const chunks = result.chunks as OpenAiChunk[];
    // Accumulate the way Hermes' _ToolCallAccumulator does: names assigned,
    // arguments concatenated, and never a JSON object.
    const slots = new Map<number, { id: string; name: string; args: string }>();
    for (const chunk of chunks) {
      for (const delta of chunk.choices[0]?.delta.tool_calls ?? []) {
        const entry = slots.get(delta.index) ?? { id: '', name: '', args: '' };
        if (delta.id !== undefined) entry.id = delta.id;
        if (delta.function?.name !== undefined) entry.name = delta.function.name;
        if (delta.function?.arguments !== undefined) {
          expect(typeof delta.function.arguments).toBe('string');
          entry.args += delta.function.arguments;
        }
        if (delta.type !== undefined) expect(delta.type).toBe('function');
        slots.set(delta.index, entry);
      }
    }
    expect(slots.size).toBe(1);
    const call = slots.get(0);
    expect(call?.id.startsWith('call_')).toBe(true);
    expect(call?.name).toBe('get_time');
    expect(JSON.parse(call?.args ?? '{}')).toEqual({ zone: 'UTC' });

    // No provider-error finish reasons, ever.
    for (const chunk of chunks) {
      const reason = chunk.choices[0]?.finish_reason;
      expect(['error', 'error_finish']).not.toContain(reason);
    }
    expect(chunks.some(chunk => chunk.choices[0]?.finish_reason === 'tool_calls')).toBe(true);

    // Resume over the wire and check the new stream is a fresh, complete one.
    const resumed = await postSse(
      port,
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('hello'),
          assistantToolCall([{ id: call?.id ?? '', name: 'get_time', args: call?.args ?? '{}' }]),
          toolResult(call?.id ?? '', '12:00'),
        ],
      }),
    );
    expect(resumed.text).toContain('12:00');
    expect(resumed.sawDone).toBe(true);
  });

  it('answers non-streaming requests with a chat.completion envelope', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'Not streamed.' }]] });
    const response = await rawRequest(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify(baseRequest()),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('Not streamed.');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(18);
  });

  it('returns a real HTTP status for a pre-stream failure', async () => {
    const { port } = await bridge({ program: [[{ kind: 'silent' }]], config: { stallWatchdogMs: 100 } });
    const response = await rawRequest(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify(baseRequest({ stream: true })),
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe('CLAUDE_BRIDGE_STALL');
  });

  it('returns 400 for an unknown model and for a malformed body', async () => {
    const { port } = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    const unknown = await rawRequest(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify(baseRequest({ tools: TOOLS, model: 'not-a-model' })),
    });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error.code).toBe('model_not_found');

    const malformed = await rawRequest(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: '{"messages": [',
    });
    expect(malformed.status).toBe(400);

    const empty = await rawRequest(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
    });
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body).error.code).toBe('CLAUDE_BRIDGE_BAD_REQUEST');
  });
});

describe('log scrubbing', () => {
  const CANARY_TEXT = 'CANARY_TEXT_ABCDEF0123456789';
  const CANARY_TOOL = 'CANARY_TOOL_ZZZZ9999';

  it('never writes message text, tool arguments or tool results to the log', async () => {
    const program: FakeProgram = [
      [
        {
          kind: 'toolCalls',
          calls: [{ name: `mcp__${MCP_SERVER_NAME}__${CANARY_TOOL}`, args: { secret: CANARY_TEXT } }],
        },
      ],
      [{ kind: 'toolEcho' }],
    ];
    const started = await bridge({ program });
    const tools = [
      {
        type: 'function',
        function: {
          name: CANARY_TOOL,
          description: `Tool description with ${CANARY_TEXT}`,
          parameters: { type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'] },
        },
      },
    ];
    const first = await postSse(started.port, baseRequest({ tools, stream: true }));
    const call = ((first.chunks as OpenAiChunk[])
      .flatMap(chunk => chunk.choices[0]?.delta.tool_calls ?? [])
      .find(delta => delta.id !== undefined)?.id ?? '');
    expect(call.startsWith('call_')).toBe(true);

    await postSse(
      started.port,
      baseRequest({
        tools,
        stream: true,
        messages: [
          { role: 'system', content: `System prompt ${CANARY_TEXT}` },
          userMessage(`User message ${CANARY_TEXT}`),
          assistantToolCall([{ id: call, name: CANARY_TOOL, args: JSON.stringify({ secret: CANARY_TEXT }) }]),
          toolResult(call, `Tool result ${CANARY_TEXT}`),
        ],
      }),
    );

    await waitFor(() => started.pipeline.logLines.length > 5, 2000, 'log lines');
    const log = started.pipeline.logLines.join('\n');
    expect(log).not.toContain(CANARY_TEXT);
    expect(log).not.toContain(CANARY_TOOL);
    // Every line is JSON with only allowlisted keys (plus ts/event).
    for (const line of started.pipeline.logLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(key === 'ts' || key === 'event' || LOG_ALLOWED_FIELDS.has(key), `field ${key}`).toBe(true);
      }
      expect(typeof parsed.event).toBe('string');
    }
    // The log still says something useful: outcomes and counts.
    expect(log).toContain('cold_start');
    expect(log).toContain('request_ok');
  });

  it('drops a canary that arrives through an allowlisted field name', async () => {
    // `model` is an allowlisted field, but a value with prose in it is dropped.
    const started = await bridge({ program: [[{ kind: 'text', text: 'x' }]] });
    await rawRequest(started.port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify({ model: `claude-sonnet-5 ${CANARY_TEXT}`, messages: [userMessage('hi')] }),
    });
    expect(started.pipeline.logLines.join('\n')).not.toContain(CANARY_TEXT);
  });

  it('drops a credential-shaped value reported by the CLI in a constrained field', async () => {
    // A token shaped like the generic machine-token allowlist, which the old
    // value filter would have logged verbatim through `apiKeySource`.
    const credential = 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const started = await bridge({
      program: [[{ kind: 'text', text: 'x' }]],
      fakeOptions: { apiKeySource: credential },
    });
    await postSse(started.port, baseRequest({ stream: true }));
    await waitFor(
      () => started.pipeline.logLines.some(line => line.includes('cli_init')),
      2000,
      'cli_init log line',
    );
    const log = started.pipeline.logLines.join('\n');
    expect(log).not.toContain(credential);
    expect(log).not.toContain('sk-ant-');
    // The line still exists and still carries the counts it is for.
    const init = started.pipeline.logLines.find(line => line.includes('cli_init')) ?? '';
    expect(JSON.parse(init).apiKeySource).toBeUndefined();
    expect(typeof JSON.parse(init).toolCount).toBe('number');
  });
});

describe('--fake policy mode', () => {
  it('performs a real tool round trip with no real binary', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather.',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: [] },
        },
      },
    ];
    const program = buildFakePolicyProgram([
      { mcpName: 'get_weather', description: 'Get the weather.', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: [] } },
    ]);
    const started = await bridge({ program });
    const first = await postSse(started.port, baseRequest({ tools, stream: true }));
    const chunks = first.chunks as OpenAiChunk[];
    const deltas = chunks.flatMap(chunk => chunk.choices[0]?.delta.tool_calls ?? []);
    const callId = deltas.find(delta => delta.id !== undefined)?.id;
    expect(callId).toBeTruthy();
    const name = deltas.map(delta => delta.function?.name ?? '').join('');
    expect(name).toBe('get_weather');

    const second = await postSse(
      started.port,
      baseRequest({
        tools,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('hello'),
          assistantToolCall([{ id: callId ?? '', name: 'get_weather', args: '{}' }]),
          toolResult(callId ?? '', 'sunny, 24C'),
        ],
      }),
    );
    expect(second.text).toContain('sunny, 24C');
    expect(second.sawDone).toBe(true);
  });
});

describe('request body size cap', () => {
  it('refuses an oversized body with 413 CLAUDE_BRIDGE_BODY_TOO_LARGE while still reading, without buffering past the cap', async () => {
    const { port } = await bridge({
      program: [[{ kind: 'text', text: 'x' }]],
      config: { maxBodyBytes: 1024 },
    });
    const oversized = 'a'.repeat(4096);
    const response = await rawRequest(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: oversized,
    });
    expect(response.status).toBe(413);
    const parsed = JSON.parse(response.body) as { error: { code: string; type: string } };
    expect(parsed.error.code).toBe('CLAUDE_BRIDGE_BODY_TOO_LARGE');
    expect(parsed.error.type).toBe('invalid_request_error');
  });

  it('accepts a body at or under the configured cap', async () => {
    const { port } = await bridge({ config: { maxBodyBytes: 1024 * 1024 } });
    const response = await postSse(port, baseRequest());
    expect(response.status).toBe(200);
  });

  it('defaults the cap to 64 MiB when CLAUDE_BRIDGE_MAX_BODY_BYTES is unset', () => {
    const config = loadConfig({ env: { CLAUDE_BRIDGE_KEY: TEST_KEY }, argv: [] });
    expect(config.maxBodyBytes).toBe(64 * 1024 * 1024);
  });

  it('honours CLAUDE_BRIDGE_MAX_BODY_BYTES from the environment', () => {
    const config = loadConfig({ env: { CLAUDE_BRIDGE_KEY: TEST_KEY, CLAUDE_BRIDGE_MAX_BODY_BYTES: '2048' }, argv: [] });
    expect(config.maxBodyBytes).toBe(2048);
  });
});
