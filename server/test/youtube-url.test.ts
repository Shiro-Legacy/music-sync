import { describe, expect, it } from 'vitest';
import { canonicalizeYouTubeUrl, YoutubeUrlError } from '../src/youtube-url.js';

const ID = 'abcdefghijk';
const CANON = `https://www.youtube.com/watch?v=${ID}`;

function expectId(raw: string, videoId = ID): void {
  expect(canonicalizeYouTubeUrl(raw)).toEqual({ videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
}

function expectReject(raw: string): void {
  expect(() => canonicalizeYouTubeUrl(raw)).toThrow(YoutubeUrlError);
}

describe('canonicalizeYouTubeUrl', () => {
  it('accepts watch, shorts, embed, /v/, and short links on allowed hosts', () => {
    expectId(`https://www.youtube.com/watch?v=${ID}`);
    expectId(`https://youtube.com/watch?v=${ID}`);
    expectId(`http://m.youtube.com/watch?v=${ID}`);
    expectId(`https://music.youtube.com/watch?v=${ID}`);
    expectId(`https://www.youtube.com/shorts/${ID}`);
    expectId(`https://youtube.com/embed/${ID}`);
    expectId(`https://www.youtube.com/v/${ID}`);
    expectId(`https://youtu.be/${ID}`);
    expectId(`https://www.youtu.be/${ID}`);
    expectId(`https://youtu.be/${ID}/`);
  });

  it('drops playlist and tracking params and always emits the canonical watch URL', () => {
    expect(canonicalizeYouTubeUrl(`https://youtu.be/${ID}?list=PLxxxx&t=12&si=abc`)).toEqual({
      videoId: ID,
      url: CANON,
    });
    expect(
      canonicalizeYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLxxxx&index=3&pp=s`).url,
    ).toBe(CANON);
  });

  it('trims whitespace and accepts a video id that starts with a dash', () => {
    expectId(`  https://youtu.be/${ID}  `);
    expectId('https://www.youtube.com/watch?v=-abcDEFghij', '-abcDEFghij');
  });

  it('rejects credentials, explicit ports, non-http(s), and lookalike hosts', () => {
    expectReject('javascript:alert(1)');
    expectReject(`file:///tmp/watch?v=${ID}`);
    expectReject(`ftp://youtube.com/watch?v=${ID}`);
    expectReject(`https://user:pass@youtube.com/watch?v=${ID}`);
    expectReject(`http://user@youtube.com/watch?v=${ID}`);
    expectReject(`https://youtube.com:8443/watch?v=${ID}`);
    expectReject(`https://youtube.com.evil.com/watch?v=${ID}`);
    expectReject(`https://evil.com/watch?v=${ID}`);
    expectReject(`https://notyoutube.com/watch?v=${ID}`);
  });

  it('rejects playlist-only, channel, and other non-video paths', () => {
    expectReject('https://www.youtube.com/playlist?list=PLxxxx');
    expectReject('https://www.youtube.com/channel/UCxxxxxxxxxx');
    expectReject('https://www.youtube.com/@someone');
    expectReject('https://www.youtube.com/watch');
    expectReject('https://www.youtube.com/watch?v=');
    expectReject('https://www.youtube.com/watch?v=short');
    expectReject(`https://www.youtube.com/watch/${ID}`);
    expectReject(`https://youtu.be/${ID}/extra`);
    expectReject(`https://www.youtube.com/live/${ID}`);
    expectReject('www.youtube.com/watch?v=abcdefghijk');
    expectReject('');
    expectReject('not a url');
  });
});
