# Code signing and trusted distribution

*For maintainers. Users, see [INSTALL.md](INSTALL.md).*

Unsigned installers trigger a one-time warning: Windows SmartScreen, or macOS Gatekeeper. Apollo must stay free, so this page lists every legitimate free route first, then the paid ones, along with what each route fixes.

**Last checked:** October 2026. Programs and prices change, so re-check the linked pages before you apply.

---

## What v1.0.7 already does (free, automatic)

| Protection | What it gives users | Where |
|---|---|---|
| `SHA256SUMS.txt` on every release | Confirms a download wasn't corrupted or swapped | `release-electron.yml` → *Generate SHA256SUMS.txt* |
| GitHub build-provenance attestations (Sigstore) | Cryptographic proof that each installer was built from this repo by GitHub Actions. Verify with `gh attestation verify <file> -R LetsLearntocodeforfun/Apollo-Running` | *Attest build provenance* step. Free for public repositories. |
| Ad-hoc signature on the Apple Silicon build | Avoids the "damaged" error that unsigned arm64 apps often get, so users see the normal "Open Anyway" flow | electron-builder's automatic fallback when no certificate is configured |
| Install guide on every release page | Explains the one-time prompt on each OS, step by step | `.github/release-notes/INSTALL_NOTES.md`, `docs/INSTALL.md` |
| Least-privilege, SHA-pinned release workflow | Reduces supply-chain risk | `release-electron.yml` |
| Dry-run releases | Actions → *Build & Release Electron Installers* → **Run workflow** builds everything without publishing | `workflow_dispatch` |
| Electron fuses (PX-34) | Packaged apps ignore `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, only load code from `app.asar`, check the asar's integrity at startup (macOS/Windows) and encrypt cookies | `package.json` → `build.electronFuses` |
| SignPath + Microsoft Store wiring (inactive) | Switches on by itself once the variables/secrets below exist | `release-electron.yml` → *SignPath 1/6–6/6*, job *store* |

None of this removes the OS warning. The options below do.

---

## Windows: free options

### 1. SignPath Foundation: free code-signing certificate for open source (recommended)

[signpath.org](https://signpath.org/) issues free code-signing certificates to open-source projects and signs builds straight from CI.

**Conditions** ([terms](https://signpath.org/terms)), and where Apollo stands:

| Condition | Apollo |
|---|---|
| OSI-approved license with no commercial dual-licensing | ✅ MIT |
| No proprietary components | ✅ All dependencies are open source (Electron, React, Dexie, Recharts…) |
| Actively maintained | ✅ |
| Already released in the form to be signed | ✅ GitHub Releases since v1.0.0 |
| The signing team maintains the repository and the build scripts | ✅ |

**Already done in the repo (inactive until you finish the steps below):** the Windows job in `release-electron.yml` runs six *SignPath* steps when both `SIGNPATH_ORGANIZATION_ID` (variable) and `SIGNPATH_API_TOKEN` (secret) exist. Otherwise it builds exactly as before.

1. electron-builder packages the app folder only (`release/win-unpacked`).
2. That folder is uploaded as a workflow artifact and signed by SignPath (artifact configuration **`apollo-app`**: `Apollo.exe` plus the bundled `.dll`/`.exe` files).
3. The NSIS installer is built from the signed folder (`electron-builder --win nsis --prepackaged`).
4. The installer is uploaded and signed (artifact configuration **`apollo-installer`**).
5. `scripts/update-latest-yml.mjs` rewrites `latest.yml`'s SHA-512/size and regenerates the `.blockmap`, so auto-update accepts the signed file.
6. *Verify Windows signatures* fails the build if `Apollo.exe` or the installer isn't validly signed.

Tag builds use the **release** signing policy. Dry runs (Run workflow) use the **test** policy, so they never use up a release approval.

**Steps for you (the owner)**

1. **Apply** at <https://signpath.org/apply>. Repository: `LetsLearntocodeforfun/Apollo-Running`. Build system: GitHub Actions. Release workflow: `.github/workflows/release-electron.yml`. Mention that releases are built on GitHub-hosted runners from tags, with provenance attestations.
2. **When approved**, sign in at <https://app.signpath.io>:
   1. Note your **Organization ID** (*Settings → Organization*).
   2. Open (or create) the project, slug **`Apollo-Running`**. Under *Trusted build systems*, link the predefined **GitHub.com** build system to it.
   3. Check the project's **signing policies**. SignPath Foundation projects normally have `test-signing` and `release-signing`. Note the slugs if they differ.
   4. Add two **artifact configurations**:

      `apollo-app` (the zipped app folder):
      ```xml
      <?xml version="1.0" encoding="utf-8"?>
      <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
        <zip-file>
          <pe-file path="Apollo.exe"><authenticode-sign /></pe-file>
          <pe-file-set>
            <include path="*.dll" max-matches="unbounded" />
            <include path="resources/**/*.exe" min-matches="0" max-matches="unbounded" />
            <include path="resources/**/*.node" min-matches="0" max-matches="unbounded" />
            <for-each><authenticode-sign /></for-each>
          </pe-file-set>
        </zip-file>
      </artifact-configuration>
      ```

      `apollo-installer` (the zipped installer):
      ```xml
      <?xml version="1.0" encoding="utf-8"?>
      <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
        <zip-file>
          <pe-file path="Apollo-Setup-*.exe"><authenticode-sign /></pe-file>
        </zip-file>
      </artifact-configuration>
      ```
      SignPath's editor validates these. Adjust them if it reports that a file is missing or already signed. Electron's own DLLs may already carry a signature, and SignPath can be told to skip those.
   5. Create an **API token** for a CI user with *Submitter* rights on the project (*Users → New CI user*).
3. **In GitHub**, open *Settings → Secrets and variables → Actions*:
   - **Secret** `SIGNPATH_API_TOKEN`: the API token. Never commit it.
   - **Variable** `SIGNPATH_ORGANIZATION_ID`: the Organization ID. Adding this switches signing on.
   - Optional variables, needed only if your slugs differ from the defaults: `SIGNPATH_PROJECT_SLUG` (`Apollo-Running`), `SIGNPATH_APP_CONFIG_SLUG` (`apollo-app`), `SIGNPATH_INSTALLER_CONFIG_SLUG` (`apollo-installer`), `SIGNPATH_RELEASE_POLICY_SLUG` (`release-signing`), `SIGNPATH_TEST_POLICY_SLUG` (`test-signing`).
4. **Test it.** Run *Actions → Build & Release Electron Installers → Run workflow*. Approve the test-signing requests in SignPath if asked, then download `installers-win` and check *Properties → Digital Signatures* on the `.exe`.
5. **Release.** Push the tag. Approve the release-signing request in SignPath (the Windows job waits up to an hour per request).

> **Limitation:** the NSIS uninstaller inside the installer stays unsigned. That's harmless (it runs from the installed folder), and SignPath can't reach inside a finished NSIS installer.

**What it fixes:** the installer shows a verified publisher. SmartScreen reputation still builds up as people download it, so the first releases may warn less but not never.

### 2. Microsoft Store: free developer account, Microsoft signs the package

Partner Center now has **no registration fee** for individual or company accounts ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)). MSIX packages submitted to the Store are **signed by the Store on submission** ([MSIX signing overview](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)). People who install from the Store get no SmartScreen prompt and get automatic updates.

**Already done in the repo (inactive):** `electron-builder.store.cjs` builds an AppX package for the Store (x64 + arm64) from the normal config, reading the package identity from the environment. The **store** job in `release-electron.yml` runs it only when the `MS_STORE_IDENTITY_NAME` variable exists, and uploads the result as the workflow artifact `microsoft-store-package`. It is never attached to the GitHub Release. The Store build doesn't use Apollo's GitHub auto-updater (`process.windowsStore` in `electron/main.ts`), because the Store updates it.

**Steps for you (the owner)**
1. Create a free **individual developer account** at <https://partner.microsoft.com/dashboard/registration>.
2. *Apps and games → New product → MSIX or PWA app*, then reserve the name **Apollo** (or **Apollo Marathon** if Apollo is taken).
3. Open *Product management → Product identity* and copy three values into *GitHub → Settings → Secrets and variables → Actions → Variables*:

   | Variable | Partner Center field | Example |
   |---|---|---|
   | `MS_STORE_IDENTITY_NAME` | Package/Identity/Name | `12345LetsLearntocodeforfun.Apollo` |
   | `MS_STORE_PUBLISHER` | Package/Identity/Publisher | `CN=1A2B3C4D-…` |
   | `MS_STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName | `LetsLearntocodeforfun` |

   These aren't secrets, so they're variables.
