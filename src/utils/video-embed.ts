/**
 * The player for a post's video link: the {{post.video_embed}} token, filled from the post's
 * `video_url` custom field. Moved out of utils/shortcodes.ts unchanged for the four hosted
 * providers (YouTube, Dailymotion, Vimeo, Loom), and extended with one more source
 * (getAlloro/alloro plans/11192026-site-courses-library, T7): an MP4 or WebM file in the business's
 * own Alloro media library, played by the browser's own <video> player.
 *
 * ⛔ A FILE PLAYS ONLY FROM ALLORO'S OWN MEDIA BUCKET. Any other address that ends in .mp4 gets no
 * player: the token never becomes a way to load a file from an arbitrary host. The bucket is the
 * same AWS_S3_IMPORTS_BUCKET / AWS_S3_IMPORTS_REGION the app uploads media to (see
 * services/artifact.service.ts for the same address shape).
 *
 * Anything not recognised answers '', so the token prints nothing rather than a broken frame.
 */

const RESPONSIVE_FRAME =
  'position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;';
const FILL = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;';
const FILE_PLAYER_STYLE = 'display:block;width:100%;height:auto;border-radius:12px;background:#000;';

/** File types a browser plays without a plugin, by extension. */
const PLAYABLE_FILE = /\.(mp4|webm)$/i;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The host of the business's Alloro media library, from the same settings the app uploads with. */
export function mediaLibraryHost(): string {
  const bucket = process.env.AWS_S3_IMPORTS_BUCKET || 'alloro-imports';
  const region = process.env.AWS_S3_IMPORTS_REGION || 'us-east-1';
  return `${bucket}.s3.${region}.amazonaws.com`.toLowerCase();
}

/** The address as a media library file the browser can play, or null. */
function mediaLibraryFile(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (parsed.hostname.toLowerCase() !== mediaLibraryHost()) return null;
  if (!PLAYABLE_FILE.test(parsed.pathname)) return null;
  return parsed.href;
}

function frame(src: string, allow: string | null): string {
  const allowAttribute = allow ? ` allow="${allow}"` : '';
  return `<div style="${RESPONSIVE_FRAME}"><iframe src="${src}" style="${FILL}"${allowAttribute} allowfullscreen></iframe></div>`;
}

export function buildVideoEmbed(url: string): string {
  if (!url) return '';

  // YouTube: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]+)/);
  if (ytMatch) {
    return frame(
      `https://www.youtube.com/embed/${ytMatch[1]}`,
      'accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture'
    );
  }

  // Dailymotion: dailymotion.com/video/ID, dai.ly/ID
  const dmMatch = url.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([\w]+)/);
  if (dmMatch) return frame(`https://www.dailymotion.com/embed/video/${dmMatch[1]}`, null);

  // Vimeo: vimeo.com/ID
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return frame(`https://player.vimeo.com/video/${vimeoMatch[1]}`, 'autoplay;fullscreen;picture-in-picture');

  // Loom: loom.com/share/ID
  const loomMatch = url.match(/loom\.com\/share\/([\w]+)/);
  if (loomMatch) return frame(`https://www.loom.com/embed/${loomMatch[1]}`, null);

  // A file in the business's own Alloro media library.
  const file = mediaLibraryFile(url);
  if (file) {
    return `<video src="${escapeAttribute(file)}" controls preload="metadata" playsinline style="${FILE_PLAYER_STYLE}"></video>`;
  }

  return '';
}
