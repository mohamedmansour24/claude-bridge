import { describe, expect, it } from 'vitest';
import { EXPOSED_MODEL_IDS, isExposedModel, sdkModelFor } from '../src/models.js';

describe('Opus 5.5 is exposed (owner request 2026-09-24)', () => {
  it('lists claude-opus-5-5 and maps it 1:1', () => {
    expect(EXPOSED_MODEL_IDS).toContain('claude-opus-5-5');
    expect(isExposedModel('claude-opus-5-5')).toBe(true);
    expect(sdkModelFor('claude-opus-5-5')).toBe('claude-opus-5-5');
  });
  it('still refuses an unknown id', () => {
    expect(sdkModelFor('claude-opus-9')).toBeUndefined();
  });
});
