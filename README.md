# claude-switch

> Automatic Claude Code account switching when rate limits hit — keep coding without interruption.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#credential-storage)
[![Version](https://img.shields.io/github/package-json/v/skysamurai/claude-switch)](package.json)

You have multiple Claude subscriptions. When one account hits the rate limit, `claude-switch` automatically detects it, picks the best available account, migrates the session, and continues — without you doing anything.

```
$ claude-switch

[claude-switch] Starting with account "work" (32% utilized)
... coding ...
[claude-switch] Rate limit detected. Switching to "personal" (0% utilized)...
[claude-switch] Session migrated. Resuming...
... coding continues seamlessly ...
```

---

## Features

- **Automatic switching** — monitors Claude Code output for rate-limit messages and swaps accounts in real time
- **Session continuity** — migrates conversation history to the new account and resumes automatically
- **Smart account selection** — queries Anthropic's usage API and picks the account with the most headroom
- **Priority system** — pin your preferred account with a numeric priority
- **Secure credential storage** — uses OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Manager)
- **Shell integration** — `claude-switch use <name>` exports env vars so your shell picks up the switch
- **Cross-platform** — macOS, Linux, Windows (including ARM)

---

## Requirements

- [Node.js](https://nodejs.org) **≥ 22.0.0**
- [Claude Code](https://claude.ai/download) CLI installed and in `PATH`
- Two or more Claude subscriptions (Pro, Max, Team, etc.)

---

## Installation

```bash
# Clone and install globally
git clone https://github.com/skysamurai/claude-switch.git
cd claude-switch
npm install -g .
```

To update later:

```bash
cd claude-switch
git pull
claude-switch update
```

---

## Quick Start

### 1. Add your accounts

Your existing Claude auth is auto-detected as `"default"` on first run.
Add additional accounts:

```bash
claude-switch add work      # Opens browser for login
claude-switch add personal  # Opens browser for login
```

### 2. Check status

```bash
claude-switch status
```

```
Accounts:

  default  (user@gmail.com)
    Session:  12% of limit  |  resets in 3h 42m
    Weekly:    8% of limit  |  resets in 4d

  work  (user@company.com)
    Session:  0% of limit
    Weekly:   0% of limit

  personal  (me@domain.com)
    Session:  95% of limit  |  resets in 0h 18m
    Weekly:  71% of limit
```

### 3. Run Claude with auto-switching

```bash
claude-switch                    # replaces `claude` — same args
claude-switch "explain this"     # passes args to Claude
claude-switch --account work     # force a specific account
```

---

## Commands

| Command | Description |
|---|---|
| `claude-switch` | Run Claude with automatic account switching |
| `claude-switch add <name>` | Register and authenticate a new account |
| `claude-switch remove <name>` | Remove a registered account |
| `claude-switch list` | List all accounts and auth status |
| `claude-switch status` | Show real-time usage for all accounts |
| `claude-switch reauth` | Re-authenticate expired accounts |
| `claude-switch resume [id]` | Resume a session, finding it across accounts |
| `claude-switch use <name>` | Switch the active account in your shell |
| `claude-switch use --best` | Switch to the account with most headroom |
| `claude-switch set-priority <name> <n>` | Set account priority (1 = highest) |
| `claude-switch set-priority <name> clear` | Remove priority |
| `claude-switch init <bash\|zsh>` | Print shell integration snippet |
| `claude-switch update` | Reinstall from local git repo |
| `claude-switch --version` | Print version |

---

## Shell Integration

Add to `~/.bashrc` or `~/.zshrc` so `claude-switch use` properly exports environment variables to your shell:

```bash
eval "$(claude-switch init bash)"   # for bash
eval "$(claude-switch init zsh)"    # for zsh
```

After that, `claude-switch use` works as expected:

```bash
claude-switch use work        # switch to "work" account
claude-switch use --best      # switch to best available account
claude-switch use --unset     # revert to system default
```

---

## Account Priority

By default, `claude-switch` picks the account with the **lowest utilization**. Use priorities to always prefer a specific account:

```bash
claude-switch set-priority work 1      # always try "work" first
claude-switch set-priority personal 2  # fallback to "personal"
# accounts without priority are used last, ordered by utilization
```

---

## Session Resume

If Claude crashes or you need to continue a conversation on a different account:

```bash
claude-switch resume            # auto-selects best session
claude-switch resume <id>       # resume a specific session ID
```

Sessions are tracked across all registered accounts.

---

## Credential Storage

Credentials are stored securely using the OS keychain — never in plain text:

| Platform | Storage |
|---|---|
| macOS | Keychain Access (`security` CLI) |
| Linux | Secret Service via `secret-tool`; falls back to encrypted file |
| Windows | Windows Credential Manager (PowerShell); falls back to file |

Credentials are stored in the same format used by Claude Code, so existing auth is picked up automatically.

---

## How It Works

```
claude-switch
  │
  ├─ Queries Anthropic usage API for all accounts
  ├─ Selects account with lowest utilization (or by priority)
  ├─ Spawns Claude Code via PTY with that account's config
  │
  └─ Monitors output in real time
       │
       ├─ "Limit reached" detected →
       │    ├─ Kill current session
       │    ├─ Pick next best account
       │    ├─ Migrate session files (JSONL + tool results)
       │    └─ Resume with `claude --resume <id> "Continue."`
       │
       └─ All accounts exhausted → sleep until earliest reset
```

---

## Contributing

Pull requests are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

```bash
git clone https://github.com/skysamurai/claude-switch.git
cd claude-switch
npm install
npm run check   # syntax check all source files
```

---

## License

[MIT](LICENSE) © skysamurai
