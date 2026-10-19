// src/probe.js — minimal media duration probing for MP4 and MKV.
//
// Deliberately small: we parse just enough to find the container's duration
// field, reading only the first/last kilobyte of each file. No demuxing, no
// dependencies. Returns null when the format is unknown or the file is
// truncated/corrupt — the caller treats null as "duration not available",
// which is fine for sorting (nulls sort last in ascending order).
//
// MP4: walk the top-level box tree looking for moov → mvhd; duration is
//      divided by its timescale. moov can be at the start (fast start) or
//      the end of the file, so we scan the head and the tail.
// MKV: walk EBML: Segment (0x18538067) → Info (0x1549A966) → either
//      TimestampScale (0x2AD7B1) + Duration (0x4489, in scaled ticks) or
//      the duration directly in nanoseconds. Both are vint-length encoded.

import fs from 'node:fs';

// NB: BigInt literals — readVint() returns BigInt values, so the constants
// must be BigInt too or the === comparisons never match.
const EBML_VINT_ID = {
  SEGMENT: 0x18538067n,
  INFO: 0x1549A966n,
  DURATION: 0x4489n,
  TIMESTAMP_SCALE: 0x2AD7B1n,
};

/**
 * Probe a media file for its duration in seconds, or null.
 * @param {string} absPath
 * @returns {Promise<number|null>}
 */
export async function probeDuration(absPath) {
  const ext = absPath.toLowerCase().split('.').pop();
  if (ext === 'mkv' || ext === 'webm') return probeMkv(absPath);
  if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') return probeMp4(absPath);
  return null; // other formats: not probed in v1
}

// ---- MP4 -------------------------------------------------------------------

