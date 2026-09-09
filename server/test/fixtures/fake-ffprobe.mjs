#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stdout.write('ffprobe version 0.0.0\n');
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({
    streams: [{ codec_type: 'audio', codec_name: 'aac' }],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.000000', size: '2048' },
  })}\n`,
);
process.exit(0);
