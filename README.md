# opencode-token-saver

A plugin for [OpenCode](https://opencode.ai) V2 that reduces token usage
during agentic coding sessions by trimming unnecessary whitespace,
offloading indentation cleanup to a real formatter, and blocking
redundant re-reads of unchanged files.

## Why

Agentic coding models spend output tokens re-writing whole blocks of code
to fix a handful of misaligned spaces, and spend input tokens re-reading
files they've already seen in the same session. Neither cost adds value
to the work. This plugin removes both without changing what the model is
allowed to do.

## Features

### 1. Whitespace trim

Before a `write` or `edit` tool call runs, the plugin strips trailing
whitespace from each line and collapses three or more consecutive blank
lines down to one. It never touches leading indentation — that's
semantic in languages like Python, so reformatting it blindly would be
unsafe. For `edit`, only `newString` is touched; `oldString` is left
untouched because it has to match the file exactly for the edit to apply.

### 2. Formatter on edit

After a `write` or `edit` completes successfully, the plugin runs the
formatter configured for that file's extension (Prettier, Black, gofmt,
or anything else you configure) via Bun's shell. The model writes its
best attempt, the formatter makes it clean — so the model never has to
regenerate a whole block over a misplaced indent.

Formatter commands are checked against an allowlist before running. When
the command is `bunx` or `npx`, the package it invokes is checked
against a second, separate allowlist, so a tampered config file can't
make the plugin run arbitrary npm packages.

### 3. Dedupe reads

Before a `read` tool call runs, the plugin checks whether that file was
already read earlier in the same session and hasn't changed since
(via `mtime` + size, not a full-content hash). If so, the read is
blocked and the model gets a short message telling it to use what's
already in its context instead of paying for the file again. A changed
file always passes through normally.

## Installation

```bash
git clone https://github.com/kikeh2/opencode-token-saver.git ~/.config/opencode/plugin/token-saver
```

Or, for a project-local install, clone into `.opencode/plugin/token-saver`
inside your project. OpenCode discovers and loads plugins placed in
either location automatically — no entry in `opencode.json` is needed.

## Configuration

On first load, the plugin creates `.opencode/token-saver.jsonc` next to
itself with these defaults (see `token-saver.example.jsonc` for a
commented copy):

```jsonc
{
  "trimWhitespace": true,
  "formatOnEdit": true,
  "dedupeReads": true,
  "alwaysProtectedFiles": ["AGENTS.md", "CLAUDE.md", "SKILL.md"],
  "formatters": {
    ".ts": ["bunx", "prettier", "--write", "$FILE"],
    ".tsx": ["bunx", "prettier", "--write", "$FILE"],
    ".js": ["bunx", "prettier", "--write", "$FILE"],
    ".py": ["black", "$FILE"],
    ".go": ["gofmt", "-w", "$FILE"]
  }
}
```

Each feature can be turned off independently. `alwaysProtectedFiles`
lists basenames that should never be re-read in the same session, even
if their `mtime` can't be checked reliably.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit, strict mode
bun run test         # runs tests/tests.ts
```

## Security notes

This plugin executes shell commands (via formatters) and reads/writes
files on disk. It was built and audited with that in mind:

- Formatter binaries run only from an allowlist; `bunx`/`npx` packages
  are checked against a second allowlist.
- File paths are resolved and checked against the project root before
  any `stat`, `read`, or formatter call — a path that would escape the
  project directory is rejected.
- The read-dedupe cache has a bounded size (1000 entries, FIFO
  eviction) to avoid unbounded memory growth in long sessions.

If you find a security issue, please open an issue rather than a public
PR with exploit details.

## License

MIT — see [LICENSE](./LICENSE).
