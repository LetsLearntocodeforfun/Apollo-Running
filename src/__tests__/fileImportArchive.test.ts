/**
 * Unit tests for the archive layer of activity file import: fileImport/inflate.ts
 * (pure-TypeScript DEFLATE and gzip, CRC-32, decompression output caps) and
 * fileImport/archive.ts (random-access ZIP reading, ZIP64, name encodings,
 * nested archives, Strava / Garmin export metadata).
 *
 * Compressed fixtures were produced with Python's zlib / gzip / zipfile and are
 * embedded as base64 together with the original size and CRC-32, so the
 * built-in decoder is checked against the reference implementation. The async
 * (native-first) APIs run once with DecompressionStream stubbed out and once
 * with a stand-in for it, covering output caps, cancellation and the fallback.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutputLimitError,
  crc32,
  gunzip,
  gunzipSync,
  inflateRaw,
  inflateRawSync,
  isGzip,
} from '@/services/fileImport/inflate';
import {
  ZipArchive,
  archiveFileKey,
  blobSource,
  bytesSource,
  decodeCp437,
  findGarminSummary,
  isZip,
  parseCsv,
  parseGarminSummaries,
  parseStravaActivitiesCsv,
  readAll,
  sliceSource,
  type ByteSource,
  type ZipEntry,
} from '@/services/fileImport/archive';
import { FileImportError } from '@/services/fileImport/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface Fixture {
  /** Uncompressed size (0 for archives). */
  size: number;
  /** CRC-32 of the uncompressed data (0 for archives). */
  crc: number;
  b64: string;
}

/**
 * Produced with Python 3's zlib, gzip and zipfile:
 *  - fixed … zeros: raw DEFLATE (wbits -15) — fixed and dynamic Huffman, a match
 *    ~32 KB back, a stored block, incompressible bytes, a long run, an empty
 *    stream, Z_HUFFMAN_ONLY, Z_RLE, sync + full flushes, and 64 KB of zeros;
 *  - gzip*: plain, every header flag (FTEXT|FHCRC|FEXTRA|FNAME|FCOMMENT), two
 *    members, trailing zero padding, a corrupted CRC, and 64 KB of zeros;
 *  - zipBasic: a directory, a deflated GPX, a stored .gpx.gz, a CSV, a UTF-8
 *    name, an empty file, and a comment containing an end-record signature;
 *  - zipNested: Garmin's DI_CONNECT layout with a stored and a deflated inner ZIP;
 *  - zip64, zipCustom, zipBomb (assembled by hand): ZIP64 records; a CP437 name,
 *    an Info-ZIP Unicode Path field, an encrypted flag, a backslash path and
 *    corrupted data; an entry that declares 1 KB but inflates to 64 KB.
 */
