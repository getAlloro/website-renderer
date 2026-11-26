const assert = require('node:assert/strict');
const { test } = require('node:test');

// The {{post.video_embed}} player (utils/video-embed.ts). The four hosted providers moved out of
// utils/shortcodes.ts and must print exactly what they printed before; a media library file is new
// (getAlloro/alloro plans/11192026-site-courses-library, T7). Pure: no database, Redis or network.

process.env.AWS_S3_IMPORTS_BUCKET = 'alloro-main-bucket';
process.env.AWS_S3_IMPORTS_REGION = 'us-east-1';
const { buildVideoEmbed, mediaLibraryHost } = require('../dist/utils/video-embed');

const FRAME = 'position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;';
const FILL = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;';
const MEDIA = 'https://alloro-main-bucket.s3.us-east-1.amazonaws.com';

test('the four hosted providers print exactly what shortcodes.ts printed before the move', () => {
  assert.equal(
    buildVideoEmbed('https://www.youtube.com/watch?v=aqz-KE-bpKQ'),
    `<div style="${FRAME}"><iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ" style="${FILL}" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe></div>`
  );
  assert.equal(
    buildVideoEmbed('https://dai.ly/x8abc12'),
    `<div style="${FRAME}"><iframe src="https://www.dailymotion.com/embed/video/x8abc12" style="${FILL}" allowfullscreen></iframe></div>`
  );
  assert.equal(
    buildVideoEmbed('https://vimeo.com/76979871'),
    `<div style="${FRAME}"><iframe src="https://player.vimeo.com/video/76979871" style="${FILL}" allow="autoplay;fullscreen;picture-in-picture" allowfullscreen></iframe></div>`
  );
  assert.equal(
    buildVideoEmbed('https://www.loom.com/share/abc123'),
    `<div style="${FRAME}"><iframe src="https://www.loom.com/embed/abc123" style="${FILL}" allowfullscreen></iframe></div>`
  );
});

test('a file in the business media library plays in the browser player', () => {
  assert.equal(mediaLibraryHost(), 'alloro-main-bucket.s3.us-east-1.amazonaws.com');
  const html = buildVideoEmbed(`${MEDIA}/uploads/project-1/lesson-one.mp4`);
  assert.match(html, /^<video src="https:\/\/alloro-main-bucket\.s3\.us-east-1\.amazonaws\.com\/uploads\/project-1\/lesson-one\.mp4" controls preload="metadata" playsinline style="[^"]+"><\/video>$/);
  assert.match(buildVideoEmbed(`${MEDIA}/uploads/a/clip.WEBM`), /^<video /);
});

test('a file anywhere else, or of another kind, gets no player', () => {
  for (const url of [
    'https://example.com/lesson.mp4',
    `http://alloro-main-bucket.s3.us-east-1.amazonaws.com/uploads/a.mp4`,
    'https://other-bucket.s3.us-east-1.amazonaws.com/uploads/a.mp4',
    'https://alloro-main-bucket.s3.us-east-1.amazonaws.com.evil.test/a.mp4',
    `https://user:pass@alloro-main-bucket.s3.us-east-1.amazonaws.com/a.mp4`,
    `${MEDIA}/uploads/a.mov`,
    `${MEDIA}/uploads/a.mp4.exe`,
    'javascript:alert(1)//.mp4',
    'not a url',
    '',
  ]) {
    assert.equal(buildVideoEmbed(url), '', url);
  }
});

test('nothing in the file address can break out of the src attribute', () => {
  for (const url of [`${MEDIA}/uploads/a%22b/clip.mp4?x="><script>.mp4`, `${MEDIA}/uploads/"onerror=x/clip.mp4`, `${MEDIA}/u/<b>.mp4`]) {
    const html = buildVideoEmbed(url);
    assert.match(html, /^<video src="[^"<>]*" controls /, url);
    assert.ok(!/<script|onerror=x"|<b>/.test(html), html);
  }
});
