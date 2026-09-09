#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2026.08.19\n');
  process.exit(0);
}

const url = args.find((arg) => arg.startsWith('https://www.youtube.com/watch?v='));
const videoId = url === undefined ? 'abcdefghijk' : (new URL(url).searchParams.get('v') ?? 'abcdefghijk');
const dump = args.includes('-J') || args.includes('--dump-single-json');

if (dump) {
  process.stdout.write(
    `${JSON.stringify({
      id: videoId,
      title: 'Fixture title',
      artist: 'Fixture artist',
      duration: 2,
      is_live: false,
      live_status: 'not_live',
      thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
      filesize: 2048,
    })}\n`,
  );
  process.exit(0);
}

const p = args.indexOf('-P');
const staging = p >= 0 ? args[p + 1] : process.cwd();
if (typeof staging !== 'string') process.exit(1);
fs.mkdirSync(staging, { recursive: true });
fs.writeFileSync(path.join(staging, `${videoId}.m4a`), Buffer.alloc(2048, 1));
process.exit(0);
