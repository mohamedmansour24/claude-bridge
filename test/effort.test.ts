import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { effortEnvName, parseEffortValue, readRequestEffort } from '../src/effort.js';
import { Pipeline, TEST_KEY, userMessage } from './harness.js';

const pipelines: Pipeline[] = [];
function pipeline(options: ConstructorParameters<typeof Pipeline>[0] = {}): Pipeline {
  const created = new Pipeline({ program: [[{ kind: 'text', text: 'x' }]], ...options });
  pipelines.push(created);
  return created;
}
afterEach(async () => {
  await Promise.all(pipelines.splice(0).map(entry => entry.shutdown()));
});

const MSGS = [userMessage('hi')];

describe('effort mapping', () => {
  it('maps levels and aliases', () => {
    expect(parseEffortValue('none')).toBe('low');
    expect(parseEffortValue('minimal')).toBe('low');
    expect(parseEffortValue('Medium')).toBe('medium');
    expect(parseEffortValue('xhigh')).toBe('xhigh');
    expect(parseEffortValue('max')).toBe('max');
    expect(parseEffortValue('turbo')).toBeUndefined();
    expect(parseEffortValue(3)).toBeUndefined();
  });

  it('reads reasoning.effort, reasoning_effort, enabled:false, absent, invalid', () => {
    expect(readRequestEffort({ reasoning: { enabled: true, effort: 'high' } })).toEqual({ kind: 'level', level: 'high' });
    expect(readRequestEffort({ reasoning_effort: 'low' })).toEqual({ kind: 'level', level: 'low' });
    expect(readRequestEffort({ reasoning: { effort: 'high' }, reasoning_effort: 'low' })).toEqual({ kind: 'level', level: 'high' });
    expect(readRequestEffort({ reasoning: { enabled: false } })).toEqual({ kind: 'level', level: 'low' });
    expect(readRequestEffort({})).toEqual({ kind: 'absent' });
    expect(readRequestEffort({ reasoning: { effort: 'bogus' } })).toEqual({ kind: 'invalid' });
    expect(readRequestEffort({ reasoning: 'high' })).toEqual({ kind: 'invalid' });
    expect(readRequestEffort({ reasoning_effort: 7 })).toEqual({ kind: 'invalid' });
  });

  it('builds the per-model env name', () => {
    expect(effortEnvName('claude-opus-5-5')).toBe('CLAUDE_BRIDGE_EFFORT_CLAUDE_OPUS_5_5');
  });
});

describe('effort config', () => {
  const base = { CLAUDE_BRIDGE_KEY: TEST_KEY };
  it('defaults to medium', () => {
    const cfg = loadConfig({ env: base, argv: [] });
    expect(cfg.defaultEffort).toBe('medium');
    expect(cfg.modelEfforts).toEqual({});
  });
  it('reads default and per-model overrides, rejects junk', () => {
    const cfg = loadConfig({
      env: { ...base, CLAUDE_BRIDGE_DEFAULT_EFFORT: 'low', CLAUDE_BRIDGE_EFFORT_CLAUDE_OPUS_5_5: 'high' },
      argv: [],
    });
    expect(cfg.defaultEffort).toBe('low');
    expect(cfg.modelEfforts).toEqual({ 'claude-opus-5-5': 'high' });
    expect(() => loadConfig({ env: { ...base, CLAUDE_BRIDGE_DEFAULT_EFFORT: 'warp' }, argv: [] })).toThrow(/DEFAULT_EFFORT/);
  });
});

describe('effort reaches the SDK options', () => {
  it('defaults to medium and logs it', async () => {
    const bridge = pipeline();
    const result = await bridge.post({ model: 'claude-opus-5', messages: MSGS });
    expect(result.error).toBeUndefined();
    expect(bridge.factory.calls[0]?.options.effort).toBe('medium');
    expect(bridge.logLines.join('\n')).toContain('"effort":"medium"');
  });

  it('honours reasoning.effort and reasoning_effort', async () => {
    const a = pipeline();
    await a.post({ model: 'claude-opus-5', messages: MSGS, reasoning: { enabled: true, effort: 'high' } });
    expect(a.factory.calls[0]?.options.effort).toBe('high');
    const b = pipeline();
    await b.post({ model: 'claude-opus-5', messages: MSGS, reasoning_effort: 'xhigh' });
    expect(b.factory.calls[0]?.options.effort).toBe('xhigh');
  });

  it('uses the configured default and the per-model override', async () => {
    const a = pipeline({ config: { defaultEffort: 'low', modelEfforts: { 'claude-opus-5-5': 'high' } } });
    await a.post({ model: 'claude-sonnet-5', messages: MSGS });
    expect(a.factory.calls[0]?.options.effort).toBe('low');
    const b = pipeline({ config: { defaultEffort: 'low', modelEfforts: { 'claude-opus-5-5': 'high' } } });
    await b.post({ model: 'claude-opus-5-5', messages: MSGS });
    expect(b.factory.calls[0]?.options.effort).toBe('high');
  });

  it('refuses an invalid value with 400 and starts no process', async () => {
    const bridge = pipeline();
    const result = await bridge.post({ model: 'claude-opus-5', messages: MSGS, reasoning: { effort: 'bogus' } });
    expect(result.error?.status).toBe(400);
    expect(bridge.factory.calls).toHaveLength(0);
  });
});
