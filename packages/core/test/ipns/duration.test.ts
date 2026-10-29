import { describe, expect, it } from 'vitest';
import { parseDurationMs } from '../../src/ipns/duration.js';

describe('parseDurationMs', () => {
  it.each([
    ['500ms', 500],
    ['10s', 10_000],
    ['5m', 300_000],
    ['24h', 86_400_000],
    ['1h30m', 5_400_000],
    ['1.5s', 1_500],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(['', '10', 's', '10x', '1h 30m', '-5s'])('rejects %j', (input) => {
    expect(() => parseDurationMs(input)).toThrow(/Invalid duration/);
  });
});
