/**
 * Microsoft Store (AppX) build — used only by the "store" job in
 * .github/workflows/release-electron.yml, never by normal releases.
 *
 *   npx electron-builder --win --config electron-builder.store.cjs --publish never
 *
 * It reuses the regular config from package.json "build" and only swaps the
 * Windows target to AppX with the package identity Partner Center assigns to
 * the app (Product management → Product identity). The Store signs the package
 * itself, so no certificate is needed. Values come from the environment so
 * nothing account-specific is committed:
 *
 *   MS_STORE_IDENTITY_NAME            Package/Identity/Name,      e.g. 12345LetsLearntocodeforfun.Apollo
 *   MS_STORE_PUBLISHER                Package/Identity/Publisher, e.g. CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
 *   MS_STORE_PUBLISHER_DISPLAY_NAME   Package/Properties/PublisherDisplayName
 *
 * See docs/SIGNING.md → "Microsoft Store".
 */
const base = require('./package.json').build;

function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is not set — copy it from Partner Center → Product identity (docs/SIGNING.md).`);
  }
  return value;
}

module.exports = {
  ...base,
  win: {
    ...base.win,
    target: [{ target: 'appx', arch: ['x64', 'arm64'] }],
  },
  appx: {
    identityName: required('MS_STORE_IDENTITY_NAME'),
    publisher: required('MS_STORE_PUBLISHER'),
    publisherDisplayName: required('MS_STORE_PUBLISHER_DISPLAY_NAME'),
    applicationId: 'Apollo',
    displayName: 'Apollo',
    backgroundColor: '#0D1B2A',
    languages: ['en-US'],
    artifactName: '${productName}-Store-${version}-${arch}.${ext}',
  },
  // The Store distributes and updates this package; never publish it to GitHub.
  publish: null,
};
