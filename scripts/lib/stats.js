/**
 * Percentile by the nearest-rank method (what most load-testing tools report).
 *
 * @param {number[]} sortedAscending
 * @param {number} percentile  0–100
 */
export function percentile(sortedAscending, percentile) {
  if (sortedAscending.length === 0) return Number.NaN;
  const rank = Math.ceil((percentile / 100) * sortedAscending.length);
  return sortedAscending[Math.min(Math.max(rank, 1), sortedAscending.length) - 1];
}

/**
 * @param {number[]} values  latencies in milliseconds, any order
 */
export function summarizeLatencies(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

/** @param {number[]} values */
export function median(values) {
  return percentile(
    [...values].sort((a, b) => a - b),
    50,
  );
}

/** @param {number} ms */
export const formatMs = (ms) => (Number.isFinite(ms) ? `${ms.toFixed(0)} ms` : 'n/a');
