import { Router } from 'express';
import { getFxRates } from '../lib/fxRates.js';

const router = Router();

/** Public display-only exchange rates (base ZAR). Charging always happens in ZAR. */
router.get('/rates', async (_req, res, next) => {
  try {
    const payload = await getFxRates();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

export default router;
