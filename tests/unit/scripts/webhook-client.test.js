import { describe, expect, it } from 'vitest';
import { parseServerTiming } from '../../../scripts/lib/webhook-client.js';

describe('parseServerTiming', () => {
  it('reads the application time from a Server-Timing header', () => {
    expect(parseServerTiming('app;dur=12.3')).toBe(12.3);
    expect(parseServerTiming('app;dur=7')).toBe(7);
  });

  it('finds it among other metrics (a proxy may add its own)', () => {
    expect(parseServerTiming('cdn-cache;desc=MISS, app;dur=41.5, edge;dur=2')).toBe(41.5);
    expect(parseServerTiming('app;desc="handler";dur=9.9')).toBe(9.9);
  });

  it('is not fooled by another metric whose name merely ends in "app"', () => {
    expect(parseServerTiming('webapp;dur=500')).toBeUndefined();
  });

  it('returns undefined when the header is missing or has no app metric', () => {
    expect(parseServerTiming(undefined)).toBeUndefined();
    expect(parseServerTiming(null)).toBeUndefined();
    expect(parseServerTiming('')).toBeUndefined();
    expect(parseServerTiming('db;dur=3')).toBeUndefined();
    expect(parseServerTiming('app')).toBeUndefined();
  });
});