const FIXTURES = {
  fixed: { size: 45, crc: 0xd8d97ba5, b64: '80jNycnXUXAsyAfSigoeeLkA' },
  dynamic: { size: 5000, crc: 0x7b0c4ed6, b64: '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' },
  far: { size: 33500, crc: 0x5bf25bb6, b64: '7d1JctswEEDRq/AImNE4DstmIpWooSg5Fd8+GAhSsrPKMvXfwqZIoNFoANzyMI3LYzidk7Gih8d0vl2tcdYMy/R2/TUtn+K0VcPycRnuj+X4Pg0/cod5OnkTRQ3TeP+sD3vzHGpYxsckJqRyfTrHoNIwjzetTUzD4TjPe+M11vAYb9Piklbt+fHymJZf47w97//vt/n4GN7G9+nyNkUR7Yf5evlZwreet/FtGs7HedrH2C4eh2W6H67zu9UphJK1EVFS07XWJlvL4HzsA3idbKoDSMj1qT20Cqql4ZLkKGXknt2h1DLaHKPXqpanJV1Lq20Ke2n3eX6/U3pqcUo/j1BCuza98id4p2KdsqikfBuit3XO5OTXmdRwJtk8t9cC1+qtyT7nXFvVgWpQL05ibZy8cr6ueF2z11on0UHWBz1lpaKpc9gX5ONiRcK6eU7n/MOb9qNGK43rRStcGdWJS6Zsp3rLG2X7MFvUlmy9t046JGvkadi8zMHbXKdy1WZer9qfvt1NyWyNYI3Rri3rWp0oOsUvg9ZIp7MxNvp9R9e16HU2XpUdVzJQIdevV7xOsMzcBQmx1aD13MvxdDNXJkVv3NODOvi6FGMe4HC9eK2Mf91JJunYwhurvdQSt541bu+5H5E1tW8HtY65zUp8lF4rHUOSdWJeYp7NXw9tS/3lLWDz3uovhuel2C7yOGoPt02s9PA65L1TZ+HyIdVflqbs0/2Q5ePrjDK9+tuDnlofoW2NNVB+y6iwnzmnkw6txVa1/bD0SNtyWeUkfUlq61dn+/pWfd0ZNXB7h7y2el71EvJ0DuJF+vOco8/v7N8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPyjA98/5/vnfP+c75/z/fP/7vvnfwA=' },
  stored: { size: 1000, crc: 0xd9309f50, b64: 'AegDF/x0ZW1wbzQ3MzI0IG1hcmF0aG9uIHNwbGl0Mjc4MTUgdGFwZXI4OTI5MiBtYXJhdGhvbiBrbSByZWNvdmVyeSB0aHJlc2hvbGQgcmVjb3Zlcnk0NzA4IHJ1biBsYXAgY2FkZW5jZSByZWNvdmVyeTIzMjU2IGhlYXJ0MjMxNjMgbGFwNjY4NjggcmVjb3ZlcnkgcmVjb3ZlcnkgbWFyYXRob24gc3RyaWRlIHJlY292ZXJ5IG1pbGUgbWlsZSBzdHJpZGU5ODgyOCBrbSBzdHJpZGUgaGVhcnQgaGlsbCBtaWxlIHN0cmlkZSBzdHJpZGUgdGhyZXNob2xkIGhpbGwgbGFwIG1hcmF0aG9uIHRhcGVyNjI4ODMgc3BsaXQgcmVjb3ZlcnkgcmVjb3ZlcnkgZmFydGxlayBwYWNlIG1pbGUgdGFwZXIgbGFwIHBhY2UgbG9uZzg1NTc4IHRlbXBvMjk3MDMgbG9uZyBpbnRlcnZhbCBoZWFydCB0ZW1wbyB0ZW1wbzQ3MjE0IG1hcmF0aG9uMzA3MiBlYXN5ODg0MiBydW4yNzcxIG1pbGUyMDU5MyBtYXJhdGhvbiBydW4gdGVtcG8gaGVhcnQ0NzUzIHJ1biB0YXBlciBsb25nNjQwNjIgcnVuIHRocmVzaG9sZCB0ZW1wbyBrbSBpbnRlcnZhbCBoZWFydDkwMDk4IGxhcCBydW4gaW50ZXJ2YWwga20gbGFwNDQ3MDIgcmF0ZTU1MDE4IHJ1biBpbnRlcnZhbCByYXRlMjExMjQgbWFyYXRob244MzI0MCBoZWFydCB0ZW1wbyBoZWFydCBlYXN5Nzc0OTQgaGVhcnQgdGFwZXIgcmF0ZSByYXRlIHJ1bjUwNDMwIGNhZGVuY2U2NzExOSBlYXN5MTMwNzcgcnVuMzAzNDYgbG9uZzY4MjUzIHN0cmlkZSB0aHJlc2hvbGQgcGFjZSBwYWNlIGNhZGVuY2UgcnVuIHRlbXBvIHJlY292ZXJ5IGxvbmcgaGlsbCByZWNvdmVyeSBsb25nIHNwbGl0IG1pbGUgY2FkZW5jZTQwMDk3IHBhY2UgcnVuIHRlbXBvIGhpbGwgZmFydGxlayBydW40ODg3NyBzcGxpdCBlYXN5NjQyODMgcGFjZTQ4OTQxIGttIGludGVydmFsIGttIHJhdGUxMDU1MiB0YXBlciBrbSBsb25nODYzOTcgaGlsbCBoaWxsNTk5MDQgaW50ZXJ2YWwgcmF0ZSBoaWxsIGNhZGVuY2Ugc3BsaXQgbWFyYXRob24gcmF0ZSBlYXN5IGZhcnRsZWs0NjY2OSBtYXJhdGhv' },
  random: { size: 500, crc: 0x3211cb4a, b64: 'AfQBC/48l4shXuqaeaCUEJsD6NZ4Qo07Mf63eIrWjHllo9wmO6Im3u2FY70Dq8YQKML1lwpNxwfS3UR5mLjr4GO2yettZbrNk3H27yLgXRgJIn43Qvesb8eg2k1rgdViklmIlWiVO+dWrurtB9tH/Zursimy3FP2iueSkRq2pzai1PySREgfEHvao/17FljMEWnlJgVLbcRq3x4Lmp3CC2C3llSN4ez7R4E8/wlPARMbmYkI8jL4aEqcQyewCvreVlBc9SPl3GBgdd6FYqTdmK6PGp758M+BRW6iuLc8701v+kKFTYxWAslq/JRQBWCdlqEiD6KgVXdarepam7RHvH0Flg/0rQX2XkCgdEyXmVEtXS9Qwl7YmENMyWAaxdAG+JGvvCFPgDinzUQ9Uy+tb6ayGBqZUvJVrNU5cM/b9SsUVr2mN+KRc0U5yR4Ih/UwUM7W1pMu3UdXztOkFc6eWJYha0qEy9lFdliiakprkWgJ62knMwF68dXhn/yCb4/z/O23OAi+dNbAqb+E9kmLV+M63BHblvhJHs8+CwjnzbGD7DLl4uZukwwDe74eK4BMPakFholpDfDpnB1XIED43Ip6z8gPWjgyH4jj0R4rPcpG6+POINLrAXygktxmDMFFP0SehoVsDXlSxtEA2w7GIAsfDBF7+Qjatg==' },
  run: { size: 10000, crc: 0x467ed497, b64: '7cEBDQAAAMKgrO9fwhxuQAEAAAAAAAAAAMC/AQ==' },
  empty: { size: 0, crc: 0x00000000, b64: 'AwA=' },
  huffmanOnly: { size: 1500, crc: 0xab17d265, b64: 'BcGJjeQwDATAVDoEy/IbDiH3joShHlC8AZz9VWWKOb4VlPnu6xFPeDbO3PWBs45+LnGLqEW5rkcM0N4+MR4LTJwYkhjP+4ioRXneW1igMmBM/Ud747qFE7monuG8FsyhxeO1Hjv+xFz5xRxaHMbUf7R33/d4w2XQ9jscK6qYeO4tbkuMcNbRj+XYIkycyEUVpTntJ4ohieuxHxumW3m4HUe8keRhS4TKwJBEaG8fZIr5ecSwwGXQoL19UMXEc28xHjucdXRQ5os5tDhURjyv84bKQJKHLREugwbKfNd9uW5Mt/Iwrue54VtRxcRzb7B/DdOtPNzOfVsxhxbHdCsPkeRhS4T29jnXbUMVE8+9oTSn/UTh2Thz1weZYg5nHf2443FhDi2OJA9bIoYkIlPMkYvqvq9hwXQrD/djOU8MSYSzjh7jGgIyxRyZYg4T53GuC1QG/sRc+YWzjg7KfPEn5sovqph47g25qEJlwJj6j/Ze9x0WmDjxraDMFyZODEm8wrrsKM1pP1GYOOGso2O6lYf4VgxJxJBE2L8GE+d239uNTDHHkMTzPtcLKgOejTN3fZCLKqZbebht1wKXQTvjvuwwcaI0p/1Ew7JtO4yp/2gv5tDioMz3DOsaMN3KQ8yhxZGLKr417MsS4DJoqEWJJA9bIqZbebjux7lgDi2OXFTh2Thz12cNcQuoYuK5N6gMqIwj3qhi4rm3bbnOBdrbB7mowmXQQJkvkjxsiahFucZjO2H/GlwGDZ6NM3d9MN3KQ/yJufILY+o/2guXQcO3ntd6BNSihMoIy7UGuAzaFfZtRRUTz71t17mfGJKIWpSgzPfajrigionn3lCLEnNocbgM2n1d9w3KfKG9fc5jPy7kogrKfKG9fY71WhZkijnm0OL4VmSKOTLFHJliDs/Gmbs+mG7lIb4VKmOP97bhT8yV33ULS4Rn48xdH3g2ztz1QS1KfCtKc9pPFNOtPEQtSsyhxWHiRC6qoMw3hnVbQJnvEbYdVUw894Y/MVd+4dk4c9cHno0zd32O61xvZIp5WI9rxZDELWzXAcp8r2W9MYcWRxUTz70hycOWCMp8Yf8aPBtn7vrs8b4DSnPaTzTey7khF1V8a4z7EWFM/Ud7MYcWh8q4QjiQ5GFLhIkT9q+hNKf9RMMe7hsug4ZMMQ9hvZDLfw==' },
  rle: { size: 4500, crc: 0xdf49d9c6, b64: '7cEBAQAACICgrqr/P3ShAQGGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGzTvDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDsHlnGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGDbvDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMPmnWEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmHYvDMMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMm3eGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYfPOMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMAzDMGzeGYZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIbNO8MwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMMwDMOweWcL' },
  flushed: { size: 3598, crc: 0xe6d95022, b64: 'bFRbkuMgDLwKR0AIBDqOK2HXrnHslOOZqrn9iLczuz9UMKK71S1yTs94WGJGdcTb/hWPbwKNWs1xOk71mI7pnPeNwAao39Z9+6uOz03dpnvcbtGBtrZXqji9voNmgXidx3KPBk2qNsFYHFWv57qc6jndYl5YO4Nl+/GwHi00dGDNXsmtiGyZ1ZkE13Wdnpacp4omWwJG6iyG5epjWeNVrvojTazxo8vzgBUv8aMxztWzele4S9N5e8bHc89dkjfG1qvLdsbja1rVOR/xNe/rPTCDTppybZX45tKoLaDeBweFpPI31IBEVJkTYmdrvbQoiF3ICM4B2kIaAMFfnC/QCaZoamDExJe6eVnXvkNBNn1Cxo+LI8OrvPRIusYMOAreMfLSEvqf1l6ehyRhyZgitjueAC8CG9JwuHB+bp6CWNnyrUSSleZBWxrK0w7eaajp9+MGSloyrh6kKTDkA7WXk0JAEIVjfn7lXTzyYGk8vuaWJR38vzkXr5qQ9jVbkhUEmUmbpz151l/J7znJ/rEJGOS5DbxLcLXQyl8BluS6ltxKMVAeLY+DRDu8MUC29IlOiy29rHQtw0YFuKoUVCAHXM5FnDZvwVsXrP0BAAD//2RWSRIDIQj8kriM8KZU/n9Ns7gwuaRGRVm6aZK4ZI/zwxCAVB9VmyFA+Z8FVilL070uC2vHtQhymK0FMwRYJBf+zm4HJO6oB+uRC7P0uU2mTGRmjp2/al0npHObVBRMcg0jSPP4+eLFp1rmY/TKcfj5jslthH+XGo8fyO4IE6hXFRb0sww0gMYN8Q0lHkLcHAI1XZdtYfWHg1cf3erM/eGR6OVBhIkJnkjnVVjpBCAt14Pupat6DVhLt+NWYO5U3CZegq2ZUyeD9513m8ealZeKjPLuADdUKPbbTgY/WOdqG8E3TDdXgt7REuZDz59aAPHWNZwTYcBEqP57ZN2/zJUud1SvNO9ufJjE5isaBp7WtkDl6FwBCrk4l8zbvua6CJ7U9ibR/4yzjGqH7p2yk3C5TDWlhxhB2qc0nJ8H8K+CY4ROol5SYYwvVDC+TvPlyUB9XrrdhOtpYr0MlkC9XR6TBtAkDmFeAzpgQKlFtN+3iNo+VsghuNcHFNsvaeQ026D/0kKZ5AcAAP//bVRbkuMgDLwKR0AIBDqOK2HXrnHslOOZqrn9iLczuz9UMKK71S1yTs94WGJGdcTb/hWPbwKNWs1xOk71mI7pnPeNwAao39Z9+6uOz03dpnvcbtGBtrZXqji9voNmgXidx3KPBk2qNsFYHFWv57qc6jndYl5YO4Nl+/GwHi00dGDNXsmtiGyZ1ZkE13Wdnpacp4omWwJG6iyG5epjWeNVrvojTazxo8vzgBUv8aMxztWzele4S9N5e8bHc89dkjfG1qvLdsbja1rVOR/xNe/rPTCDTppybZX45tKoLaDeBweFpPI31IBEVJkTYmdrvbQoiF3ICM4B2kIaAMFfnC/QCaZoamDExJe6eVnXvkNBNn1Cxo+LI8OrvPRIusYMOAreMfLSEvqf1l6ehyRhyZgitjueAC8CG9JwuHB+bp6CWNnyrUSSleZBWxrK0w7eaajp9+MGSloyrh6kKTDkA7WXk0JAEIVjfn7lXTzyYGk8vuaWJR38vzkXr5qQ9jVbkhUEmUmbpz151l/J7znJ/rEJGOS5DbxLcLXQyl8BluS6ltxKMVAeLY+DRDu8MUC29IlOiy29rHQtw0YFuKoUVCAHXM5FnDZvwVsXrP0B' },
  zeros: { size: 65536, crc: 0xd7978eeb, b64: '7cEBAQAAAICQ/q/uCAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABq' },
  gzipPlain: { size: 1500, crc: 0xf523bfc5, b64: 'H4sIAAAAAAAC/21UW5LjIAy8CkdASAh0HFfCblLjPMrxTNXcfkFg2ZnZH5uXulstwTw93cfNlen17ebH/a9by+35cM/pVCJnzO40ncv9VAByFrdelvK6POaz+zMt61w+ggT228T+HaN/r/e1LF/TDFl82gHIE+IB7zYt03p53BNlzkr/HzIWie5ynedNlXuty/Vsv0upB/sXBSO5pZweX2WpqdU0X8/5umqmkbInozSJG2pOMVO3ZMuoxd+uc7EF3a3xRUcCQnEQdC3RR2YNYR8h6ggiUlL9mDjRzlsL0FZjrsxtYhtmQaRmlyo47INk9CPr5fO+iUOWiG0hec/So1oC5saoj/k7+Pt6SMg4siCKCdw6PcuCVmbAIANVXdDt7kUftj5ilBSsPM0YwFoT1aFc5r7WepdmoralTKF2xO63BY68t8g+VbSWT5sxxTyUNnsab23C5IfOoU73tT6I9XjHqTozJEnjaJdsKetNUSpTUwOEGMBuk+1UavYih3p3zAaXIPO+ITF47uB2VlnaJ6R2A3uP2UUztwyCa0+8t6o5tA1AxMO+PGxQUSCM+83IADT0vPXP/lAgB+HRTztP9frQGcf++FXdw6Ad0GyP90Jx7F4m2hywM1q4VDMaeUBATC3yvU8ix/pQGdlAJGiIvbeq6OFEG/7Wp0mP5qhDjEwwMt+ooJoP9jb9yPjwlKRIftfX6EMrvOrQj9JAFMpDUwokP5GVugvasAImwm5itekfxb8j9dwFAAA=' },
  gzipAllFlags: { size: 1500, crc: 0xf523bfc5, b64: 'H4sIHwDxU2UAAwgAQVAEAHRlc3RydW4uZ3B4AGEgY29tbWVudADf+m1UW5LjIAy8CkdASAh0HFfCblLjPMrxTNXcfkFg2ZnZH5uXulstwTw93cfNlen17ebH/a9by+35cM/pVCJnzO40ncv9VAByFrdelvK6POaz+zMt61w+ggT228T+HaN/r/e1LF/TDFl82gHIE+IB7zYt03p53BNlzkr/HzIWie5ynedNlXuty/Vsv0upB/sXBSO5pZweX2WpqdU0X8/5umqmkbInozSJG2pOMVO3ZMuoxd+uc7EF3a3xRUcCQnEQdC3RR2YNYR8h6ggiUlL9mDjRzlsL0FZjrsxtYhtmQaRmlyo47INk9CPr5fO+iUOWiG0hec/So1oC5saoj/k7+Pt6SMg4siCKCdw6PcuCVmbAIANVXdDt7kUftj5ilBSsPM0YwFoT1aFc5r7WepdmoralTKF2xO63BY68t8g+VbSWT5sxxTyUNnsab23C5IfOoU73tT6I9XjHqTozJEnjaJdsKetNUSpTUwOEGMBuk+1UavYih3p3zAaXIPO+ITF47uB2VlnaJ6R2A3uP2UUztwyCa0+8t6o5tA1AxMO+PGxQUSCM+83IADT0vPXP/lAgB+HRTztP9frQGcf++FXdw6Ad0GyP90Jx7F4m2hywM1q4VDMaeUBATC3yvU8ix/pQGdlAJGiIvbeq6OFEG/7Wp0mP5qhDjEwwMt+ooJoP9jb9yPjwlKRIftfX6EMrvOrQj9JAFMpDUwokP5GVugvasAImwm5itekfxb8j9dwFAAA=' },
  gzipMulti: { size: 27, crc: 0xcd58975e, b64: 'H4sIAAAAAAAC/0vLLCouUchNzU1KLdJRAADe/wpiDgAAAB+LCAAAAAAAAv8rTk3Oz0tRyE3NTUotAgAkdPqfDQAAAA==' },
  gzipTrailing: { size: 14, crc: 0x620affde, b64: 'H4sIAAAAAAAC/0vLLCouUchNzU1KLdJRAADe/wpiDgAAAAAAAAAAAAAAAAAAAAAAAAA=' },
  gzipBadCrc: { size: 14, crc: 0x00000000, b64: 'H4sIAAAAAAAC/0vLLCouUchNzU1KLdJRAAAh/wpiDgAAAA==' },
  zipBasic: { size: 1048, crc: 0x00000000, b64: 'UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAALAAAAYWN0aXZpdGllcy9QSwMEFAAAAAgAAAAhWAVFQdyTAAAA/gAAABAAAABhY3Rpdml0aWVzLzEuZ3B4hY/BCsMgDIZfRbxvaunYGNG+xE69yRCRWSuaju7tF4WdNhgE/vwk+ZLAtC+RPV2pYU2aq6PkkwGfd3YvzuJaNEdXkRvA8jCQ7OLMHDIrWwLRHeArO0M+heRBdNeaq/NdM7JoUfPxRGwW25YzZVQLND3IYTxIRXGTl6uUFDNBWomkTX9B1D+K+kkRn5tE/0TQj+YNUEsDBBQAAAAAAAAAIVgK/+QWpQAAAKUAAAATAAAAYWN0aXZpdGllcy8yLmdweC5neh+LCAAAAAAAAv+Fj8EKwyAMhl9FvG9q6dgY0b7ETr3JEJFZK5qO7u0XhZ02GAT+/CT5ksC0L5E9XalhTZqro+STAZ93di/O4lo0R1eRG8DyMJDs4swcMitbAtEd4Cs7Qz6F5EF015qr810zsmhR8/FEbBbbljNlVAs0PchhPEhFcZOXq5QUM0FaiaRNf0HUP4r6SRGfm0T/RNCP5g0FRUHc/gAAAFBLAwQUAAAACAAAACFYaLvq7iEAAAAmAAAADgAAAGFjdGl2aXRpZXMuY3N2c0wuySzLLKlU8HTRcYSx/RJzU3m5DHWiMgsUikrzeLkAUEsDBBQAAAgAAAAAIViGphA2BQAAAAUAAAAaAAAAbm90ZXMvw7xuw69jb2RlIOa8ouWtly50eHRoZWxsb1BLAwQUAAAACAAAACFYAAAAAAIAAAAAAAAACQAAAGVtcHR5LnR4dAMAUEsBAhQDFAAAAAAAAAAhAAAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAIABAAAAAGFjdGl2aXRpZXMvUEsBAhQDFAAAAAgAAAAhWAVFQdyTAAAA/gAAABAAAAAAAAAAAAAAAIABKQAAAGFjdGl2aXRpZXMvMS5ncHhQSwECFAMUAAAAAAAAACFYCv/kFqUAAAClAAAAEwAAAAAAAAAAAAAAgAHqAAAAYWN0aXZpdGllcy8yLmdweC5nelBLAQIUAxQAAAAIAAAAIVhou+ruIQAAACYAAAAOAAAAAAAAAAAAAACAAcABAABhY3Rpdml0aWVzLmNzdlBLAQIUAxQAAAgAAAAAIViGphA2BQAAAAUAAAAaAAAAAAAAAAAAAACAAQ0CAABub3Rlcy/DvG7Dr2NvZGUg5ryi5a2XLnR4dFBLAQIUAxQAAAAIAAAAIVgAAAAAAgAAAAAAAAAJAAAAAAAAAAAAAACAAUoCAABlbXB0eS50eHRQSwUGAAAAAAYABgBzAQAAcwIAABwAU3RyYXZhIGV4cG9ydCBQSwUGIGxvb2thbGlrZQ==' },
  gpx: { size: 254, crc: 0xdc414505, b64: 'PD94bWwgdmVyc2lvbj0iMS4wIj8+PGdweCBjcmVhdG9yPSJ0ZXN0Ij48dHJrPjxuYW1lPlppcCBydW48L25hbWU+PHR5cGU+cnVubmluZzwvdHlwZT48dHJrc2VnPjx0cmtwdCBsYXQ9IjQ1LjAiIGxvbj0iNy4wIj48dGltZT4yMDI0LTAxLTAxVDA4OjAwOjAwWjwvdGltZT48L3Rya3B0Pjx0cmtwdCBsYXQ9IjQ1LjAxIiBsb249IjcuMCI+PHRpbWU+MjAyNC0wMS0wMVQwODoxMDowMFo8L3RpbWU+PC90cmtwdD48L3Rya3NlZz48L3Ryaz48L2dweD4=' },
  zipNested: { size: 914, crc: 0x00000000, b64: 'UEsDBBQAAAAAAAAAIVj5BBBDDQEAAA0BAAA/AAAARElfQ09OTkVDVC9ESS1Db25uZWN0LVVwbG9hZGVkLUZpbGVzL1VwbG9hZGVkRmlsZXNfMC1fUGFydDEuemlwUEsDBBQAAAAIAAAAIVgFRUHckwAAAP4AAAAMAAAAdXNlcl8xMjMuZ3B4hY/BCsMgDIZfRbxvaunYGNG+xE69yRCRWSuaju7tF4WdNhgE/vwk+ZLAtC+RPV2pYU2aq6PkkwGfd3YvzuJaNEdXkRvA8jCQ7OLMHDIrWwLRHeArO0M+heRBdNeaq/NdM7JoUfPxRGwW25YzZVQLND3IYTxIRXGTl6uUFDNBWomkTX9B1D+K+kkRn5tE/0TQj+YNUEsBAhQDFAAAAAgAAAAhWAVFQdyTAAAA/gAAAAwAAAAAAAAAAAAAAIABAAAAAHVzZXJfMTIzLmdweFBLBQYAAAAAAQABADoAAAC9AAAAAABQSwMEFAAAAAgAAAAhWNxZmHXbAAAAewEAAD8AAABESV9DT05ORUNUL0RJLUNvbm5lY3QtVXBsb2FkZWQtRmlsZXMvVXBsb2FkZWRGaWxlc18wLV9QYXJ0Mi56aXAL8GZmEWGAAMWIS+HHpBkZGRhAmAcoUlqcWhRvYmqml15QYWNfkZujUJZaVJyZn2erZKhnoGRvZwOUUEguSk0syS+yVSpJLS5RsrMpKcq2s8lLzE218wMKpKYoFJXm2eiDBWxKKgtS7YD8vMy8dBt9MA+kvjg1HUwXlCjkJJbYKpmYAo1XyAFZZA5kAeUygbqNDIxMdA0MgSjEwMLKwACIooCGgKSAFEg3hiGGhEwxxGqKPsxN+mDP6AO9aRfgzcgkwow7sGCggZEBLegCvFnZQGKMQGgFpLXBKgBQSwECFAMUAAAAAAAAACFY+QQQQw0BAAANAQAAPwAAAAAAAAAAAAAAgAEAAAAARElfQ09OTkVDVC9ESS1Db25uZWN0LVVwbG9hZGVkLUZpbGVzL1VwbG9hZGVkRmlsZXNfMC1fUGFydDEuemlwUEsBAhQDFAAAAAgAAAAhWNxZmHXbAAAAewEAAD8AAAAAAAAAAAAAAIABagEAAERJX0NPTk5FQ1QvREktQ29ubmVjdC1VcGxvYWRlZC1GaWxlcy9VcGxvYWRlZEZpbGVzXzAtX1BhcnQyLnppcFBLBQYAAAAAAgACANoAAACiAgAAAAA=' },
  zip64: { size: 555, crc: 0x00000000, b64: 'UEsDBC0AAAAIAAAAIQAFRUHc//////////8SABQAYWN0aXZpdGllcy9iaWcuZ3B4AQAQAP4AAAAAAAAAkwAAAAAAAACFj8EKwyAMhl9FvG9q6dgY0b7ETr3JEJFZK5qO7u0XhZ02GAT+/CT5ksC0L5E9XalhTZqro+STAZ93di/O4lo0R1eRG8DyMJDs4swcMitbAtEd4Cs7Qz6F5EF015qr810zsmhR8/FEbBbbljNlVAs0PchhPEhFcZOXq5QUM0FaiaRNf0HUP4r6SRGfm0T/RNCP5g1QSwMELQAAAAAAAAAhAC9AwzP//////////woAFAByZWFkbWUudHh0AQAQAAYAAAAAAAAABgAAAAAAAAB6aXA2NCFQSwECLQAtAAAACAAAACEABUVB3P//////////EgAcAAAAAAAAAAAAAAD/////YWN0aXZpdGllcy9iaWcuZ3B4AQAYAP4AAAAAAAAAkwAAAAAAAAAAAAAAAAAAAFBLAQItAC0AAAAAAAAAIQAvQMMz//////////8KABwAAAAAAAAAAAAAAP////9yZWFkbWUudHh0AQAYAAYAAAAAAAAABgAAAAAAAADXAAAAAAAAAFBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAIAAAAAAAAAAgAAAAAAAACwAAAAAAAAABkBAAAAAAAAUEsGBwAAAADJAQAAAAAAAAEAAABQSwUG/////////////////////wAA' },
  zipCustom: { size: 562, crc: 0x00000000, b64: 'UEsDBBQAAAAAAAAAIQBv1zscBQAAAAUAAAAKAAAAY2FmgiCaLnR4dGNwNDM3UEsDBBQAAAAAAAAAIQBxIFhIDAAAAAwAAAAIAAAAY2FmZS5ncHh1bmljb2RlIHBhdGhQSwMEFAABAAAAAAAhAHdkFWwEAAAABAAAAAoAAABzZWNyZXQuZ3B4eHh4eFBLAwQUAAAAAAAAACEAM4FZXQsAAAALAAAADgAAAC5cd2luXHBhdGguZ3B4YmFja3NsYXNoZXNQSwMEFAAAAAAAAAAhAJrfb94IAAAACAAAAAcAAABiYWQudHh0Q0hFQ0tTVU1QSwECFAAUAAAAAAAAACEAb9c7HAUAAAAFAAAACgAAAAAAAAAAAAAAAAAAAAAAY2FmgiCaLnR4dFBLAQIUABQAAAAAAAAAIQBxIFhIDAAAAAwAAAAIABYAAAAAAAAAAAAAAC0AAABjYWZlLmdweHVwEgABSq5s5WNhZsOpIOKdpC5ncHhQSwECFAAUAAEAAAAAACEAd2QVbAQAAAAEAAAACgAAAAAAAAAAAAAAAABfAAAAc2VjcmV0LmdweFBLAQIUABQAAAAAAAAAIQAzgVldCwAAAAsAAAAOAAAAAAAAAAAAAAAAAIsAAAAuXHdpblxwYXRoLmdweFBLAQIUABQAAAAAAAAAIQCa32/eCAAAAAgAAAAHAAAAAAAAAAAAAAAAAMIAAABiYWQudHh0UEsFBgAAAAAFAAUALQEAAO8AAAAAAA==' },
  gzipZeros: { size: 65536, crc: 0xd7978eeb, b64: 'H4sIAAAAAAAC/+3BAQEAAACAkP6v7ggKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAauuOl9cAAAEA' },
  zipBomb: { size: 471, crc: 0x00000000, b64: 'UEsDBBQAAAAIAAAAIQAFRUHckwAAAP4AAAARAAAAYWN0aXZpdGllcy9vay5ncHiFj8EKwyAMhl9FvG9q6dgY0b7ETr3JEJFZK5qO7u0XhZ02GAT+/CT5ksC0L5E9XalhTZqro+STAZ93di/O4lo0R1eRG8DyMJDs4swcMitbAtEd4Cs7Qz6F5EF015qr810zsmhR8/FEbBbbljNlVAs0PchhPEhFcZOXq5QUM0FaiaRNf0HUP4r6SRGfm0T/RNCP5g1QSwMEFAAAAAgAAAAhAOuOl9dOAAAAAAQAABMAAABhY3Rpdml0aWVzL2JvbWIuZ3B47cEBAQAAAICQ/q/uCAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABqUEsBAhQAFAAAAAgAAAAhAAVFQdyTAAAA/gAAABEAAAAAAAAAAAAAAAAAAAAAAGFjdGl2aXRpZXMvb2suZ3B4UEsBAhQAFAAAAAgAAAAhAOuOl9dOAAAAAAQAABMAAAAAAAAAAAAAAAAAwgAAAGFjdGl2aXRpZXMvYm9tYi5ncHhQSwUGAAAAAAIAAgCAAAAAQQEAAAAA' },
} satisfies Record<string, Fixture>;

