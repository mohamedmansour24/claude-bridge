/**
 * Unit tests for the pure pieces: tool mirroring, history rendering,
 * conversation identity, config validation, the spawn/argv guards and the log
 * field filter.
 */

import { describe, expect, it } from 'vitest';

import { FakeClock, makeTestConfig, settle } from './harness.js';
import { loadConfig, MIN_KEY_LENGTH } from '../src/config.js';
import { canonicalMessage, isContinuation, messagesPrefixHash, systemTextOf, trailingToolResults } from '../src/conversation.js';
import { MCP_SERVER_NAME, ToolMirror, mcpNameFor, visibleNameFor } from '../src/tool-mirror.js';
import { renderConversation, composeOpeningPrompt } from '../src/history.js';
import { LOG_ALLOWED_FIELDS, LOG_CONSTRAINED_FIELDS, createMemoryLogger, looksLikeCredential, sanitizeFields } from '../src/log.js';
import {
  assertArgvSafe,
  describeClaudeBinary,
  GroupSpawner,
  resolveClaudeBinary,
  resolveClaudeBinarySource,
} from '../src/spawn.js';
import { buildProcessDeps, isLoopbackHost, originIsLoopback } from '../src/server.js';
import { classifyFailureText, finishReasonFor, hasAuthEvidence, hasOverflowEvidence, mapUsage, scrubEnv } from '../src/process.js';
import type { ChildLike } from '../src/spawn.js';
import type { ProcessDeps } from '../src/process.js';
import { PassThrough } from 'node:stream';

const KEY = 'k'.repeat(MIN_KEY_LENGTH);

/** A credential-shaped token that passes the generic machine-token shape check. */
const CREDENTIAL_TOKEN = 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Credential-shaped values that ALL satisfy the generic machine-token shape
 * check (`SAFE_TOKEN`, `[A-Za-z0-9_.:@/+-]{1,64}`), so only a credential-shape
 * rule can stop them: an Anthropic key, a JWT, a padded-free base64 blob, and a
 * blob carrying base64 punctuation.
 */
const CREDENTIAL_SHAPED = [
  CREDENTIAL_TOKEN,
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2ln',
  'Y29ycmVjdCBob3JzZSBiYXR0ZXJ5IHN0YXBsZSAwMTIzNDU2Nzg5',
  'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo+/0Z',
];

