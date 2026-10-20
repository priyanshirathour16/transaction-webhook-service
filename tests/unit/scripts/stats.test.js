import { describe, expect, it } from 'vitest';
import { formatMs, percentile, summarizeLatencies } from '../../../scripts/lib/stats.js';

describe('percentile (nearest rank)', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

  it.each([
    [50, 50],
    [90, 90],
    [95, 95],
    [99, 99],
    [100, 100],
  ])('p%i of 1..100 is %i', (p, expected) => {
    expect(percentile(hundred, p)).toBe(expected);
  });

  it('handles tiny samples without going out of range', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, 2], 0)).toBe(1);
    expect(percentile([1, 2], 100)).toBe(2);
  });

  it('returns NaN for no data', () => {
    expect(percentile([], 95)).toBeNaN();
  });
});

describe('summarizeLatencies', () => {
  it('sorts the input and does not mutate it', () => {
    const input = [30, 10, 20];
    const summary = summarizeLatencies(input);

    expect(summary).toMatchObject({ count: 3, min: 10, p50: 20, max: 30 });
    expect(input).toEqual([30, 10, 20]);
  });

  it('reports NaN extremes for an empty sample', () => {
    expect(summarizeLatencies([])).toMatchObject({ count: 0, min: Number.NaN, max: Number.NaN });
  });
});

describe('formatMs', () => {
  it('rounds to whole milliseconds and tolerates missing values', () => {
    expect(formatMs(12.6)).toBe('13 ms');
    expect(formatMs(Number.NaN)).toBe('n/a');
  });
});
