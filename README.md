# claude-usage

Audit which Claude Code **skills, commands, plugins, agents and MCP servers you actually use** — and get a ranked list of what to uninstall.

Everything Claude Code installs is free to add and invisible to forget. Skill descriptions sit in the system prompt of *every* session, so a plugin you installed once and never used is a standing tax on your context window. This reads your local transcripts and tells you what is earning its place.

```
claude-usage · 512 transcripts · 30d of history · 2026-08-27

PLUGINS  (9)  1 keep · 1 review · 7 drop
 ○ posthog             — ············ never    never used in 46d since install
 ○ slack               — ············ never    never used in 170d since install
 ◐ vercel             1× ············ 1mo ago  only 1x, idle 59d
 ● feature-dev        3× ·······█·█·█ 3d ago   3x, last 3d ago

MCP SERVERS  (11)  5 keep · 6 drop
 ○ overleaf              — ············ never                   never used in 30d of history
 ● Figma              408× ·········█▇· 10d ago   claude.ai     408x, last 10d ago
 ● claude-in-chrome   274× ·······▅▃█▄▃ yesterday built-in      274x, last 1d ago

UNINSTALL SUGGESTIONS  49 items · ~14k tokens of context reclaimed
   1. plugin posthog — never used in 46d since install ~11k tok
      claude plugin uninstall posthog@claude-plugins-official
```

## Use it

No install, no dependencies — just Node 18+:

```bash
npx github:JerryWu0430/claude-usage          # full audit
npx github:JerryWu0430/claude-usage clean    # pick what to remove, then remove it
npx github:JerryWu0430/claude-usage --html   # open the dashboard
```

Or clone and link it:

```bash
git clone https://github.com/JerryWu0430/claude-usage && cd claude-usage && npm link
claude-usage
```

## What you get

```
claude-usage [kinds...] [options]
claude-usage clean [kinds...] [options]

KINDS
  skills  commands  mcp  plugins  agents        (default: all)

CLEAN
  clean             pick what to uninstall interactively, then remove it
  --dry-run         with clean: show what would run, change nothing
  --yes             with clean: skip the final confirmation

OPTIONS
  --html [file]     write an HTML dashboard (default ./claude-usage.html) and open it
  --json            emit the full analysis as JSON
  --prune           print a copy-pasteable uninstall script for the drop list
  --all             include items you cannot remove directly (plugin-provided, built-ins)
  --sort <key>      verdict | count | recent | name          (default: verdict)
  --stale <days>    idle days before an item is dropped      (default: 90)
  --warm <days>     idle days still counted as active        (default: 30)
  --grace <days>    grace period for newly installed items   (default: 14)
  --no-cache        rescan every transcript from scratch
  --no-color        disable ANSI colour
```

The `--html` dashboard is the same data with sortable tables and 12-week sparklines. Nothing leaves your machine — it is a single self-contained file.

## Cleaning up

`claude-usage clean` opens a picker over everything you can actually remove, grouped by kind, with the `drop` items already ticked. Deselect what you want to keep, confirm, done.

```
Select items to uninstall
↑↓ move · space toggle · a all · n none · enter confirm · q cancel

  PLUGINS (9)
› [x] ○ posthog          never used in 46d since install    ~11k tok
  [x] ○ slack            never used in 170d since install   ~156 tok
  [ ] ◐ vercel           only 1x, idle 59d                 ~2.0k tok
  [ ] ● feature-dev      3x, last 3d ago                     ~26 tok

  MCP SERVERS (7)
  [x] ○ overleaf         never used in 30d of history
  [ ] ● datadog          34x, last 8d ago

  49 selected · ~14k tokens reclaimed   62 more below
```

| Key | |
| --- | --- |
| `↑` `↓` / `j` `k` | move (group headers are skipped) |
| `space` | toggle the row under the cursor |
| `a` / `n` | select all / none |
| `PgUp` `PgDn` `Home` `End` | jump |
| `enter` | confirm · `q` `esc` `^C` cancel |

Click a row to toggle it and scroll with the wheel — mouse works too. Nothing is removed until you confirm a second time on the normal screen (unless you pass `--yes`), so the record of what ran stays in your scrollback. `--dry-run` stops before that.

Removals run without a shell: files are unlinked directly and plugins go through `claude plugin uninstall`, so a path with a space or a `;` in it is a filename, never a command. Symlinked skills are unlinked, leaving your source library untouched.

Prefer to review a script instead?

```bash
claude-usage --prune > clean.sh
less clean.sh && bash clean.sh
```

## How it decides

| Verdict | Meaning |
| --- | --- |
| ● `keep` | used within the last 30 days, or a heavy staple (20+ uses) still used within 90 |
| ◐ `review` | used, but idle 30–90 days and never heavily |
| ○ `drop` | never used past its grace period, or idle beyond 90 days |
| ◆ `new` | installed under 14 days ago and not used yet — too early to judge |

Only items you can actually remove yourself are suggested for uninstall. A plugin's usage is the sum of everything it ships (its skills, commands, agents and MCP servers), because a plugin is never invoked directly — so an unused plugin is reported once, not as 142 unused skills.

`~N tok` is the approximate context each skill or command costs in every session, from the description Claude Code loads into the system prompt. It is the number that makes an unused plugin worth removing.

## Where the data comes from

| Source | Used for |
| --- | --- |
| `~/.claude.json` → `skillUsage` | lifetime skill and command counts, last used |
| `~/.claude/projects/**/*.jsonl` | MCP, agent and tool usage; first use; per-project; 12-week trend |
| `~/.claude/skills`, `commands`, `agents` | what is installed, and when (symlinks resolved) |
| `~/.claude/plugins/installed_plugins.json` | plugin install dates and versions |
| `~/.claude.json` → `mcpServers`, per-project config, plugin `.mcp.json` | configured MCP servers |

Transcripts are parsed with a line prefilter and cached per file by mtime, so a full 400MB scan takes about a second and repeat runs are near-instant. The cache lives at `~/.claude/.claude-usage-cache.json`; delete it or pass `--no-cache` to rebuild.

### Caveats worth knowing

- **Claude Code prunes old transcripts.** The header tells you how far back yours actually reach. For MCP servers that window is all there is, so `never used in 30d of history` means exactly that — not "never used ever". Skills and commands are counted from `skillUsage`, which is lifetime.
- **MCP servers have no recorded install date**, so they are judged against the transcript window instead.
- **Context cost is an estimate** (`chars / 4`) over skill and command descriptions only. MCP tool schemas also cost context but their size is not knowable without connecting to each server, so they are not counted.
- **`built-in / project`** means a skill or command was used but is not in your user config — it ships with Claude Code, comes from a project directory, or has since been removed. Those are never suggested for uninstall.
- **Symlinked skills** are unlinked with `rm`, not `rm -rf`, so your source library is left intact.

## Why a CLI and not a web app

The data is entirely local, the task is a periodic audit rather than something to watch, and the result is *acting on your own filesystem* — a web page cannot unlink a skill or run `claude plugin uninstall`, so it could only ever hand you commands to paste. A CLI needs no server, no auth and no deploy, and `clean` closes the loop in one keystroke. `--html` covers the part a terminal genuinely cannot do: sortable columns and trend sparklines across a few hundred rows.

## Development

```bash
npm test
```

MIT