type FixtureName = keyof typeof FIXTURES;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode base64 without relying on atob / Buffer. */
function fromBase64(text: string) {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let value = 0;
  let bits = 0;
  let n = 0;
  for (const ch of text) {
    const digit = BASE64.indexOf(ch);
    if (digit < 0) continue; // '=' padding
    value = ((value << 6) | digit) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >>> bits) & 0xff;
    }
  }
  return out.slice(0, n);
}

const fixture = (name: FixtureName) => fromBase64(FIXTURES[name].b64);
const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Bytes must match the fixture's original size and CRC-32. */
function expectContent(bytes: Uint8Array, name: FixtureName): void {
  expect(bytes.length).toBe(FIXTURES[name].size);
  expect(crc32(bytes)).toBe(FIXTURES[name].crc);
}

async function listEntries(zip: ZipArchive): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for await (const entry of zip.entries()) entries.push(entry);
  return entries;
}

async function entryNamed(zip: ZipArchive, name: string): Promise<ZipEntry> {
  const entry = (await listEntries(zip)).find((e) => e.name === name);
  if (!entry) throw new Error(`No entry named ${name}`);
  return entry;
}

/** A source that counts the bytes it hands out. */
function countingSource(inner: ByteSource): ByteSource & { bytesRead: number } {
  const counter = {
    size: inner.size,
    bytesRead: 0,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const chunk = await inner.read(offset, length);
      counter.bytesRead += chunk.length;
      return chunk;
    },
  };
  return counter;
}