describe('tool mirror', () => {
  const mirror = new ToolMirror([
    { type: 'function', function: { name: 'get_time', description: 't', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'weird tool/name!', description: 'w', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'mcp__other__thing', description: 'o', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'x'.repeat(90), description: 'long', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'no_schema' } },
  ]);

  it('passes legal names through and aliases everything else reversibly', () => {
    expect(mcpNameFor('get_time')).toBe('get_time');
    expect(visibleNameFor('get_time')).toBe(`mcp__${MCP_SERVER_NAME}__get_time`);

    for (const tool of mirror.tools) {
      // The MCP-side name is always legal, and the visible name always fits.
      expect(tool.mcpName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(`${'mcp__'}${MCP_SERVER_NAME}__${tool.mcpName}`.length).toBeLessThanOrEqual(120);
      expect(tool.visibleName.length).toBeLessThanOrEqual(114);
      // Names that look like MCP client names are rewritten, never forwarded.
      if (tool.openaiName.startsWith('mcp__')) expect(tool.mcpName).not.toBe(tool.openaiName);
      // Hermes must always get its own name back.
      expect(mirror.openaiNameForEmitted(tool.visibleName)).toBe(tool.openaiName);
      expect(mirror.openaiNameForEmitted(tool.mcpName)).toBe(tool.openaiName);
      expect(mirror.openaiNameForEmitted(tool.openaiName)).toBe(tool.openaiName);
    }
    expect(mirror.openaiNameForEmitted('mcp__hermes__not_a_tool')).toBeUndefined();
    // A tool without a schema is still callable.
    expect(mirror.byOpenAiName('no_schema')?.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('fingerprints the same tool set the same way regardless of order', () => {
    const a = new ToolMirror([
      { type: 'function', function: { name: 'a', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'b', parameters: { type: 'object' } } },
    ]);
    const b = new ToolMirror([
      { type: 'function', function: { name: 'b', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'a', parameters: { type: 'object' } } },
    ]);
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = new ToolMirror([{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }]);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
});

describe('history rendering', () => {
  const mirror = new ToolMirror([
    { type: 'function', function: { name: 'get_time', description: 't', parameters: { type: 'object' } } },
  ]);

  it('renders history, live prompt, tool calls, tool results and images', () => {
    const dataUrl = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    const rendered = renderConversation(
      [
        { role: 'system', content: 'Persona text.' },
        { role: 'user', content: 'first question' },
        {
          role: 'assistant',
          content: 'let me check',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"a":1}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
        { role: 'assistant', content: 'It is 12:00.' },
        { role: 'user', content: [{ type: 'text', text: 'and a picture' }, { type: 'image_url', image_url: { url: dataUrl } }] },
      ],
      mirror,
    );

    expect(rendered.systemText).toBe('Persona text.');
    expect(rendered.historyText).toContain('=== Conversation history (oldest first) ===');
    expect(rendered.historyText).toContain('=== End of conversation history ===');
    expect(rendered.historyText).toContain('[user] first question');
    // Tool calls render with the name Claude sees, arguments verbatim.
    expect(rendered.historyText).toContain('[called mcp__hermes__get_time({"a":1})]');
    expect(rendered.historyText).toContain('[tool] 12:00');
    expect(rendered.historyText).toContain('[assistant] It is 12:00.');
    // The trailing user run is the live prompt, without a role prefix.
    expect(rendered.liveText).toContain('and a picture');
    expect(rendered.liveText).not.toContain('[user]');
    expect(rendered.images).toHaveLength(1);
    expect(rendered.images[0]?.mediaType).toBe('image/png');
    expect(rendered.historyText).not.toContain('and a picture');
    expect(composeOpeningPrompt(rendered)).toContain('first question');
  });

  it('replaces a non-data-URL image with a placeholder', () => {
    const rendered = renderConversation(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }],
      mirror,
    );
    expect(rendered.images).toHaveLength(0);
    expect(rendered.liveText).toContain('[image omitted: not a data URL]');
  });

  it('omits unknown content blocks rather than guessing', () => {
    const rendered = renderConversation(
      [{ role: 'user', content: [{ type: 'audio', text: 'x' }] }],
      mirror,
    );
    expect(rendered.liveText).toContain('[audio block omitted]');
  });
});

describe('conversation identity', () => {
  it('hashes prefixes stably and only continues real continuations', () => {
    const first = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'hello' },
    ];
    const hash = messagesPrefixHash(first, first.length);
    expect(messagesPrefixHash(first, first.length)).toBe(hash);
    expect(messagesPrefixHash(first, 1)).not.toBe(hash);

    const continued = [
      ...first,
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ];
    expect(isContinuation(continued, first.length, hash)).toBe(true);
    // An edited history is not a continuation.
    expect(isContinuation([{ role: 'user', content: 'different' }, { role: 'user', content: 'x' }], 1, messagesPrefixHash(first, 1))).toBe(false);
    // A shorter or equal list is not a continuation.
    expect(isContinuation(first, first.length, hash)).toBe(false);
    // Tool results never arrive through the continuation path.
    expect(isContinuation([...first, { role: 'tool', tool_call_id: 'c', content: 'x' }], first.length, hash)).toBe(false);
    // An assistant message carrying tool_calls is the parked path, not this one.
    expect(
      isContinuation(
        [...first, { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{}' } }] }],
        first.length,
        hash,
      ),
    ).toBe(false);
  });

  it('reads the trailing tool results and the system text', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
      { role: 'tool', tool_call_id: 'call_a', content: 'A' },
      { role: 'tool', tool_call_id: 'call_b', content: 'B' },
    ];
    expect(trailingToolResults(messages).map(result => result.id)).toEqual(['call_a', 'call_b']);
    expect(trailingToolResults(messages)[1]?.payload.content[0]?.text).toBe('B');
    expect(trailingToolResults([{ role: 'user', content: 'u' }])).toEqual([]);
    expect(systemTextOf(messages)).toBe('sys');
    expect(canonicalMessage({ role: 'user', content: 'u' })).not.toBe(canonicalMessage({ role: 'user', content: 'v' }));
  });
});

describe('config', () => {
  it('refuses to start without a long enough key', () => {
    expect(() => loadConfig({ env: {}, argv: [] })).toThrow(/CLAUDE_BRIDGE_KEY/);
    expect(() => loadConfig({ env: { CLAUDE_BRIDGE_KEY: 'short' }, argv: [] })).toThrow(/at least 32/);
    expect(loadConfig({ env: { CLAUDE_BRIDGE_KEY: KEY }, argv: [] }).key).toBe(KEY);
  });

  it('validates the aux model and reads the flags', () => {
    expect(() => loadConfig({ env: { CLAUDE_BRIDGE_KEY: KEY, CLAUDE_BRIDGE_AUX_MODEL: 'gpt-4o' }, argv: [] })).toThrow(
      /CLAUDE_BRIDGE_AUX_MODEL/,
    );
    const parsed = loadConfig({ env: { CLAUDE_BRIDGE_KEY: KEY }, argv: ['--fake', '--port', '9999'] });
    expect(parsed.fake).toBe(true);
    expect(parsed.port).toBe(9999);
    expect(parsed.auxModel).toBe('claude-haiku-4-5');
    expect(parsed.maxProcs).toBe(4);
    expect(parsed.parkedCallTimeoutMs).toBe(30 * 60 * 1000);
    expect(parsed.stallWatchdogMs).toBe(90 * 1000);
  });
});

describe('loopback Host/Origin parsing', () => {
  it('accepts exactly the loopback host forms SPEC.md names', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:8801', 'localhost:8801', '[::1]:8801', 'localhost', '[::1]', 'LOCALHOST:1']) {
      expect(isLoopbackHost(host), `host ${host}`).toBe(true);
    }
  });

  it('refuses a host that is not loopback, including lookalikes', () => {
    for (const host of [
      // The two the adversarial review found accepted.
      '127.0.0.1:8801@evil.com',
      '[::1].attacker.com',
      // Prefix/suffix games.
      '127.0.0.1.evil.com',
      'localhost.attacker.com',
      // An unbracketed IPv6 literal is not a loopback Host value.
      '::1',
      // Expanded IPv6 and other non-canonical spellings are not accepted either.
      '[0:0:0:0:0:0:0:1]:1',
      '0.0.0.0',
      'example.com',
      '10.0.0.5:8123',
      '127.0.0.1:0',
      '127.0.0.1:99999',
      '127.0.0.1:80:80',
      '127.0.0.1/',
      '127.0.0.1\\evil',
      '127.0.0.1 ',
      'evil\t127.0.0.1',
      '[::1]evil.com',
      '[::1]:8801/evil',
      '',
    ]) {
      expect(isLoopbackHost(host), `host ${JSON.stringify(host)}`).toBe(false);
    }
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost('127.0.0.1:8801@evil.com')).toBe(false);
  });

  it('refuses an Origin that is not loopback, and an absent Origin is fine', () => {
    expect(originIsLoopback(undefined)).toBe(true);
    for (const origin of [
      'https://evil.example.com',
      'http://127.0.0.1:8801@evil.com',
      'http://evil.com@127.0.0.1',
      'http://localhost.attacker.com',
      'http://127.0.0.1.evil.com',
      // `null` (sandboxed documents) is not a loopback origin.
      'null',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(originIsLoopback(origin), `origin ${JSON.stringify(origin)}`).toBe(false);
    }
    for (const origin of ['http://127.0.0.1:8801', 'http://localhost', 'https://[::1]:443', 'http://LOCALHOST:1']) {
      expect(originIsLoopback(origin), `origin ${origin}`).toBe(true);
    }
  });
});

