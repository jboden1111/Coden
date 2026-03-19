CODEN Topic Files (.coden) - Windows launcher for persistent Codex topics

What this folder is for
- CODEN lets one `.coden` file act as one persistent topic.
- Each topic file stores its own instructions, pinned context, rolling summary, and conversation history.
- Opening a `.coden` file starts an interactive terminal session and writes future turns back into that same file.

Keep this file
- Keep `README.txt` as human-facing setup and usage documentation.
- Keep `AGENTS.md` as folder-level instructions for Codex when it works in this folder.
- They serve different purposes and should not be merged.

Files in this folder
- `coden.mjs`          Main Node runner
- `coden-open.cmd`     File association launcher for `.coden`
- `coden-setup.bat`    Windows file-association installer
- `coden_template.coden`  Starter template for new topics
- `AGENTS.md`          Shared folder-level instructions for Codex

What CODEN does
- Loads the `.coden` file as the source of truth
- Reads `AGENTS.md` from the same folder as shared context
- Shows startup context for existing topics
- Prompts for minimal instructions when a `.coden` file is empty
- Streams Codex output in the terminal
- Appends each new turn into `## Conversation`
- Refreshes the rolling summary when requested or when auto-summary triggers

Requirements
- Windows
- Node.js 18+ available in PATH
- Codex CLI installed and available in PATH

Install / register `.coden`
1. Put these files in one folder, for example:
   `C:\Mine\Coden`
2. Run `coden-setup.bat` as Administrator.
3. Double-click a `.coden` file to open it with CODEN.
4. Right-click a `.coden` file and choose `Run Coden as administrator` if you need an elevated launch.

Manual registration
If you prefer to set the association manually in an elevated command prompt:

`assoc .coden=CodenFile`

`ftype CodenFile="C:\Mine\Coden\coden-open.cmd" "%1"`

To remove the association:

`assoc .coden=`

`ftype CodenFile=`

Creating a new topic
- Create an empty `.coden` file and open it. CODEN will prompt for minimal instructions and build the required sections.
- Or copy `coden_template.coden` and rename it for the topic you want.

Recommended `.coden` structure

# CODEN v1
# title: Example Topic

## Instructions
Goal:
- State the exact objective of this topic.

Deliverable:
- Define what a successful result looks like.

Working style:
- Note any topic-specific preferences.

Out of scope:
- List anything this topic should avoid doing.

## Pinned
- Stable facts, paths, names, constraints, and preferences that should persist across turns.

## Summary
- Rolling summary maintained over time.

## Conversation

Important format rule
- Do not add extra `##` headings inside section bodies.
- CODEN uses `## Section Name` as top-level boundaries, so nested `##` headings inside `Instructions`, `Pinned`, or `Summary` can break parsing.
- Use plain labels like `Goal:` and bullet lists inside sections instead.

Commands
- `:help`               Show commands
- `:exit` / `:quit` / `:q`  Exit the session
- `:summary`            Force a rolling summary refresh
- `:tail N`             Set how many recent turns are sent
- `:model NAME`         Override model for this session
- `:reload`             No-op reminder; file reload is automatic each turn
- `:open`               Open the current `.coden` file in Notepad
- `:fork`               Duplicate the topic file next to it
- `:export`             Save the last assistant reply to `<topic>.last.txt`
- `:file`               List files in the current directory
- `:file N`             Select file N from the list
- `:file open [N]`      Open the selected file or file N
- `:file path [N]`      Print the full path of the selected file or file N

Notes
- Default sandbox behavior is workspace write access in the topic folder.
- Each open topic creates a sibling `.lock` file until the session exits.
- Topic files are meant to stay human-editable.
- `AGENTS.md` should hold folder-level operating guidance, not topic-specific conversation state.