/** A big archive that is never materialized: `prefix` virtual zero bytes (a self-extractor stub), then a real ZIP. */
function prefixedSource(prefix: number, zip: Uint8Array): ByteSource {
  const size = prefix + zip.length;
  return {
    size,
    async read(offset, length) {
      const start = Math.max(0, Math.min(size, offset));
      const end = Math.max(start, Math.min(size, start + length));
      const out = new Uint8Array(end - start);
      if (end > prefix) out.set(zip.subarray(Math.max(0, start - prefix), end - prefix), Math.max(0, prefix - start));
      return out;
    },
  };
}

// ── Native DecompressionStream stand-ins ─────────────────────────────────────

interface FakeNativeLog {
  formats: string[];
  cancelled: number;
}

/**
 * A DecompressionStream look-alike that emits 16 KB chunks. `mode: 'ok'`
 * decodes with the built-in decoder (like a real engine would), 'fail'
 * errors on read (like an engine rejecting trailing data), 'unsupported'
 * throws from the constructor (like an engine without 'deflate-raw').
 */
function fakeDecompressionStream(mode: 'ok' | 'fail' | 'unsupported', log: FakeNativeLog) {
  return class FakeDecompressionStream {
    readonly writable;
    readonly readable;
    constructor(format: string) {
      if (mode === 'unsupported') throw new TypeError(`Unsupported compression format: '${format}'`);
      log.formats.push(format);
      const input: Uint8Array[] = [];
      let markClosed = (): void => undefined;
      const closed = new Promise<void>((resolve) => { markClosed = () => resolve(); });
      let output: Uint8Array | null = null;
      let at = 0;
      this.writable = {
        getWriter: () => ({
          write: async (chunk: Uint8Array): Promise<void> => { input.push(chunk); },
          close: async (): Promise<void> => { markClosed(); },
        }),
      };
      this.readable = {
        getReader: () => ({
          read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
            await closed;
            if (mode === 'fail') throw new TypeError('Junk found after end of compressed data.');
            output ??= format === 'gzip' ? gunzipSync(concat(...input)) : inflateRawSync(concat(...input));
            if (at >= output.length) return { done: true };
            const value = output.subarray(at, at + 16384);
            at += value.length;
            return { done: false, value };
          },
          cancel: async (): Promise<void> => { log.cancelled++; },
        }),
      };
    }
  };
}

