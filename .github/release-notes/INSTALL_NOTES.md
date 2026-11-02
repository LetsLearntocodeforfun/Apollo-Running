## Download Apollo

Apollo is free and open source. It needs no account, and your data stays on your computer.

<!-- Release highlights: refresh this section for every release. -->

### What's new in v1.0.9

- **33 training plans, each labeled honestly.** 25 new plans:
  - four Hal Higdon plans transcribed day for day (`Novice Supreme`, `Personal Best`, `Intermediate 2`, `Advanced 2`);
  - Pete Pfitzinger's `12/55` to `18/85` methods and multiple-marathon plans;
  - Jack Daniels' `2Q` for up to 40 to 85 miles a week;
  - Hansons `Just Finish` and `Advanced`, and Jeff Galloway's `Run-Walk-Run`;
  - four plans designed by Apollo, and four base and recovery blocks.
- **Portable plans:** export and import any plan as an `.apollo-plan.json` file.
- **Aerobic durability (Pa:HR & Efficiency Factor), a shoe garage and a training journal.**
- **Course `.gpx` upload** for any race, fitted to the official distance.
- **Desktop backup folder and CSV export.**
- **Tighter local-first security:**
  - the desktop window can reach only intervals.icu and Strava; everything else is blocked;
  - update checks no longer send a device ID;
  - spellcheck never downloads dictionaries on Windows or Linux.
- **Illustrated Quick-Start Guide and Training Program Guide.**

Your data stays where it is: storage is unchanged from v1.0.8. Full details are in the [changelog](https://github.com/LetsLearntocodeforfun/Apollo-Running/blob/main/CHANGELOG.md).

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
