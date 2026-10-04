/**
 * The only module in the project that reaches the real Agent SDK `query()`.
 *
 * Invariant 1: this is the sole route to Claude. `query()` spawns the official
 * `claude` binary (whose own login it uses); the bridge itself never reads a
 * credential, never opens a login directory and never calls a model API.
 *
 * Kept in its own module so nothing else — in particular the test suite —
 * pulls the SDK in at module load.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFactory } from './process.js';

export const officialQuery: QueryFactory = input =>
  query({ prompt: input.prompt, options: input.options });
