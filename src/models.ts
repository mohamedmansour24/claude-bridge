/**
 * The model ids this bridge exposes and their 1:1 mapping onto the Agent SDK's
 * model identifiers (SPEC.md: "map 1:1 to the SDK's model"). The SDK takes the
 * model string through `Options.model`; the ids below are the same strings.
 */

export const EXPOSED_MODEL_IDS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
] as const;

export type ExposedModelId = (typeof EXPOSED_MODEL_IDS)[number];

export const DEFAULT_AUX_MODEL: ExposedModelId = 'claude-haiku-4-5';

/**
 * Identity mapping, spelled out so the "1:1" claim is checkable rather than
 * implied. Returns undefined for an id this bridge does not expose.
 */
export function sdkModelFor(id: string): string | undefined {
  return (EXPOSED_MODEL_IDS as readonly string[]).includes(id) ? id : undefined;
}

export function isExposedModel(id: unknown): id is ExposedModelId {
  return typeof id === 'string' && (EXPOSED_MODEL_IDS as readonly string[]).includes(id);
}
