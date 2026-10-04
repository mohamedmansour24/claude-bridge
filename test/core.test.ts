/**
 * Phase 3 core proof: text streaming, parked tool calls (single and parallel)
 * resumed in the SAME fake process, cold start on unmatched history, the aux
 * no-tools path, non-streaming mode and the no-partials fallback.
 */

import { describe, expect, it, afterEach } from 'vitest';

import { Pipeline, assistantToolCall, captureProcessWrites, childStderr, settle, toolResult, userMessage } from './harness.js';
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

function baseRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5',
    messages: [{ role: 'system', content: 'You are Hermes.' }, userMessage('what time is it?')],
    ...extra,
  };
}

describe('text stream', () => {
  it('streams OpenAI chunks, a terminal finish_reason, usage and [DONE]', async () => {
    const program: FakeProgram = [[{ kind: 'text', text: 'Hello from Claude.' }]];
    const bridge = pipeline({ program });
    const result = await bridge.post(baseRequest({ stream: true }));

    expect(result.error).toBeUndefined();
    expect(result.done).toBe(true);
    expect(result.sink.text).toBe('Hello from Claude.');
    expect(result.sink.finishReasons).toEqual(['stop']);

    // Every chunk carries the OpenAI envelope Hermes parses.
    for (const chunk of result.chunks) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(typeof chunk.id).toBe('string');
      expect(chunk.id.startsWith('chatcmpl-')).toBe(true);
      expect(typeof chunk.created).toBe('number');
      expect(chunk.model).toBe('claude-sonnet-5');
      expect(Array.isArray(chunk.choices)).toBe(true);
    }
    // Non-terminal chunks have a null finish_reason; the terminal one does not.
    const terminal = result.chunks.filter(
      chunk => chunk.choices.length > 0 && chunk.choices[0]?.finish_reason !== null,
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.choices[0]?.finish_reason).toBe('stop');
    // The choiceless usage chunk Hermes asks for via stream_options.
    expect(result.sink.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    // The last frame is the sentinel.
    expect(result.chunks.at(-1)?.choices).toEqual([]);
  });

  it('answers non-streaming requests with a chat.completion object', async () => {
    const bridge = pipeline({ program: [[{ kind: 'text', text: 'Non-streamed.' }]] });
    const result = await bridge.post(baseRequest());
    expect(result.chunks).toHaveLength(0);
    expect(result.completion?.object).toBe('chat.completion');
    expect(result.completion?.choices[0]?.message.content).toBe('Non-streamed.');
    expect(result.completion?.choices[0]?.finish_reason).toBe('stop');
    expect(result.completion?.usage.total_tokens).toBe(18);
  });

  it('works when the CLI emits no partial messages at all', async () => {
    const bridge = pipeline({
      program: [
        [
          { kind: 'text', text: 'Assembled ' },
          { kind: 'text', text: 'without partials.' },
        ],
      ],
      fakeOptions: { partials: false },
    });
    const result = await bridge.post(baseRequest({ stream: true }));
    expect(result.sink.text).toBe('Assembled without partials.');
    expect(result.sink.finishReasons).toEqual(['stop']);
  });
});

