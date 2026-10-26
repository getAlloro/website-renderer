import compression from 'compression';
import { constants } from 'zlib';

// Compress every compressible response body (HTML, CSS, JS, JSON, XML, SVG) for clients
// that accept it. Caddy proxies to this process without an `encode` directive, so until
// this middleware every hosted page left the box uncompressed: www.getalloro.com's home
// page was 111 KB on the wire and Lighthouse mobile scored it 60–69.
//
// Brotli is used when the client offers it (every current browser), gzip otherwise.
// Measured on that home page: brotli quality 5 → 21.6 KB, gzip at the zlib default →
// 24.1 KB, both in about 1 ms on an M-series Mac. Images and fonts are skipped by the
// library's content-type filter, bodies under 1 KB go out as-is, and the library sets
// `Vary: Accept-Encoding` on every compressible response so caches keep the variants apart.
export const responseCompression = compression({
  threshold: 1024,
  brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } },
});
