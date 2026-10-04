/**
 * Reasoning effort: request field -> Agent SDK `Options.effort` (EffortLevel).
 *
 * Accepted request shapes (OpenAI / OpenRouter style; Hermes sends
 * `extra_body.reasoning = {enabled, effort}`):
 *   - `reasoning: { effort: "<level>", enabled?: boolean }`
 *   - top-level `reasoning_effort: "<level>"`
 * `reasoning.effort` wins when both are present.
 *
 * Level mapping: none|minimal|low -> low; medium; high; xhigh; max.
 * `reasoning.enabled === false` with no explicit effort -> low.
 * Anything else is a 400 (never silently ignored).
 */

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_EFFORT: EffortLevel = 'medium';

const ALIASES: Readonly<Record<string, EffortLevel>> = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** Returns the mapped level, or undefined when the value is not a known level. */
export function parseEffortValue(raw: unknown): EffortLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  return ALIASES[raw.trim().toLowerCase()];
}

export type EffortRequest =
  | { readonly kind: 'absent' }
  | { readonly kind: 'level'; readonly level: EffortLevel }
  | { readonly kind: 'invalid' };

export function readRequestEffort(request: { reasoning?: unknown; reasoning_effort?: unknown }): EffortRequest {
  const { reasoning, reasoning_effort: top } = request;
  if (reasoning !== undefined && reasoning !== null) {
    if (typeof reasoning !== 'object' || Array.isArray(reasoning)) return { kind: 'invalid' };
    const { effort, enabled } = reasoning as { effort?: unknown; enabled?: unknown };
    if (effort !== undefined && effort !== null) {
      const level = parseEffortValue(effort);
      return level === undefined ? { kind: 'invalid' } : { kind: 'level', level };
    }
    if (enabled === false) return { kind: 'level', level: 'low' };
  }
  if (top !== undefined && top !== null) {
    const level = parseEffortValue(top);
    return level === undefined ? { kind: 'invalid' } : { kind: 'level', level };
  }
  return { kind: 'absent' };
}

/** CLAUDE_BRIDGE_EFFORT_<MODEL_ID_UPPER_WITH_UNDERSCORES>, e.g. CLAUDE_BRIDGE_EFFORT_CLAUDE_OPUS_5_5. */
export function effortEnvName(modelId: string): string {
  return `CLAUDE_BRIDGE_EFFORT_${modelId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function parseConfiguredEffort(raw: string | undefined, name: string): EffortLevel | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const level = parseEffortValue(raw);
  if (level === undefined) {
    throw new Error(`claude-bridge: ${name} must be one of ${Object.keys(ALIASES).join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return level;
}
