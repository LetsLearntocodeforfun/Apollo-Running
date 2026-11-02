# Security policy

Apollo keeps your training data on your device, so security problems matter a lot. Thank you for reporting them responsibly.

## Reporting a vulnerability

Please **don't open a public issue or discussion** for a security problem.

Report it privately through GitHub instead: **[Report a vulnerability](https://github.com/LetsLearntocodeforfun/Apollo-Running/security/advisories/new)** (repository **Security** tab → **Report a vulnerability**). Only the maintainer can see it.

Helpful details:

- the Apollo version (Settings › About) and your operating system, or whether it's the web version;
- what an attacker could do, and the steps to reproduce it;
- a proof of concept, if you have one.

Please never include real API keys, tokens or personal training data. The maintainer reads every report; allow a few days for a first reply. Fixes ship in a new release, and the advisory is published once people can update. With your permission, you'll be credited.

## Supported versions

Security fixes go into the latest release. Desktop users with automatic updates turned on get them on the next update check; otherwise download the newest version from the [releases page](https://github.com/LetsLearntocodeforfun/Apollo-Running/releases/latest). The [web version](https://letslearntocodeforfun.github.io/Apollo-Running/) always runs the latest release.

## Scope

In scope: the Apollo desktop app, the web version, and this repository's build and release pipeline.

Out of scope: the services Apollo can connect to (Garmin Connect, intervals.icu, Strava). Please report problems with those services to them directly.

## Checking your download

Every release includes `SHA256SUMS.txt` and GitHub build-provenance attestations, so you can confirm an installer was built from this repository. See [docs/INSTALL.md](docs/INSTALL.md).
