/**
 * Phase 3 failure paths. Every case asserts the exact HTTP status + structured
 * error code AND that the process group and the private temp dir are gone.
 */

import { existsSync } from 'node:fs';

import { describe, expect, it, afterEach } from 'vitest';

import { FakeClock, Pipeline, RecordingSink, assistantToolCall, toolResult, userMessage, waitFor } from './harness.js';
import type { FakeProgram } from '../src/fake.js';
import { MCP_SERVER_NAME } from '../src/tool-mirror.js';

const pipelines: Pipeline[] = [];
function pipeline(options: ConstructorParameters<typeof Pipeline>[0] = {}): Pipeline {
  const created = new Pipeline(options);
  pipelines.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(pipelines.splice(0).map(entry => entry.shutdown()));
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

/** Every teardown must leave the group killed and the private cwd removed. */
async function expectTornDown(bridge: Pipeline, index = 0): Promise<void> {
  const process = bridge.created[index];
  expect(process).toBeDefined();
  await waitFor(() => process?.state === 'disposed', 3000, 'process to dispose');
  await waitFor(() => process?.tempDirExists === false, 3000, 'temp dir removal');
  expect(process?.tempDirExists).toBe(false);
  expect(existsSync(process?.tempDir ?? '/nonexistent')).toBe(false);
  const groupKills = bridge.groupKills.filter(kill => kill.scope === 'group');
  expect(groupKills.length).toBeGreaterThan(0);
  expect(groupKills.map(kill => kill.signal)).toContain('SIGTERM');
}

describe('stall watchdog', () => {
  it('answers 503 CLAUDE_BRIDGE_STALL when Claude goes silent and tears the group down', async () => {
    const bridge = pipeline({
      program: [[{ kind: 'silent' }]],
      config: { stallWatchdogMs: 120 },
    });
    const result = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(result.error?.status).toBe(503);
    expect(result.error?.code).toBe('CLAUDE_BRIDGE_STALL');
    expect(result.error?.type).toBe('rate_limit_or_stall');
    // Nothing was written to the client: the failure was a real HTTP status.
    expect(result.chunks).toHaveLength(0);
    await expectTornDown(bridge);
  });

  it('reports the stall rather than hanging when the process never emits anything', async () => {
    const bridge = pipeline({ program: [[]], config: { stallWatchdogMs: 100 } });
    const started = Date.now();
    const result = await bridge.post(baseRequest({ tools: TOOLS }));
    // An empty program still emits its `result`, so this is a normal turn...
    // unless the watchdog fires first. Either way the request must terminate.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.error === undefined || result.error.code === 'CLAUDE_BRIDGE_STALL').toBe(true);
  });
});

describe('authentication', () => {
  it('answers 503 CLAUDE_BRIDGE_NOT_SIGNED_IN on an authentication_failed assistant frame', async () => {
    const bridge = pipeline({ program: [[{ kind: 'assistantError', error: 'authentication_failed' }]] });
    const result = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(result.error?.status).toBe(503);
    expect(result.error?.code).toBe('CLAUDE_BRIDGE_NOT_SIGNED_IN');
    expect(result.error?.message).toContain('run claude once in a terminal and sign in');
    await expectTornDown(bridge);
  });

  it('answers 401 on CLI auth evidence in a failed result', async () => {
    const bridge = pipeline({
      program: [
        [
          {
            kind: 'resultError',
            subtype: 'error_during_execution',
            result: 'Invalid API key · Please run /login',
          },
        ],
      ],
    });
    const result = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(result.error?.status).toBe(503);
    expect(result.error?.code).toBe('CLAUDE_BRIDGE_NOT_SIGNED_IN');
    await expectTornDown(bridge);
  });

  it('never starts a sign-in flow and never parses a credential', async () => {
    const bridge = pipeline({ program: [[{ kind: 'authStatus', error: 'not logged in' }]] });
    const result = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(result.error?.status).toBe(503);
    expect(result.error?.code).toBe('CLAUDE_BRIDGE_NOT_SIGNED_IN');
  });
});

describe('context overflow', () => {
  it('answers 400 context_length_exceeded on Claude prompt-too-long evidence', async () => {
    const bridge = pipeline({
      program: [
        [
          {
            kind: 'resultError',
            subtype: 'error_during_execution',
            result: 'Prompt is too long: 250000 tokens > 200000 maximum',
          },
        ],
      ],
    });
    const result = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(result.error?.status).toBe(400);
    expect(result.error?.code).toBe('context_length_exceeded');
    expect(result.error?.type).toBe('invalid_request_error');
    expect(result.error?.message).toMatch(/context length/i);
    await expectTornDown(bridge);
  });

  it('answers 400 on the prompt_too_long terminal reason', async () => {
    const bridge = pipeline({
      program: [
        [
          {
            kind: 'resultError',
            subtype: 'error_during_execution',
            result: 'turn failed',
            terminalReason: 'prompt_too_long',
          },
        ],
      ],
    });
    const result = await bridge.post(baseRequest({ tools: TOOLS }));
    expect(result.error?.status).toBe(400);
    expect(result.error?.code).toBe('context_length_exceeded');
  });
});

describe('client disconnect', () => {
  it('kills the process when nothing is parked for the response', async () => {
    const bridge = pipeline({ program: [[{ kind: 'silent' }]], config: { stallWatchdogMs: 60_000 } });
    const sink = new RecordingSink(true);
    const pending = bridge.post(baseRequest({ tools: TOOLS, stream: true }), { sink });
    await waitFor(() => bridge.created.length === 1, 2000, 'process creation');
    expect(bridge.created[0]?.tempDirExists).toBe(true);
    sink.disconnect();
    await pending;
    await expectTornDown(bridge);
  });

  it('keeps the process alive when calls are parked for that response', async () => {
    const bridge = pipeline({
      program: [
        [{ kind: 'toolCalls', calls: [{ name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} }] }],
        [{ kind: 'toolEcho' }],
      ],
    });
    const first = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    const call = first.sink.toolCalls[0];
    expect(call).toBeDefined();

    const process = bridge.created[0];
    expect(process?.parkedCount).toBe(1);
    // The socket drops after the response: parked calls must survive it.
    process?.onClientGone();
    expect(process?.state).toBe('parked');
    expect(process?.tempDirExists).toBe(true);

    // ...and Hermes can still answer the parked call afterwards.
    const second = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('hello'),
          assistantToolCall([{ id: call?.id ?? '', name: 'get_time', args: '{}' }]),
          toolResult(call?.id ?? '', '12:00'),
        ],
      }),
    );
    expect(second.error).toBeUndefined();
    expect(second.sink.text).toContain('12:00');
    expect(bridge.queryCallCount).toBe(1);
  });
});

