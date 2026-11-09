# A/B Test Results: `token-saver` plugin for OpenCode V2

This document summarizes a real A/B comparison between OpenCode sessions with and
without the `token-saver` plugin, translating a Python file to Rust.

---

## Test Setup

| Aspect | Session WITHOUT plugin | Session WITH plugin |
|---|---|---|
| **Task** | Translate `calculador_tokens.py` to Rust | Translate `calculador_tokens_copia.py` to Rust |
| **Source file** | `<your-project>/calculador_tokens.py` | `<your-project>/calculador_tokens_copia.py` |
| **Target file** | `calculador_tokens.rs` | `calculador_tokens_copia.rs` |
| **Source content** | Identical (2836 bytes, 74 lines) | Identical (2836 bytes, 74 lines) |
| **Session ID** | `ses-rust-sin-plugin` | `ses-rust-con-plugin` |
| **Model** | `beam-free` | `beam-free` |

Both Python files contained exactly the same code. The only difference was the
target file path (original vs copy), so both sessions worked independently but
on equivalent content.

---

## Token Consumption Comparison Table

| Metric | WITHOUT plugin | WITH plugin | Difference | Savings % |
|---|---|---|---|---|
| **Input tokens** | 30,920 | 13,932 | −16,988 | **54.9%** |
| **Output tokens** | 3,304 | 2,026 | −1,278 | **38.7%** |
| **Total tokens** | 34,224 | 15,958 | −18,266 | **53.4%** |
| **Messages** | 31 | 12 | −19 | — |

---

## Why the plugin saves over 50%

### 1. Read deduplication (`dedupeReads`)

Before allowing a `read`, the plugin checks with `stat()` (mtime + size,
without reading content) if the file was already read in the current session
and hasn't changed. If so, it blocks the re-read and the model receives a short
message telling it to use what's already in context instead of paying for the
file again.

In the WITHOUT plugin session, the model read the Python file multiple times
during translation. In the WITH plugin session, repeated reads were blocked
after the first one.

### 2. Safe whitespace trim (`trimWhitespace`)

Before executing `write` or `edit`, the plugin trims trailing spaces/tabs from
each line and collapses 3+ consecutive blank lines to one, without touching
leading indentation (which is semantic). This reduces the bytes the model
writes without changing code logic.

### 3. Fewer round trips

The WITHOUT plugin session required 31 messages vs 12 in the WITH plugin
session. The plugin helps the model be more direct in its file operations.

### 4. Real formatting post-edit (`formatOnEdit`)

After each successful `write`/`edit`, the plugin runs an external formatter
(Prettier, Black, gofmt...) via Bun Shell. The model writes its best attempt,
the formatter makes it clean — so the model doesn't have to regenerate whole
blocks over a misplaced indent.

---

## Generated Files

| Session | Generated Rust file | Source |
|---|---|---|
| WITHOUT plugin | `<your-project>/calculador_tokens.rs` | `<your-project>/calculador_tokens.py` |
| WITH plugin | `<your-project>/calculador_tokens_copia.rs` | `<your-project>/calculador_tokens_copia.py` |

Both Rust files contain the same logic (`estimar_tokens`, `main`,
`sumar_dos_numeros`) and produce output identical to the Python script
(verified with stdout diff).

---

## Complete Sessions in Markdown

### Session WITHOUT plugin

See [`sesion-rust-sin-plugin.md`](./sesion-rust-sin-plugin.md) — 31 messages,
34,224 total tokens.

### Session WITH plugin

See [`sesion-rust-con-plugin.md`](./sesion-rust-con-plugin.md) — 12 messages,
15,958 total tokens.

---

## Code Quality Analysis

See [`RUST_CODE_ANALYSIS.md`](./RUST_CODE_ANALYSIS.md) for a detailed review of
the generated Rust code (compilation, correctness, UTF-8 handling, number
formatting, comparison with Python original).

---

## Conclusion

In a real-world code translation task (Python → Rust), the `token-saver`
plugin reduced token consumption by **53.4%** compared to an equivalent session
without the plugin.

Savings breakdown:
- **Input tokens:** −54.9% (fewer re-reads of files)
- **Output tokens:** −38.7% (less code regeneration over formatting issues)

The plugin fulfills its goal of reducing token consumption in AI-assisted
programming sessions, without changing what the model can do or compromising
code quality.

---

## How to Reproduce

1. Clone the repository:
   ```bash
   git clone https://github.com/kikeh2/opencode-token-saver.git ~/.config/opencode/plugin/token-saver
   ```

2. Create a test file (or use an existing one).

3. Run OpenCode with and without the plugin active, asking for the same file
   modification/creation task.

4. Compare token consumption in session exports.

---

*Test performed with OpenCode V2, model `beam-free`, November 9, 2026.*
