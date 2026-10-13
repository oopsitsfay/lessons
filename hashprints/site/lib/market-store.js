// Where signed orders live: market/<collection>/<kind>/<name>.json, one small file per order, so
// two people posting at once never overwrite each other. Listings are named by token id (one
// per print), offers by order hash. Vercel Blob in production (BLOB_STORE_ID or
// BLOB_READ_WRITE_TOKEN, set when a Blob store is connected to the project), a local folder in tests (MARKET_STORE_DIR). With
// neither, the market is switched off.
const fs = require('fs');
const path = require('path');

const KINDS = new Set(['listings', 'offers', 'health']);
const safe = (name) => String(name).replace(/[^0-9a-zA-Zx]/g, '');
function check(kind) {
  if (!KINDS.has(kind)) throw new Error(`unknown kind ${kind}`);
}

function fileStore(dir) {
  const folder = (key, kind) => path.join(dir, key, kind);
  return {
    async all(key, kind) {
      check(kind);
      const d = folder(key, kind);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
    },
    async put(key, kind, name, value) {
      check(kind);
      fs.mkdirSync(folder(key, kind), { recursive: true });
      fs.writeFileSync(path.join(folder(key, kind), `${safe(name)}.json`), JSON.stringify(value));
    },
    async remove(key, kind, name) {
      check(kind);
      fs.rmSync(path.join(folder(key, kind), `${safe(name)}.json`), { force: true });
    },
  };
}

function blobStore() {
  const blob = require('@vercel/blob');
  const file = (key, kind, name) => `market/${key}/${kind}/${safe(name)}.json`;
  return {
    async all(key, kind) {
      check(kind);
      const found = [];
      let cursor;
      do {
        const page = await blob.list({ prefix: `market/${key}/${kind}/`, cursor, limit: 1000 });
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
    async put(key, kind, name, value) {
      check(kind);
      await blob.put(file(key, kind, name), JSON.stringify(value), {
        access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60,
      });
    },
    async remove(key, kind, name) {
      check(kind);
      await blob.del(file(key, kind, name)).catch(() => {});
    },
  };
}

function backend() {
  if (process.env.MARKET_STORE_DIR) return 'folder';
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob (token)';
  if (process.env.BLOB_STORE_ID) return 'blob (OIDC)';
  return null;
}

function store() {
  if (process.env.MARKET_STORE_DIR) return fileStore(process.env.MARKET_STORE_DIR);
  // A connected store gives either a read-write token or a store id used with the function's OIDC token.
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) return blobStore();
  return null;
}

module.exports = { store, backend };
