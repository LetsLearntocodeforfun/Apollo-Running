## Download Apollo

Apollo is free and open source. It needs no account, and your data stays on your computer.

**What's new in this version:** see the [changelog](https://github.com/LetsLearntocodeforfun/Apollo-Running/blob/main/CHANGELOG.md).

| Your computer | Download this file |
|---|---|
| **Windows 10/11** | `Apollo-Setup-<version>.exe` |
| **Mac with Apple Silicon** (M1–M4 and later) | `Apollo-<version>-arm64.dmg` |
| **Mac with an Intel chip** | `Apollo-<version>.dmg` |
| **Linux** (any distro) | `Apollo-<version>.AppImage` |
| **Debian / Ubuntu** | `apollo-marathon_<version>_amd64.deb` |

The `.zip`, `.blockmap` and `latest*.yml` files are for in-app updates. You don't need to download them.

### First launch: expect one security prompt

These builds aren't signed with a paid publisher certificate yet, so your computer asks you to confirm once:

- **Windows:** "Windows protected your PC" → click **More info** → **Run anyway**.
- **macOS 15 (Sequoia) and later:** open Apollo once and close the warning. Then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.
- **macOS 14 and earlier:** in Applications, Control-click Apollo → **Open** → **Open**.
- **Linux AppImage:** make it executable (`chmod +x Apollo-*.AppImage`), then run it.

Step-by-step help, including fixes for a "damaged" warning on macOS: [docs/INSTALL.md](https://github.com/LetsLearntocodeforfun/Apollo-Running/blob/main/docs/INSTALL.md).

### Check your download (optional)

- **Checksums:** `SHA256SUMS.txt` lists the SHA-256 of every installer.
  - macOS/Linux: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`
  - Windows (PowerShell): `Get-FileHash .\Apollo-Setup-<version>.exe`, then compare the result with the file.
- **Provenance:** every installer has a GitHub build-provenance attestation, which proves it was built from this repository by GitHub Actions. If you have the GitHub CLI: `gh attestation verify <file> -R LetsLearntocodeforfun/Apollo-Running`.
