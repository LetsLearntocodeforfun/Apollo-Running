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

**Steps**
1. Apply at <https://signpath.org/apply> and link this repository.
2. Once approved, create the SignPath project. Configure GitHub Actions as the trusted build system and add an artifact configuration that signs `Apollo-Setup-*.exe` (and, ideally, `Apollo.exe` inside it).
3. In `release-electron.yml`, after *Package installers* on the Windows job: upload the unsigned `.exe` with SignPath's official GitHub action, wait for the signed result, and replace the file before *Upload installer artifacts*. Then regenerate `latest.yml` and the `.blockmap` from the signed file. The auto-updater checks the SHA-512 in `latest.yml`, so signing must happen before those files are produced, or they must be rebuilt.
4. Store the SignPath API token as the repository secret `SIGNPATH_API_TOKEN`. Never put it in the repo.

**What it fixes:** the installer shows a verified publisher. SmartScreen reputation still builds up as people download it, so the first releases may warn less but not never.

### 2. Microsoft Store: free developer account, Microsoft signs the package

Partner Center now has **no registration fee** for individual or company accounts ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)). MSIX packages submitted to the Store are **signed by the Store on submission** ([MSIX signing overview](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)). People who install from the Store get no SmartScreen prompt and get automatic updates.

**Steps**
1. Create an individual developer account in Partner Center and reserve the name "Apollo" (or "Apollo Marathon").
2. Copy the package identity values that Partner Center shows (Package/Identity/Name, Publisher `CN=…`, Publisher display name) into `package.json` → `build.appx`, and add `appx` to the Windows targets. Do this in a separate Store build job so the GitHub `.exe` stays unchanged.
3. Build `Apollo-<version>.appx` in CI and upload it to Partner Center. Store certification checks it, then publishes it.

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

1. **Now, free:** keep checksums, provenance and the install guide (done in v1.0.7).
2. **Next, free:** apply to **SignPath Foundation** for Windows signing, and open a free **Microsoft Store** account for a Store listing.
3. **Optional, free:** winget/Scoop manifests and a Flathub listing.
4. **When there's budget:** the Apple Developer Program, for a prompt-free macOS install and in-app macOS updates.