describe('capacity', () => {
  it('answers 429 with Retry-After when the process cap is reached', async () => {
    const parkedProgram: FakeProgram = [
      [
        {
          kind: 'toolCalls',
          calls: [
            { name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} },
          ],
        },
      ],
      [{ kind: 'toolEcho' }],
    ];
    const bridge = pipeline({ program: parkedProgram, config: { maxProcs: 2 } });

    for (let i = 0; i < 2; i += 1) {
      const result = await bridge.post(
        baseRequest({
          tools: TOOLS,
          stream: true,
          messages: [{ role: 'system', content: 'You are Hermes.' }, userMessage(`conversation ${i}`)],
        }),
      );
      expect(result.error).toBeUndefined();
      expect(result.sink.finishReasons).toEqual(['tool_calls']);
    }
    expect(bridge.queryCallCount).toBe(2);

    const refused = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [{ role: 'system', content: 'You are Hermes.' }, userMessage('conversation 3')],
      }),
    );
    expect(refused.error?.status).toBe(429);
    expect(refused.error?.code).toBe('CLAUDE_BRIDGE_MAX_PROCS');
    expect(refused.error?.headers['retry-after']).toBe('5');
    expect(bridge.queryCallCount).toBe(2);
  });
});

describe('parked-call timeout', () => {
  it('answers 504 CLAUDE_BRIDGE_PARKED_TIMEOUT and tears the process down when the deadline passed', async () => {
    const clock = new FakeClock();
    const bridge = pipeline({
      clock,
      program: [
        [{ kind: 'toolCalls', calls: [{ name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} }] }],
        [{ kind: 'toolEcho' }],
      ],
      config: { parkedCallTimeoutMs: 1000, stallWatchdogMs: 60_000 },
    });

    const firstPending = bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    await waitFor(() => bridge.created.length === 1, 2000, 'process creation');
    await clock.advance(200);
    const first = await firstPending;
    const call = first.sink.toolCalls[0];
    expect(call).toBeDefined();

    // Time passes past the parked deadline while Hermes is still deciding.
    clock.skew(2000);

    const late = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('hello'),
          assistantToolCall([{ id: call?.id ?? '', name: 'get_time', args: '{}' }]),
          toolResult(call?.id ?? '', '12:00'),
        ],
      }),
    );
    expect(late.error?.status).toBe(504);
    expect(late.error?.code).toBe('CLAUDE_BRIDGE_PARKED_TIMEOUT');
    await expectTornDown(bridge);
  });

  it('disposes the process when the parked timer fires, and a later request cold starts', async () => {
    const clock = new FakeClock();
    const bridge = pipeline({
      clock,
      program: (_input, index) => (index === 0 ? parkedOnce() : [[{ kind: 'text', text: 'cold' }]]),
      config: { parkedCallTimeoutMs: 1000, stallWatchdogMs: 60_000 },
    });

    const firstPending = bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    await waitFor(() => bridge.created.length === 1, 2000, 'process creation');
    await clock.advance(200);
    const first = await firstPending;
    expect(first.sink.finishReasons).toEqual(['tool_calls']);

    await clock.advance(1500);
    await expectTornDown(bridge);

    const later = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(later.error).toBeUndefined();
    expect(later.sink.text).toBe('cold');
    expect(bridge.queryCallCount).toBe(2);
  });
});

