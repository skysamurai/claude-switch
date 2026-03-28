# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.0] — 2026-03-27

### Added

- **Automatic rate-limit detection** — real-time PTY monitoring for "Limit reached" messages
- **Seamless session migration** — copies JSONL conversation files and tool results to the new account and resumes with `claude --resume`
- **Smart account selection** — queries Anthropic's OAuth usage API; picks the account with the lowest effective utilization (`max(sessionPercent, weeklyPercent)`)
- **Priority system** — `set-priority <name> <n>` lets you pin preferred accounts
- **Countdown timers** — `status` shows time remaining until each account's rate-limit resets
- **OS keychain integration** — macOS Keychain, Linux Secret Service, Windows Credential Manager
- **Shell integration** — `init bash/zsh` prints an eval-able function so `use` properly exports env vars
- **Silent token refresh** — proactively refreshes OAuth tokens before checking usage to avoid spurious 401 errors
- **Duplicate account detection** — prevents registering the same Claude email under two names
- **Cross-platform support** — macOS (x64/arm64), Linux (x64/arm64), Windows (x64/arm64)
- **`update` command** — reinstall from local git repo with `npm pack` + `npm install -g`

### Commands

`add`, `remove`, `list`, `status`, `reauth`, `resume`, `use`, `set-priority`, `init`, `update`, `help`, `--version`
