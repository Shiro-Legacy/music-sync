#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('-version') || args.includes('-hide_banner')) {
  if (args.includes('-version')) {
    process.stdout.write('ffmpeg version 0.0.0\n');
    process.exit(0);
  }
}

const i = args.indexOf('-i');
const input = i >= 0 ? args[i + 1] : undefined;
const output = args.at(-1);
if (input === undefined || output === undefined || output.startsWith('-')) {
  process.stderr.write('fake-ffmpeg: missing files\n');
  process.exit(1);
}
fs.copyFileSync(input, output);
process.exit(0);