describe('tool calls', () => {
  it('parks a single tool call and resumes it in the same process', async () => {
    const program: FakeProgram = [
      [{ kind: 'toolCalls', calls: [{ name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} }] }],
      [{ kind: 'toolEcho' }],
    ];
    const bridge = pipeline({ program });

    const first = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(first.error).toBeUndefined();
    expect(first.done).toBe(true);
    expect(first.sink.finishReasons).toEqual(['tool_calls']);
    expect(first.sink.toolCalls).toHaveLength(1);

    const [call] = first.sink.toolCalls;
    expect(call).toBeDefined();
    // Hermes gets its OWN tool name back, and the minted id shape from SPEC.md.
    expect(call?.name).toBe('get_time');
    expect(call?.id.startsWith('call_')).toBe(true);
    expect(JSON.parse(call?.args ?? '{}')).toEqual({});
    expect(bridge.queryCallCount).toBe(1);

    const second = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('what time is it?'),
          assistantToolCall([{ id: call?.id ?? '', name: 'get_time', args: call?.args ?? '{}' }]),
          toolResult(call?.id ?? '', '12:00'),
        ],
      }),
    );

    expect(second.error).toBeUndefined();
    expect(second.sink.text).toContain('12:00');
    expect(second.sink.finishReasons).toEqual(['stop']);
    // The resumed stream must NOT replay the already-answered tool call.
    expect(second.sink.toolCalls).toEqual([]);
    // THE SAME fake process served both turns.
    expect(bridge.queryCallCount).toBe(1);
    expect(bridge.factory.toolResults.map(entry => entry.text)).toEqual(['12:00']);
  });

  it('refuses a partial group: no resume, no cold start, and the process stays parked', async () => {
    const toolProgram: FakeProgram = [
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
    const bridge = pipeline({
      program: (_input, index) => (index === 0 ? toolProgram : [[{ kind: 'text', text: 'cold after partial' }]]),
    });

    const first = await bridge.post(baseRequest({ tools: TWO_TOOLS, stream: true }));
    expect(first.sink.toolCalls).toHaveLength(2);
    const [firstCall, secondCall] = first.sink.toolCalls;
    expect(firstCall?.id).not.toBe(secondCall?.id);
    expect(new Set([firstCall?.name, secondCall?.name])).toEqual(new Set(['get_time', 'read_file']));
    expect(JSON.parse(secondCall?.args ?? '{}')).toEqual({ path: '/tmp/x' });
    const parked = bridge.created[0];
    expect(parked?.parkedCount).toBe(2);

    // SPEC.md: "all ids of one assistant turn must come back before you resume;
    // a missing one after the timeout = failure, not a guess". A PARTIAL group is
    // therefore refused as it stands — never a resume, and never a cold start.
    const partial = await bridge.post(
      baseRequest({
        tools: TWO_TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('what time is it?'),
          assistantToolCall([
            { id: firstCall?.id ?? '', name: 'get_time', args: '{}' },
            { id: secondCall?.id ?? '', name: 'read_file', args: '{"path":"/tmp/x"}' },
          ]),
          toolResult(firstCall?.id ?? '', '12:00'),
        ],
      }),
    );
    expect(partial.error?.status).toBe(409);
    expect(partial.error?.code).toBe('CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS');
    expect(partial.sink.text).toBe('');
    expect(partial.sink.toolCalls).toEqual([]);
    // No cold start: the same single process is still there...
    expect(bridge.queryCallCount).toBe(1);
    expect(parked?.state).toBe('parked');
    expect(parked?.parkedCount).toBe(2);
    expect(parked?.tempDirExists).toBe(true);
    // ...and the delivered result was NOT applied to the parked call.
    expect(bridge.factory.toolResults).toEqual([]);
    expect(bridge.logLines.join('\n')).toContain('partial_tool_results_refused');
  });

  it('cold starts a genuinely new user turn even while a call is parked', async () => {
    const bridge = pipeline({
      program: (_input, index) =>
        index === 0
          ? [[{ kind: 'toolCalls', calls: [{ name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} }] }], [{ kind: 'toolEcho' }]]
          : [[{ kind: 'text', text: 'a brand new turn' }]],
    });
    const first = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(first.sink.finishReasons).toEqual(['tool_calls']);
    expect(bridge.created[0]?.state).toBe('parked');

    // No tool results at all: a new user message that references no parked id.
    const second = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('what time is it?'),
          { role: 'assistant', content: '', tool_calls: [{ id: bridge.created[0]?.parkedCallIds[0] ?? '', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
          userMessage('never mind, different question'),
        ],
      }),
    );
    expect(second.error).toBeUndefined();
    expect(second.sink.text).toBe('a brand new turn');
    expect(bridge.queryCallCount).toBe(2);
  });

  it('resumes parallel calls when every result comes back', async () => {
    const program: FakeProgram = [
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
    const bridge = pipeline({ program });
    const first = await bridge.post(baseRequest({ tools: TWO_TOOLS, stream: true }));
    const calls = first.sink.toolCalls;

    const second = await bridge.post(
      baseRequest({
        tools: TWO_TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('what time is it?'),
          assistantToolCall(calls.map(call => ({ id: call.id, name: call.name, args: call.args }))),
          ...calls.map(call => toolResult(call.id, `${call.name}-result`)),
        ],
      }),
    );
    expect(second.error).toBeUndefined();
    expect(second.sink.text).toContain('get_time-result');
    expect(second.sink.toolCalls).toEqual([]);
    expect(bridge.queryCallCount).toBe(1);
    expect(bridge.factory.toolResults).toHaveLength(2);
  });
});

