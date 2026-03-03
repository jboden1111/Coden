CODEN Topic Files (.coden) — Double-click to start a terminal session

This package installs:
  C:\Mine\Coden\coden.mjs         Node wrapper that runs Codex CLI in a loop
  C:\Mine\Coden\coden-open.cmd    File association target for .coden
  C:\Mine\Coden\coden-open.bat    Same as .cmd (optional)

What it does
- Each .coden file is plain text: instructions + pinned context + optional rolling summary + conversation log.
- Double-click a .coden file -> terminal opens -> you type follow-up questions until you type :exit.
- It shows the assistant response in the terminal (streamed) and appends the turn back into the same .coden file.

Prereqs
- Windows
- Node.js 18+ installed (node in PATH)
- OpenAI Codex CLI installed (codex in PATH)

Install steps
1) Create folder:
   C:\Mine\Coden

2) Copy these files into C:\Mine\Coden:
   - coden.mjs
   - coden-open.cmd (and/or coden-open.bat)

3) Associate .coden extension with the launcher (Admin Command Prompt):
   assoc .coden=CodenFile
   ftype CodenFile="C:\Mine\Coden\coden-open.cmd" "%1"

   To remove the association:
   assoc .coden=
   ftype CodenFile=

Create your first topic file
- Make a file anywhere, e.g.
    Race handicapping.coden

- Put this template inside (optional; script will add it if missing):

# CODEN v1
# title: Race handicapping

## Instructions
You are my horse-racing handicapping assistant.

## Pinned
- I like pace + Prime Power style reasoning.
- Medium odds ~ 6/1.

## Summary
- (optional)

## Conversation

Commands in the terminal
  :help               Show commands
  :exit / :quit / :q  Exit the session
  :summary            Force a rolling summary refresh
  :tail N             Set how many recent turns are sent (4..200)
  :model NAME         Override model for this session (e.g. :model o3)
  :open               Open the .coden in Notepad
  :fork               Duplicate the topic file next to it
  :export             Save last assistant reply to <topic>.last.txt

Notes / Tips
- The script uses: codex exec --json --output-last-message ...
  It streams deltas for live display and still writes the final message for reliable saving.
- Shared folder instructions: put `AGENTS.md` in the same folder as your `.coden` files.
  The runner loads it on each turn for all topics in that folder (fallback: `agent.md`).
- Default sandbox is `workspace-write` (scoped to the topic folder via `--cd`).
- Lock files: each running topic creates <topic>.coden.lock until you exit.