async function probeMp4(absPath) {
  const MAX_HEAD = 256 * 1024;
  const MAX_TAIL = 2 * 1024 * 1024; // mdat can be huge; moov at the end
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size < 32) return null;

    const headSize = Math.min(MAX_HEAD, size);
    const head = Buffer.alloc(headSize);
    await fh.read(head, 0, headSize, 0);

    // Walk boxes in the head region, recursing into moov.
    let off = 0;
    while (off + 8 <= headSize) {
      const boxSize = head.readUInt32BE(off);
      const boxType = head.toString('ascii', off + 4, off + 8);
      if (boxSize === 1) break; // 64-bit sizes: skip, keep it simple
      if (boxSize < 8) break;
      if (boxType === 'moov') {
        const d = findMvhd(head.subarray(off, off + Math.min(boxSize, headSize - off)));
        if (d) return d;
      }
      if (boxType === 'mdat' && boxSize >= headSize - off) break; // rest of head is payload
      off += boxSize;
      if (boxSize === 0) break;
    }

    // moov not found in the head — try the tail (seeked files).
    if (size > 0) {
      const tailSize = Math.min(MAX_TAIL, size);
      const tail = Buffer.alloc(tailSize);
      await fh.read(tail, 0, tailSize, size - tailSize);
      off = 0;
      while (off + 8 <= tailSize) {
        const boxSize = tail.readUInt32BE(off);
        const boxType = tail.toString('ascii', off + 4, off + 8);
        if (boxSize < 8) break;
        if (boxType === 'moov') {
          const d = findMvhd(tail.subarray(off, off + Math.min(boxSize, tailSize - off)));
          if (d) return d;
        }
        off += boxSize;
        if (boxSize === 0) break;
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Look for mvhd inside a moov box; return seconds or null. */
function findMvhd(moov) {
  let off = 8; // skip moov header
  while (off + 8 <= moov.length) {
    const boxSize = moov.readUInt32BE(off);
    if (boxSize < 8) break;
    if (moov.toString('ascii', off + 4, off + 8) === 'mvhd') return parseMvhd(moov.subarray(off + 8, off + Math.min(boxSize, moov.length)));
    off += boxSize;
    if (boxSize === 0) break;
  }
  return null;
}

function parseMvhd(mvhd) {
  const version = mvhd.readUInt8(0);
  let ts, dur;
  if (version === 1) {
    if (mvhd.length < 32) return null;
    ts = mvhd.readUInt32BE(20);   // timescale (v1: creation 8 + mod 8)
    dur = Number(mvhd.readBigUInt64BE(24));
  } else {
    if (mvhd.length < 20) return null;
    ts = mvhd.readUInt32BE(12);   // v0: creation 4 + mod 4
    dur = mvhd.readUInt32BE(16);
  }
  if (!ts || ts === 0 || dur === 0) return null;
  return dur / ts;
}

// ---- MKV (EBML) ------------------------------------------------------------

async function probeMkv(absPath) {
  const MAX_HEAD = 256 * 1024;
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const size = (await fh.stat()).size;
    const headSize = Math.min(MAX_HEAD, size);
    const head = Buffer.alloc(headSize);
    await fh.read(head, 0, headSize, 0);

    // EBML elements: ID (vint) then size (vint).
    let pos = 0;
    const seen = { [EBML_VINT_ID.SEGMENT]: false, [EBML_VINT_ID.INFO]: false };
    let duration = null;
    let tsScale = 1000000n; // default 1ms in ns

    while (pos + 2 <= head.length) {
      const id = readVint(head, pos, true);
      if (!id) break;
      pos += id.bytes;
      const sizeV = readVint(head, pos);
      if (!sizeV) break;
      pos += sizeV.bytes;
      const end = sizeV.value === 'unknown' ? head.length : pos + Number(sizeV.value);

      if (id.value === EBML_VINT_ID.SEGMENT) {
        if (!seen[EBML_VINT_ID.SEGMENT]) {
          seen[EBML_VINT_ID.SEGMENT] = true;
          continue; // descend into segment: its children start at pos
        }
        break;
      }
      if (id.value === EBML_VINT_ID.INFO) {
        // Re-scan Info region for Duration/TimestampScale.
        const infoEnd = Math.min(end, head.length);
        let ip = pos;
        while (ip + 2 <= infoEnd) {
          const iid = readVint(head, ip, true);
          if (!iid) break;
          ip += iid.bytes;
          const isz = readVint(head, ip);
          if (!isz) break;
          ip += isz.bytes;
          const ival = Number(isz.value);
          if (iid.value === EBML_VINT_ID.DURATION && ival <= 8 && ip + ival <= infoEnd) {
            duration = head.readDoubleBE(ip);
          }
          if (iid.value === EBML_VINT_ID.TIMESTAMP_SCALE && ival <= 8 && ip + ival <= infoEnd) {
            tsScale = BigInt(head.readUIntBE(ip, ival));
          }
          ip += ival;
        }
        // NB: no break here — falling through lets the shared duration
        // return (below) run; a break would exit the outer while and hit
        // the `return null` after it.
      }
      if (id.value === EBML_VINT_ID.DURATION && duration === null) {
        const ival = Number(sizeV.value);
        if (ival <= 8 && pos + ival <= head.length) duration = head.readDoubleBE(pos);
      }
      if (duration !== null && duration > 0) {
        return Number(tsScale * BigInt(Math.round(duration))) / 1e9;
      }
      pos = end;
      if (end <= 0) break;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Read one EBML variable-length integer. Returns { value, bytes } or null.
 *  `includeMarker` keeps the marker bit in the value (needed for element
 *  IDs, whose spec value includes the marker); sizes strip it. */
function readVint(buf, off, includeMarker = false) {
  if (off >= buf.length) return null;
  const first = buf[off];
  let len = 1;
  let mask = 0x80;
  while ((first & mask) === 0 && mask !== 0) { mask >>= 1; len++; }
  if (len > 8 || off + len > buf.length) return null;
  let value;
  if (includeMarker) {
    value = 0;
    for (let i = 0; i < len; i++) value = value * 256 + buf[off + i];
  } else {
    value = first & (mask - 1);
    for (let i = 1; i < len; i++) value = value * 256 + buf[off + i];
  }
  return { value: BigInt(value), bytes: len };
}