describe('serial dispatch of a parallel batch (2026-09-24 cron stall)', () => {
  // The real CLI runs MCP tools that are not read-only one at a time: with two
  // tool_use blocks in one message it dispatches the first handler and does
  // not dispatch the second until the first returns. It sends tool_progress
  // heartbeats meanwhile, so the stall watchdog never fires. The turn must
  // still settle as tool_calls carrying BOTH calls.
  function serialProgram(): FakeProgram {
    return [
      [
        {
          kind: 'serialToolCalls',
          heartbeatMs: 40,
          calls: [
            { name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} },
            { name: `mcp__${MCP_SERVER_NAME}__read_file`, args: { path: '/tmp/x' } },
          ],
        },
      ],
      [{ kind: 'toolEcho' }],
    ];
  }

  async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms (turn never settled)`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  for (const stream of [true, false]) {
    it(`settles tool_calls for a serially dispatched parallel batch and resumes it (stream=${stream})`, async () => {
      const bridge = pipeline({ program: serialProgram() });
      const first = await within(bridge.post(baseRequest({ tools: TWO_TOOLS, stream })), 2000, 'first request');
      expect(first.error).toBeUndefined();
      const choice = first.sink.completion?.choices[0];
      const finish = stream ? first.sink.finishReasons : [choice?.finish_reason];
      expect(finish).toEqual(['tool_calls']);
      const calls = stream
        ? first.sink.toolCalls
        : (choice?.message.tool_calls ?? []).map(call => ({
            id: call.id,
            name: call.function.name,
            args: call.function.arguments,
          }));
      expect(calls.map(call => call.name)).toEqual(['get_time', 'read_file']);

      const second = await within(
        bridge.post(
          baseRequest({
            tools: TWO_TOOLS,
            stream,
            messages: [
              { role: 'system', content: 'You are Hermes.' },
              userMessage('what time is it?'),
              assistantToolCall(calls.map(call => ({ id: call.id, name: call.name, args: call.args }))),
              ...calls.map(call => toolResult(call.id, `${call.name}-result`)),
            ],
          }),
        ),
        2000,
        'resume request',
      );
      expect(second.error).toBeUndefined();
      const answer = stream ? second.sink.text : String(second.sink.completion?.choices[0]?.message.content ?? '');
      expect(answer).toContain('get_time-result');
      if (stream) expect(second.sink.toolCalls).toEqual([]);
      expect(bridge.queryCallCount).toBe(1);
      expect(bridge.factory.toolResults.map(entry => entry.text)).toEqual(['get_time-result', 'read_file-result']);
    });
  }
});

describe('CLI output hygiene', () => {
  const CANARY = 'CLI-STDERR-CANARY-0123456789';

  it('never forwards the spawned CLI stderr into the log or the console', async () => {
    const bridge = pipeline({
      program: [
        [{ kind: 'toolCalls', calls: [{ name: `mcp__${MCP_SERVER_NAME}__get_time`, args: {} }] }],
        [{ kind: 'toolEcho' }],
      ],
    });
    const first = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(first.sink.finishReasons).toEqual(['tool_calls']);

    // The CLI (here: the recording fake) writes to its own stderr. The bridge
    // owns that pipe: it must consume the bytes and keep none of them.
    const capture = captureProcessWrites();
    try {
      childStderr(bridge).write(`warning: something happened ${CANARY}\n`);
      await settle();
    } finally {
      capture.stop();
    }

    expect(bridge.spawner.stderrBytes).toBeGreaterThan(0);
    expect(capture.written.join('')).not.toContain(CANARY);
    expect(bridge.logLines.join('\n')).not.toContain(CANARY);
  });
});

describe('cold start and correlation', () => {
  it('cold starts when the tool_call_ids match nothing live', async () => {
    const bridge = pipeline({ program: [[{ kind: 'text', text: 'Cold.' }]] });
    const result = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('run something'),
          assistantToolCall([{ id: 'call_deadbeef', name: 'get_time', args: '{}' }]),
          toolResult('call_deadbeef', '12:00'),
        ],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.sink.text).toBe('Cold.');
    expect(bridge.queryCallCount).toBe(1);
  });

  it('continues a warm idle process on the next user turn, and cold starts on an edited history', async () => {
    const program: FakeProgram = [
      [{ kind: 'text', text: 'First answer.' }],
      [{ kind: 'await' }, { kind: 'text', text: 'Second answer.' }],
    ];
    const bridge = pipeline({ program });

    const first = await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(first.sink.text).toBe('First answer.');
    expect(bridge.queryCallCount).toBe(1);

    const history = [
      { role: 'system', content: 'You are Hermes.' },
      userMessage('what time is it?'),
      { role: 'assistant', content: 'First answer.' },
      userMessage('and now?'),
    ];
    const second = await bridge.post(baseRequest({ tools: TOOLS, stream: true, messages: history }));
    expect(second.sink.text).toBe('Second answer.');
    expect(bridge.queryCallCount).toBe(1);

    // Same conversation, but the history was rewritten: never a partial match.
    const edited = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are Hermes.' },
          userMessage('something entirely different'),
          userMessage('and now?'),
        ],
      }),
    );
    expect(edited.error).toBeUndefined();
    expect(bridge.queryCallCount).toBe(2);
  });

  it('cold starts when the system prompt changes for the same history', async () => {
    const bridge = pipeline({
      program: [
        [{ kind: 'text', text: 'one' }],
        [{ kind: 'text', text: 'two' }],
      ],
    });
    await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    const other = await bridge.post(
      baseRequest({
        tools: TOOLS,
        stream: true,
        messages: [
          { role: 'system', content: 'You are a different persona.' },
          userMessage('what time is it?'),
          { role: 'assistant', content: 'one' },
          userMessage('again'),
        ],
      }),
    );
    expect(other.error).toBeUndefined();
    expect(bridge.queryCallCount).toBe(2);
  });
});

describe('auxiliary calls', () => {
  it('serves a no-tools request as a cold one-shot with the aux model', async () => {
    const bridge = pipeline({
      program: [[{ kind: 'text', text: 'A short title.' }]],
      config: { auxModel: 'claude-haiku-4-5' },
    });
    const result = await bridge.post({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'Give a title.' }, userMessage('Summarise this.')],
      max_tokens: 64,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    expect(result.error).toBeUndefined();
    expect(result.completion?.choices[0]?.message.content).toBe('A short title.');
    // Hermes asked for a model this bridge does not expose -> aux default.
    expect(result.completion?.model).toBe('claude-haiku-4-5');

    const call = bridge.factory.calls[0];
    expect(call?.meta.kind).toBe('aux');
    expect(call?.meta.tools).toHaveLength(0);
    expect(call?.options.maxTurns).toBe(1);
    expect(call?.options.mcpServers).toEqual({});
    expect(call?.options.tools).toEqual([]);
    expect(call?.options.settingSources).toEqual([]);
    expect(call?.options.strictMcpConfig).toBe(true);
  });

  it('respects an exposed model id on the aux path', async () => {
    const bridge = pipeline({ program: [[{ kind: 'text', text: 'x' }]] });
    const result = await bridge.post({
      model: 'claude-opus-5',
      messages: [userMessage('compress this')],
    });
    expect(result.completion?.model).toBe('claude-opus-5');
    expect(bridge.factory.calls[0]?.options.model).toBe('claude-opus-5');
    expect(bridge.factory.calls[0]?.meta.kind).toBe('aux');
  });
});

describe('invariants in the SDK options', () => {
  it('never lets Claude execute anything', async () => {
    const bridge = pipeline({ program: [[{ kind: 'text', text: 'ok' }]] });
    await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    const call = bridge.factory.calls[0];
    expect(call?.options.tools).toEqual([]);
    expect(call?.options.settingSources).toEqual([]);
    expect(call?.options.strictMcpConfig).toBe(true);
    expect(call?.options.permissionMode).toBe('default');
    expect(call?.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(call?.options.includePartialMessages).toBe(true);
    expect(call?.options.persistSession).toBe(false);
    expect(Object.keys(call?.options.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    // The private cwd is a real, empty, 0700 temp dir.
    expect(call?.options.cwd).toContain('claude-bridge');
  });

  it('tells the SDK which claude binary to spawn, and only when one was resolved', async () => {
    const withPath = pipeline({
      program: [[{ kind: 'text', text: 'ok' }]],
      config: { claudePath: '/opt/bin/claude' },
    });
    await withPath.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(withPath.factory.calls[0]?.options.pathToClaudeCodeExecutable).toBe('/opt/bin/claude');

    // No resolved binary: the option stays unset, so the SDK spawns the official
    // CLI it bundles (SPEC.md invariant 1 — still only the official program).
    const bundled = pipeline({ program: [[{ kind: 'text', text: 'ok' }]] });
    await bundled.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(bundled.factory.calls[0]?.options.pathToClaudeCodeExecutable).toBeUndefined();

    // A raw relative value is never handed to the SDK either, even if one
    // reaches the config: the boot resolver refuses to start on it, and this is
    // the process-level guard behind that.
    const relative = pipeline({ program: [[{ kind: 'text', text: 'ok' }]], config: { claudePath: 'relative/claude' } });
    await relative.post(baseRequest({ tools: TOOLS, stream: true }));
    expect(relative.factory.calls[0]?.options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('swallows the CLI stderr the SDK would otherwise hand back', async () => {
    const bridge = pipeline({ program: [[{ kind: 'text', text: 'ok' }]] });
    await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    const stderr = bridge.factory.calls[0]?.options.stderr as unknown as ((data: string) => void) | undefined;
    expect(stderr).toBeTypeOf('function');
    const capture = captureProcessWrites();
    try {
      stderr?.('CLI-STDERR-CANARY-THROUGH-THE-SDK');
      await settle();
      expect(capture.written.join('')).not.toContain('CLI-STDERR-CANARY');
    } finally {
      capture.stop();
    }
  });

  it('denies every non-bridged tool through canUseTool', async () => {
    const bridge = pipeline({ program: [[{ kind: 'text', text: 'ok' }]] });
    await bridge.post(baseRequest({ tools: TOOLS, stream: true }));
    const canUseTool = bridge.factory.calls[0]?.options.canUseTool as unknown as (
      name: string,
      input: Record<string, unknown>,
      options: unknown,
    ) => Promise<{ behavior: string }>;
    expect(canUseTool).toBeTypeOf('function');
    const allowed = await canUseTool(`mcp__${MCP_SERVER_NAME}__get_time`, {}, {});
    const denied = await canUseTool('Bash', { command: 'ls' }, {});
    expect(allowed.behavior).toBe('allow');
    expect(denied.behavior).toBe('deny');
  });
});
