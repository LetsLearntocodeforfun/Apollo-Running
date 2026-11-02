# Social and link-preview assets

| File | What it is |
|---|---|
| `card.html` | Source of the link-preview images (Art Deco navy + gold, the app's fonts, a real screenshot). |
| `social-preview.png` | 1280×640 GitHub social preview. Upload by hand: **Settings → General → Social preview → Edit**. |
| `../../public/og-image.png` | 1200×630 Open Graph / Twitter card for the web version (referenced from `index.html`). |
| `spotlights.json` | The weekly feature spotlights posted to Bluesky and Mastodon. |
| `images/` | Post-sized copies of screenshots that are too large for Bluesky (1,000,000-byte limit). |

Regenerate both preview images after changing `card.html` or the Today screenshot:

```bash
node scripts/render-social-cards.mjs   # needs a Chromium: npx playwright install chromium, or CHROME_PATH
```

## Automation

- **`.github/workflows/announce-release.yml`** — after a release is published, links a Discussions announcement (category *Announcements*) and posts the release to Bluesky/Mastodon. Put `<!-- social-post: your text {url} -->` in the release notes to write the post yourself.
- **`.github/workflows/social-spotlight.yml`** — every Tuesday, posts the next spotlight from `spotlights.json`.
- Both run `scripts/social-post.mjs`, skip networks whose secrets are missing, support a dry run from **Actions → Run workflow**, and never post the same release or weekly spotlight twice.

Repository secrets (**Settings → Secrets and variables → Actions → New repository secret**):

| Secret | Value |
|---|---|
| `BLUESKY_HANDLE` | The account handle, e.g. `apollo-running.bsky.social` |
| `BLUESKY_APP_PASSWORD` | An app password (Bluesky **Settings → Privacy and security → App passwords**), never the account password |
| `MASTODON_INSTANCE` | The server address, e.g. `https://mastodon.social` |
| `MASTODON_TOKEN` | Access token from **Preferences → Development → New application** with only `read:accounts`, `read:statuses`, `write:media` and `write:statuses` |

## Writing spotlights

- One real feature per post, described as it works today, with a real screenshot from `docs/images/`.
- Calm and plain: no hype, no comparisons with other apps, no health promises.
- Alt text describes what the screenshot shows, for people using screen readers.
- Text + link + hashtags must fit in 300 characters. Check with `node scripts/social-post.mjs check`.
