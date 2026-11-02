# Contributing to Apollo

Thanks for helping. Apollo is a free, local-first marathon training app, and every bug report, idea, fix and doc improvement makes it better for runners.

## Ways to help

- **Ask a question or share an idea** in [Discussions](https://github.com/LetsLearntocodeforfun/Apollo-Running/discussions) (Q&A, Ideas, Show and tell).
- **Report a bug** with the [bug report form](https://github.com/LetsLearntocodeforfun/Apollo-Running/issues/new/choose). Please leave out personal data: never paste API keys, tokens or full backup files.
- **Pick up an issue.** Issues labeled [`good first issue`](https://github.com/LetsLearntocodeforfun/Apollo-Running/labels/good%20first%20issue) are small and well-scoped; [`help wanted`](https://github.com/LetsLearntocodeforfun/Apollo-Running/labels/help%20wanted) ones are bigger. Comment on the issue first so nobody duplicates work.
- **Improve the guides** in [`docs/`](docs/) — clearer wording and corrections are always welcome.
- **Security problems:** please don't open a public issue. See [SECURITY.md](SECURITY.md).

## What Apollo stands for

These are the things a pull request must keep true:

- **Your data stays on your device.** No analytics, telemetry, trackers, ads or third-party fonts/CDNs. A new network destination needs a discussion first and must be listed in **Settings › Data & Privacy**.
- **Honest training content.** A coach-based plan follows the coach's published schedule, says how closely it does, and links to the source. Apollo's own plans are labeled **Designed by Apollo**. Formulas cite their published source and get tests.
- **Calm, plain copy.** Short sentences, no hype, no fear. Apollo gives training guidance, not medical advice.
- **The look.** Art Deco navy (`#0D1B2A`) and gold — use the variables in `src/styles/design-system.css`.

## Development setup

You need [Node.js](https://nodejs.org/) 22 or later.

```bash
git clone https://github.com/LetsLearntocodeforfun/Apollo-Running.git
cd Apollo-Running
npm ci
npm run dev            # browser: http://localhost:5173
npm run dev:electron   # desktop app
```

## Before you open a pull request

Run the same checks as CI:

```bash
npm run typecheck
npm run lint
npm run format:check   # npm run format fixes formatting
npm test
npm run build:web && npm run check:bundle
```

- Keep pull requests small and focused on one change.
- Add or update tests for behavior changes (`src/__tests__/`).
- For user-facing changes, update the relevant guide or README section and add a line to `CHANGELOG.md`.
- Check keyboard use and screen-reader labels for UI changes.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
