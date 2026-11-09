# Why 31 messages vs 12 messages?

This document explains the difference in message count between two OpenCode sessions — one **without** the `token-saver` plugin (31 messages) and one **with** the plugin (12 messages).

The difference is not random: it is exactly what the plugin is designed to fix.

---

## Session WITHOUT plugin — 31 messages

The model had to work harder to complete the translation:

1. **Read the Python file multiple times** — each `read` puts the entire file back into context, costing input tokens again.
2. **Attempted to write the Rust file**, but indentation or formatting was likely not perfect.
3. **Had to rewrite entire blocks** because indentation was off.
4. **More back-and-forth:** every failed attempt generated another message, another `read`, another `write`/`edit`.

**Result:** 31 messages, 30,920 input tokens, 3,304 output tokens.

---

## Session WITH plugin — 12 messages

The plugin intervened at every step:

1. **First `read`:** passed normally and the mtime was recorded.
2. **Second `read` (if the model tried to re-read):** blocked by `dedupeReads` — the model received a short message ("you already read this, no need to re-read") instead of re-loading the entire file into context.
3. **`write`/`edit`:** before executing, `trimWhitespace` trimmed trailing spaces/tabs and collapsed 3+ blank lines into one, so the model wrote fewer bytes.
4. **After `write`/`edit`:** the formatter cleaned up the file automatically, so the model **did not have to regenerate blocks** due to misplaced indentation.

**Result:** 12 messages, 13,932 input tokens, 2,026 output tokens.

---

## Key difference

| Aspect | WITHOUT plugin | WITH plugin |
|---|---|---|
| Repeated reads | Allowed and billed again | Blocked after the first one |
| Trailing spaces / blank lines | Model writes them and pays tokens | Trimmed automatically |
| Misplaced indentation | Model regenerates entire blocks | Formatter fixes it automatically |
| Number of messages | More (back-and-forth over formatting) | Fewer (more direct) |

---

## Bottom line

The plugin did not change what the model **knows how to do**, but it prevented the model from **wasting time and tokens** on mechanical tasks (re-reading, rewriting whitespace, fixing indentation). That is why messages dropped from 31 to 12 and total token consumption dropped by more than half.