describe('partial tool-result batches (SPEC.md: "not a guess")', () => {
  const TWO_TOOLS = [
    ...TOOLS,
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  ];

  function parallelParkedProgram(): FakeProgram {
    return [
      [
        {
          kind: 'toolCalls',
          calls: [
            { name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} },
            { name: `mcp__${MCP_SERVER_NAME}__read_file`, args: { path: '/tmp/x' } },
          ],
        },
      ],
      [{ kind: 'toolEcho' }],
    ];
  }

  function partialRequest(ids: { first: string; second: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return baseRequest({
      tools: TWO_TOOLS,
      stream: true,
      messages: [
        { role: 'system', content: 'You are Hermes.' },
        userMessage('read it'),
        assistantToolCall([
          { id: ids.first, name: 'get_time', args: '{}' },
          { id: ids.second, name: 'read_file', args: '{"path":"/tmp/x"}' },
        ]),
        toolResult(ids.first, '12:00'),
      ],
      ...extra,
    });
  }

  function fullRequest(ids: { first: string; second: string }): Record<string, unknown> {
    return baseRequest({
      tools: TWO_TOOLS,
      stream: true,
      messages: [
        { role: 'system', content: 'You are Hermes.' },
        userMessage('read it'),
        assistantToolCall([
          { id: ids.first, name: 'get_time', args: '{}' },
          { id: ids.second, name: 'read_file', args: '{"path":"/tmp/x"}' },
        ]),
        toolResult(ids.first, '12:00'),
        toolResult(ids.second, 'contents'),
      ],
    });
  }

  it('refuses a partial batch as 409 without cold-starting, and the missing id still expires into the parked-timeout failure', async () => {
    const clock = new FakeClock();
    const bridge = pipeline({
      clock,
      program: parallelParkedProgram(),
      config: { parkedCallTimeoutMs: 1000, stallWatchdogMs: 60_000 },
    });

    const firstPending = bridge.post(baseRequest({ tools: TWO_TOOLS, stream: true }));
    await waitFor(() => bridge.created.length === 1, 2000, 'process creation');
    await clock.advance(200);
    const first = await firstPending;
    const calls = first.sink.toolCalls;
    expect(calls).toHaveLength(2);
    const ids = { first: calls[0]?.id ?? '', second: calls[1]?.id ?? '' };

    // Only ONE of the two parked ids comes back: refused, not guessed at, and
    // NOT a cold start (a new process would have been a silent wrong answer).
    const partial = await bridge.post(partialRequest(ids));
    expect(partial.error?.status).toBe(409);
    expect(partial.error?.code).toBe('CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS');
    expect(bridge.queryCallCount).toBe(1);
    expect(bridge.created).toHaveLength(1);
    // The parked call is still parked: its deadline is what decides its fate.
    expect(bridge.created[0]?.state).toBe('parked');
    expect(bridge.created[0]?.parkedCount).toBe(2);

    // Time passes past that deadline WITHOUT the timer firing: a later request
    // that does carry the whole batch gets the parked-timeout failure.
    clock.skew(2000);
    const late = await bridge.post(fullRequest(ids));
    expect(late.error?.status).toBe(504);
    expect(late.error?.code).toBe('CLAUDE_BRIDGE_PARKED_TIMEOUT');
    expect(bridge.queryCallCount).toBe(1);
    await expectTornDown(bridge);
  });

  it('gives the same refusal when a partial batch references ids held by nobody', async () => {
    const bridge = pipeline({ program: parallelParkedProgram() });
    const first = await bridge.post(baseRequest({ tools: TWO_TOOLS, stream: true }));
    const calls = first.sink.toolCalls;
    const ids = { first: calls[0]?.id ?? '', second: calls[1]?.id ?? '' };

    const partial = await bridge.post(partialRequest(ids));
    expect(partial.error?.code).toBe('CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS');
    // Repeated: still refused, still no new process (never a silent cold start).
    const again = await bridge.post(partialRequest(ids));
    expect(again.error?.code).toBe('CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS');
    expect(bridge.queryCallCount).toBe(1);
    expect(bridge.created[0]?.parkedCount).toBe(2);

    // The complete batch that follows still resumes the SAME process.
    const resumed = await bridge.post(fullRequest(ids));
    expect(resumed.error).toBeUndefined();
    expect(resumed.sink.finishReasons).toEqual(['stop']);
    expect(bridge.queryCallCount).toBe(1);
    expect(bridge.factory.toolResults).toHaveLength(2);
  });

  it('refuses every id multiset that is not exactly the parked set, and leaves the parked process alive', async () => {
    const bridge = pipeline({ program: parallelParkedProgram() });
    const first = await bridge.post(baseRequest({ tools: TWO_TOOLS, stream: true }));
    const calls = first.sink.toolCalls;
    expect(calls).toHaveLength(2);
    const ids = { first: calls[0]?.id ?? '', second: calls[1]?.id ?? '' };
    const parked = bridge.created[0];
    expect(parked?.parkedCount).toBe(2);

    // SPEC.md's "all ids of one assistant turn must come back" is an EXACT-set
    // rule. `[A,A]` used to count as two matches against a two-call turn, so the
    // lookup said "found", the resume path threw on the duplicate id, and the
    // failure handler disposed and forgot the live parked process — a 500 that
    // destroyed a conversation waiting on a human. Every deviation below must be
    // the bridge's 409 instead, with the parked process untouched.
    const deviations: ReadonlyArray<{ label: string; carried: readonly string[] }> = [
      { label: '[A,A] against parked {A,B} (repeated id)', carried: [ids.first, ids.first] },
      { label: '[A,B,B] (repeated id)', carried: [ids.first, ids.second, ids.second] },
      { label: '[A] (subset)', carried: [ids.first] },
      { label: '[A,B,X] (superset with an unknown id)', carried: [ids.first, ids.second, 'call_0000000000000000'] },
    ];

    for (const { label, carried } of deviations) {
      const result = await bridge.post(
        baseRequest({
          tools: TWO_TOOLS,
          stream: true,
          messages: [
            { role: 'system', content: 'You are Hermes.' },
            userMessage('read it'),
            assistantToolCall([
              { id: ids.first, name: 'get_time', args: '{}' },
              { id: ids.second, name: 'read_file', args: '{"path":"/tmp/x"}' },
            ]),
            ...carried.map((id, index) => toolResult(id, `result-${index}`)),
          ],
        }),
      );
      expect(result.error?.status, label).toBe(409);
      expect(result.error?.code, label).toBe('CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS');
      expect(result.sink.text, label).toBe('');
      expect(result.sink.toolCalls, label).toEqual([]);
      // Never a resume (the same single process served the turn) and never a
      // cold start (no second process exists).
      expect(bridge.queryCallCount, label).toBe(1);
      expect(bridge.created, label).toHaveLength(1);
      // Never disposed, never forgotten: still parked, still holding both calls,
      // its temp dir intact, no group kill, and the delivered results discarded.
      expect(parked?.state, label).toBe('parked');
      expect(parked?.parkedCount, label).toBe(2);
      expect(parked?.tempDirExists, label).toBe(true);
      expect(bridge.groupKills, label).toEqual([]);
      expect(bridge.factory.toolResults, label).toEqual([]);
      expect(bridge.logLines.join('\n'), label).toContain('partial_tool_results_refused');
    }

    // The process survived all four: the exact set still resumes it.
    const resumed = await bridge.post(fullRequest(ids));
    expect(resumed.error).toBeUndefined();
    expect(resumed.sink.finishReasons).toEqual(['stop']);
    expect(bridge.queryCallCount).toBe(1);
    expect(bridge.factory.toolResults).toHaveLength(2);
  });

  it('refuses ids that span two parked turns, and neither parked process is touched', async () => {
    const bridge = pipeline({
      program: (_input, index) => (index <= 1 ? parkedOnce() : [[{ kind: 'text', text: 'cold' }]]),
    });

    // Two independent conversations, each holding one parked call of its own.
    const first = await bridge.post(
      baseRequest({ tools: TOOLS, stream: true, messages: [{ role: 'system', content: 'You are Hermes.' }, userMessage('one')] }),
    );
    const second = await bridge.post(
      baseRequest({ tools: TOOLS, stream: true, messages: [{ role: 'system', content: 'You are Hermes.' }, userMessage('two')] }),
    );
    expect(first.sink.finishReasons).toEqual(['tool_calls']);
    expect(second.sink.finishReasons).toEqual(['tool_calls']);
    const idA = first.sink.toolCalls[0]?.id ?? '';
    const idB = second.sink.toolCalls[0]?.id ?? '';
    expect(idA).not.toBe(idB);
    expect(bridge.created).toHaveLength(2);
    expect(bridge.created[0]?.parkedCount).toBe(1);
    expect(bridge.created[1]?.parkedCount).toBe(1);

    // One result for each turn: two live turns are involved and neither turn's
    // id set is complete, so this is a mismatch, not a resume of either.
    const mixed = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('mixed'),
          toolResult(idA, 'a'),
          toolResult(idB, 'b'),
        ],
      }),
    );
    expect(mixed.error?.status).toBe(409);
    expect(mixed.error?.code).toBe('CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS');
    expect(bridge.queryCallCount).toBe(2);
    expect(bridge.created).toHaveLength(2);
    for (const process of bridge.created) {
      expect(process.state).toBe('parked');
      expect(process.parkedCount).toBe(1);
      expect(process.tempDirExists).toBe(true);
    }
    expect(bridge.groupKills).toEqual([]);
    expect(bridge.factory.toolResults).toEqual([]);

    // Answering one turn's own call still resumes that turn's own process.
    const resumed = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('one'),
          assistantToolCall([{ id: idA, name: 'get_time', args: '{}' }]),
          toolResult(idA, '12:00'),
        ],
      }),
    );
    expect(resumed.error).toBeUndefined();
    expect(resumed.sink.text).toContain('12:00');
    expect(bridge.queryCallCount).toBe(2);
  });
});

