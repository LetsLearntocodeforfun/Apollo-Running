/**
 * DEFLATE / gzip decompression for activity files and export archives.
 *
 * Uses the platform's native `DecompressionStream` (Electron, modern
 * browsers, Node) when it supports the format, and otherwise falls back to a
 * compact pure-TypeScript RFC 1951 decoder (stored, fixed-Huffman and
 * dynamic-Huffman blocks), so imports work in every environment — including
 * unit tests — without third-party dependencies.
 *
 * Every decoder takes an output cap (`maxOutput`) and stops with an
 * `OutputLimitError` as soon as the data would inflate past it, so a crafted
 * or corrupt archive (a "zip bomb") can't exhaust memory.
 *
 * Also exports CRC-32, used to verify ZIP entries and gzip members.
 */

import { FileImportError } from './types';

const CORRUPT = 'The compressed data is corrupt or truncated.';

/** Thrown when decompressed data would exceed the caller's `maxOutput`. */
export class OutputLimitError extends FileImportError {
  constructor() {
    super('The file is too large to import.');
    this.name = 'OutputLimitError';
  }
}

// ── CRC-32 ────────────────────────────────────────────────────────────────────

let crcTable: Int32Array | null = null;

function getCrcTable(): Int32Array {
  if (crcTable) return crcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  crcTable = table;
  return table;
}

/**
 * CRC-32 (IEEE 802.3 polynomial, as used by ZIP and gzip) as an unsigned
 * 32-bit number. Pass a previous result to continue a running checksum.
 */
export function crc32(data: Uint8Array, previous: number = 0): number {
  const table = getCrcTable();
  let c = ~previous;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ── Pure-TypeScript inflate (RFC 1951) ────────────────────────────────────────

/** Base match lengths for length codes 257..285 and their extra bits. */
const LEN_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LEN_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
/** Base distances for distance codes 0..29 and their extra bits. */
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
/** Order in which code-length code lengths are stored in a dynamic block header. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * Single-level Huffman lookup table: indexed by the next `bits` input bits
 * (LSB-first, as DEFLATE packs them); each entry is `symbol << 4 | codeLength`
 * and 0 marks an unused code.
 */
interface HuffmanTable {
  table: Int32Array;
  bits: number;
}

function buildHuffman(lengths: Uint8Array): HuffmanTable {
  const counts = new Uint16Array(16);
  let maxBits = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (len) {
      counts[len]++;
      if (len > maxBits) maxBits = len;
    }
  }
  // Reject over-subscribed code sets (incomplete sets are legal for tiny trees).
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new FileImportError(CORRUPT);
  }
  const next = new Uint16Array(16);
  for (let len = 1, code = 0; len <= 15; len++) {
    code = (code + counts[len - 1]) << 1;
    next[len] = code;
  }
  const size = 1 << maxBits;
  const table = new Int32Array(size);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const len = lengths[symbol];
    if (!len) continue;
    const code = next[len]++;
    // Huffman codes are defined MSB-first but packed LSB-first: reverse them.
    let reversed = 0;
    for (let i = 0; i < len; i++) reversed |= ((code >>> i) & 1) << (len - 1 - i);
    const entry = (symbol << 4) | len;
    for (let j = reversed; j < size; j += 1 << len) table[j] = entry;
  }
  return { table, bits: maxBits };
}

let fixedTables: { lit: HuffmanTable; dist: HuffmanTable } | null = null;

function getFixedTables(): { lit: HuffmanTable; dist: HuffmanTable } {
  if (fixedTables) return fixedTables;
  const lit = new Uint8Array(288);
  lit.fill(8, 0, 144);
  lit.fill(9, 144, 256);
  lit.fill(7, 256, 280);
  lit.fill(8, 280, 288);
  const dist = new Uint8Array(30).fill(5);
  fixedTables = { lit: buildHuffman(lit), dist: buildHuffman(dist) };
  return fixedTables;
}

/** Result of decoding one raw DEFLATE stream. */
interface InflateResult {
  out: Uint8Array;
  /** Offset of the first input byte after the end of the DEFLATE stream. */
  end: number;
}

/**
 * Decode one raw DEFLATE stream starting at `start`. Trailing input is left
 * untouched. Throws OutputLimitError once the output would exceed `maxOutput`.
 */
