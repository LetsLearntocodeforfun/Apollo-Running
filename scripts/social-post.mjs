/**
 * Apollo's social announcements (GitHub Actions; Node 22, no dependencies).
 *
 *   node scripts/social-post.mjs release     announce a published GitHub release
 *   node scripts/social-post.mjs spotlight   post this week's feature spotlight
 *   node scripts/social-post.mjs check       validate .github/social/spotlights.json (no network)
 *
 * Channels switch on when their secrets exist and are skipped otherwise:
 *   Bluesky:  BLUESKY_HANDLE, BLUESKY_APP_PASSWORD (an app password, never the
 *             account password), optional BLUESKY_SERVICE (default https://bsky.social)
 *   Mastodon: MASTODON_INSTANCE (e.g. https://mastodon.social), MASTODON_TOKEN
 *             (scopes: read:accounts read:statuses write:media write:statuses)
 *
 * Other inputs (environment): GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, TAG
 * (release; empty = latest release), SPOTLIGHT_INDEX (spotlight; empty = this
 * week's), DRY_RUN=1 (print the posts, publish nothing).
 *
 * Releases also get a GitHub Discussions announcement (category "Announcements")
 * linked to the release. Posts already made for a release or spotlight are
 * detected and skipped, so re-running a workflow doesn't post twice.
 * Secrets are only ever sent to their own service and are never printed.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPOTLIGHTS_FILE = join(ROOT, '.github', 'social', 'spotlights.json');
const RELEASE_CARD_IMAGE = join(ROOT, 'public', 'og-image.png');
const REPO = process.env.GITHUB_REPOSITORY || 'LetsLearntocodeforfun/Apollo-Running';
const GITHUB_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const DISCUSSION_CATEGORY = 'Announcements';
const RELEASE_TAGS = ['running', 'marathon', 'OpenSource'];
/** Monday the weekly rotation starts from (spotlight 0). */
const SPOTLIGHT_EPOCH = Date.UTC(2026, 10, 2);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** A spotlight counts as already posted only if it went out in the last 6 days. */
const SPOTLIGHT_REPOST_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;
const postedRecently = (iso) => Date.now() - Date.parse(String(iso ?? '')) < SPOTLIGHT_REPOST_WINDOW_MS;

export const BLUESKY_MAX_GRAPHEMES = 300;
export const BLUESKY_MAX_BYTES = 3000;
export const BLUESKY_MAX_IMAGE_BYTES = 1_000_000;
export const MASTODON_MAX_CHARS = 500;
export const MAX_ALT_CHARS = 1500;

// ── Text helpers ────────────────────────────────────────────────────────────

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Length as Bluesky counts it (user-perceived characters). */
export function graphemeLength(text) {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

const utf8 = new TextEncoder();
const byteLength = (text) => utf8.encode(text).length;

/**
 * Bluesky rich-text facets for links and #hashtags. Offsets are UTF-8 byte
 * offsets, as the AT Protocol requires.
 */
export function buildFacets(text) {
  const facets = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const uri = m[0].replace(/[.,;:!?)\]]+$/, '');
    const byteStart = byteLength(text.slice(0, m.index));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLength(uri) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  for (const m of text.matchAll(/(^|\s)#([A-Za-z][A-Za-z0-9_]{0,63})(?=$|[\s.,;:!?])/g)) {
    const start = m.index + m[1].length;
    const byteStart = byteLength(text.slice(0, start));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLength(`#${m[2]}`) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }],
    });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/** Problems with a post's text for each network (empty array = fine). */
export function textProblems(text) {
  const problems = [];
  const graphemes = graphemeLength(text);
  if (graphemes > BLUESKY_MAX_GRAPHEMES)
    problems.push(`${graphemes} characters (Bluesky allows ${BLUESKY_MAX_GRAPHEMES})`);
  if (byteLength(text) > BLUESKY_MAX_BYTES) problems.push(`more than ${BLUESKY_MAX_BYTES} bytes`);
  if (text.length > MASTODON_MAX_CHARS)
    problems.push(`${text.length} characters (Mastodon allows ${MASTODON_MAX_CHARS})`);
  return problems;
}

const hashtags = (tags) => tags.map((t) => `#${t}`).join(' ');

// ── Images ──────────────────────────────────────────────────────────────────

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/** Width and height of a PNG, or null for anything else. */
export function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Width and height of a baseline or progressive JPEG, or null for anything else. */
export function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    // SOF0–SOF15 carry the frame size (C4, C8 and CC are other segment types).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