4. Optional but recommended: add Store tile images in `build/appx/` (`StoreLogo.png` 50×50, `Square44x44Logo.png`, `Square150x150Logo.png`, `Wide310x150Logo.png`). Without them, electron-builder uses default Electron artwork.
5. Run the release workflow (a tag, or Run workflow). Download `microsoft-store-package`, then in Partner Center create a submission and upload the `.appx` files under *Packages*. Fill in the listing (description, screenshots, privacy policy URL: the README's privacy section), choose free pricing, and submit for certification.
6. Each later version: upload the new `.appx` from that release's workflow run to a new submission.

The Store copy and the GitHub copy are separate installs. Keep the GitHub `.exe` for people who don't use the Store.

### 3. Package managers: free, more ways to install

- **winget** (`winget install Apollo…`): submit a manifest to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) that points to the GitHub release `.exe`.
- **Scoop**: add a manifest to an extras bucket or our own bucket.

These don't sign anything. They make installing and updating a one-line command and add another place people can find Apollo.

### Low-cost (not free) Windows alternatives

- **Azure Artifact Signing** (formerly *Trusted Signing*): a Microsoft-managed signing service with a monthly fee. electron-builder supports it through `win.azureSignOptions`.
- **Commercial OV/EV certificates**: from about $100–$500 a year, and usually a hardware token or cloud HSM.