// ── inflate.ts ────────────────────────────────────────────────────────────────

describe('crc32', () => {
  it('matches the standard check values and continues running checksums', () => {
    expect(crc32(encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const fox = encode('The quick brown fox jumps over the lazy dog');
    expect(crc32(fox)).toBe(0x414fa339);
    expect(crc32(fox.subarray(10), crc32(fox.subarray(0, 10)))).toBe(0x414fa339);
  });
});

const RAW_FIXTURES: FixtureName[] = [
  'fixed', 'dynamic', 'far', 'stored', 'random', 'run', 'empty', 'huffmanOnly', 'rle', 'flushed', 'zeros',
];

describe('inflateRawSync', () => {
  it.each(RAW_FIXTURES)('decodes the zlib "%s" fixture exactly', (name: FixtureName) => {
    expectContent(inflateRawSync(fixture(name)), name);
  });

  it('works with any size hint and ignores bytes after the end of the stream', () => {
    const data = fixture('dynamic');
    expectContent(inflateRawSync(data, 1), 'dynamic');
    expectContent(inflateRawSync(data, FIXTURES.dynamic.size), 'dynamic');
    expectContent(inflateRawSync(concat(data, encode('trailing bytes'))), 'dynamic');
  });

  it('rejects corrupt and truncated streams with FileImportError', () => {
    const dynamic = fixture('dynamic');
    expect(() => inflateRawSync(dynamic.subarray(0, dynamic.length >> 1))).toThrow(FileImportError);
    expect(() => inflateRawSync(new Uint8Array(0))).toThrow(FileImportError);
    // Final block with the reserved block type 3.
    expect(() => inflateRawSync(new Uint8Array([0x07, 0, 0, 0]))).toThrow(/corrupt/);
    // Stored block whose one's-complement length doesn't match.
    expect(() => inflateRawSync(new Uint8Array([0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]))).toThrow(/corrupt/);
    // Stored block longer than the remaining input.
    expect(() => inflateRawSync(new Uint8Array([0x01, 0x05, 0x00, 0xfa, 0xff, 1, 2]))).toThrow(/corrupt/);
  });

  it('stops with OutputLimitError as soon as output would pass maxOutput (zip-bomb guard)', () => {
    const zeros = fixture('zeros'); // ~80 bytes that inflate to 64 KB
    expect(zeros.length).toBeLessThan(200);
    expect(() => inflateRawSync(zeros, 0, 1024)).toThrow(OutputLimitError);
    expect(() => inflateRawSync(zeros, 1 << 20, 1024)).toThrow(OutputLimitError); // a size hint can't raise the cap
    expect(() => inflateRawSync(zeros, 0, 65535)).toThrow(OutputLimitError);
    expectContent(inflateRawSync(zeros, 0, 65536), 'zeros'); // exactly at the cap is fine
    expect(() => inflateRawSync(fixture('stored'), 0, FIXTURES.stored.size - 1)).toThrow(OutputLimitError);
    expect(inflateRawSync(fixture('empty'), 0, 0)).toHaveLength(0);
  });

  it('reports the cap as a readable FileImportError', () => {
    let error: unknown;
    try {
      inflateRawSync(fixture('zeros'), 0, 10);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OutputLimitError);
    expect(error).toBeInstanceOf(FileImportError);
    expect((error as Error).message).toBe('The file is too large to import.');
  });
});

describe('gunzipSync', () => {
  it('decodes plain gzip and every optional header field', () => {
    expect(isGzip(fixture('gzipPlain'))).toBe(true);
    expect(isGzip(fixture('gpx'))).toBe(false);
    expectContent(gunzipSync(fixture('gzipPlain')), 'gzipPlain');
    expectContent(gunzipSync(fixture('gzipAllFlags')), 'gzipAllFlags');
  });

  it('concatenates multiple members and ignores trailing zero padding', () => {
    expect(utf8(gunzipSync(fixture('gzipMulti')))).toBe('first member, second member');
    expect(utf8(gunzipSync(fixture('gzipTrailing')))).toBe('first member, ');
  });

  it('rejects bad checksums, truncation and non-gzip data', () => {
    expect(() => gunzipSync(fixture('gzipBadCrc'))).toThrow(/integrity check/);
    const plain = fixture('gzipPlain');
    expect(() => gunzipSync(plain.subarray(0, plain.length - 4))).toThrow(FileImportError);
    expect(() => gunzipSync(fixture('gpx'))).toThrow('Not a gzip file.');
  });

  it('caps the output of all members together', () => {
    expect(() => gunzipSync(fixture('gzipZeros'), 1024)).toThrow(OutputLimitError);
    expectContent(gunzipSync(fixture('gzipZeros'), 65536), 'gzipZeros');
    expect(() => gunzipSync(fixture('gzipMulti'), 26)).toThrow(OutputLimitError); // 14 + 13 bytes
    expect(utf8(gunzipSync(fixture('gzipMulti'), 27))).toBe('first member, second member');
  });
});

describe('inflateRaw / gunzip (async)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('use the built-in decoder when DecompressionStream is unavailable', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    expectContent(await inflateRaw(fixture('far'), FIXTURES.far.size, FIXTURES.far.size), 'far');
    expectContent(await gunzip(fixture('gzipAllFlags')), 'gzipAllFlags');
    expect(utf8(await gunzip(fixture('gzipMulti')))).toBe('first member, second member');
    await expect(inflateRaw(new Uint8Array([0x07]))).rejects.toThrow(FileImportError);
    await expect(gunzip(fixture('gzipBadCrc'))).rejects.toThrow(/integrity check/);
    await expect(gunzip(fixture('gpx'))).rejects.toThrow('Not a gzip file.');
  });

  it('reject output past the cap, natively or not', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(inflateRaw(fixture('zeros'), 0, 1024)).rejects.toThrow(OutputLimitError);
    await expect(gunzip(fixture('gzipZeros'), 1024)).rejects.toThrow(OutputLimitError);
    expectContent(await gunzip(fixture('gzipZeros'), 65536), 'gzipZeros');

    const log: FakeNativeLog = { formats: [], cancelled: 0 };
    vi.stubGlobal('DecompressionStream', fakeDecompressionStream('ok', log));
    await expect(inflateRaw(fixture('zeros'), 0, 20000)).rejects.toThrow(OutputLimitError);
    await expect(gunzip(fixture('gzipZeros'), 20000)).rejects.toThrow(OutputLimitError);
    expect(log.formats).toEqual(['deflate-raw', 'gzip']); // no second decode by the fallback
    expect(log.cancelled).toBe(2); // the native streams were stopped, not drained
  });

  it('prefer the native decoder when it works', async () => {
    const log: FakeNativeLog = { formats: [], cancelled: 0 };
    vi.stubGlobal('DecompressionStream', fakeDecompressionStream('ok', log));
    expectContent(await inflateRaw(fixture('dynamic')), 'dynamic');
    expectContent(await gunzip(fixture('gzipPlain')), 'gzipPlain');
    expectContent(await gunzip(fixture('gzipZeros'), 65536), 'gzipZeros');
    expect(log.formats).toEqual(['deflate-raw', 'gzip', 'gzip']);
    expect(log.cancelled).toBe(0);
  });

  it('fall back to the built-in decoder when the native one fails or is missing a format', async () => {
    const log: FakeNativeLog = { formats: [], cancelled: 0 };
    vi.stubGlobal('DecompressionStream', fakeDecompressionStream('fail', log));
    expect(utf8(await gunzip(fixture('gzipMulti')))).toBe('first member, second member');
    expectContent(await inflateRaw(concat(fixture('dynamic'), encode('padding'))), 'dynamic');
    await expect(inflateRaw(new Uint8Array([0x07]))).rejects.toThrow(FileImportError);
    expect(log.formats).toEqual(['gzip', 'deflate-raw', 'deflate-raw']);

    vi.stubGlobal('DecompressionStream', fakeDecompressionStream('unsupported', log));
    expectContent(await inflateRaw(fixture('huffmanOnly')), 'huffmanOnly');
  });
});

