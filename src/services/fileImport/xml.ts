/**
 * Tiny, dependency-free XML reading for activity files (GPX, TCX).
 *
 * `DOMParser` isn't available everywhere the import code runs (unit tests,
 * workers) and activity files can hold 100k+ trackpoints, so this is a
 * streaming, SAX-style scanner rather than a DOM: parsers get open / text /
 * close callbacks and keep only what they need.
 *
 * Tolerant by design, because exporters are sloppy:
 *  - element and attribute names are reported as lower-cased LOCAL names
 *    ("gpxtpx:hr" → "hr", "ns3:RunCadence" → "runcadence"), so namespace
 *    prefixes and capitalization don't matter;
 *  - attributes may use either quote style and appear in any order;
 *  - CDATA sections, comments, processing instructions and DOCTYPEs (with an
 *    internal subset) are handled; leading whitespace before `<?xml` is fine;
 *  - predefined, decimal and hex entities are decoded, unknown ones kept;
 *  - mismatched end tags are repaired and a truncated document is closed, so
 *    a partially written file still yields its data.
 */

/** Callbacks for `scanXml`. `path` is the live element stack (lower-cased local names), innermost last. */
export interface XmlHandler {
  /** Start of an element; `path` already includes it. */
  open?(name: string, attrs: Record<string, string>, path: readonly string[]): void;
  /** Character data inside the innermost element of `path` (entities decoded, CDATA unwrapped, never blank). */
  text?(text: string, path: readonly string[]): void;
  /** End of an element (also right after `open` for `<empty/>` elements); `path` still includes it. */
  close?(name: string, path: readonly string[]): void;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

/** Decode XML entities (`&amp;`, `&#233;`, `&#xE9;`, …); unknown entities are kept verbatim. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** "gpxtpx:TrackPointExtension" → "trackpointextension". */
export function localName(qualifiedName: string): string {
  const colon = qualifiedName.indexOf(':');
  return (colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName).toLowerCase();
}

const ATTRIBUTE_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (source.indexOf('=') < 0) return attrs;
  ATTRIBUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUTE_RE.exec(source)) !== null) {
    attrs[localName(m[1])] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Index of the `>` that ends a start tag, skipping `>` inside quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  const gt = xml.indexOf('>', from);
  if (gt < 0) return -1;
  const head = xml.slice(from, gt);
  if (head.indexOf('"') < 0 && head.indexOf("'") < 0) return gt;
  let quote = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    }
  }
  return -1;
}

/** End of a `<!DOCTYPE …>`-style declaration, honouring an internal `[…]` subset. */
function skipDeclaration(xml: string, from: number): number {
  let depth = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (c === 91) depth++;
    else if (c === 93) depth--;
    else if (c === 62 && depth <= 0) return i + 1;
  }
  return xml.length;
}

function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c >= 0x80;
}

/** Stream through an XML document, invoking `handler` for elements and text. Never throws on bad markup. */
export function scanXml(xml: string, handler: XmlHandler): void {
  const path: string[] = [];
  const len = xml.length;
  let pos = 0;
  let text = '';

  const flushText = (): void => {
    if (!text) return;
    if (path.length && handler.text && /\S/.test(text)) handler.text(text, path);
    text = '';
  };
  const closeTo = (depth: number): void => {
    while (path.length > depth) {
      handler.close?.(path[path.length - 1], path);
      path.pop();
    }
  };

  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) {
      text += decodeEntities(xml.slice(pos));
      break;
    }
    if (lt > pos) text += decodeEntities(xml.slice(pos, lt));
    const next = xml.charCodeAt(lt + 1);

    if (next === 33 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        pos = end < 0 ? len : end + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        text += xml.slice(lt + 9, end < 0 ? len : end);
        pos = end < 0 ? len : end + 3;
      } else {
        pos = skipDeclaration(xml, lt + 2);
      }
      continue;
    }
    if (next === 63 /* ? */) {
      const end = xml.indexOf('?>', lt + 2);
      pos = end < 0 ? len : end + 2;
      continue;
    }
    if (next === 47 /* / */) {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) break;
      flushText();
      const name = localName(xml.slice(lt + 2, end).trim());
      const depth = path.lastIndexOf(name);
      // Repair mismatched nesting by closing intermediate elements; ignore stray end tags.
      if (depth >= 0) closeTo(depth);
      pos = end + 1;
      continue;
    }
    if (!isNameStart(next)) {
      text += '<'; // a stray '<' in text content
      pos = lt + 1;
      continue;
    }

    const end = findTagEnd(xml, lt + 1);
    if (end < 0) break;
    flushText();
    const selfClosing = xml.charCodeAt(end - 1) === 47;
    const inner = xml.slice(lt + 1, selfClosing ? end - 1 : end);
    let nameEnd = 0;
    while (nameEnd < inner.length) {
      const c = inner.charCodeAt(nameEnd);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) break;
      nameEnd++;
    }
    const name = localName(inner.slice(0, nameEnd));
    path.push(name);
    handler.open?.(name, parseAttributes(inner.slice(nameEnd)), path);
    if (selfClosing) closeTo(path.length - 1);
    pos = end + 1;
  }
  flushText();
  closeTo(0); // a truncated document still delivers what it contained
}

