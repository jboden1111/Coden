# AGENTS.md

## Purpose
This folder contains the CODEN system: a Windows-first wrapper around Codex CLI that turns a `.coden` file into a persistent topic conversation with saved instructions, pinned context, rolling summary, and conversation history.

Work in this folder should improve the CODEN system itself without weakening its core design:

- One `.coden` file per topic
- Human-editable files as the source of truth
- Persistent conversation written back into the topic file
- Folder-level shared instructions through `AGENTS.md`
- Windows-friendly launch and file-association behavior
- Practical, production-minded behavior over cleverness

Prefer changes that make the system more reliable, more transparent, and easier to operate manually.

## Repo Contents
Current top-level files:

- [`coden.mjs`](C:\Mine\Coden\coden.mjs): main Node runner that parses `.coden` files, loads shared instructions, builds prompts, shells to `codex exec`, streams output, appends turns, and updates rolling summaries.
- [`coden-open.cmd`](C:\Mine\Coden\coden-open.cmd): launcher used by the `.coden` file association.
- [`coden-setup.bat`](C:\Mine\Coden\coden-setup.bat): Windows file-association installer and Explorer verb registration.
- [`README.txt`](C:\Mine\Coden\README.txt): user-facing setup and usage notes.
- [`Git_push.bat`](C:\Mine\Coden\Git_push.bat): local helper script for manual git push workflow.

Do not assume older topic files, subfolders, or experiments still exist unless they are present in the current tree.

## Runtime Model
Preserve these assumptions unless the user explicitly asks to change them:

1. A `.coden` file is the persistent state store.
2. A topic file is expected to contain:
   - `## Instructions`
   - `## Pinned`
   - `## Summary`
   - `## Conversation`
3. Folder-level `AGENTS.md` is shared context for topics launched from this folder.
4. The runner should re-read live file contents on each turn so manual edits take effect immediately.
5. Startup behavior matters:
   - empty `.coden` files should bootstrap cleanly
   - non-empty `.coden` files should show useful context on load
   - available commands should be visible on load
6. The system is designed for Windows shell users first.
7. The system should remain understandable and editable without hidden state or a database.

Do not move the source of truth out of the `.coden` files unless the user directly asks for that.

## Priorities
Optimize for these outcomes, in this order:

1. Reliability of the persistent-topic workflow
2. Correctness of file parsing and turn persistence
3. Clear Windows launcher behavior
4. Safe prompt construction and context loading
5. Good operator experience in terminal sessions
6. Maintainable code and clear failure modes

If there is a tradeoff between flashy features and robustness, choose robustness.

## Product Principles
- Keep the file format human-readable.
- Avoid hidden magic when a visible file or explicit command would do.
- Prefer stable Codex CLI behavior and documented flags.
- Avoid relying on undocumented event shapes more than necessary.
- Preserve manual recoverability after crashes or partial failures.
- Prefer pragmatic implementation over abstractions that do not pay for themselves.

## Established Intent
These points are already established and should inform future changes:

- Codex should have write access by default within the folder containing the active `.coden` file.
- Startup context matters: shared folder instructions first, then topic instructions, then recent conversation.
- Empty topic files should prompt for minimal instructions and then be initialized into a valid `.coden` structure.
- `AGENTS.md` is the preferred shared instruction filename; `agent.md` is only a fallback if the implementation still supports it.
- The system should work well when launched by double-click or Explorer context menu, not just from a developer terminal.
- The user is comfortable doing some setup manually if given precise instructions.

## Safety Rules
When working in this repo:

- Do not damage or casually rewrite `.coden` conversation history.
- Do not reformat existing `.coden` files in bulk unless asked.
- Do not discard summaries, pinned context, or prior turns.
- Do not silently broaden launcher or sandbox behavior beyond the intended scope.
- Do not remove Windows-specific behavior just to make the code look cleaner.
- Do not assume the current git worktree is clean.
- Do not revert existing user changes unless explicitly requested.

If a fix touches conversation parsing, prompt construction, lock files, sandboxing, or startup behavior, treat it as high risk and verify carefully.

## File Guidance

### `coden.mjs`
This is the center of the system. Be conservative here.

