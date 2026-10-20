/**
 * Health check: deliberately makes no dependency calls, so it stays instant and cannot flap.
 *
 * @param {{ now?: () => Date }} [deps]
 */
export function createHealthController({ now = () => new Date() } = {}) {
  return {
    getHealth: (_req, res) => {
      res.json({ status: 'HEALTHY', current_time: now().toISOString() });
    },
  };
}