function loadImage(relativePath, alt) {
  const file = join(ROOT, relativePath);
  const bytes = readFileSync(file);
  const size = pngSize(bytes) ?? jpegSize(bytes);
  return { file: relativePath, bytes, mime: MIME[extname(file).toLowerCase()], alt, size };
}

// ── Spotlights ──────────────────────────────────────────────────────────────

export function loadSpotlights() {
  return JSON.parse(readFileSync(SPOTLIGHTS_FILE, 'utf8')).spotlights;
}

export function composeSpotlight(entry) {
  return `${entry.text}\n\n${entry.link}\n\n${hashtags(entry.tags)}`;
}

/** Index of the spotlight for the week containing `now` (rotates forever). */
export function spotlightIndexFor(now, count) {
  const week = Math.floor((now - SPOTLIGHT_EPOCH) / WEEK_MS);
  return ((week % count) + count) % count;
}

/** Every problem in the spotlight list (empty array = fine). */
export function validateSpotlights(spotlights) {
  const problems = [];
  const ids = new Set();
  if (!Array.isArray(spotlights) || spotlights.length === 0) return ['spotlights.json has no spotlights'];
  spotlights.forEach((s, i) => {
    const where = `spotlight ${i} (${s?.id ?? 'no id'})`;
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id))
      problems.push(`${where}: id must be lowercase-with-dashes`);
    else if (ids.has(s.id)) problems.push(`${where}: duplicate id`);
    else ids.add(s.id);
    if (typeof s.text !== 'string' || s.text.trim() === '') problems.push(`${where}: missing text`);
    if (typeof s.link !== 'string' || !/^https:\/\/\S+$/.test(s.link))
      problems.push(`${where}: link must be an https URL`);
    if (!Array.isArray(s.tags) || s.tags.some((t) => !/^[A-Za-z][A-Za-z0-9]*$/.test(t)))
      problems.push(`${where}: tags must be words without "#"`);
    if (typeof s.text === 'string' && typeof s.link === 'string' && Array.isArray(s.tags)) {
      for (const p of textProblems(composeSpotlight(s))) problems.push(`${where}: post is ${p}`);
    }
    if (typeof s.image !== 'string' || !existsSync(join(ROOT, s.image))) {
      problems.push(`${where}: image not found (${s.image})`);
    } else {
      if (!MIME[extname(s.image).toLowerCase()]) problems.push(`${where}: image must be .png or .jpg`);
      const bytes = statSync(join(ROOT, s.image)).size;
      if (bytes > BLUESKY_MAX_IMAGE_BYTES)
        problems.push(`${where}: image is ${bytes} bytes (Bluesky allows ${BLUESKY_MAX_IMAGE_BYTES})`);
    }
    if (typeof s.alt !== 'string' || s.alt.trim().length < 20) problems.push(`${where}: alt text missing or too short`);
    else if (s.alt.length > MAX_ALT_CHARS) problems.push(`${where}: alt text over ${MAX_ALT_CHARS} characters`);
  });
  return problems;
}

// ── Releases ────────────────────────────────────────────────────────────────

