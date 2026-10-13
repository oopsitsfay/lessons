// Where signed listings live. One small JSON file per token (market/<collection>/<id>.json), so
// two sellers listing at once never overwrite each other. Vercel Blob in production
// (BLOB_READ_WRITE_TOKEN, set when a Blob store is connected to the project), a local folder
// in tests (MARKET_STORE_DIR). With neither, the market is switched off.
const fs = require('fs');
const path = require('path');

function fileStore(dir) {
  const file = (key, id) => path.join(dir, key, `${Number(id)}.json`);
  return {
    async all(key) {
      const d = path.join(dir, key);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
    },
    async put(key, id, value) {
      fs.mkdirSync(path.join(dir, key), { recursive: true });
      fs.writeFileSync(file(key, id), JSON.stringify(value));
    },
    async remove(key, id) {
      fs.rmSync(file(key, id), { force: true });
    },
  };
}

function blobStore() {
  const blob = require('@vercel/blob');
  const name = (key, id) => `market/${key}/${Number(id)}.json`;
  return {
    async all(key) {
      const found = [];
      let cursor;
      do {
        const page = await blob.list({ prefix: `market/${key}/`, cursor, limit: 1000 });
        found.push(...page.blobs);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      // The CDN may hold an older copy of an overwritten file; the upload time busts it.
      const rows = await Promise.all(found.map(async (b) => {
        const r = await fetch(`${b.url}?v=${new Date(b.uploadedAt).getTime()}`).catch(() => null);
        return r && r.ok ? r.json().catch(() => null) : null;
      }));
      return rows.filter(Boolean);
    },
    async put(key, id, value) {
      await blob.put(name(key, id), JSON.stringify(value), {
        access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60,
      });
    },
    async remove(key, id) {
      await blob.del(name(key, id)).catch(() => {});
    },
  };
}

function store() {
  if (process.env.MARKET_STORE_DIR) return fileStore(process.env.MARKET_STORE_DIR);
  if (process.env.BLOB_READ_WRITE_TOKEN) return blobStore();
  return null;
}

module.exports = { store };