describe('which official claude binary is spawned', () => {
  const existsAt = (...paths: string[]) => (path: string): boolean => paths.includes(path);

  it('resolves env override > PATH > SDK-bundled, without probing a credential path', () => {
    // Explicit wins over PATH (and must name a real executable to be honoured).
    expect(
      resolveClaudeBinarySource({
        explicit: '/usr/bin/claude',
        env: { PATH: '/opt/bin' },
        exists: existsAt('/usr/bin/claude', '/opt/bin/claude'),
      }),
    ).toEqual({ source: 'explicit', path: '/usr/bin/claude' });
    // PATH when nothing is explicit.
    expect(
      resolveClaudeBinarySource({ explicit: undefined, env: { PATH: '/opt/bin:/usr/bin' }, exists: existsAt('/usr/bin/claude') }),
    ).toEqual({ source: 'path', path: '/usr/bin/claude' });
    // Nothing on PATH -> the SDK's own bundled official CLI, and NO refusal.
    const probes: string[] = [];
    const bundled = resolveClaudeBinarySource({
      explicit: undefined,
      env: { PATH: '/opt/bin:/usr/bin' },
      exists: path => {
        probes.push(path);
        return false;
      },
    });
    expect(bundled).toEqual({ source: 'bundled', path: undefined });
    for (const probe of probes) {
      expect(probe).not.toContain('.claude');
      expect(probe).not.toContain('.hermes');
      expect(probe).not.toContain('.config');
    }
    // An empty PATH behaves the same way.
    expect(resolveClaudeBinarySource({ explicit: undefined, env: {}, exists: () => false })).toEqual({
      source: 'bundled',
      path: undefined,
    });
    // ...and a relative override is looked up on PATH only.
    expect(
      resolveClaudeBinarySource({ explicit: 'claude', env: { PATH: '/opt/bin' }, exists: existsAt('/opt/bin/claude') }),
    ).toEqual({ source: 'explicit', path: '/opt/bin/claude' });
  });

  it('states which CLI will be spawned, in one line per case', () => {
    expect(describeClaudeBinary({ source: 'explicit', path: '/x/claude' })).toContain('/x/claude');
    expect(describeClaudeBinary({ source: 'explicit', path: '/x/claude' })).toContain('CLAUDE_BRIDGE_CLAUDE_PATH');
    expect(describeClaudeBinary({ source: 'path', path: '/usr/bin/claude' })).toContain('found on PATH');
    const bundled = describeClaudeBinary({ source: 'bundled', path: undefined });
    expect(bundled).toContain('bundled with @anthropic-ai/claude-agent-sdk');
    expect(bundled).toContain('no claude on PATH');
    // `bundled` claims the variable is UNSET, so it may only be reached when it
    // really is (unset, or empty/whitespace-only): every other explicit value
    // either resolves or refuses to start.
    expect(bundled).toContain('CLAUDE_BRIDGE_CLAUDE_PATH unset');
  });

  it('refuses an explicit path that names nothing spawnable, and only calls empty/unset values unset', () => {
    const exists = existsAt('/opt/bin/claude');
    // absolute + exists -> explicit.
    expect(resolveClaudeBinarySource({ explicit: '/opt/bin/claude', env: { PATH: '/nope' }, exists })).toEqual({
      source: 'explicit',
      path: '/opt/bin/claude',
    });
    // absolute + missing -> refuse to start, naming the bad value.
    expect(() => resolveClaudeBinarySource({ explicit: '/opt/bin/gone', env: { PATH: '/opt/bin' }, exists })).toThrow(
      /\/opt\/bin\/gone/,
    );
    // relative + not on PATH -> refuse to start, naming the bad value.
    expect(() => resolveClaudeBinarySource({ explicit: 'claude-nowhere', env: { PATH: '/opt/bin' }, exists })).toThrow(
      /claude-nowhere/,
    );
    // relative + on PATH -> resolved to the absolute candidate (unchanged).
    expect(resolveClaudeBinarySource({ explicit: 'claude', env: { PATH: '/opt/bin' }, exists })).toEqual({
      source: 'explicit',
      path: '/opt/bin/claude',
    });
    // A refusal never spies on a credential-adjacent path either.
    const probes: string[] = [];
    expect(() => resolveClaudeBinarySource({ explicit: 'nope', env: { PATH: '/opt/bin' }, exists: path => { probes.push(path); return false; } })).toThrow();
    for (const probe of probes) {
      expect(probe).not.toContain('.claude');
      expect(probe).not.toContain('.hermes');
      expect(probe).not.toContain('.config');
    }
    // empty / whitespace-only count as UNSET: PATH first, then the bundle.
    for (const explicit of ['', '   ']) {
      expect(resolveClaudeBinarySource({ explicit, env: { PATH: '/opt/bin' }, exists })).toEqual({
        source: 'path',
        path: '/opt/bin/claude',
      });
      expect(resolveClaudeBinarySource({ explicit, env: { PATH: '/nope' }, exists: () => false })).toEqual({
        source: 'bundled',
        path: undefined,
      });
    }
    // unset: PATH first, then the bundle.
    expect(resolveClaudeBinarySource({ explicit: undefined, env: { PATH: '/opt/bin' }, exists })).toEqual({
      source: 'path',
      path: '/opt/bin/claude',
    });
    expect(resolveClaudeBinarySource({ explicit: undefined, env: { PATH: '/nope' }, exists: () => false })).toEqual({
      source: 'bundled',
      path: undefined,
    });
  });

  it('passes the resolved binary to the SDK and still starts with no PATH binary', () => {
    const unusedQuery: ProcessDeps['queryFn'] = () => {
      throw new Error('the query must never run in this test');
    };
    // A PATH binary becomes Options.pathToClaudeCodeExecutable (via the config
    // the process is built from) and the bridge is available.
    const withPath = buildProcessDeps(makeTestConfig(), {
      env: { PATH: '/opt/bin' },
      queryFnOverride: unusedQuery,
      exists: existsAt('/opt/bin/claude'),
    });
    expect(withPath.claudeBinary).toEqual({ source: 'path', path: '/opt/bin/claude' });
    expect(withPath.processDeps.config.claudePath).toBe('/opt/bin/claude');
    expect(withPath.claudeAvailable).toBe(true);

    // No PATH binary: the path stays unset (the SDK spawns its bundled CLI) and
    // the bridge STILL does not refuse to start.
    const bundled = buildProcessDeps(makeTestConfig(), {
      env: { PATH: '/nope' },
      queryFnOverride: unusedQuery,
      exists: () => false,
    });
    expect(bundled.claudeBinary).toEqual({ source: 'bundled', path: undefined });
    expect(bundled.processDeps.config.claudePath).toBeUndefined();
    expect(bundled.claudeAvailable).toBe(true);

    // --fake needs no binary at all.
    const fake = buildProcessDeps(makeTestConfig({ fake: true }), { env: {}, exists: () => false });
    expect(fake.claudeBinary.source).toBe('bundled');
    expect(fake.claudeAvailable).toBe(true);
  });

  it('never carries a raw CLAUDE_BRIDGE_CLAUDE_PATH into the SDK config, and refuses an unusable one', () => {
    const unusedQuery: ProcessDeps['queryFn'] = () => {
      throw new Error('the query must never run in this test');
    };

    // An empty value is unset: the effective config carries undefined, so the
    // raw string can never reach Options.pathToClaudeCodeExecutable.
    const empty = buildProcessDeps(makeTestConfig({ claudePath: '' }), {
      env: { PATH: '/nope' },
      queryFnOverride: unusedQuery,
      exists: () => false,
    });
    expect(empty.claudeBinary).toEqual({ source: 'bundled', path: undefined });
    expect(empty.processDeps.config.claudePath).toBeUndefined();
    expect(empty.claudeAvailable).toBe(true);

    // A relative value that resolves on PATH is replaced by the absolute
    // candidate, which is what the SDK is told to spawn.
    const relative = buildProcessDeps(makeTestConfig({ claudePath: 'claude' }), {
      env: { PATH: '/opt/bin' },
      queryFnOverride: unusedQuery,
      exists: existsAt('/opt/bin/claude'),
    });
    expect(relative.claudeBinary).toEqual({ source: 'explicit', path: '/opt/bin/claude' });
    expect(relative.processDeps.config.claudePath).toBe('/opt/bin/claude');

    // A relative value that resolves nowhere, and an absolute value that is
    // missing, both refuse to start and name the bad value — they are never
    // quietly reported as `bundled` ("CLAUDE_BRIDGE_CLAUDE_PATH unset") while a
    // raw relative path goes to the SDK.
    expect(() =>
      buildProcessDeps(makeTestConfig({ claudePath: 'claude-nowhere' }), {
        env: { PATH: '/nope' },
        queryFnOverride: unusedQuery,
        exists: () => false,
      }),
    ).toThrow(/claude-nowhere/);
    expect(() =>
      buildProcessDeps(makeTestConfig({ claudePath: '/gone/claude' }), {
        env: {},
        queryFnOverride: unusedQuery,
        exists: () => false,
      }),
    ).toThrow(/\/gone\/claude/);
  });
});

