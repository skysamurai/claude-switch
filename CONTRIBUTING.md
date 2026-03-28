# Contributing

Thanks for your interest in contributing to claude-switch!

## Getting Started

```bash
git clone https://github.com/skysamurai/claude-switch.git
cd claude-switch
npm install
```

## Development

The codebase uses ES modules (Node.js 22+). Entry point is `bin/claude-switch.js`; logic lives in `lib/`.

```
bin/claude-switch.js   — CLI commands and dispatch
lib/config.js          — Account registry (~/.claude-switch/accounts.json)
lib/keychain.js        — OS credential storage (macOS / Linux / Windows)
lib/usage.js           — Anthropic usage API queries
lib/scorer.js          — Account selection algorithm
lib/runner.js          — PTY spawning and rate-limit detection
lib/session.js         — Session migration between accounts
lib/reauth.js          — Token refresh and browser re-auth
lib/browser.js         — Cross-platform browser control
lib/platform.js        — Platform detection
```

## Syntax Check

```bash
npm run check
```

This runs `node --check` on all source files — catches syntax errors without executing any code.

## Pull Requests

1. Fork the repo and create a feature branch
2. Keep changes focused — one feature or fix per PR
3. Run `npm run check` before submitting
4. Describe what the change does and why in the PR description

## Reporting Issues

Please include:
- OS and Node.js version (`node --version`)
- Claude Code version (`claude --version`)
- The command you ran
- Full error output

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