// ── Values ────────────────────────────────────────────────────────────────────

/**
 * Parse an XML timestamp to UTC ms. Accepts ISO-8601 with "Z" or an offset
 * ("+02:00" / "+0200"), any number of fractional digits, a space instead of
 * "T", and no zone at all (GPX and TCX define timestamps as UTC). NaN if invalid.
 */
export function parseXmlTime(value: string): number {
  let iso = value.trim();
  if (!iso) return NaN;
  iso = iso.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(iso) && /T\d{2}:\d{2}/.test(iso)) iso += 'Z';
  return Date.parse(iso);
}

/** Parse a number ("12.5", " 12 ", tolerating a decimal comma "12,5"); undefined if invalid. */
export function parseXmlNumber(value: string): number | undefined {
  const s = value.trim();
  if (!s) return undefined;
  let n = Number(s);
  if (!Number.isFinite(n) && /^-?\d+,\d+$/.test(s)) n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

// ── Bytes → text ──────────────────────────────────────────────────────────────

/** Windows-1252 characters for bytes 0x80–0x9F (browsers treat ISO-8859-1 the same way). */
const CP1252_80 =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

const CHUNK = 0x2000;

function decodeSingleByte(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, i + CHUNK);
    let chunk = String.fromCharCode(...part);
    if (part.some((b) => b >= 0x80 && b < 0xa0)) {
      chunk = chunk.replace(/[\u0080-\u009f]/g, (c) => CP1252_80[c.charCodeAt(0) - 0x80]);
    }
    out += chunk;
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const units = bytes.length >> 1;
  let out = '';
  for (let i = 0; i < units; i += CHUNK) {
    const end = Math.min(units, i + CHUNK);
    const codes: number[] = new Array(end - i);
    for (let k = i; k < end; k++) {
      const a = bytes[2 * k];
      const b = bytes[2 * k + 1];
      codes[k - i] = littleEndian ? a | (b << 8) : (a << 8) | b;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

/**
 * Decode an XML file's bytes to text: UTF-8 (default, BOM stripped), UTF-16
 * LE/BE (BOM or `<` + NUL pattern) and declared ISO-8859-1 / Windows-1252 /
 * ASCII encodings.
 */
export function decodeXmlBytes(data: Uint8Array): string {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) return decodeUtf16(data.subarray(2), true);
    if (data[0] === 0xfe && data[1] === 0xff) return decodeUtf16(data.subarray(2), false);
    if (data[0] === 0x3c && data[1] === 0 && data.length >= 4 && data[3] === 0) return decodeUtf16(data, true);
    if (data[0] === 0 && data[1] === 0x3c) return decodeUtf16(data, false);
  }
  const head = decodeSingleByte(data.subarray(0, Math.min(data.length, 512)));
  const declared = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1].toLowerCase();
  if (declared && /^(?:iso[-_]?8859[-_]?1|latin-?1|l1|windows-1252|cp1252|us-ascii|ascii)$/.test(declared)) {
    return decodeSingleByte(data);
  }
  return new TextDecoder('utf-8').decode(data);
}