describe('per-request wall clock', () => {
  it('answers 504 CLAUDE_BRIDGE_REQUEST_TIMEOUT and tears the process down', async () => {
    const clock = new FakeClock();
    const bridge = pipeline({
      clock,
      program: [[{ kind: 'silent' }]],
      config: { requestWallClockMs: 500, stallWatchdogMs: 60_000 },
    });
    const pending = bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    await waitFor(() => bridge.created.length === 1, 2000, 'process creation');
    await clock.advance(1000);
    const result = await pending;
    expect(result.error?.status).toBe(504);
    expect(result.error?.code).toBe('CLAUDE_BRIDGE_REQUEST_TIMEOUT');
    await expectTornDown(bridge);
  });
});

describe('unknown models', () => {
  it('answers 400 for an unknown model on a tools request', async () => {
    const bridge = pipeline({ program: [[{ kind: 'text', text: 'x' }]] });
    const result = await bridge.post(baseRequest({ tools: TOOLS, model: 'gpt-9-ultra' }));
    expect(result.error?.status).toBe(400);
    expect(result.error?.code).toBe('model_not_found');
    expect(result.error?.message).toContain('claude-sonnet-5');
    expect(bridge.queryCallCount).toBe(0);
  });
});

function parkedOnce(): FakeProgram {
  return [
    [{ kind: 'toolCalls', calls: [{ name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} }] }],
    [{ kind: 'toolEcho' }],
  ];
}