// ── archive.ts: byte sources and ZIP reading ──────────────────────────────────

const gpxText = (): string => utf8(fixture('gpx'));

describe('byte sources', () => {
  it('clamp reads to the source and window nested ranges', async () => {
    const digits = bytesSource(encode('0123456789'));
    expect(utf8(await digits.read(8, 10))).toBe('89');
    const window = sliceSource(digits, 2, 5);
    expect(window.size).toBe(5);
    expect(utf8(await window.read(1, 10))).toBe('3456');
    expect(utf8(await window.read(-5, 3))).toBe('234');
    expect(utf8(await readAll(window))).toBe('23456');
    const blob = blobSource(new Blob([encode('0123456789')]));
    expect(utf8(await blob.read(3, 4))).toBe('3456');
    expect(await blob.read(20, 4)).toHaveLength(0);
  });
});

describe('ZipArchive', () => {
  it('recognizes ZIP data by its signature', () => {
    expect(isZip(fixture('zipBasic'))).toBe(true);
    expect(isZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(true); // empty archive
    expect(isZip(fixture('gpx'))).toBe(false);
    expect(isZip(fixture('gzipPlain'))).toBe(false);
  });

  it('lists entries with names, sizes and methods from the central directory', async () => {
    const zip = await ZipArchive.open(bytesSource(fixture('zipBasic')));
    expect(zip.entryCount).toBe(6);
    const entries = await listEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'activities/', 'activities/1.gpx', 'activities/2.gpx.gz', 'activities.csv', 'notes/ünïcode 漢字.txt', 'empty.txt',
    ]);
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1]).toMatchObject({
      method: 8, size: FIXTURES.gpx.size, crc32: FIXTURES.gpx.crc, isDirectory: false, encrypted: false,
    });
    expect(entries[1].compressedSize).toBeLessThan(entries[1].size);
    expect(entries[2].method).toBe(0);
  });

  it('reads stored, deflated, gzipped, empty and directory entries', async () => {
    const zip = await ZipArchive.open(bytesSource(fixture('zipBasic')));
    const [dir, gpx, gz, csv, notes, empty] = await listEntries(zip);
    expect(utf8(await zip.read(gpx))).toBe(gpxText());
    expect(utf8(gunzipSync(await zip.read(gz)))).toBe(gpxText());
    expect(utf8(await zip.read(csv))).toBe('Activity ID,Activity Name\r\n1,Zip run\r\n');
    expect(utf8(await zip.read(notes))).toBe('hello');
    expect(await zip.read(empty)).toHaveLength(0);
    expect(await zip.read(dir)).toHaveLength(0);
  });

  it('reads a File / Blob through slices', async () => {
    const data = fixture('zipBasic');
    const zip = await ZipArchive.open(blobSource(new Blob([data])));
    expect(utf8(await zip.read(await entryNamed(zip, 'activities/1.gpx')))).toBe(gpxText());
  });

  it('finds an archive behind prepended data and reads only what it needs', async () => {
    const source = countingSource(prefixedSource(10 * 1024 * 1024, fixture('zipBasic')));
    const zip = await ZipArchive.open(source);
    expect(utf8(await zip.read(await entryNamed(zip, 'activities/1.gpx')))).toBe(gpxText());
    expect(source.bytesRead).toBeLessThan(100 * 1024); // of a 10 MB file
  });

  it('opens an empty archive', async () => {
    const empty = new Uint8Array(22);
    empty.set([0x50, 0x4b, 0x05, 0x06]);
    expect(await listEntries(await ZipArchive.open(bytesSource(empty)))).toEqual([]);
  });

  it('opens nested archives: stored ones in place, deflated ones in memory', async () => {
    const outer = await ZipArchive.open(bytesSource(fixture('zipNested')));
    const [stored, deflated] = await listEntries(outer);
    expect(stored.method).toBe(0);
    expect(deflated.method).toBe(8);

    const inner1 = await outer.openNested(stored);
    expect(inner1.source.size).toBe(stored.compressedSize); // a window of the outer archive, not a copy
    const [run1] = await listEntries(inner1);
    expect(run1.name).toBe('user_123.gpx');
    expect(utf8(await inner1.read(run1))).toBe(gpxText());

    const inner2 = await outer.openNested(deflated);
    const [run2] = await listEntries(inner2);
    expect(run2.name).toBe('user_456.gpx');
    expect(utf8(await inner2.read(run2))).toContain('<name>Nested run</name>');
  });

  it('reads ZIP64 archives', async () => {
    const zip = await ZipArchive.open(bytesSource(fixture('zip64')));
    expect(zip.entryCount).toBe(2);
    const [big, readme] = await listEntries(zip);
    expect(big).toMatchObject({ name: 'activities/big.gpx', method: 8, size: FIXTURES.gpx.size });
    expect(utf8(await zip.read(big))).toBe(gpxText());
    expect(utf8(await zip.read(readme))).toBe('zip64!');
  });

  it('decodes CP437 and Info-ZIP Unicode names and normalizes Windows paths', async () => {
    const zip = await ZipArchive.open(bytesSource(fixture('zipCustom')));
    const entries = await listEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['café Ü.txt', 'café ❤.gpx', 'secret.gpx', 'win/path.gpx', 'bad.txt']);
    expect(utf8(await zip.read(entries[0]))).toBe('cp437');
    expect(utf8(await zip.read(entries[3]))).toBe('backslashes');
  });

  it('refuses encrypted entries, unknown compression methods and checksum mismatches', async () => {
    const zip = await ZipArchive.open(bytesSource(fixture('zipCustom')));
    const entries = await listEntries(zip);
    expect(entries[2].encrypted).toBe(true);
    await expect(zip.read(entries[2])).rejects.toThrow(/Password-protected/);
    await expect(zip.read({ ...entries[0], method: 12 })).rejects.toThrow(/Unsupported ZIP compression method \(12\)/);
    await expect(zip.read(entries[4])).rejects.toThrow(/checksum mismatch/);
  });

  it('refuses entries that inflate past their declared size (zip bomb)', async () => {
    const zip = await ZipArchive.open(bytesSource(fixture('zipBomb')));
    const [ok, bomb] = await listEntries(zip);
    expect(utf8(await zip.read(ok))).toBe(gpxText());
    expect(bomb.size).toBe(1024); // declared — the data really inflates to 64 KB
    expect(bomb.compressedSize).toBeLessThan(200);
    const error = await zip.read(bomb).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(FileImportError);
    expect((error as Error).message).toMatch(/more data than its header declares/);
    await expect(zip.read(ok, 100)).rejects.toThrow('The file is too large to import.');
  });

  it('rejects files that are not (complete) ZIP archives', async () => {
    await expect(ZipArchive.open(bytesSource(fixture('gpx')))).rejects.toThrow(/Not a ZIP archive/);
    await expect(ZipArchive.open(bytesSource(new Uint8Array(10)))).rejects.toThrow(/too small/);
    const data = fixture('zipBasic');
    await expect(ZipArchive.open(bytesSource(data.subarray(0, data.length - 60)))).rejects.toThrow(FileImportError);
  });
});