describe('spawn guards', () => {
  it('refuses permission-bypass argv', () => {
    expect(() => assertArgvSafe(['--dangerously-skip-permissions'])).toThrow(/refused/);
    expect(() => assertArgvSafe(['--allow-dangerously-skip-permissions=1'])).toThrow(/refused/);
    expect(() => assertArgvSafe(['--permission-mode', 'bypassPermissions'])).toThrow(/refused/);
    expect(() => assertArgvSafe(['--permission-mode', 'default'])).not.toThrow();
    expect(() => assertArgvSafe(['--model', 'claude-sonnet-5'])).not.toThrow();
  });

  it('resolves the claude binary from an explicit path or PATH only', () => {
    const exists = (path: string): boolean => path === '/opt/bin/claude' || path === '/usr/bin/claude';
    expect(resolveClaudeBinary({ explicit: undefined, env: { PATH: '/opt/bin:/usr/bin' }, exists })).toBe('/opt/bin/claude');
    expect(resolveClaudeBinary({ explicit: undefined, env: { PATH: '/nope' }, exists })).toBeUndefined();
    expect(resolveClaudeBinary({ explicit: '/usr/bin/claude', env: {}, exists })).toBe('/usr/bin/claude');
    expect(resolveClaudeBinary({ explicit: 'claude', env: { PATH: '/usr/bin' }, exists })).toBe('/usr/bin/claude');
    // No probing of credential-adjacent locations.
    const probes: string[] = [];
    resolveClaudeBinary({
      explicit: undefined,
      env: { PATH: '/opt/bin' },
      exists: path => {
        probes.push(path);
        return false;
      },
    });
    for (const probe of probes) {
      expect(probe).not.toContain('.claude');
      expect(probe).not.toContain('.hermes');
      expect(probe).not.toContain('.config');
    }
  });

  it('pipes the CLI stderr and throws it away instead of inheriting it, and still kills the group', async () => {
    const clock = new FakeClock();
    const stderr = new PassThrough();
    const CANARY = 'CLI-STDERR-CANARY-0123456789';
    const killed: Array<{ pid: number; signal: string }> = [];
    let spawnOptions: Record<string, unknown> | undefined;
    const child: ChildLike = {
      pid: 4242,
      stdin: null,
      stdout: null,
      stderr,
      killed: false,
      exitCode: null,
      kill: () => true,
      on: () => child,
      once: () => child,
      off: () => child,
    };
    const spawner = new GroupSpawner({
      clock,
      killGraceMs: 5000,
      spawnChild: (_command, _args, options) => {
        spawnOptions = options as unknown as Record<string, unknown>;
        return child;
      },
      killGroup: (pid, signal) => {
        killed.push({ pid, signal });
        return true;
      },
    });

    // Bypass argv is refused before anything is spawned.
    expect(() => spawner.spawn({ command: 'claude', args: ['--dangerously-skip-permissions'], env: {} })).toThrow(
      /refused/,
    );
    expect(spawner.spawned).toHaveLength(0);

    const handle = spawner.spawn({ command: 'claude', args: ['--print'], env: {} });
    expect(spawnOptions?.detached).toBe(true);
    // stderr is piped, never inherited: the bridge owns the CLI's stderr.
    expect(spawnOptions?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(spawner.children).toHaveLength(1);

    stderr.write(`${CANARY}\n`);
    await settle();
    // The bytes were consumed (so the CLI cannot block on a full pipe) and
    // counted; nothing of the content is kept anywhere.
    expect(spawner.stderrBytes).toBe(CANARY.length + 1);
    expect(Object.keys(spawner)).not.toContain('stderrTail');
    expect(JSON.stringify(spawner.spawned)).not.toContain(CANARY);

    handle.terminate();
    handle.terminate();
    expect(killed).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    await clock.advance(6000);
    expect(killed).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
    expect(spawner.kills.map(kill => kill.scope)).toEqual(['group', 'group']);
  });
});

describe('error classification', () => {
  it('recognises auth and overflow evidence without inventing it', () => {
    expect(hasAuthEvidence('Not logged in · Please run /login')).toBe(true);
    expect(hasAuthEvidence('401 Unauthorized')).toBe(true);
    expect(hasAuthEvidence('something else entirely')).toBe(false);
    expect(hasAuthEvidence(undefined)).toBe(false);
    expect(hasOverflowEvidence('Prompt is too long: 250000 tokens > 200000 maximum')).toBe(true);
    expect(hasOverflowEvidence('input length and max_tokens exceed the context window')).toBe(true);
    expect(hasOverflowEvidence('the context window in my other error')).toBe(false);
    expect(classifyFailureText('please run /login', 'fallback').status).toBe(503);
    expect(classifyFailureText('prompt is too long', 'fallback').code).toBe('context_length_exceeded');
    expect(classifyFailureText('nothing', 'fallback').code).toBe('CLAUDE_BRIDGE_CLI_EXIT');
  });

  it('maps finish reasons the way Hermes expects', () => {
    expect(finishReasonFor('end_turn', false)).toBe('stop');
    expect(finishReasonFor('max_tokens', false)).toBe('length');
    expect(finishReasonFor('refusal', false)).toBe('content_filter');
    expect(finishReasonFor('end_turn', true)).toBe('tool_calls');
    expect(finishReasonFor(null, false)).toBe('stop');
  });

  it('derives usage from real fields only', () => {
    expect(mapUsage(undefined)).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(
      mapUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 1 }),
    ).toEqual({ prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 });
  });

  it('scrubs ambient credential env vars and CLAUDE_* before spawning', () => {
    const env = scrubEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/someone',
        CLAUDE_CONFIG_DIR: '/keep',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_API_KEY: 'do-not-pass',
        ANTHROPIC_AUTH_TOKEN: 'do-not-pass',
      },
      { MCP_TOOL_TIMEOUT: '1000' },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/someone');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/keep');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.MCP_TOOL_TIMEOUT).toBe('1000');
  });
});

