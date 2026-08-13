#!/usr/bin/env node
// make-fixtures.mjs — generate a throwaway music library with structurally
// valid MP3 files (real ID3v2.3 tags + genuine MPEG-1 Layer III silent frames)
// so a metadata parser such as music-metadata extracts title/artist/album.
//
// Usage:
//   node tools/make-fixtures.mjs [targetDir]
//
// Default targetDir: a fresh directory under os.tmpdir().
// Zero dependencies; plain Node (>= 18).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// ID3v2.3 construction
// ---------------------------------------------------------------------------
// Tag layout:   "ID3" | 0x03 0x00 | flags 0x00 | 4-byte SYNCHSAFE size | frames
// Frame layout: 4-char id | 4-byte PLAIN big-endian size | 2 flag bytes | body
// (Only the tag-header size is synchsafe in v2.3; frame sizes are plain BE.)

const latin1 = (s) => Buffer.from(s, 'latin1');

function synchsafe(n) {
  if (n > 0x0fffffff) throw new Error('tag too large for synchsafe size');
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function id3Frame(id, body) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(body.length, 4); // v2.3: plain 32-bit BE, excludes this 10-byte header
  // bytes 8-9 stay 0x00 0x00 (no frame flags)
  return Buffer.concat([header, body]);
}

function textFrame(id, text) {
  // body = encoding byte 0x00 (ISO-8859-1) + text
  return id3Frame(id, Buffer.concat([Buffer.from([0x00]), latin1(text)]));
}

function apicFrame(png) {
  // body = encoding | mime NUL | picture type (3 = front cover) | description NUL | data
  return id3Frame('APIC', Buffer.concat([
    Buffer.from([0x00]),
    latin1('image/png'), Buffer.from([0x00]),
    Buffer.from([0x03]),
    Buffer.from([0x00]),
    png,
  ]));
}

function id3v23Tag(frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([
    latin1('ID3'),
    Buffer.from([0x03, 0x00]), // version 2.3.0
    Buffer.from([0x00]),       // flags
    synchsafe(body.length),    // size of everything after this 10-byte header
    body,
  ]);
}

// ---------------------------------------------------------------------------
// MPEG-1 Layer III silent audio frames
// ---------------------------------------------------------------------------
// Header 0xFF 0xFB 0x90 0x00:
//   FF        11111111  sync
//   FB        111 11 01 1  sync | MPEG-1 | Layer III | no CRC
//   90        1001 00 0 0  bitrate idx 9 = 128 kbps | 44100 Hz | no padding | private 0
//   00        00 00 0 0 00 stereo | mode ext | copyright | original | no emphasis
// Frame length = floor(144 * 128000 / 44100) + padding = 417 bytes (incl. header).
// Zeroed side info / main data decodes as digital silence.

const MPEG_FRAME_LEN = Math.floor((144 * 128000) / 44100); // 417
const SILENT_FRAME = (() => {
  const f = Buffer.alloc(MPEG_FRAME_LEN);
  f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; f[3] = 0x00;
  return f;
})();
const FRAMES_PER_FILE = 12; // ~0.31 s of audio, ~5 KB
const SILENT_AUDIO = Buffer.concat(Array.from({ length: FRAMES_PER_FILE }, () => SILENT_FRAME));

// ---------------------------------------------------------------------------
// Tiny (1x1) valid PNG for embedded cover art
// ---------------------------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function tinyPng(r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8;              // bit depth
  ihdr[9] = 2;              // color type 2 = truecolor RGB
  const idat = zlib.deflateSync(Buffer.from([0x00, r, g, b])); // filter byte + 1 pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Fixture library definition: 2 artists x 2 albums + 1 MP3 nested 2 dirs deep
// ---------------------------------------------------------------------------

const COVER = tinyPng(196, 30, 58);

const MP3S = [
  { rel: 'The Null Pointers/Segmentation Fault/01 - Dangling Reference.mp3',
    title: 'Dangling Reference', artist: 'The Null Pointers', album: 'Segmentation Fault', trck: '1', art: COVER },
  { rel: 'The Null Pointers/Segmentation Fault/02 - Heap of Trouble.mp3',
    title: 'Heap of Trouble', artist: 'The Null Pointers', album: 'Segmentation Fault', trck: '2', art: COVER },
  { rel: 'Static Cling/Voltage Drop/01 - Ohm Sweet Ohm.mp3',
    title: 'Ohm Sweet Ohm', artist: 'Static Cling', album: 'Voltage Drop', trck: '1', art: null },
  { rel: 'Static Cling/Voltage Drop/02 - Short Circuit.mp3',
    title: 'Short Circuit', artist: 'Static Cling', album: 'Voltage Drop', trck: '2', art: null },
  // Nested two directories deep, exercised by the manifest path check.
  { rel: 'nested/deep/Buried Track.mp3',
    title: 'Buried Track', artist: 'Static Cling', album: 'Voltage Drop', trck: '3', art: null },
];

function buildMp3({ title, artist, album, trck, art }) {
  const frames = [
    textFrame('TIT2', title),
    textFrame('TPE1', artist),
    textFrame('TALB', album),
    textFrame('TRCK', trck),
  ];
  if (art) frames.push(apicFrame(art));
  return Buffer.concat([id3v23Tag(frames), SILENT_AUDIO]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'music-fixtures-'));

fs.mkdirSync(target, { recursive: true });

for (const t of MP3S) {
  const abs = path.join(target, ...t.rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildMp3(t));
}

// .ogg extension, arbitrary bytes -> should surface as format 'unsupported'.
fs.writeFileSync(path.join(target, 'mystery.ogg'),
  Buffer.concat([latin1('OggS'), Buffer.alloc(256, 0xa5)]));

// Non-audio file -> should be skipped entirely (absent from the manifest).
fs.writeFileSync(path.join(target, 'liner-notes.txt'),
  'Not audio. This file must not appear in the manifest.\n');

// ---------------------------------------------------------------------------
// Print the created tree
// ---------------------------------------------------------------------------

function printTree(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  entries.forEach((e, i) => {
    const last = i === entries.length - 1;
    const branch = last ? '\\-- ' : '|-- ';
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      console.log(prefix + branch + e.name + '/');
      printTree(abs, prefix + (last ? '    ' : '|   '));
    } else {
      console.log(`${prefix}${branch}${e.name}  (${fs.statSync(abs).size} bytes)`);
    }
  });
}

console.log(target);
printTree(target);
console.log(`\nFixture library created at: ${target}`);
