# TDAI Memory — CodeBuddy IDE Plugin

PowerShell-based memory plugin for **CodeBuddy IDE** (the Electron app). Use this variant when the Node.js hook (`claude-code-plugin/`) fails due to subprocess HTTP timeouts inside the IDE's sandboxed renderer.

## Why a separate plugin?

CodeBuddy IDE spawns hooks through its headless CLI backend (`@tencent-ai/codebuddy-code`), which inherits Electron's subprocess environment. In that context, Node.js's HTTP client to `localhost:8421` reliably times out. PowerShell's `Invoke-RestMethod` works.

This plugin:
- Uses PowerShell instead of Node.js for all HTTP calls
- Derives a project-scoped session key from `cwd` (matches Claude Code's `getSessionKey`)
- Cross-client memory sharing — same project hash → same `session_key` → same L0/L1 data
- Conditional injection — full persona on cold start, lightweight L0 search on warm turns
- Captures full user+assistant turns by parsing `transcript_path` on Stop

## Installation (CodeBuddy IDE)

### Option 1: Copy to marketplace (volatile — IDE updates may wipe)
```powershell
$src = "C:\path\to\TencentDB-Agent-Memory\codebuddy-plugin"
$dst = "$env:USERPROFILE\.codebuddy\plugins\marketplaces\cb_teams_marketplace\plugins\tdai-memory"
Copy-Item -Recurse -Force $src $dst
```

### Option 2: Symlink from fork (survives IDE updates if symlinks aren't purged)
```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.codebuddy\plugins\marketplaces\cb_teams_marketplace\plugins\tdai-memory" -Target "C:\path\to\TencentDB-Agent-Memory\codebuddy-plugin"
```
Note: CodeBuddy's plugin loader has historically skipped symlinks. Test first.

### Hook registration in `~/.codebuddy/settings.json`
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "powershell.exe -ExecutionPolicy Bypass -File \"<plugin-path>/hooks/tdai-hook.ps1\" session-start", "async": true, "timeout": 30000 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "powershell.exe -ExecutionPolicy Bypass -File \"<plugin-path>/hooks/tdai-hook.ps1\" user-prompt-submit", "timeout": 5000 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "powershell.exe -ExecutionPolicy Bypass -File \"<plugin-path>/hooks/tdai-hook.ps1\" stop", "async": true, "timeout": 30000 }] }]
  }
}
```

## Prerequisites

- Windows + PowerShell 5.1+
- TDAI gateway running at `http://127.0.0.1:8421` (use PM2 to keep it alive)
- Ollama serving `nomic-embed-text` on port 11434 (CPU embedding)

## Cross-Client Memory Sharing

Both this plugin and `claude-code-plugin/` derive the session key the same way:

```
session_key = SHA-256(path.resolve(cwd)).slice(0, 16)
```

So `C:\ProjectJarvis` produces `02562a787e10c9dd` from either Claude Code or CodeBuddy IDE. L0 conversations, L1 atoms, persona, and scenes all flow through the same gateway and database. Memory written from one client is immediately readable by the other.

## Architecture

```
CodeBuddy IDE (Electron)
  └── @tencent-ai/codebuddy-code (npm headless CLI)
        └── reads ~/.codebuddy/settings.json
              └── spawns: powershell.exe → tdai-hook.ps1
                    └── Invoke-RestMethod → localhost:8421
                          └── TDAI gateway (Node.js, PM2-managed)
                                ├── /recall (persona + L1 atoms)
                                ├── /capture (write L0)
                                └── /search/conversations (hybrid L0 search)
```

## Hook Behavior

| Event | Action |
|-------|--------|
| `SessionStart` | Reset cold-start counter (forces full inject on first prompt) |
| `UserPromptSubmit` (cold) | Recall + L0 search + capture + inject ALL |
| `UserPromptSubmit` (warm) | L0 search + capture + inject light (skip persona) |
| `Stop` | Read `transcript_path`, capture full user+assistant turn |

## Files

| File | Purpose |
|------|---------|
| `.codebuddy-plugin/plugin.json` | Plugin manifest (skills registration) |
| `hooks/tdai-hook.ps1` | The PowerShell hook script |
| `hooks/hooks.json` | Hook event → command mapping (reference) |
| `skills/tdai-memory-search/SKILL.md` | Optional skill for on-demand memory search |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Hook silently fails | Syntax error | `echo '{"prompt":"test"}' \| powershell.exe -File tdai-hook.ps1 user-prompt-submit` |
| `Missing required fields` | UTF-16 encoding | Hook uses `[System.Text.Encoding]::UTF8.GetBytes()` — verify on update |
| Plugin disappears after IDE update | Marketplace dir is volatile | Restore from this fork; consider symlink (test first) |
| L0 search empty | Gateway not running | `pm2 status tdai-gateway` |
| Session keys don't match Claude Code | `cwd` not passed | Verify hook input has `data.cwd`; falls back to `CODEBUDDY_PROJECT_DIR` env var |
