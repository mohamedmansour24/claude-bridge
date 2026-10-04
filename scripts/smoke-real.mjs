#!/usr/bin/env node
/**
 * claude-bridge real-binary smoke test — the OWNER runs this, the build agent does not.
 *
 * It is the ONLY script in this project that may touch the real `claude` binary.
 * It starts the real bridge as a child process (exactly the documented start
 * command), drives it over the OpenAI Chat Completions wire the way Hermes
 * does, and prints PASS/FAIL per step plus the SDK and CLI versions. It never
 * prints, reads or derives anything from a credential or a login file.
 *
 *   cd claude-bridge
 *   npm install
 *   npm run build
 *   node scripts/smoke-real.mjs
 *
 * Requires an already-signed-in `claude` (or CLAUDE_BRIDGE_CLAUDE_PATH). The
 * bridge spawns the first official CLI it finds — CLAUDE_BRIDGE_CLAUDE_PATH,
 * then `claude` on PATH, then the CLI bundled with the Agent SDK — and this
 * script prints the bridge's own startup line so you can see which one it used.
 * If it reports NOT_SIGNED_IN, run `claude` once in a terminal and sign in.
 *
 * Env:
 *   CLAUDE_BRIDGE_CLAUDE_PATH  explicit path to the official claude binary
 *   CLAUDE_BRIDGE_KEY          reused if set; otherwise a throwaway key is
 *                              generated for this smoke run and never printed
 *   SMOKE_PORT                 port for the child bridge (default: a free port)
 *   SMOKE_TIMEOUT_MS           per-step timeout (default 180000)
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

const KEY = process.env.CLAUDE_BRIDGE_KEY ?? `smoke-${randomBytes(24).toString('hex')}`;
const KEY_WAS_GENERATED = process.env.CLAUDE_BRIDGE_KEY === undefined;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const MODEL = process.env.SMOKE_MODEL ?? 'claude-sonnet-5';

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function sdkVersions() {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
    return { sdk: pkg.version, bundledCli: pkg.claudeCodeVersion };
  } catch {
    return { sdk: 'unknown', bundledCli: 'unknown' };
  }
}

async function freePort() {
  if (process.env.SMOKE_PORT) return Number(process.env.SMOKE_PORT);
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

class SseReader {
  constructor(response) {
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.frames = [];
    this.done = false;
  }

  async readAll() {
    for (;;) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.buffer += this.decoder.decode(value, { stream: true });
      let index = this.buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.consume(block);
        index = this.buffer.indexOf('\n\n');
      }
    }
    if (this.buffer.trim().length > 0) this.consume(this.buffer);
    return this.frames;
  }

  consume(block) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        this.done = true;
        continue;
      }
      try {
        this.frames.push(JSON.parse(payload));
      } catch {
        this.frames.push({ __unparsed: payload });
      }
    }
  }
}

function assemble(frames) {
  let text = '';
  let finishReason = null;
  let usage;
  const calls = new Map();
  for (const frame of frames) {
    if (frame.usage) usage = frame.usage;
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
    if (choice === undefined) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (typeof choice.delta?.content === 'string') text += choice.delta.content;
    for (const delta of choice.delta?.tool_calls ?? []) {
      const entry = calls.get(delta.index) ?? { index: delta.index, id: '', name: '', args: '' };
      if (delta.id) entry.id = delta.id;
      if (delta.function?.name) entry.name = delta.function.name;
      if (typeof delta.function?.arguments === 'string') entry.args += delta.function.arguments;
      calls.set(delta.index, entry);
    }
  }
  return { text, finishReason, usage, calls: [...calls.values()].sort((a, b) => a.index - b.index) };
}

async function post(port, body, label) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 400) };
    }
    return { ok: false, status: response.status, error: parsed?.error, label };
  }
  if (body.stream) {
    const reader = new SseReader(response);
    const frames = await reader.readAll();
    return { ok: true, ...assemble(frames), sawDone: reader.done, frameCount: frames.length, label };
  }
  const parsed = await response.json();
  const choice = parsed.choices?.[0];
  return {
    ok: true,
    text: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: parsed.usage,
    calls: (choice?.message?.tool_calls ?? []).map((call, index) => ({
      index,
      id: call.id,
      name: call.function?.name ?? '',
      args: call.function?.arguments ?? '{}',
    })),
    sawDone: true,
    frameCount: 1,
    label,
  };
}

async function waitForHealth(port, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return `the bridge exited with code ${child.exitCode}`;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return null;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return 'the bridge did not answer /healthz in time';
}

const VERSIONS = sdkVersions();
process.stdout.write('claude-bridge real-binary smoke test\n');
process.stdout.write(`  @anthropic-ai/claude-agent-sdk ${VERSIONS.sdk} (bundles Claude Code ${VERSIONS.bundledCli})\n`);
process.stdout.write(`  model under test: ${MODEL}\n`);
if (KEY_WAS_GENERATED) {
  process.stdout.write('  CLAUDE_BRIDGE_KEY was not set: a throwaway key was generated for this run (value never printed)\n');
}

if (!existsSync(join(rootDir, 'dist/server.js'))) {
  record('build present', false, 'dist/server.js is missing — run `npm run build` first');
  process.exitCode = 1;
  process.exit(1);
}

const port = await freePort();
const child = spawn(process.execPath, [join(rootDir, 'dist/server.js'), '--port', String(port)], {
  cwd: rootDir,
  env: {
    ...process.env,
    CLAUDE_BRIDGE_KEY: KEY,
    // The smoke keeps its own stderr noise out of the way of its exit path.
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childStderr = '';
let printedStartupLine = false;
child.stderr.on('data', chunk => {
  childStderr += chunk.toString('utf8');
  // Which official CLI the bridge decided to spawn (its own startup line), and
  // its own structured lines — which never carry content.
  if (!printedStartupLine) {
    const match = /(claude-bridge: listening on[^\n]*)/.exec(childStderr);
    if (match !== null) {
      printedStartupLine = true;
      process.stdout.write(`  ${match[1]}\n`);
    }
  }
  for (const line of chunk.toString('utf8').split('\n')) {
    if (line.includes('"event":"cli_init"')) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.claudeCodeVersion === 'string') {
          process.stdout.write(`  CLI version reported by the session: ${parsed.claudeCodeVersion}\n`);
        }
      } catch {
        // ignore
      }
    }
  }
});

const startupProblem = await waitForHealth(port, child);
if (startupProblem !== null) {
  record('bridge starts with the real claude binary', false, startupProblem);
  process.stdout.write(`\n--- bridge stderr (last 2000 chars) ---\n${childStderr.slice(-2000)}\n`);
  child.kill('SIGTERM');
  process.exitCode = 1;
  process.exit(1);
}
record('bridge starts with the real claude binary', true, `http://127.0.0.1:${port}/v1`);

try {
  // ---------------------------------------------------------------- step (a)
  const a = await post(
    port,
    {
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'You are being smoke-tested. Reply in one short sentence.' },
        { role: 'user', content: 'Say the words BRIDGE-OK and nothing else.' },
      ],
    },
    'a',
  );
  const aOk = a.ok && typeof a.text === 'string' && a.text.trim().length > 0 && a.sawDone && a.finishReason !== null;
  record(
    'a) one prompt with tools off streams text',
    aOk,
    a.ok
      ? `${a.frameCount} frames, finish_reason=${a.finishReason}, usage=${JSON.stringify(a.usage ?? null)}, reply=${JSON.stringify(a.text.slice(0, 120))}`
      : `HTTP ${a.status} ${JSON.stringify(a.error)}`,
  );
  if (a.ok && !a.text.includes('BRIDGE-OK')) {
    process.stdout.write('      note: the model did not echo BRIDGE-OK verbatim; a non-empty streamed reply is what this step checks.\n');
  }

  // ---------------------------------------------------------------- step (b)
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Return the current time as the caller knows it. The caller runs this tool, not you.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
  const b1 = await post(
    port,
    {
      model: MODEL,
      stream: true,
      tools,
      messages: [
        { role: 'system', content: 'A get_time tool is available. Call it when asked for the time, then report what it returned.' },
        { role: 'user', content: 'What time is it? Call the get_time tool.' },
      ],
    },
    'b1',
  );
  const call = b1.ok ? b1.calls.find(entry => entry.name === 'get_time') : undefined;
  record(
    'b) Claude calls the bridged get_time tool',
    call !== undefined,
    b1.ok ? `finish_reason=${b1.finishReason}, tool_calls=${JSON.stringify(b1.calls.map(entry => entry.name))}` : `HTTP ${b1.status} ${JSON.stringify(b1.error)}`,
  );

  if (call !== undefined) {
    process.stdout.write('      parking the call for 5 s (as Hermes would while a human approves)...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
    const b2 = await post(
      port,
      {
        model: MODEL,
        stream: true,
        tools,
        messages: [
          { role: 'system', content: 'A get_time tool is available. Call it when asked for the time, then report what it returned.' },
          { role: 'user', content: 'What time is it? Call the get_time tool.' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: call.id, type: 'function', function: { name: 'get_time', arguments: call.args || '{}' } }],
          },
          { role: 'tool', tool_call_id: call.id, content: '12:00' },
        ],
      },
      'b2',
    );
    const b2Ok = b2.ok && typeof b2.text === 'string' && b2.text.includes('12:00');
    record(
      'b) the parked call resumes in the same process and the final answer contains 12:00',
      b2Ok,
      b2.ok ? `finish_reason=${b2.finishReason}, reply=${JSON.stringify(b2.text.slice(0, 160))}` : `HTTP ${b2.status} ${JSON.stringify(b2.error)}`,
    );
  }

  // ---------------------------------------------------------------- step (c)
  const canary = join(tmpdir(), `claude-bridge-smoke-${randomBytes(6).toString('hex')}.txt`);
  const c1 = await post(
    port,
    {
      model: MODEL,
      stream: true,
      messages: [
        {
          role: 'system',
          content:
            'You have no tools in this session. If asked to run a shell command or create a file, say plainly that you cannot.',
        },
        {
          role: 'user',
          content: `Use your Bash and Write tools to create the file ${canary} containing exactly HELLO, then run \`ls\` and paste the output.`,
        },
      ],
    },
    'c1',
  );
  const noToolCalls = c1.ok ? c1.calls.length === 0 : false;
  const noFileCreated = !existsSync(canary);
  record(
    'c) Claude has no built-in tools: nothing was called and no file appeared',
    noToolCalls && noFileCreated,
    `tool_calls=${c1.ok ? c1.calls.length : 'n/a'}, file_created=${!noFileCreated}, reply=${JSON.stringify((c1.text ?? '').slice(0, 160))}`,
  );
} catch (error) {
  record('smoke run completed', false, `${error?.name ?? 'error'}: ${error?.message ?? String(error)}`);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill('SIGKILL');
}

const failed = results.filter(result => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} steps passed\n`);
if (failed.length > 0) {
  process.stdout.write('FAILURES:\n');
  for (const result of failed) process.stdout.write(`  - ${result.name}: ${result.detail}\n`);
  process.stdout.write(
    '\nIf a step failed with CLAUDE_BRIDGE_NOT_SIGNED_IN: run `claude` once in a terminal and sign in, then run this again.\n',
  );
}
process.exitCode = failed.length === 0 ? 0 : 1;
