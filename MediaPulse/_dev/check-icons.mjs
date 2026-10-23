/**
 * check-icons.mjs — validates the shipped PNG icons without any image library.
 *
 * Chrome silently refuses to load an extension whose icon is not a real PNG of
 * the declared size, so we verify: PNG signature, IHDR dimensions, bit depth,
 * colour type, and that the corners are transparent (proving a rounded shape
 * rather than an opaque square).
 *
 * Run:  node _dev/check-icons.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = resolve(here, '../icons');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse the IHDR chunk of a PNG buffer. */
function readIhdr(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('first chunk is not IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28]
  };
}

/**
 * Decode a non-interlaced PNG into RGBA pixels. Supports the colour types
 * Pillow emits for these icons (6 = RGBA and 2 = RGB), bit depth 8.
 */
function decodeRgba(buf, ihdr) {
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG not supported');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bit depth ${ihdr.bitDepth}`);

  const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${ihdr.colorType}`);

  // Collect IDAT payloads.
  let offset = 8;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!idat.length) throw new Error('no IDAT chunk');

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    raw.copy(cur, 0, pos, pos + stride);
    pos += stride;

    // Undo the per-scanline filter (PNG spec §9.2).
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = cur[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown filter ${filter}`);
      cur[x] = value & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      out[di] = cur[si];
      out[di + 1] = cur[si + 1];
      out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }

    cur.copy(prev);
    cur = Buffer.alloc(stride);
  }

  return out;
}

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
};

console.log('\nMediaPulse icon checks\n');

const EXPECTED = [
  ['icon16.png', 16],
  ['icon48.png', 48],
  ['icon128.png', 128]
];

for (const [name, size] of EXPECTED) {
  const path = resolve(iconDir, name);
  if (!existsSync(path)) {
    check(`${name} exists`, false);
    continue;
  }

  const buf = readFileSync(path);
  let ihdr;
  try {
    ihdr = readIhdr(buf);
    check(`${name} is a valid PNG`, true, `${buf.length} bytes`);
  } catch (err) {
    check(`${name} is a valid PNG`, false, err.message);
    continue;
  }

  check(`${name} is ${size}x${size}`, ihdr.width === size && ihdr.height === size, `got ${ihdr.width}x${ihdr.height}`);

  let pixels;
  try {
    pixels = decodeRgba(buf, ihdr);
  } catch (err) {
    check(`${name} decodes`, false, err.message);
    continue;
  }

  const alphaAt = (x, y) => pixels[(y * size + x) * 4 + 3];

  // Rounded corners must be transparent, otherwise the icon reads as a
  // hard-edged square in the Chrome toolbar.
  const corners = [alphaAt(0, 0), alphaAt(size - 1, 0), alphaAt(0, size - 1), alphaAt(size - 1, size - 1)];
  check(`${name} has transparent corners`, corners.every((a) => a === 0), `alpha=${corners.join(',')}`);

  // The icon must be mostly opaque so it stays legible at 16px.
  let opaque = 0;
  let whiteish = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 128) {
      opaque += 1;
      if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220) whiteish += 1;
    }
  }
  const opaquePct = (opaque / (size * size)) * 100;
  const whitePct = (whiteish / (size * size)) * 100;

  check(`${name} is well covered`, opaquePct > 70 && opaquePct < 99, `${opaquePct.toFixed(1)}% opaque`);
  check(`${name} has a visible glyph`, whitePct > 3 && whitePct < 45, `${whitePct.toFixed(1)}% light pixels`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
