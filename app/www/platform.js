/* Yayındasın platform layer.
 * Replaces what the app used to get from claude.ai (window.claude.use: sample / db / assets / downloads)
 * with your own Express backend, and bridges the few things a WebView cannot do on its own
 * (Android back button, status bar colour, saving/sharing files) through Capacitor plugins.
 * Everything degrades gracefully: no API_URL or no network -> AI and shared voices are simply hidden. */
(function () {
  'use strict';
  const cfg = window.YAYIN_CONFIG || {};
  const base = String(cfg.API_URL || '').replace(/\/+$/, '');
  const TKEY = 'yayindasin-trainer';
  const Cap = window.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const P = name => (Cap && Cap.Plugins && Cap.Plugins[name]) || null;

  const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} },
  };

  function err(code, status) { const e = new Error(code); e.code = code; e.status = status; return e; }

  function headers(extra) {
    const h = Object.assign({}, extra);
    if (cfg.APP_KEY) h['X-App-Key'] = cfg.APP_KEY;
    const t = ls.get(TKEY);
    if (t) h['X-Trainer-Key'] = t;
    return h;
  }

  async function req(path, opt) {
    opt = opt || {};
    if (!base) throw err('unavailable');
    let r;
    try { r = await fetch(base + path, Object.assign({}, opt, { headers: headers(opt.headers) })); }
    catch (e) { if (e && e.name === 'AbortError') throw e; throw err('network'); }
    if (!r.ok) { let c = 'upstream'; try { c = (await r.json()).code || c; } catch (e) {} throw err(c, r.status); }
    return r;
  }

  /* ---------- AI output hygiene ----------
   * Model text is rendered with innerHTML in many places. Neutralise the characters that could
   * open a tag or break out of an attribute; typographic look-alikes keep the text readable. */
  function clean(v) {
    if (typeof v === 'string') return v.replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, '”');
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = clean(v[k]); return o; }
    return v;
  }

  /* ---------- AI: same shape as claude.ai `sample` ----------
   * sample(prompt, opts)      -> { text }
   * sample.json(prompt, opts) -> parsed JSON
   * opts: { modelTier: 'quick' | 'default', signal } ; errors carry .code like the original runtime */
  async function call(prompt, opts, mode) {
    opts = opts || {};
    const r = await req('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode, tier: opts.modelTier === 'quick' ? 'quick' : 'default' }),
      signal: opts.signal,
    });
    return r.json();
  }
  const sample = async (prompt, opts) => ({ text: clean(String((await call(prompt, opts, 'text')).text || '')) });
  sample.json = async (prompt, opts) => clean((await call(prompt, opts, 'json')).data);

  // Render free instances sleep; the first request can take ~50 s. Ask once, retry later on failure.
  let health = null;
  function aiReady() {
    if (!base) return Promise.resolve(false);
    if (!health) {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60000);
      health = fetch(base + '/health', { signal: ac.signal }).then(r => r.json()).then(j => !!j.ai)
        .catch(() => { health = null; return false; }).finally(() => clearTimeout(t));
    }
    return health;
  }

  /* ---------- shared trainer voices ---------- */
  let vlist = null;
  function voices(force) {
    if (!base) return Promise.resolve({});
    if (force || !vlist) {
      vlist = req('/api/voices').then(r => r.json()).then(j => {
        const m = {}; (j.voices || []).forEach(v => { m[v.key] = v; }); return m;
      }).catch(() => { vlist = null; return {}; });
    }
    return vlist;
  }
  const voiceUrl = v => `${base}/api/voices/${encodeURIComponent(v.key)}/audio?v=${v.at}`;
  const EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', '3gp': 'audio/3gpp' };
  function mimeOf(blob) {
    let t = (blob.type || '').split(';')[0];
    if (!t) { const m = /\.([a-z0-9]+)$/i.exec(blob.name || ''); t = (m && EXT[m[1].toLowerCase()]) || 'audio/mpeg'; }
    return t;
  }
  async function uploadVoice(key, blob) {
    await req('/api/voices/' + encodeURIComponent(key), { method: 'PUT', headers: { 'Content-Type': mimeOf(blob) }, body: blob });
    await voices(true);
  }
  async function deleteVoice(key) {
    await req('/api/voices/' + encodeURIComponent(key), { method: 'DELETE' });
    await voices(true);
  }

  // Trainer mode: unlocked by typing the server's TRAINER_KEY in Profil.
  let trainerP = null;
  function isTrainer() {
    if (!base || !ls.get(TKEY)) return Promise.resolve(false);
    if (!trainerP) trainerP = req('/api/trainer').then(r => r.json()).then(j => !!j.trainer).catch(() => { trainerP = null; return false; });
    return trainerP;
  }
  async function setTrainerKey(key) {
    ls.set(TKEY, key ? String(key).trim() : '');
    trainerP = null;
    if (!key) return false;
    const ok = await isTrainer();
    if (!ok) ls.set(TKEY, '');
    return ok;
  }

  /* ---------- files: download on the web, share sheet on phones ---------- */
  function b64(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function saveFile(filename, blob, title) {
    const FS = P('Filesystem'), Share = P('Share');
    if (isNative && FS && Share) {
      const w = await FS.writeFile({ path: filename, data: await b64(blob), directory: 'CACHE', recursive: true });
      await Share.share({ title: title || filename, files: [w.uri], dialogTitle: title || filename });
      return 'shared';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return 'downloaded';
  }

  /* ---------- native chrome ---------- */
  function setTheme(dark) {
    // SystemBars ships inside @capacitor/core 8. Style DARK = light icons, for dark backgrounds.
    const SB = P('SystemBars');
    if (!isNative || !SB) return;
    SB.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
  }
  function onBack(handler) {
    const App = P('App');
    if (!isNative || !App) return;
    App.addListener('backButton', () => { if (!handler()) App.exitApp(); });
  }
  function ready() {
    const SS = P('SplashScreen');
    if (isNative && SS) SS.hide({ fadeOutDuration: 250 }).catch(() => {});
  }

  window.Yayin = {
    isNative, hasServer: !!base, platform: isNative ? Cap.getPlatform() : 'web',
    sample, aiReady, clean,
    voices, voiceUrl, uploadVoice, deleteVoice, isTrainer, setTrainerKey, hasTrainerKey: () => !!ls.get(TKEY),
    saveFile, setTheme, onBack, ready,
  };
})();
