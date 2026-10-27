import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

let client = null;
function getClient() {
  if (!config.anthropicKey) return null;
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey, baseURL: config.anthropicBaseURL, maxRetries: 2, timeout: 90_000 });
  return client;
}

export class AiError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}

const JSON_SYSTEM = 'You are the content engine of a mobile app. Reply with a single valid JSON value only: no markdown fences, no comments, no text before or after it.';

/** Pull the first JSON value out of a model reply (tolerates ```json fences and stray prose). */
export function extractJSON(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const start = t.search(/[\[{]/);
  if (start < 0) throw new Error('no json');
  const open = t[start], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error('unterminated json');
}

function mapError(e) {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate_limited', 429);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiError('unavailable', 503, 'AI key rejected');
  if (e instanceof Anthropic.APIUserAbortError) return new AiError('aborted', 499);
  if (e instanceof Anthropic.APIError && e.status === 529) return new AiError('overloaded', 503);
  return new AiError('upstream', 502, e && e.message);
}

/**
 * Run one prompt. mode 'json' returns parsed JSON (one retry on a malformed reply), 'text' returns a string.
 * tier 'quick' → small fast model (translations); anything else → default model.
 */
export async function runPrompt({ prompt, mode = 'text', tier = 'default', signal }) {
  const c = getClient();
  if (!c) throw new AiError('unavailable', 503, 'ANTHROPIC_API_KEY is not set');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new AiError('bad_request', 400, 'prompt is required');
  if (prompt.length > config.maxPromptChars) throw new AiError('too_long', 413, 'prompt too long');
  const model = tier === 'quick' ? config.modelQuick : config.modelDefault;
  const call = () => c.messages.create({
    model,
    max_tokens: mode === 'json' ? 8000 : 1500,
    ...(mode === 'json' ? { system: JSON_SYSTEM } : {}),
    messages: [{ role: 'user', content: prompt }],
  }, { signal });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = await call();
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (mode !== 'json') return text.trim();
      try { return extractJSON(text); } catch { if (attempt === 1) throw new AiError('bad_output', 502, 'model did not return JSON'); }
    }
  } catch (e) { throw mapError(e); }
}
