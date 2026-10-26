const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { after, before, test } = require('node:test');
const express = require('express');

const { responseCompression } = require('../dist/middleware/responseCompression');

// ~112 KB of HTML, the size of www.getalloro.com's home page.
const page = `<!doctype html><html><body>${'<p>Alloro gets local businesses more customers.</p>\n'.repeat(2200)}</body></html>`;
const image = Buffer.alloc(50 * 1024, 7);

const app = express();
app.use(responseCompression);
app.get('/page', (_req, res) => res.type('html').send(page));
app.get('/tiny', (_req, res) => res.type('html').send('<p>ok</p>'));
app.get('/image', (_req, res) => res.type('image/webp').send(image));

let server;
let port;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});
after(() => server.close());

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

test('an HTML page goes out as brotli when the client offers it', async () => {
  const res = await get('/page', { 'accept-encoding': 'gzip, deflate, br, zstd' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.equal(res.headers.vary, 'Accept-Encoding');
  assert.equal(res.headers['content-length'], undefined);
  assert.equal(zlib.brotliDecompressSync(res.body).toString(), page);
  assert.ok(res.body.length < Buffer.byteLength(page) / 4, `brotli body is ${res.body.length} bytes`);
});

test('gzip when that is all the client offers', async () => {
  const res = await get('/page', { 'accept-encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(res.body).toString(), page);
});

test('identity when the client sends no Accept-Encoding', async () => {
  const res = await get('/page');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(page));
  assert.equal(res.body.toString(), page);
});

test('bodies under the threshold and already-compressed types are left alone', async () => {
  const tiny = await get('/tiny', { 'accept-encoding': 'br, gzip' });
  assert.equal(tiny.headers['content-encoding'], undefined);
  assert.equal(tiny.body.toString(), '<p>ok</p>');

  const webp = await get('/image', { 'accept-encoding': 'br, gzip' });
  assert.equal(webp.headers['content-encoding'], undefined);
  assert.equal(webp.body.length, image.length);
});