/** Bold lead-ins of the bullets under the first "What's new" heading. */
export function releaseHighlights(body) {
  const highlights = [];
  let inSection = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^#{2,4}\s+what['’]?s new/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^#{1,4}\s/.test(line)) break;
    const m = line.match(/^[-*]\s+\*\*(.+?)\*\*/);
    if (m)
      highlights.push(
        m[1]
          .replace(/`/g, '')
          .replace(/[.:;,]+$/, '')
          .trim(),
      );
  }
  return highlights.filter(Boolean);
}

/**
 * The release post. An optional `<!-- social-post: ... -->` comment in the
 * release notes overrides the generated text ({url} marks where the link goes).
 */
export function composeRelease({ tag, url, body }) {
  const override = String(body ?? '').match(/<!--\s*social-post:\s*([\s\S]*?)-->/i);
  if (override) {
    const text = override[1].trim();
    return text.includes('{url}') ? text.replaceAll('{url}', url) : `${text}\n\n${url}`;
  }
  const intro = `Apollo ${tag} is out: free, local-first marathon training for Windows, macOS, Linux and the web.`;
  const tail = `${url}\n\n${hashtags(RELEASE_TAGS)}`;
  const highlights = releaseHighlights(body);
  for (let n = Math.min(highlights.length, 3); n > 0; n--) {
    const text = `${intro}\n\nNew: ${highlights.slice(0, n).join(' · ')}\n\n${tail}`;
    if (textProblems(text).length === 0) return text;
  }
  if (highlights.length > 0) {
    // One long highlight: shorten it to fit.
    const room = BLUESKY_MAX_GRAPHEMES - graphemeLength(`${intro}\n\nNew: …\n\n${tail}`);
    const short = [...segmenter.segment(highlights[0])].map((s) => s.segment);
    if (room > 10) return `${intro}\n\nNew: ${short.slice(0, room).join('').trimEnd()}…\n\n${tail}`;
  }
  return `${intro}\n\n${tail}`;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function request(url, { method = 'GET', headers = {}, body, expect = [200] } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!expect.includes(res.status)) {
    const detail = data?.message || data?.error_description || data?.error || text.slice(0, 200);
    throw new Error(`${method} ${new URL(url).host}${new URL(url).pathname} → HTTP ${res.status}: ${detail}`);
  }
  return { status: res.status, data };
}

// ── GitHub ──────────────────────────────────────────────────────────────────

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'apollo-social-post',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function getRelease(tag) {
  const path = tag ? `releases/tags/${encodeURIComponent(tag)}` : 'releases/latest';
  const { data } = await request(`${GITHUB_API}/repos/${REPO}/${path}`, { headers: githubHeaders() });
  return data;
}

/** Creates the Discussions announcement for a release (GitHub ignores this if one is linked). */
async function linkReleaseDiscussion(release, dryRun) {
  if (release.discussion_url) {
    console.log(`Discussions: already linked (${release.discussion_url}).`);
    return true;
  }
  if (dryRun) {
    console.log(`Discussions: would create a "${DISCUSSION_CATEGORY}" discussion for ${release.tag_name}.`);
    return true;
  }
  if (!process.env.GITHUB_TOKEN) {
    console.log('Discussions: skipped (no GITHUB_TOKEN).');
    return true;
  }
  try {
    const { data } = await request(`${GITHUB_API}/repos/${REPO}/releases/${release.id}`, {
      method: 'PATCH',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ discussion_category_name: DISCUSSION_CATEGORY }),
    });
    console.log(`Discussions: ${data.discussion_url ? `linked ${data.discussion_url}` : 'requested'}.`);
    return true;
  } catch (err) {
    console.log(`::warning::Discussions announcement failed: ${err.message}`);
    return false;
  }
}

// ── Bluesky ─────────────────────────────────────────────────────────────────

function blueskyConfig() {
  const handle = process.env.BLUESKY_HANDLE?.trim().replace(/^@/, '');
  const password = process.env.BLUESKY_APP_PASSWORD?.trim();
  if (!handle || !password) return null;
  return {
    handle,
    password,
    service: (process.env.BLUESKY_SERVICE?.trim() || 'https://bsky.social').replace(/\/+$/, ''),
  };
}

async function blueskyLogin(cfg) {
  const { data } = await request(`${cfg.service}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: cfg.handle, password: cfg.password }),
  });
  return { service: cfg.service, did: data.did, auth: { Authorization: `Bearer ${data.accessJwt}` } };
}

async function blueskyRecentPosts(session) {
  const q = new URLSearchParams({ repo: session.did, collection: 'app.bsky.feed.post', limit: '30' });
  const { data } = await request(`${session.service}/xrpc/com.atproto.repo.listRecords?${q}`, {
    headers: session.auth,
  });
  return (data?.records ?? []).map((r) => r.value);
}

async function blueskyUpload(session, image) {
  const { data } = await request(`${session.service}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { ...session.auth, 'Content-Type': image.mime },
    body: image.bytes,
  });
  return data.blob;
}

/** post = { text, image?, card?: { uri, title, description, thumb } }, isDuplicate(record) */
async function postToBluesky(cfg, post, isDuplicate, dryRun) {
  if (dryRun) {
    console.log(
      `Bluesky: would post as @${cfg.handle} (${graphemeLength(post.text)}/${BLUESKY_MAX_GRAPHEMES} characters).`,
    );
    return;
  }
  const session = await blueskyLogin(cfg);
  if ((await blueskyRecentPosts(session)).some(isDuplicate)) {
    console.log('Bluesky: already posted; skipping.');
    return;
  }
  const record = {
    $type: 'app.bsky.feed.post',
    text: post.text,
    facets: buildFacets(post.text),
    langs: ['en'],
    createdAt: new Date().toISOString(),
  };
  if (post.image) {
    const image = { alt: post.image.alt, image: await blueskyUpload(session, post.image) };
    if (post.image.size) image.aspectRatio = post.image.size;
    record.embed = { $type: 'app.bsky.embed.images', images: [image] };
  } else if (post.card) {
    const external = { uri: post.card.uri, title: post.card.title, description: post.card.description };
    if (post.card.thumb) external.thumb = await blueskyUpload(session, post.card.thumb);
    record.embed = { $type: 'app.bsky.embed.external', external };
  }
  const { data } = await request(`${session.service}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { ...session.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
  });
  const rkey = String(data.uri).split('/').pop();
  console.log(`Bluesky: posted https://bsky.app/profile/${cfg.handle}/post/${rkey}`);
}

