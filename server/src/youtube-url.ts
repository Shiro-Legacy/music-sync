const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export class YoutubeUrlError extends Error {}

export function canonicalizeYouTubeUrl(raw: string): { videoId: string; url: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new YoutubeUrlError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new YoutubeUrlError('Only http(s) YouTube URLs are allowed');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new YoutubeUrlError('Credentials are not allowed');
  }
  if (parsed.port !== '') {
    throw new YoutubeUrlError('Unexpected port');
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new YoutubeUrlError('Not a YouTube URL');
  }
  const videoId = extractVideoId(host, parsed);
  if (videoId === undefined || !VIDEO_ID_RE.test(videoId)) {
    throw new YoutubeUrlError('Not a YouTube video URL');
  }
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

function extractVideoId(host: string, parsed: URL): string | undefined {
  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return parts.length === 1 ? parts[0] : undefined;
  }
  if (parts[0] === 'watch' && parts.length === 1) {
    return parsed.searchParams.get('v') ?? undefined;
  }
  if (
    (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'v') &&
    parts.length === 2
  ) {
    return parts[1];
  }
  return undefined;
}
