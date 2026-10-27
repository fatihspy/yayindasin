import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Fake Anthropic Messages API: replies depend on the prompt so each path can be exercised.
let fakeCalls = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c).on('end', () => {
    fakeCalls++;
    const p = JSON.parse(body).messages[0].content;
    if (p.includes('RATE')) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'x' } })); }
    let text = 'Merhaba dünya';
    if (p.includes('FENCED')) text = 'Tabii!\n```json\n["bir","iki"]\n```';
    if (p.includes('PROSE')) text = 'İşte sonuç: {"a":"} süslü {","b":[1,2]} umarım işine yarar';
    if (p.includes('BROKEN')) text = 'json yok';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: JSON.parse(body).model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});

let srv, base;
before(async () => {
  await new Promise(r => fake.listen(0, r));
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.address().port}`,
    APP_KEY: 'appk', TRAINER_KEY: 'trainerk', AI_PER_MINUTE: '1000', MONGODB_URI: '',
  });
  const { createStore } = await import('../src/storage.js');
  const { createApp } = await import('../src/app.js');
  srv = createApp(await createStore()).listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fake.close(); });

const H = { 'x-app-key': 'appk' };
const ai = (body) => fetch(base + '/api/ai', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health', async () => {
  const r = await (await fetch(base + '/health')).json();
  assert.deepEqual(r, { ok: true, ai: true, storage: 'memory' });
});

test('app key is required', async () => {
  const r = await fetch(base + '/api/voices');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'not_granted');
});

test('text mode', async () => {
  const r = await ai({ prompt: 'selam', mode: 'text' });
  assert.deepEqual(await r.json(), { text: 'Merhaba dünya' });
});

test('json mode tolerates fences and prose', async () => {
  assert.deepEqual((await (await ai({ prompt: 'FENCED', mode: 'json', tier: 'quick' })).json()).data, ['bir', 'iki']);
  assert.deepEqual((await (await ai({ prompt: 'PROSE', mode: 'json' })).json()).data, { a: '} süslü {', b: [1, 2] });
});

test('json mode retries once, then reports bad_output', async () => {
  const before = fakeCalls;
  const r = await ai({ prompt: 'BROKEN', mode: 'json' });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'bad_output');
  assert.equal(fakeCalls - before, 2);
});

test('upstream 429 maps to rate_limited', async () => {
  const r = await ai({ prompt: 'RATE', mode: 'text' });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'rate_limited');
});

test('empty prompt is rejected', async () => {
  const r = await ai({ prompt: '  ' });
  assert.equal(r.status, 400);
});

test('voice lifecycle with ranges and trainer auth', async () => {
  const audio = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  // students cannot upload
  let r = await fetch(base + '/api/voices/welcome_tr', { method: 'PUT', headers: { ...H, 'content-type': 'audio/mpeg' }, body: audio });
  assert.equal(r.status, 403);
  assert.equal((await (await fetch(base + '/api/trainer', { headers: { ...H, 'x-trainer-key': 'nope' } })).json()).trainer, false);
  assert.equal((await (await fetch(base + '/api/trainer', { headers: { ...H, 'x-trainer-key': 'trainerk' } })).json()).trainer, true);
  const T = { ...H, 'x-trainer-key': 'trainerk' };
  r = await fetch(base + '/api/voices/welcome_tr', { method: 'PUT', headers: { ...T, 'content-type': 'image/png' }, body: audio });
  assert.equal(r.status, 415);
  r = await fetch(base + '/api/voices/Bad-Key', { method: 'PUT', headers: { ...T, 'content-type': 'audio/mpeg' }, body: audio });
  assert.equal(r.status, 400);
  r = await fetch(base + '/api/voices/welcome_tr', { method: 'PUT', headers: { ...T, 'content-type': 'audio/mp4;codecs=mp4a' }, body: audio });
  assert.equal(r.status, 200);
  const list = (await (await fetch(base + '/api/voices', { headers: H })).json()).voices;
  assert.equal(list.length, 1); assert.equal(list[0].key, 'welcome_tr'); assert.equal(list[0].mime, 'audio/mp4');

  // audio itself is public (an <audio src> cannot send headers)
  r = await fetch(base + '/api/voices/welcome_tr/audio');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), audio);
  r = await fetch(base + '/api/voices/welcome_tr/audio', { headers: { ...H, range: 'bytes=0-1' } });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 0-1/1000');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0, 1]);
  r = await fetch(base + '/api/voices/welcome_tr/audio', { headers: { ...H, range: 'bytes=998-' } });
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [998 % 256, 999 % 256]);
  r = await fetch(base + '/api/voices/welcome_tr/audio', { headers: { ...H, range: 'bytes=-3' } });
  assert.equal(r.headers.get('content-range'), 'bytes 997-999/1000');
  r = await fetch(base + '/api/voices/welcome_tr/audio', { headers: { ...H, range: 'bytes=5000-' } });
  assert.equal(r.status, 416);

  r = await fetch(base + '/api/voices/welcome_tr', { method: 'DELETE', headers: H });
  assert.equal(r.status, 403);
  r = await fetch(base + '/api/voices/welcome_tr', { method: 'DELETE', headers: T });
  assert.deepEqual(await r.json(), { deleted: true });
  r = await fetch(base + '/api/voices/welcome_tr/audio', { headers: H });
  assert.equal(r.status, 404);
});