When editing:
- Preserve the simple mental model: load file, parse sections, build prompt, run Codex, append turn, optionally summarize.
- Keep command handling explicit and readable.
- Prefer small helper functions over deep abstraction layers.
- Favor predictable string and regex parsing over parser frameworks.
- Be careful with Windows path handling, quoting, and spaces in filenames.
- Preserve streaming UX unless the user asks otherwise.
- Keep fallback behavior robust when Codex JSON streaming changes or partially fails.

Before changing prompt assembly, think through:
- instruction precedence
- shared folder instructions
- pinned context
- rolling summary
- recent turns
- final user message

Do not accidentally duplicate or omit one of those layers.

### Launchers and setup scripts
Files:
- [`coden-open.cmd`](C:\Mine\Coden\coden-open.cmd)
- [`coden-setup.bat`](C:\Mine\Coden\coden-setup.bat)

When editing:
- Assume filenames may contain spaces.
- Assume the user may move this folder later.
- Prefer path-relative behavior over hardcoded absolute paths where practical.
- Preserve clear error output for double-click users.
- Do not make UAC or elevation behavior more confusing than necessary.

### `.coden` files
Treat `.coden` files as user data and design history, not test fixtures.

You may read them freely for context.
Edit them only when:
- the user is explicitly working inside that topic
- the task is to improve topic content itself
- the system intentionally appends a new turn during normal operation

Otherwise avoid unnecessary edits to topic history files.

## Sandbox Guidance
This repo intentionally shells out to Codex CLI. Changes around sandboxing are sensitive.

When working on sandbox behavior:
- Preserve the user's current intent: normal CODEN use should allow productive work inside the active topic folder.
- Be explicit about where write access applies.
- Keep behavior easy to reason about from the launcher and from `coden.mjs`.
- If adding environment-based overrides, make them obvious and documented.
- Avoid silently broadening access beyond what the user asked for.

If the user asks for broad access, encode it clearly rather than through accidental side effects.

## Testing Expectations
When you change code in this folder, validate proportionally.

Minimum expectations:
- Run a syntax check for `coden.mjs` after edits.
- If launcher behavior changes, inspect the exact command path and quoting.
- If parsing changes, reason through multiline assistant output, missing sections, and end-of-file behavior.
- If startup changes, verify both:
  - empty topic file path
  - existing topic file path

Useful checks include:
- `node --check coden.mjs`
- manual review of prompt-building order
- manual review of `.cmd` and `.bat` quoting

If you cannot fully test an interactive or Explorer-launched path, say so clearly.

## Good Investment Areas
These are good places to invest effort when improving the system:

- parser correctness and resilience
- stale lock handling and recovery
- startup UX and situational visibility
- explicit configuration for sandbox, model, and tail behavior
- safer prompt and context assembly
- better diagnostics for launch failures
- path handling and portability
- documentation that matches actual behavior
- lightweight tests for parsing and command routing

## Anti-Patterns
- Do not introduce a database for state that already lives well in `.coden`.
- Do not split core logic across too many files without a strong reason.
- Do not replace readable control flow with over-engineered abstractions.
- Do not optimize for framework elegance over double-click usability.
- Do not assume a non-Windows environment.
- Do not treat topic history as disposable logs.

## Working Style
When helping in this repo:

- Read the relevant `.coden` topic first if the request touches an established area and the file exists.
- Use the repo's own conversation history and current code to infer intent before inventing new policy.
- Prefer implementing the fix over merely describing it, unless the user asks for instructions only.
- Keep user-facing explanations direct and concrete.
- Surface real risks and uncertainty plainly.

## Fast Context
Start here when you need orientation:

1. Read [`coden.mjs`](C:\Mine\Coden\coden.mjs)
2. Read [`README.txt`](C:\Mine\Coden\README.txt)
3. Read the active `.coden` topic file if one exists and is relevant

## Scope
This `AGENTS.md` governs the root folder `C:\Mine\Coden`.

Important consequence:
- It applies to files in this folder.
- It applies to `.coden` topics launched from this folder.
- If future subfolders need different behavior, add a more specific `AGENTS.md` there.