describe('log field filter', () => {
  it('keeps allowlisted machine tokens and drops everything else', () => {
    const safe = sanitizeFields({
      requestId: 'abc123',
      model: 'claude-sonnet-5',
      status: 200,
      stream: true,
      count: 3,
    });
    expect(safe).toEqual({ requestId: 'abc123', model: 'claude-sonnet-5', status: 200, stream: true, count: 3 });

    expect(sanitizeFields({ message: 'hello world' })).toEqual({});
    expect(sanitizeFields({ requestId: 'has spaces' })).toEqual({});
    expect(sanitizeFields({ model: 'a'.repeat(200) })).toEqual({});
    expect(sanitizeFields({ model: { nested: 'object' } })).toEqual({});
    expect(sanitizeFields({ model: undefined })).toEqual({});
    expect(sanitizeFields({ procs: ['p1'] })).toEqual({});
    expect(LOG_ALLOWED_FIELDS.has('model')).toBe(true);
  });

  it('constrains every CLI/SDK/request-shaped field to a closed set or a bounded shape', () => {
    // Exactly these fields carry values the bridge does not author itself.
    expect([...LOG_CONSTRAINED_FIELDS].sort()).toEqual([
      'apiKeySource',
      'claudeCodeVersion',
      'effort',
      'kind',
      'model',
      'outcome',
      'phase',
      'subtype',
      'terminalReason',
    ]);
  });

  it('never logs a credential-shaped token through a constrained field', () => {
    // Both tokens are machine-token-shaped (`[A-Za-z0-9_.:@/+-]{1,64}`) and would
    // pass the generic shape check; the field rules are one thing that stops
    // them, and the credential-shape rule (below) is the other.
    const tokens = [CREDENTIAL_TOKEN, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2ln'];
    for (const token of tokens) {
      for (const field of LOG_CONSTRAINED_FIELDS) {
        expect(sanitizeFields({ [field]: token }), `${field} kept a credential-shaped value`).toEqual({});
      }
    }
    expect(sanitizeFields({ requestId: 'abcdef0123456789' })).toEqual({ requestId: 'abcdef0123456789' });
  });

  it('rejects a credential-shaped value in EVERY field name, allow-listed or not', () => {
    for (const token of CREDENTIAL_SHAPED) {
      // The rule is about the value's shape, not about which field carries it.
      expect(looksLikeCredential(token), `${token} is not recognised as credential-shaped`).toBe(true);
      for (const field of LOG_ALLOWED_FIELDS) {
        expect(sanitizeFields({ [field]: token }), `${field} kept ${token}`).toEqual({});
      }
      // A credential-shaped value in a cluster of legal fields is dropped alone,
      // so the rest of the line still tells the truth.
      expect(sanitizeFields({ requestId: 'abcdef0123456789', code: token, count: 2 })).toEqual({
        requestId: 'abcdef0123456789',
        count: 2,
      });
    }
    // Unlisted field names were already dropped; that is unchanged.
    expect(sanitizeFields({ notAField: CREDENTIAL_TOKEN })).toEqual({});
    // A realistic full-length JWT is rejected on its shape alone, and a PEM
    // header (which carries spaces) never passes the token shape either.
    expect(looksLikeCredential('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')).toBe(true);
    expect(sanitizeFields({ requestId: '-----BEGIN RSA PRIVATE KEY-----' })).toEqual({});
  });

  it('rejects a credential-shaped EVENT name, not just a credential-shaped field value', () => {
    const { logger, lines } = createMemoryLogger();
    for (const token of CREDENTIAL_SHAPED) {
      logger.log(token, { count: 1 });
      const line = lines.at(-1) ?? '';
      expect(line, `event ${token}`).not.toContain(token);
      expect(JSON.parse(line).event).toBe('invalid_event');
      // The rest of the line is still written: only the bad value is dropped.
      expect(JSON.parse(line).count).toBe(1);
    }
    // A normal event name — including every name the bridge actually uses — is
    // kept, as is a name that fails only the generic shape check.
    for (const event of ['request_ok', 'partial_tool_results_refused', 'bridge_listening', 'process_disposed']) {
      logger.log(event, { count: 1 });
      expect(JSON.parse(lines.at(-1) ?? '{}').event).toBe(event);
    }
    logger.log('event with spaces', { count: 1 });
    expect(JSON.parse(lines.at(-1) ?? '{}').event).toBe('invalid_event');
  });

  it('still keeps every legitimate value a log line is made of', () => {
    // The values that must survive the credential-shape rule: bridge codes, hex
    // request/proc ids, model ids, `code` slugs, versions and short enums.
    const legitimate = {
      requestId: '0123456789abcdef0123456789abcdef', // 32-char hex id
      procId: 'p12',
      code: 'CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS', // 33 chars, and still kept
      type: 'rate_limit_or_stall',
      phase: 'bundled',
      kind: 'conversation',
      model: 'claude-sonnet-5',
      outcome: 'tool_calls',
      subtype: 'compact_boundary',
      terminalReason: 'structured_output_retry_exhausted', // 33 chars, and still kept
      apiKeySource: 'oauth',
      claudeCodeVersion: '2.0.30',
      status: 200,
      count: 3,
      ms: 12,
      stream: true,
    };
    expect(sanitizeFields(legitimate)).toEqual(legitimate);
    for (const code of ['CLAUDE_BRIDGE_STALL', 'context_length_exceeded', 'idle-timeout', 'request-failed', 'capacity-evict', 'cli-exit']) {
      expect(sanitizeFields({ code }), `code ${code} was dropped`).toEqual({ code });
    }
    for (const id of ['abcdef0123456789', '0123456789abcdef0123456789abcdef', 'p1', 'req-0-1700000000000']) {
      expect(sanitizeFields({ requestId: id }), `id ${id} was dropped`).toEqual({ requestId: id });
    }
    for (const model of ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'none']) {
      expect(sanitizeFields({ model }), `model ${model} was dropped`).toEqual({ model });
    }
  });

  it('still keeps the real values those fields carry', () => {
    const fields = {
      apiKeySource: 'oauth',
      claudeCodeVersion: '2.0.30',
      subtype: 'init',
      terminalReason: 'prompt_too_long',
      kind: 'conversation',
      outcome: 'tool_calls',
      model: 'claude-sonnet-5',
      phase: 'bundled',
    };
    expect(sanitizeFields(fields)).toEqual(fields);
    // The bridge's own labels for --fake mode are kept too.
    expect(sanitizeFields({ apiKeySource: 'fake', phase: 'scripted', kind: 'fake', model: 'none' })).toEqual({
      apiKeySource: 'fake',
      phase: 'scripted',
      kind: 'fake',
      model: 'none',
    });
    // A version-shaped value that is not a version, or an SDK enum we do not
    // know, is dropped rather than guessed at.
    expect(sanitizeFields({ claudeCodeVersion: '2.0.30 (Claude Code)' })).toEqual({});
    // …and so is a value that passes the generic token shape but is not
    // version-shaped: the shape rule is what `claudeCodeVersion` adds.
    expect(sanitizeFields({ claudeCodeVersion: '2.0.30-beta-extra-long-suffix' })).toEqual({});
    expect(sanitizeFields({ terminalReason: 'something-new' })).toEqual({});
  });
});