---

## macOS

### There is no free way to make a downloaded app open without a prompt

Gatekeeper only trusts apps signed with a **Developer ID** certificate and **notarized** by Apple. Both require the [Apple Developer Program](https://developer.apple.com/programs/), which costs US$99 a year for individuals. Apple waives the fee only for eligible organisations (nonprofits, accredited educational institutions, government entities; see [fee waivers](https://developer.apple.com/help/account/membership/fee-waivers/)). Distributing through the Mac App Store needs the same membership.

**What we do for free:**
- ad-hoc sign the Apple Silicon build (see above);
- give clear first-launch steps for macOS 15+ (*System Settings → Privacy & Security → Open Anyway*) and for macOS 14 and earlier (Control-click → Open);
- publish checksums and provenance so users can trust what they're allowing.

### When budget allows: signing and notarization are already wired up

Add these **repository secrets**. `release-electron.yml` then signs and notarizes the macOS build automatically, with no workflow edits:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64 of your *Developer ID Application* certificate exported as `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your 10-character Team ID |

With a real signature, Apollo can also install updates by itself on macOS: set `CAN_AUTO_INSTALL` in `electron/main.ts` to include `darwin`. Today macOS users download updates by hand.

---

## Linux: already free

Linux has no gatekeeper prompt for AppImage or `.deb` files; checksums and provenance cover integrity. Optional free channels that add discoverability and automatic updates:

- **Flathub**: free. Flathub builds and signs the app from a manifest in their repository.
- **Snap Store**: free developer account; snaps are signed by the store.
- **Our own apt repository**: sign it with a free GPG key and host it on GitHub Pages.

---

## Recommended order

1. **Now, free:** keep checksums, provenance, fuses and the install guide (done in v1.0.7). The free web version on GitHub Pages needs no signing at all.
2. **Next, free:** apply to **SignPath Foundation** for Windows signing, and open a free **Microsoft Store** account for a Store listing. The CI wiring is in place, so just add the variables/secrets above.
3. **Optional, free:** winget/Scoop manifests and a Flathub listing.
4. **When there's budget:** the Apple Developer Program, for a prompt-free macOS install and in-app macOS updates.