// ── Mastodon ────────────────────────────────────────────────────────────────

function mastodonConfig() {
  let instance = process.env.MASTODON_INSTANCE?.trim();
  const token = process.env.MASTODON_TOKEN?.trim();
  if (!instance || !token) return null;
  if (!/^https?:\/\//.test(instance)) instance = `https://${instance}`;
  return { instance: instance.replace(/\/+$/, ''), auth: { Authorization: `Bearer ${token}` } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mastodonUpload(cfg, image) {
  const form = new FormData();
  form.append('file', new Blob([image.bytes], { type: image.mime }), image.file.split('/').pop());
  form.append('description', image.alt);
  const { data } = await request(`${cfg.instance}/api/v2/media`, {
    method: 'POST',
    headers: cfg.auth,
    body: form,
    expect: [200, 202],
  });
  // Large files are processed in the background: wait until the media is ready.
  for (let i = 0; i < 15 && !data.url; i++) {
    await sleep(2000);
    const check = await request(`${cfg.instance}/api/v1/media/${data.id}`, { headers: cfg.auth, expect: [200, 206] });
    if (check.status === 200) break;
  }
  return data.id;
}

/** post = { text, image? }, isDuplicate(status), idempotencyKey */
async function postToMastodon(cfg, post, isDuplicate, idempotencyKey, dryRun) {
  if (dryRun) {
    console.log(
      `Mastodon: would post on ${new URL(cfg.instance).host} (${post.text.length}/${MASTODON_MAX_CHARS} characters).`,
    );
    return;
  }
  const { data: me } = await request(`${cfg.instance}/api/v1/accounts/verify_credentials`, { headers: cfg.auth });
  const recent = await request(`${cfg.instance}/api/v1/accounts/${me.id}/statuses?limit=30&exclude_replies=true`, {
    headers: cfg.auth,
  });
  if ((recent.data ?? []).some(isDuplicate)) {
    console.log('Mastodon: already posted; skipping.');
    return;
  }
  const mediaIds = post.image ? [await mastodonUpload(cfg, post.image)] : [];
  const { data } = await request(`${cfg.instance}/api/v1/statuses`, {
    method: 'POST',
    headers: { ...cfg.auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ status: post.text, media_ids: mediaIds, visibility: 'public', language: 'en' }),
  });
  console.log(`Mastodon: posted ${data.url}`);
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Posts to every configured network; returns false if any of them failed. */
async function publish(post, { dryRun, bluesky: bskyDuplicate, mastodon: mastoDuplicate, key }) {
  const bsky = blueskyConfig();
  const masto = mastodonConfig();
  console.log(`\n----- post (${graphemeLength(post.text)} characters) -----\n${post.text}\n-----`);
  if (post.image) console.log(`Image: ${post.image.file} — alt: ${post.image.alt}`);
  if (!bsky && !masto) {
    console.log('No social accounts configured (BLUESKY_* / MASTODON_* secrets); nothing to post.');
    return true;
  }
  let ok = true;
  for (const [name, run] of [
    ['Bluesky', bsky && (() => postToBluesky(bsky, post, bskyDuplicate, dryRun))],
    ['Mastodon', masto && (() => postToMastodon(masto, post, mastoDuplicate, key, dryRun))],
  ]) {
    if (!run) {
      console.log(`${name}: not configured; skipped.`);
      continue;
    }
    try {
      await run();
    } catch (err) {
      ok = false;
      console.log(`::error::${name} post failed: ${err.message}`);
    }
  }
  return ok;
}

async function releaseCommand(dryRun) {
  const tag = process.env.TAG?.trim() || '';
  if (tag && !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Not a release tag: ${tag}`);
  const release = await getRelease(tag);
  if (release.draft || release.prerelease) {
    console.log(`${release.tag_name} is a ${release.draft ? 'draft' : 'pre-release'}; not announcing it.`);
    return true;
  }
  const url = release.html_url;
  const discussionOk = await linkReleaseDiscussion(release, dryRun);
  const card = existsSync(RELEASE_CARD_IMAGE) ? loadImage('public/og-image.png', 'Apollo') : null;
  const post = {
    text: composeRelease({ tag: release.tag_name, url, body: release.body }),
    card: {
      uri: url,
      title: `Apollo ${release.tag_name}`,
      description: 'Free, local-first marathon training for Windows, macOS, Linux and the web.',
      thumb: card && card.bytes.length <= BLUESKY_MAX_IMAGE_BYTES ? card : null,
    },
  };
  for (const p of textProblems(post.text)) console.log(`::warning::The release post is ${p}.`);
  const tagPath = `/releases/tag/${release.tag_name}`;
  const posted = await publish(post, {
    dryRun,
    bluesky: (r) => String(r?.text ?? '').includes(tagPath) || String(r?.embed?.external?.uri ?? '').includes(tagPath),
    mastodon: (s) => String(s?.content ?? '').includes(tagPath) || String(s?.card?.url ?? '').includes(tagPath),
    key: `apollo-release-${release.tag_name}`,
  });
  return posted && discussionOk;
}

async function spotlightCommand(dryRun) {
  const spotlights = loadSpotlights();
  const problems = validateSpotlights(spotlights);
  if (problems.length) throw new Error(`spotlights.json:\n  ${problems.join('\n  ')}`);
  const raw = process.env.SPOTLIGHT_INDEX?.trim();
  const index = raw ? Number(raw) : spotlightIndexFor(Date.now(), spotlights.length);
  if (!Number.isInteger(index) || index < 0 || index >= spotlights.length) {
    throw new Error(`SPOTLIGHT_INDEX must be 0–${spotlights.length - 1}`);
  }
  const entry = spotlights[index];
  console.log(`Spotlight ${index + 1} of ${spotlights.length}: ${entry.id}`);
  const text = composeSpotlight(entry);
  const firstLine = entry.text.split('\n')[0].slice(0, 60);
  const week = Math.floor((Date.now() - SPOTLIGHT_EPOCH) / WEEK_MS);
  return publish(
    { text, image: loadImage(entry.image, entry.alt) },
    {
      dryRun,
      bluesky: (r) => postedRecently(r?.createdAt) && String(r?.text ?? '').startsWith(firstLine),
      // Mastodon returns HTML; compare without tags and entities.
      mastodon: (s) =>
        postedRecently(s?.created_at) &&
        String(s?.content ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/&#39;|&apos;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .startsWith(firstLine),
      key: `apollo-spotlight-${entry.id}-${week}`,
    },
  );
}

function checkCommand() {
  const spotlights = loadSpotlights();
  const problems = validateSpotlights(spotlights);
  spotlights.forEach((s, i) => {
    const text = composeSpotlight(s);
    console.log(
      `${String(i).padStart(2)} ${s.id.padEnd(22)} ${String(graphemeLength(text)).padStart(3)} chars  ${s.image}`,
    );
  });
  const sample = composeRelease({
    tag: 'v0.0.0',
    url: `https://github.com/${REPO}/releases/tag/v0.0.0`,
    body: existsSync(join(ROOT, '.github', 'release-notes', 'INSTALL_NOTES.md'))
      ? readFileSync(join(ROOT, '.github', 'release-notes', 'INSTALL_NOTES.md'), 'utf8')
      : '',
  });
  console.log(`\nSample release post (${graphemeLength(sample)} characters):\n${sample}\n`);
  problems.push(...textProblems(sample).map((p) => `sample release post is ${p}`));
  if (problems.length) {
    console.log(`::error::${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    return false;
  }
  console.log(`OK: ${spotlights.length} spotlights.`);
  return true;
}

async function main() {
  const command = process.argv[2];
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
  if (dryRun) console.log('Dry run: nothing will be published.');
  let ok;
  if (command === 'release') ok = await releaseCommand(dryRun);
  else if (command === 'spotlight') ok = await spotlightCommand(dryRun);
  else if (command === 'check') ok = checkCommand();
  else {
    console.log('Usage: node scripts/social-post.mjs <release|spotlight|check> [--dry-run]');
    ok = false;
  }
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