// ── archive.ts: export metadata ───────────────────────────────────────────────

describe('decodeCp437 / archiveFileKey', () => {
  it('decodes CP437 bytes', () => {
    expect(decodeCp437(new Uint8Array([0x52, 0x75, 0x6e, 0x80, 0x81, 0x82, 0xe1, 0xff]))).toBe('RunÇüéß\u00a0');
  });

  it('keys archive paths by lower-cased base name without .gz', () => {
    expect(archiveFileKey('activities/123456.fit.gz')).toBe('123456.fit');
    expect(archiveFileKey('Activities\\Morning.GPX')).toBe('morning.gpx');
    expect(archiveFileKey('export.tcx')).toBe('export.tcx');
  });
});

describe('parseCsv', () => {
  it('handles quotes, embedded separators and line breaks, a BOM and every line ending', () => {
    const text = '\ufeffa,"b, with comma","c ""quoted"""\r\n1,"multi\nline",3\r4,,\n\nlast';
    expect(parseCsv(text)).toEqual([
      ['a', 'b, with comma', 'c "quoted"'],
      ['1', 'multi\nline', '3'],
      ['4', '', ''],
      [''],
      ['last'],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('"unterminated,field')).toEqual([['unterminated,field']]);
  });
});

describe('parseStravaActivitiesCsv', () => {
  // Strava repeats column names (Elapsed Time, Distance…); the first occurrence is what Strava shows.
  const header = 'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,'
    + 'Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,'
    + 'Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,Activity Type';

  it('maps activity files to Strava IDs, names and types', () => {
    const csv = [
      header,
      '1001,"Jan 1, 2024, 8:00:00 AM",Morning Run,Run,,3600,10.01,170,50,false,,,activities/1001.fit.gz,,,3600,3500,10010.5,4.2,Ride',
      '1002,"Jan 2, 2024, 6:00:00 PM","Tempo, with ""strides""",Virtual Ride,,1800,20,,,false,,,activities/1002.TCX.gz,,,1800,1800,20000,12,Run',
      '1003,"Jan 3, 2024, 7:00:00 AM",Gym,Weight Training,,2700,0,,,false,,,,,,2700,2700,0,0,Run',
      'n/a,"Jan 4, 2024, 7:00:00 AM",Broken,Run,,60,1,,,false,,,activities/x.gpx,,,60,60,1,1,Run',
      '1005,"Jan 5, 2024, 7:00:00 AM", ,,,60,1,,,false,,,activities/1005.gpx,,,60,60,1,1,Run',
    ].join('\n');
    const index = parseStravaActivitiesCsv(csv);
    expect(index?.withoutFile).toBe(1);
    expect(Array.from(index?.byFile ?? [])).toEqual([
      ['1001.fit', { id: 1001, name: 'Morning Run', type: 'Run' }],
      ['1002.tcx', { id: 1002, name: 'Tempo, with "strides"', type: 'Virtual Ride' }],
      ['1005.gpx', { id: 1005 }],
    ]);
  });

  it('returns null for other CSV files', () => {
    expect(parseStravaActivitiesCsv('Name,Date\nfoo,bar')).toBeNull();
    expect(parseStravaActivitiesCsv('')).toBeNull();
  });
});

describe('parseGarminSummaries / findGarminSummary', () => {
  const start = Date.UTC(2024, 4, 1, 6, 30, 0);
  const summaries = parseGarminSummaries([{
    summarizedActivitiesExport: [
      {
        activityId: 1, name: 'Lunch Swim', activityType: { typeKey: 'lap_swimming' },
        startTimeGmt: '2024-05-02 11:00:00', startTimeLocal: '2024-05-02 13:00:00',
      },
      {
        activityId: 2, name: 'Paris Running', activityType: 'running',
        beginTimestamp: start, startTimeGmt: start, startTimeLocal: start + 2 * 3600 * 1000,
      },
      { activityId: 3, activityName: 'Treadmill', activityType: '', sportType: 'RUNNING', startTimeGMT: start / 1000 + 3 * 86400 },
      { activityId: 4, name: 'No start time' },
    ],
  }]);

  it('reads names, types and UTC offsets from any export shape, sorted by start', () => {
    expect(summaries).toEqual([
      { start, name: 'Paris Running', type: 'running', utcOffsetSec: 7200 },
      { start: Date.UTC(2024, 4, 2, 11, 0, 0), name: 'Lunch Swim', type: 'lap_swimming', utcOffsetSec: 7200 },
      { start: start + 3 * 86400 * 1000, name: 'Treadmill', type: 'RUNNING' },
    ]);
    expect(parseGarminSummaries({ foo: 1 })).toEqual([]);
    expect(parseGarminSummaries(null)).toEqual([]);
    expect(parseGarminSummaries('summarizedActivitiesExport')).toEqual([]);
  });

  it('matches a start time to the nearest summary within the tolerance', () => {
    expect(findGarminSummary(summaries, start + 90_000)?.name).toBe('Paris Running');
    expect(findGarminSummary(summaries, start - 60_000)?.name).toBe('Paris Running');
    expect(findGarminSummary(summaries, Date.UTC(2024, 4, 2, 10, 59, 0))?.name).toBe('Lunch Swim');
    expect(findGarminSummary(summaries, start + 121_000)).toBeUndefined();
    expect(findGarminSummary(summaries, start + 200_000, 300_000)?.name).toBe('Paris Running');
    expect(findGarminSummary([], start)).toBeUndefined();
  });
});
