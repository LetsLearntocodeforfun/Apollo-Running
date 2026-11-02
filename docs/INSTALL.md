# Install Apollo

Apollo is a free, open-source marathon training app for **Windows, macOS and Linux**. It has no account and no subscription, and your data stays on your computer.

**Download:** [github.com/LetsLearntocodeforfun/Apollo-Running/releases/latest](https://github.com/LetsLearntocodeforfun/Apollo-Running/releases/latest)

**Don't want to install anything?** [Use it in your browser](#use-it-in-your-browser) instead.

**Already installed?** Continue with the **[Illustrated Quick-Start Guide](QUICK_START_GUIDE.md)** (first-run setup, watch sync, and page-by-page visual tour) and the **[Training Program Guide](TRAINING_PROGRAM_GUIDE.md)** (choosing among all 33 plans, calibrating VDOT & heart-rate zones, and structuring a full marathon cycle).

---

## 1. Pick the right file

| Your computer | File | Notes |
|---|---|---|
| Windows 10 or 11 (64-bit) | `Apollo-Setup-<version>.exe` | A normal installer. You can choose the install folder. |
| Mac with Apple Silicon (M1, M2, M3, M4 or later) | `Apollo-<version>-arm64.dmg` | Not sure which Mac you have? Open  menu → **About This Mac**: "Chip: Apple M…" means Apple Silicon. |
| Mac with an Intel chip | `Apollo-<version>.dmg` | "Processor: Intel" in About This Mac. |
| Linux, any distribution | `Apollo-<version>.AppImage` | One file. No install needed. |
| Debian, Ubuntu, Linux Mint, Pop!_OS | `apollo-marathon_<version>_amd64.deb` | Installs through your package manager. |

You can ignore `.zip`, `.blockmap` and `latest*.yml`. The in-app updater uses them.

---

## 2. Install and open it for the first time

Apollo's installers aren't yet signed with a paid publisher certificate (see [SIGNING.md](SIGNING.md) for why, and what's planned), so the first time you open Apollo your computer asks you to confirm. It's a one-time step.

### Windows

1. Run `Apollo-Setup-<version>.exe`.
2. If **"Windows protected your PC"** appears, click **More info**, then **Run anyway**.
3. Follow the installer. Apollo appears in the Start menu.

### macOS

1. Open the `.dmg` and drag **Apollo** into **Applications**.
2. Open Apollo from Applications. macOS will say it can't verify the app. Click **Done** (not "Move to Trash").
3. Allow it:
   - **macOS 15 Sequoia and later:** go to **System Settings → Privacy & Security**, scroll to *Security*, click **Open Anyway** next to "Apollo was blocked…", and confirm with your password or Touch ID.
   - **macOS 14 Sonoma and earlier:** in Applications, **Control-click** (or right-click) Apollo → **Open** → **Open**.
4. From then on Apollo opens normally.

**If macOS says "Apollo is damaged and can't be opened":** this usually means the download quarantine flag is blocking an unsigned app, not that the file is broken. Check the download (step 3 below), then run this in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Apollo.app
```

### Linux: AppImage

```bash
chmod +x Apollo-<version>.AppImage
./Apollo-<version>.AppImage
```

If it doesn't start on Ubuntu 22.04 or later, install FUSE 2: `sudo apt install libfuse2` (on Ubuntu 24.04 the package is `libfuse2t64`).

### Linux: .deb

```bash
sudo apt install ./apollo-marathon_<version>_amd64.deb
```

Apollo then appears in your applications menu.

---

## 3. Check your download (optional, recommended)

Every release includes two free ways to confirm a file is genuine:

**SHA-256 checksums.** Download `SHA256SUMS.txt` into the same folder as the installer, then:

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

```powershell
# Windows PowerShell: compare the output with the matching line in SHA256SUMS.txt
Get-FileHash .\Apollo-Setup-<version>.exe -Algorithm SHA256
```

**Build provenance.** Each installer carries a GitHub artifact attestation (signed with Sigstore). It proves the file was built from this repository by GitHub Actions and wasn't modified afterwards. With the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify Apollo-<version>-arm64.dmg -R LetsLearntocodeforfun/Apollo-Running
```

---

## 4. Updates

- **Windows and Linux AppImage:** Apollo can check for, download and install updates itself. It's off until you turn it on in **Settings → About**.
- **macOS and .deb:** Settings → About can tell you a new version exists. Install it by downloading the new file from the Releases page, the same way as above. (In-app installation on macOS needs a paid Apple signing certificate.)

Updating never touches your training data.

---

## 5. Where your data lives

Apollo stores everything locally in your user profile:

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Apollo` |
| macOS | `~/Library/Application Support/Apollo` |
| Linux | `~/.config/Apollo` |

Uninstalling Apollo **keeps** this folder, so reinstalling brings your data back. To move to a new computer, use **Settings → Data & Privacy → Download current data**, then **Import from file…** on the new machine.

---

## 6. Uninstall

- **Windows:** Settings → Apps → Apollo → Uninstall.
- **macOS:** drag Apollo from Applications to the Trash.
- **Linux:** delete the AppImage, or run `sudo apt remove apollo-marathon`.

To remove your data as well, use **Settings → Data & Privacy → Delete all data…** before uninstalling, or delete the folder listed in step 5.

---

## Use it in your browser

Apollo also runs as a website, free and with nothing to install:

**[letslearntocodeforfun.github.io/Apollo-Running](https://letslearntocodeforfun.github.io/Apollo-Running/)**

It's the same app as the desktop version. Good to know:

- **Your data stays in this browser** on this device (in the browser's own storage). Nothing is uploaded, and there is no account. A different browser, a private/incognito window or another computer starts empty.
- **Clearing your browser's site data deletes your Apollo data.** Back it up regularly with **Settings → Data & Privacy → Download current data**. You can bring that file into the desktop app (or another browser) with **Import from file…**.
- **Strava and Garmin Connect sync are available in the desktop app** (Garmin's API doesn't accept requests from web browsers). In the browser, connect **intervals.icu** (free; it collects activities from COROS, Suunto, Wahoo, Zwift and others) or import activity files (`.fit`, `.gpx`, `.tcx`, Strava/Garmin exports).
- **Use one tab at a time.** If Apollo is open in two tabs, the second one shows a warning, because changes made in both could overwrite each other.
- Updates arrive automatically the next time you open the page.

To move to the desktop app later: download your data in the browser, install the desktop app, then use **Import from file…**.

---

## Next steps

Once Apollo opens on your computer or in your browser:

1. **[Illustrated Quick-Start Guide](QUICK_START_GUIDE.md)** — Walk through the 5-step onboarding wizard, connect Garmin Connect, `intervals.icu`, or offline `.fit`/`.gpx`/`.tcx`/`.zip` files, and tour every screen with screenshots.
2. **[Training Program Guide](TRAINING_PROGRAM_GUIDE.md)** — Learn how to choose the right schedule from Apollo's 33 built-in plans, calibrate VDOT paces and 5 heart-rate zones, read `CTL`/`ATL`/`TSB` and `Pa:HR` durability, and execute taper, fueling, and race day.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Windows: nothing happens after "Run anyway" | Check the Start menu; the installer may have finished in the background. Some antivirus tools also quarantine new unsigned apps, so restore Apollo from quarantine if that's what happened. |
| macOS: no "Open Anyway" button | Try to open Apollo once first. The button only appears for about an hour after a blocked launch. |
| macOS: "damaged and can't be opened" | See the `xattr` command in step 2. |
| Linux: AppImage won't start | Install `libfuse2` (or `libfuse2t64`), or use the `.deb`. |
| Browser: "Apollo is open in another tab" | Close the other Apollo tabs (or this one), then click **Reload**. |
| Browser: my data is gone | The browser's site data was cleared, or you're in a different browser/profile or a private window. Restore your last download with **Import from file…**. |
| Something else | [Open an issue](https://github.com/LetsLearntocodeforfun/Apollo-Running/issues) with your OS version and what you saw. |

## Run from source (developers)

```bash
git clone https://github.com/LetsLearntocodeforfun/Apollo-Running.git
cd Apollo-Running
npm ci
npm run dev           # browser at http://localhost:5173
npm run dev:electron  # desktop app
npm run build:pages   # the GitHub Pages web build (base /Apollo-Running/)
npm run test:e2e      # build the desktop app and run the Playwright smoke test
```

Requires Node.js 22 or later.
