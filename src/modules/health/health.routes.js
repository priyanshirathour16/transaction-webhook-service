import { Router } from 'express';
import { createHealthController } from './health.controller.js';

/** @param {{ now?: () => Date }} [deps] */
export function createHealthRouter(deps) {
  const router = Router();
  router.get('/', createHealthController(deps).getHealth);
  return router;
}