function inflateStream(data: Uint8Array, start: number, sizeHint: number, maxOutput: number): InflateResult {
  const inLen = data.length;
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;
  /** Zero bytes fed past the end of the input (only legal if never consumed). */
  let padded = 0;

  const initial = sizeHint > 0 ? sizeHint : Math.max(1024, (inLen - start) * 4);
  let out = new Uint8Array(Math.max(0, Math.min(initial, maxOutput)));
  let op = 0;

  /** Make room for output up to `needed` bytes (never beyond `maxOutput`). */
  const ensure = (needed: number): void => {
    if (needed <= out.length) return;
    if (needed > maxOutput) throw new OutputLimitError();
    let n = Math.max(1024, out.length * 2);
    while (n < needed) n *= 2;
    const bigger = new Uint8Array(Math.min(n, maxOutput));
    bigger.set(out.subarray(0, op));
    out = bigger;
  };

  const need = (n: number): void => {
    while (bitCnt < n) {
      if (pos < inLen) bitBuf |= data[pos++] << bitCnt;
      else if (++padded > 4) throw new FileImportError(CORRUPT);
      bitCnt += 8;
    }
  };

  const checkOverrun = (): void => {
    if (padded && bitCnt < padded * 8) throw new FileImportError(CORRUPT);
  };

  const bits = (n: number): number => {
    if (n === 0) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    checkOverrun();
    return v;
  };

  const decode = (h: HuffmanTable): number => {
    need(h.bits);
    const entry = h.table[bitBuf & ((1 << h.bits) - 1)];
    const len = entry & 15;
    if (len === 0) throw new FileImportError(CORRUPT);
    bitBuf >>>= len;
    bitCnt -= len;
    checkOverrun();
    return entry >>> 4;
  };

  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);

    if (type === 0) {
      // Stored block: skip to a byte boundary and hand buffered whole bytes back.
      bitBuf >>>= bitCnt & 7;
      bitCnt -= bitCnt & 7;
      if (padded) throw new FileImportError(CORRUPT);
      pos -= bitCnt >>> 3;
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > inLen) throw new FileImportError(CORRUPT);
      const len = data[pos] | (data[pos + 1] << 8);
      const nlen = data[pos + 2] | (data[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new FileImportError(CORRUPT);
      pos += 4;
      if (pos + len > inLen) throw new FileImportError(CORRUPT);
      ensure(op + len);
      out.set(data.subarray(pos, pos + len), op);
      op += len;
      pos += len;
      continue;
    }

    let lit: HuffmanTable;
    let dist: HuffmanTable;
    if (type === 1) {
      ({ lit, dist } = getFixedTables());
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      if (hlit > 286 || hdist > 30) throw new FileImportError(CORRUPT);
      const clLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = bits(3);
      const clTable = buildHuffman(clLengths);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < lengths.length;) {
        const sym = decode(clTable);
        if (sym < 16) {
          lengths[i++] = sym;
          continue;
        }
        let repeat: number;
        let value = 0;
        if (sym === 16) {
          if (i === 0) throw new FileImportError(CORRUPT);
          value = lengths[i - 1];
          repeat = 3 + bits(2);
        } else if (sym === 17) {
          repeat = 3 + bits(3);
        } else {
          repeat = 11 + bits(7);
        }
        if (i + repeat > lengths.length) throw new FileImportError(CORRUPT);
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
      if (lengths[256] === 0) throw new FileImportError(CORRUPT);
      lit = buildHuffman(lengths.subarray(0, hlit));
      dist = buildHuffman(lengths.subarray(hlit));
    } else {
      throw new FileImportError(CORRUPT);
    }

    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        if (op >= out.length) ensure(op + 1);
        out[op++] = sym;
        continue;
      }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= 29) throw new FileImportError(CORRUPT);
      const length = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = decode(dist);
      if (di >= 30) throw new FileImportError(CORRUPT);
      const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      if (distance > op) throw new FileImportError(CORRUPT);
      ensure(op + length);
      let from = op - distance;
      for (let k = 0; k < length; k++) out[op++] = out[from++];
    }
  }

  // Unused whole bytes still in the bit buffer belong to whatever follows.
  const end = pos - (bitCnt >>> 3);
  return { out: op === out.length ? out : out.slice(0, op), end };
}

/**
 * Decompress raw DEFLATE data (ZIP method 8) with the built-in decoder.
 * `sizeHint` (e.g. the ZIP entry's uncompressed size) avoids re-allocations;
 * output beyond `maxOutput` bytes throws OutputLimitError.
 */
export function inflateRawSync(data: Uint8Array, sizeHint: number = 0, maxOutput: number = Infinity): Uint8Array {
  return inflateStream(data, 0, sizeHint, maxOutput).out;
}

// ── gzip (RFC 1952) ───────────────────────────────────────────────────────────

const GZIP_FHCRC = 0x02;
const GZIP_FEXTRA = 0x04;
const GZIP_FNAME = 0x08;
const GZIP_FCOMMENT = 0x10;

