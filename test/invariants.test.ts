/**
 * Structural guards for the hard invariants.
 *
 * These read the project's own source (the bridge never reads a credential, and
 * these tests prove the source cannot): the only filesystem calls in `src/` are
 * the ones that create and remove the private temp dir and check that a binary
 * is executable, and no source file names a credential-adjacent path.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOG_ALLOWED_FIELDS, LOG_CONSTRAINED_FIELDS } from '../src/log.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function filesUnder(relative: string, extension = '.ts'): string[] {
  const dir = join(root, relative);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, extension));
    else if (entry.name.endsWith(extension)) out.push(path);
  }
  return out;
}

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

/** Statements, not comments: strip line comments before matching. */
function code(text: string): string {
  return text
    .split('\n')
    .map(line => (line.trim().startsWith('*') || line.trim().startsWith('//') ? '' : line.split('//')[0] ?? ''))
    .join('\n');
}

describe('invariant 1: no credential is ever reachable from this source', () => {
  const forbidden = [
    '.claude/',
    '~/.claude',
    '.hermes',
    '.codex',
    '.gemini',
    '.zcode',
    'auth.json',
    'credentials.json',
    'keychain',
    'api.anthropic.com',
    'ANTHROPIC_AUTH_TOKEN=',
  ];

  it('names no credential-adjacent path anywhere in src/', () => {
    for (const file of filesUnder('src')) {
      const text = code(read(file)).toLowerCase();
      for (const token of forbidden) {
        expect(text.includes(token.toLowerCase()), `${file} mentions ${token}`).toBe(false);
      }
    }
  });

  it('imports no file-reading API', () => {
    const readers = ['readfile', 'readfilesync', 'createreadstream', 'readdir', 'openSync', 'existsSync', 'execFile'];
    for (const file of filesUnder('src')) {
      const text = code(read(file));
      for (const reader of readers) {
        expect(text.toLowerCase().includes(reader.toLowerCase()), `${file} uses ${reader}`).toBe(false);
      }
    }
  });

  it('touches only the temp dir and an executable check on the filesystem', () => {
    const allowedFsApis = new Set([
      'mkdir',
      'mkdtemp',
      'chmod',
      'rm',
      'stat',
      'accessSync',
      'statSync',
      'constants',
    ]);
    for (const file of filesUnder('src')) {
      const text = code(read(file));
      for (const match of text.matchAll(/import \{([^}]*)\} from 'node:(fs|fs\/promises)'/g)) {
        for (const name of (match[1] ?? '').split(',').map(entry => entry.trim()).filter(Boolean)) {
          expect(allowedFsApis.has(name), `${file} imports ${name} from node:${match[2]}`).toBe(true);
        }
      }
    }
  });

  it('reaches the Agent SDK at runtime from exactly one module', () => {
    for (const file of filesUnder('src')) {
      const lines = read(file).split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]?.includes("'@anthropic-ai/claude-agent-sdk'")) continue;
        let statement = '';
        for (let j = i; j >= 0 && j > i - 6; j -= 1) {
          if (lines[j]?.trimStart().startsWith('import')) {
            statement = lines[j]?.trim() ?? '';
            break;
          }
        }
        const typeOnly = statement.startsWith('import type');
        expect(typeOnly || file === 'src/real-query.ts', `${file}:${i + 1} imports the SDK as a value`).toBe(true);
      }
    }
  });

  it('never loads the Agent SDK inside the test suite', () => {
    // This scanner quotes the package name by design; it is not a consumer.
    for (const file of filesUnder('test').filter(entry => entry !== 'test/invariants.test.ts')) {
      const lines = read(file).split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]?.includes("'@anthropic-ai/claude-agent-sdk'")) continue;
        let statement = '';
        for (let j = i; j >= 0 && j > i - 6; j -= 1) {
          if (lines[j]?.trimStart().startsWith('import')) {
            statement = lines[j]?.trim() ?? '';
            break;
          }
        }
        expect(statement.startsWith('import type'), `${file}:${i + 1} loads the real SDK in a test`).toBe(true);
      }
    }
  });

  it('spawns only from src/spawn.ts, and no test spawns anything', () => {
    for (const file of filesUnder('src')) {
      const text = code(read(file));
      const spawns = /from 'node:child_process'/.test(text);
      expect(spawns, `${file} imports node:child_process`).toBe(file === 'src/spawn.ts');
    }
    // This scanner quotes the module name by design; it is not a consumer.
    for (const file of filesUnder('test').filter(entry => entry !== 'test/invariants.test.ts')) {
      expect(/node:child_process/.test(code(read(file))), `${file} imports node:child_process`).toBe(false);
    }
  });
});

describe('dependency surface', () => {
  it('declares only the allowed runtime and dev dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@modelcontextprotocol/sdk',
    ]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['@types/node', 'typescript', 'vitest']);
    expect(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.241');
  });
});

describe('invariant 3: nothing in the source enables Claude execution', () => {
  it('never mentions a permission-bypass mode outside the refusal list', () => {
    // A bare quoted flag literal is part of the refusal list; anything else has
    // to be a comment or live in the one module that refuses argv.
    const bareFlagLiteral = /^'--[a-z-]*dangerously[a-z-]*'?=?',?$/;
    const mentionsBypass = (trimmed: string): boolean =>
      trimmed.includes('bypassPermissions') || trimmed.includes('dangerously');
    for (const file of filesUnder('src')) {
      for (const line of read(file).split('\n')) {
        const trimmed = line.trim();
        if (!mentionsBypass(trimmed)) continue;
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
        const isRefusalList = file === 'src/spawn.ts' && (bareFlagLiteral.test(trimmed) || /BYPASS_FLAGS|refused|permission-bypass|value !== 'default'/.test(trimmed));
        expect(isComment || isRefusalList, `${file}: ${trimmed}`).toBe(true);
      }
    }
    // bypassPermissions may only be named where it is refused or explained.
    for (const file of filesUnder('src')) {
      if (file === 'src/spawn.ts') continue;
      const text = code(read(file));
      expect(text.includes('bypassPermissions'), `${file} names bypassPermissions outside spawn.ts`).toBe(false);
    }
  });
});

describe('log filter reachability', () => {
  it('keeps the allowlist small and content-free', () => {
    for (const forbidden of ['content', 'message', 'text', 'arguments', 'result', 'prompt', 'toolName']) {
      expect(LOG_ALLOWED_FIELDS.has(forbidden), `allowlist contains ${forbidden}`).toBe(false);
    }
  });

  it('constrains every field that can carry a CLI/SDK/request value', () => {
    // A field whose value the bridge does not author itself must be closed-set or
    // version-shaped, so a credential-shaped token can never be logged verbatim.
    for (const field of ['apiKeySource', 'claudeCodeVersion', 'subtype', 'terminalReason', 'kind', 'outcome', 'model']) {
      expect(LOG_CONSTRAINED_FIELDS.has(field), `${field} is not constrained`).toBe(true);
    }
    // And the closed sets live in src/log.ts, not in a caller's discipline.
    const source = read('src/log.ts');
    expect(source).toContain('ENUM_FIELDS');
    expect(source).toContain('VERSION_SHAPE');
  });
});
