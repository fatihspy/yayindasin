import { MongoClient, GridFSBucket } from 'mongodb';
import { config } from './config.js';

/**
 * Trainer voice storage. Each voice key (e.g. "welcome_tr", "p2_tr") holds one audio file.
 * Production: MongoDB GridFS (works on Atlas free tier; Render's disk is wiped on deploy).
 * No MONGODB_URI: in-memory store, fine for local development, lost on restart.
 *
 * Interface:
 *   list()                      -> [{ key, at, size, mime }]
 *   meta(key)                   -> { key, at, size, mime } | null
 *   read(key, { start, end })   -> Readable
 *   put(key, buffer, mime)      -> meta
 *   remove(key)                 -> boolean
 */

class MemoryStore {
  constructor() { this.m = new Map(); this.kind = 'memory'; }
  async init() {}
  async list() { return [...this.m.values()].map(({ buf, ...meta }) => meta); }
  async meta(key) { const v = this.m.get(key); if (!v) return null; const { buf, ...meta } = v; return meta; }
  async read(key, { start = 0, end } = {}) {
    const { Readable } = await import('node:stream');
    const v = this.m.get(key);
    return Readable.from([v.buf.subarray(start, end == null ? undefined : end + 1)]);
  }
  async put(key, buf, mime) { const meta = { key, at: Date.now(), size: buf.length, mime }; this.m.set(key, { ...meta, buf }); return meta; }
  async remove(key) { return this.m.delete(key); }
}

class MongoStore {
  constructor(uri, dbName) { this.uri = uri; this.dbName = dbName; this.kind = 'mongodb'; }
  async init() {
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.bucket = new GridFSBucket(db, { bucketName: 'voices' });
    this.col = db.collection('voices'); // { _id: key, fileId, at, size, mime }
  }
  #pub(d) { return d && { key: d._id, at: d.at, size: d.size, mime: d.mime }; }
  async list() { return (await this.col.find({}).toArray()).map(d => this.#pub(d)); }
  async meta(key) { return this.#pub(await this.col.findOne({ _id: key })); }
  async read(key, { start = 0, end } = {}) {
    const d = await this.col.findOne({ _id: key });
    // GridFS `end` is exclusive
    return this.bucket.openDownloadStream(d.fileId, end == null ? { start } : { start, end: end + 1 });
  }
  async put(key, buf, mime) {
    const old = await this.col.findOne({ _id: key });
    const fileId = await new Promise((res, rej) => {
      const up = this.bucket.openUploadStream(key, { metadata: { mime } });
      up.on('error', rej).on('finish', () => res(up.id));
      up.end(buf);
    });
    const doc = { _id: key, fileId, at: Date.now(), size: buf.length, mime };
    await this.col.replaceOne({ _id: key }, doc, { upsert: true });
    if (old) await this.bucket.delete(old.fileId).catch(() => {});
    return this.#pub(doc);
  }
  async remove(key) {
    const old = await this.col.findOneAndDelete({ _id: key });
    if (!old) return false;
    await this.bucket.delete(old.fileId).catch(() => {});
    return true;
  }
}

export async function createStore() {
  const s = config.mongoUri ? new MongoStore(config.mongoUri, config.mongoDb) : new MemoryStore();
  await s.init();
  if (s.kind === 'memory') console.warn('[storage] MONGODB_URI is not set: trainer voices are kept in memory and lost on restart.');
  return s;
}