function readUint32LE(data: Uint8Array, at: number): number {
  return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** True when `data` starts with the gzip magic bytes. */
export function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Decompress gzip data with the built-in decoder: parses the member header
 * (FEXTRA / FNAME / FCOMMENT / FHCRC), verifies each member's CRC-32 and size
 * and concatenates multiple members like `gunzip` does. Output beyond
 * `maxOutput` bytes (all members together) throws OutputLimitError.
 */
export function gunzipSync(data: Uint8Array, maxOutput: number = Infinity): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pos = 0;
  while (pos < data.length) {
    if (data.length - pos < 18 || data[pos] !== 0x1f || data[pos + 1] !== 0x8b) {
      // Like gzip(1): trailing zero padding / garbage after a valid member is ignored.
      if (chunks.length > 0) break;
      throw new FileImportError('Not a gzip file.');
    }
    if (data[pos + 2] !== 8) throw new FileImportError('Unsupported gzip compression method.');
    const flags = data[pos + 3];
    let p = pos + 10;
    if (flags & GZIP_FEXTRA) {
      if (p + 2 > data.length) throw new FileImportError(CORRUPT);
      p += 2 + (data[p] | (data[p + 1] << 8));
    }
    if (flags & GZIP_FNAME) {
      while (p < data.length && data[p] !== 0) p++;
      p++;
    }
    if (flags & GZIP_FCOMMENT) {
      while (p < data.length && data[p] !== 0) p++;
      p++;
    }
    if (flags & GZIP_FHCRC) p += 2;
    if (p >= data.length) throw new FileImportError(CORRUPT);

    const { out, end } = inflateStream(data, p, 0, maxOutput - total);
    if (end + 8 > data.length) throw new FileImportError(CORRUPT);
    if (readUint32LE(data, end) !== crc32(out) || readUint32LE(data, end + 4) !== out.length % 0x100000000) {
      throw new FileImportError('The gzip data failed its integrity check (corrupt or truncated file).');
    }
    chunks.push(out);
    total += out.length;
    pos = end + 8;
  }
  return concatChunks(chunks, total);
}

// ── Native DecompressionStream ────────────────────────────────────────────────

/** The reader side of a native stream (`cancel` may be missing in test doubles). */
interface NativeReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void> | void;
}

/**
 * The parts of the Compression Streams API used here, typed structurally so
 * environments without it (and test doubles) need no DOM stream types.
 */
interface NativeDecompressor {
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
  readonly readable: {
    getReader(): NativeReader;
  };
}

type NativeDecompressorCtor = new (format: string) => NativeDecompressor;

/**
 * Decompress with the native `DecompressionStream`. Resolves to null when the
 * API or the format is unavailable; rejects when the data is invalid, and with
 * OutputLimitError (after cancelling the stream) once output passes `maxOutput`.
 */
async function nativeDecompress(
  format: 'deflate-raw' | 'gzip',
  data: Uint8Array,
  maxOutput: number,
): Promise<Uint8Array | null> {
  const Ctor = (globalThis as unknown as { DecompressionStream?: NativeDecompressorCtor }).DecompressionStream;
  if (typeof Ctor !== 'function') return null;
  let stream: NativeDecompressor;
  try {
    stream = new Ctor(format);
  } catch {
    return null; // e.g. 'deflate-raw' is not supported by older engines
  }
  const writer = stream.writable.getWriter();
  // Write and read concurrently: awaiting the write first can deadlock on back-pressure.
  const written = writer.write(data).then(() => writer.close());
  written.catch(() => { /* the same failure surfaces from the reader */ });
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      total += value.length;
      if (total > maxOutput) {
        // Stop decompressing the rest instead of buffering it.
        if (typeof reader.cancel === 'function') {
          Promise.resolve(reader.cancel()).catch(() => { /* already failing */ });
        }
        throw new OutputLimitError();
      }
      chunks.push(value);
    }
  }
  await written;
  return concatChunks(chunks, total);
}

/**
 * Decompress raw DEFLATE data (ZIP method 8). Uses the native decoder when
 * available and the built-in one otherwise (or when the native decoder rejects
 * the data, e.g. because of padding after the end of the stream). Output
 * beyond `maxOutput` bytes rejects with OutputLimitError.
 */
export async function inflateRaw(
  data: Uint8Array,
  sizeHint: number = 0,
  maxOutput: number = Infinity,
): Promise<Uint8Array> {
  try {
    const native = await nativeDecompress('deflate-raw', data, maxOutput);
    if (native) return native;
  } catch (err) {
    if (err instanceof OutputLimitError) throw err;
    // Fall through: the built-in decoder tolerates trailing bytes and reports corruption itself.
  }
  return inflateRawSync(data, sizeHint, maxOutput);
}

/**
 * Decompress gzip data (e.g. Strava's `activities/123.fit.gz`), including
 * multi-member files. Output beyond `maxOutput` bytes rejects with OutputLimitError.
 */
export async function gunzip(data: Uint8Array, maxOutput: number = Infinity): Promise<Uint8Array> {
  if (!isGzip(data)) throw new FileImportError('Not a gzip file.');
  try {
    const native = await nativeDecompress('gzip', data, maxOutput);
    if (native) return native;
  } catch (err) {
    if (err instanceof OutputLimitError) throw err;
    // Fall through: the built-in decoder handles multi-member files and padding.
  }
  return gunzipSync(data, maxOutput);
}
