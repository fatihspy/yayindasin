import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { runPrompt, AiError } from './ai.js';

const VOICE_KEY = /^[a-z0-9_]{1,48}$/;
const AUDIO_MIME = /^(audio\/[a-z0-9.+-]+|video\/(webm|mp4))$/i;

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function createApp(store) {
  const app = express();
  app.set('trust proxy', config.trustProxy === 'false' ? false : isNaN(+config.trustProxy) ? config.trustProxy : +config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    allowedHeaders: ['Content-Type', 'X-App-Key', 'X-Trainer-Key'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
    maxAge: 86400,
  }));

  app.get('/health', (req, res) => res.json({ ok: true, ai: !!config.anthropicKey, storage: store.kind }));

  // Every /api call must carry the app key when one is configured.
  // Exception: audio files, because an <audio src> request cannot carry custom headers.
  app.use('/api', (req, res, next) => {
    if (!config.appKey || same(req.get('x-app-key'), config.appKey)) return next();
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/voices\/[a-z0-9_]+\/audio$/.test(req.path)) return next();
    res.status(401).json({ code: 'not_granted' });
  });

  const isTrainer = req => !!config.trainerKey && same(req.get('x-trainer-key'), config.trainerKey);
  const trainerOnly = (req, res, next) => isTrainer(req) ? next() : res.status(403).json({ code: 'not_trainer' });

  /* ---------------- AI ---------------- */
  const limitMsg = { code: 'rate_limited' };
  const aiMinute = rateLimit({ windowMs: 60_000, limit: config.aiPerMinute, standardHeaders: 'draft-8', legacyHeaders: false, message: limitMsg });
  const aiDay = rateLimit({ windowMs: 86_400_000, limit: config.aiPerDay, standardHeaders: false, legacyHeaders: false, message: { code: 'usage_limited' } });

  app.post('/api/ai', aiMinute, aiDay, express.json({ limit: '128kb' }), async (req, res) => {
    const { prompt, mode, tier } = req.body || {};
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const out = await runPrompt({ prompt, mode: mode === 'json' ? 'json' : 'text', tier: tier === 'quick' ? 'quick' : 'default', signal: ac.signal });
      res.json(mode === 'json' ? { data: out } : { text: out });
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('upstream', 502, e.message);
      if (err.code !== 'aborted') console.warn('[ai]', err.code, err.message);
      if (!res.headersSent && !res.writableEnded) res.status(err.status || 502).json({ code: err.code });
    }
  });

  /* ---------------- trainer voices ---------------- */
  app.get('/api/trainer', (req, res) => res.json({ trainer: isTrainer(req) }));

  app.get('/api/voices', async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json({ voices: await store.list() });
  });

  app.get('/api/voices/:key/audio', async (req, res) => {
    const { key } = req.params;
    if (!VOICE_KEY.test(key)) return res.status(400).end();
    const m = await store.meta(key);
    if (!m) return res.status(404).end();
    res.set({ 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${key}-${m.at}"` });
    if (req.fresh) return res.status(304).end();
    // iOS (AVFoundation) plays <audio> only from servers that answer byte ranges.
    let start = 0, end = m.size - 1;
    const range = req.get('range');
    if (range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!r || (r[1] === '' && r[2] === '')) return res.status(416).set('Content-Range', `bytes */${m.size}`).end();
      if (r[1] === '') { start = Math.max(0, m.size - Number(r[2])); }
      else { start = Number(r[1]); if (r[2] !== '') end = Math.min(end, Number(r[2])); }
      if (start > end || start >= m.size) return res.status(416).set('Content-Range', `bytes */${m.size}`).end();
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${m.size}`);
    }
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    const s = await store.read(key, { start, end });
    s.on('error', () => res.destroy());
    s.pipe(res);
  });

  app.put('/api/voices/:key', trainerOnly,
    express.raw({ type: () => true, limit: config.maxVoiceBytes }),
    async (req, res) => {
      const { key } = req.params;
      const mime = (req.get('content-type') || '').split(';')[0].trim();
      if (!VOICE_KEY.test(key)) return res.status(400).json({ code: 'bad_key' });
      if (!AUDIO_MIME.test(mime)) return res.status(415).json({ code: 'bad_type' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ code: 'empty' });
      res.json({ voice: await store.put(key, req.body, mime) });
    });

  app.delete('/api/voices/:key', trainerOnly, async (req, res) => {
    if (!VOICE_KEY.test(req.params.key)) return res.status(400).json({ code: 'bad_key' });
    res.json({ deleted: await store.remove(req.params.key) });
  });

  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ code: 'too_large' });
    console.error(err);
    res.status(err.status || 500).json({ code: 'server_error' });
  });
  return app;
}
