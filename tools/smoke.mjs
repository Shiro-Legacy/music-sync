#!/usr/bin/env node
// smoke.mjs — black-box HTTP protocol smoke test against a RUNNING server
// whose --music-dir points at a library created by tools/make-fixtures.mjs.
//
// Usage:
//   node tools/smoke.mjs <baseUrl> <token>
//   (or env MUSIC_SYNC_URL / MUSIC_SYNC_TOKEN)
//
// Prints PASS/FAIL per check, a summary line, and exits non-zero on any FAIL.
// Zero dependencies; uses the Node global fetch.

const baseUrl = (process.argv[2] || process.env.MUSIC_SYNC_URL || '').replace(/\/+$/, '');
const token = process.argv[3] || process.env.MUSIC_SYNC_TOKEN || '';

if (!baseUrl || !token) {
  console.error('Usage: node tools/smoke.mjs <baseUrl> <token>');
  console.error('   or: set MUSIC_SYNC_URL and MUSIC_SYNC_TOKEN');
  process.exit(2);
}

let passed = 0, failed = 0, skipped = 0;
const pass = (name, extra = '') => { passed++; console.log(`PASS  ${name}${extra ? `  [${extra}]` : ''}`); };
const fail = (name, extra = '') => { failed++; console.log(`FAIL  ${name}${extra ? `  [${extra}]` : ''}`); };
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}  [${why}]`); };
const check = (cond, name, extra = '') => { cond ? pass(name) : fail(name, extra); return cond; };

function req(pathname, { auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth) h.authorization = `Bearer ${token}`;
  return fetch(baseUrl + pathname, { headers: h, redirect: 'manual' });
}

async function bodyBuf(res) {
  return Buffer.from(await res.arrayBuffer());
}

function summarize() {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// 1. ping (no auth required)
// ---------------------------------------------------------------------------

let pingRes;
try {
  pingRes = await fetch(baseUrl + '/api/v1/ping'); // deliberately no Authorization
} catch (e) {
  console.error(`Cannot reach ${baseUrl}: ${e.cause?.message || e.message}`);
  console.error('Is the server running?');
  process.exit(2);
}
{
  let body = null;
  try { body = await pingRes.json(); } catch { /* not JSON */ }
  check(
    pingRes.status === 200 && body && body.serverId && body.name && body.version,
    'ping: 200 JSON with serverId/name/version, no auth',
    `status=${pingRes.status} body=${JSON.stringify(body)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. manifest: auth, shape, fixture expectations, ETag / 304
// ---------------------------------------------------------------------------

{
  const res = await req('/api/v1/manifest', { auth: false });
  check(res.status === 401, 'manifest without token -> 401', `status=${res.status}`);
}

const mres = await req('/api/v1/manifest');
let manifest = null;
try { manifest = await mres.json(); } catch { /* not JSON */ }
const manifestOk = check(
  mres.status === 200 && manifest && manifest.v === 1 && Array.isArray(manifest.tracks),
  'manifest with token -> 200, v === 1, tracks array',
  `status=${mres.status} v=${manifest?.v} tracks=${Array.isArray(manifest?.tracks) ? 'array' : typeof manifest?.tracks}`,
);

if (!manifestOk) {
  skip('all remaining checks', 'no usable manifest');
  summarize();
}

const tracks = manifest.tracks;
const p = (t) => String(t.path ?? '');

{
  const ogg = tracks.find((t) => p(t).toLowerCase().endsWith('.ogg'));
  check(ogg && ogg.format === 'unsupported',
    ".ogg present in manifest with format 'unsupported'",
    ogg ? `format=${ogg.format}` : 'no .ogg track found');

  check(!tracks.some((t) => p(t).toLowerCase().endsWith('.txt')),
    '.txt absent from manifest');

  const nested = tracks.find((t) => p(t).startsWith('nested/deep/') && p(t).toLowerCase().endsWith('.mp3'));
  const noBackslashes = tracks.every((t) => !p(t).includes('\\'));
  check(nested && noBackslashes,
    'nested MP3 present with forward-slash path (no backslashes anywhere)',
    nested ? 'backslash found in some path' : "no track path starting with 'nested/deep/'");
}

{
  const etag = mres.headers.get('etag');
  if (!etag) {
    fail('manifest ETag header present');
    skip('manifest If-None-Match -> 304', 'no ETag to send');
  } else {
    pass('manifest ETag header present', etag);
    const res = await req('/api/v1/manifest', { headers: { 'if-none-match': etag } });
    check(res.status === 304, 'manifest If-None-Match -> 304', `status=${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// 3. track download: full body, ranges, preconditions, bad id
// ---------------------------------------------------------------------------

const mp3 = tracks.find((t) =>
  (t.format === 'mp3' || p(t).toLowerCase().endsWith('.mp3')) && Number(t.size) >= 1024);

if (!mp3) {
  skip('track full/range/precondition checks', 'no mp3 track with size >= 1024 in manifest');
} else {
  const trackPath = `/api/v1/tracks/${encodeURIComponent(mp3.id)}`;

  const fullRes = await req(trackPath);
  const full = await bodyBuf(fullRes);
  check(fullRes.status === 200 && full.length === Number(mp3.size),
    `track full GET -> 200, byte length === manifest size (${mp3.size})`,
    `status=${fullRes.status} got=${full.length}`);

  {
    const res = await req(trackPath, { headers: { range: 'bytes=0-1023' } });
    const buf = await bodyBuf(res);
    check(
      res.status === 206 && !!res.headers.get('content-range')
        && buf.length === 1024 && buf.equals(full.subarray(0, 1024)),
      'range bytes=0-1023 -> 206 + Content-Range + first 1024 bytes match',
      `status=${res.status} content-range=${res.headers.get('content-range')} got=${buf.length}`,
    );
  }

  {
    const res = await req(trackPath, { headers: { range: 'bytes=-100' } });
    const buf = await bodyBuf(res);
    check(
      res.status === 206 && buf.length === 100 && buf.equals(full.subarray(full.length - 100)),
      'range bytes=-100 -> 206 + last 100 bytes match',
      `status=${res.status} got=${buf.length}`,
    );
  }

  {
    const res = await req(trackPath, { headers: { range: 'bytes=999999999-' } });
    check(res.status === 416, 'range bytes=999999999- -> 416', `status=${res.status}`);
  }

  {
    const res = await req(trackPath, { headers: { 'if-match': '"smoke-test-wrong-etag"' } });
    check(res.status === 412, 'If-Match with wrong ETag -> 412', `status=${res.status}`);
  }

  {
    const res = await req('/api/v1/tracks/zzzzzzzzzzzzzzzz');
    check(res.status === 404, 'bogus track id -> 404', `status=${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// 4. artwork (only if the manifest advertises any)
// ---------------------------------------------------------------------------

const withArt = tracks.find((t) => t.artworkId);
if (!withArt) {
  skip('artwork checks', 'no track has artworkId');
} else {
  const res = await req(`/api/v1/artwork/${encodeURIComponent(withArt.artworkId)}`);
  const ct = res.headers.get('content-type') || '';
  check(res.status === 200 && ct.startsWith('image/'),
    'artwork GET -> 200 with image content-type',
    `status=${res.status} content-type=${ct}`);

  const bad = await req('/api/v1/artwork/zzz');
  check(bad.status === 404, "malformed artwork id 'zzz' -> 404", `status=${bad.status}`);
}

summarize();
