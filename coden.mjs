#!/usr/bin/env node
/**
 * CODEN topic runner (Windows-friendly)
 * - One .coden file = one topic (instructions + pinned + rolling summary + conversation log)
 * - Loops prompting for follow-ups until :exit
 * - Uses Codex CLI as the model runner via `codex exec`
 *
 * Requirements:
 * - Node 18+
 * - Codex CLI installed and available as `codex` in PATH
 *
 * Design choices:
 * - Stream output live using `--json` events (best UX)
 * - Capture the final assistant message via `--output-last-message` (robust)
 * - Keep your topic file as the source of truth (summary + tail turns)
 *
 * Commands:
 *   :help, :exit, :summary, :tail N, :model NAME, :reload, :open, :fork, :export
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const DEFAULTS = {
  codexBin: process.platform === "win32" ? "codex.cmd" : "codex",
  sandbox: "workspace-write",
  tailTurns: 24,
  autoSummarize: true,
  summarizeEveryTurns: 12,
  maxFileBytesBeforeSummarize: 250_000,
};

const EXIT_COMMANDS = new Set([":q", ":quit", ":exit"]);

function nowStamp() {
  // Local time stamp
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function safeRead(p) {
  try { return fs.readFileSync(p, "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return "";
    throw e;
  }
}

function atomicWrite(p, text) {
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.${path.basename(p)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
}

function ensureLock(lock) {
  try {
    fs.writeFileSync(lock, `${process.pid}\n${nowStamp()}\n`, { flag: "wx" });
    return true;
  } catch { return false; }
}

function releaseLock(lock) {
  try { fs.unlinkSync(lock); } catch {}
}

function parseSection(fileText, sectionName) {
  // Returns text between "## <sectionName>" and the next "## <...>" heading.
  const normalized = fileText.replace(/\r\n/g, "\n");
  const headingRe = /^##\s+([^\n]+)\s*$/gm;
  let m;
  let captureStart = -1;

  while ((m = headingRe.exec(normalized))) {
    const name = (m[1] || "").trim();
    if (captureStart >= 0) {
      return normalized.slice(captureStart, m.index).trim();
    }
    if (name.toLowerCase() === sectionName.toLowerCase()) {
      captureStart = headingRe.lastIndex;
    }
  }

  return captureStart >= 0 ? normalized.slice(captureStart).trim() : "";
}

function parseTurns(conversationText) {
  if (!conversationText) return [];
  const blocks = [];
  const re = /^===\s+(.+?)\s+START\s+===\s*$([\s\S]*?)^===\s+\1\s+END\s+===\s*$/gm;
  let m;

  const extractTurn = (body) => {
    const normalized = (body || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) return { user: "", assistant: "" };

    const userTag = "USER:";
    const assistantTag = "\nASSISTANT:";

    const userStart = normalized.indexOf(userTag);
    if (userStart === -1) {
      const assistantStart = normalized.indexOf("ASSISTANT:");
      if (assistantStart === -1) return { user: "", assistant: "" };
      return {
        user: "",
        assistant: normalized.slice(assistantStart + "ASSISTANT:".length).trim(),
      };
    }

    const rest = normalized.slice(userStart + userTag.length);
    const assistantOffset = rest.indexOf(assistantTag);

    if (assistantOffset === -1) {
      return { user: rest.trim(), assistant: "" };
    }

    return {
      user: rest.slice(0, assistantOffset).trim(),
      assistant: rest.slice(assistantOffset + assistantTag.length).trim(),
    };
  };

  while ((m = re.exec(conversationText))) {
    const body = (m[2] || "");
    const { user, assistant } = extractTurn(body);
    if (user || assistant) blocks.push({ user, assistant });
  }

  // Fallback if markers were missing
  if (blocks.length === 0) {
    const parts = conversationText.split(/^USER:\s*/m).slice(1);
    for (const p of parts) {
      const [u, ...rest] = p.split(/^ASSISTANT:\s*/m);
      blocks.push({ user: (u ?? "").trim(), assistant: rest.join("ASSISTANT: ").trim() });
    }
  }
  return blocks;
}

function loadSharedAgentInstructions(workdir) {
  // Prefer Codex-style shared instructions filename, with a fallback.
  const candidates = ["AGENTS.md", "agents.md", "agent.md", "AGENT.md"];
  for (const name of candidates) {
    const p = path.join(workdir, name);
    const text = safeRead(p).trim();
    if (text) return { path: p, text };
  }
  return { path: "", text: "" };
}

function buildPrompt({ title, sharedInstructions, instructions, pinned, summary, turnsTail, userMessage }) {
  const lines = [];
  lines.push(`You are continuing a persistent topic chat stored in a .coden text file.`);
  lines.push(`Topic title: ${title}`);
  lines.push(``);
  if (sharedInstructions?.trim()) {
    lines.push(`=== Shared folder instructions (AGENTS.md) ===`);
    lines.push(sharedInstructions.trim());
    lines.push(``);
  }
  lines.push(`=== Instructions (highest priority) ===`);
  lines.push((instructions || "(none)").trim());
  lines.push(``);
  if (pinned?.trim()) {
    lines.push(`=== Pinned context ===`);
    lines.push(pinned.trim());
    lines.push(``);
  }
  if (summary?.trim()) {
    lines.push(`=== Rolling summary of earlier conversation ===`);
    lines.push(summary.trim());
    lines.push(``);
  }
  if (turnsTail.length) {
    lines.push(`=== Recent conversation (most recent last) ===`);
    for (const t of turnsTail) {
      if (t.user) lines.push(`USER: ${t.user}`);
      if (t.assistant) lines.push(`ASSISTANT: ${t.assistant}`);
      lines.push(``);
    }
  }
  lines.push(`=== New message ===`);
  lines.push(`USER: ${userMessage}`);
  lines.push(``);
  lines.push(`Respond as ASSISTANT only. Do not include "USER:" in your response.`);
  return lines.join("\n");
}

function ensureBaseStructure(filePath) {
  const existing = safeRead(filePath);
  if (/^##\s+Conversation\s*$/m.test(existing)) return existing;

  const title = path.basename(filePath, path.extname(filePath));
  const template =
`# CODEN v1
# title: ${title}

## Instructions
(put stable instructions here)

## Pinned
(put stable facts/context here)

## Summary
(optional rolling summary)

## Conversation
`;
  const merged = (existing.trim() ? existing.trim() + "\n\n" : "") + template;
  atomicWrite(filePath, merged);
  return merged;
}

function buildCodenTemplate({ title, instructions }) {
  const cleanInstructions = (instructions || "").trim();
  return (
`# CODEN v1
# title: ${title}

## Instructions
${cleanInstructions || "Use this .coden file as the persistent source of truth for this topic conversation."}

## Pinned

## Summary

## Conversation
`
  );
}

function compactSingleLine(text, maxLen = 200) {
  const oneLine = (text || "").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  if (!oneLine) return "(none)";
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 3) + "..." : oneLine;
}

function showStartupSnapshot({ fileText, sharedInstructions = "", maxTurns = 5 }) {
  const instructions = parseSection(fileText, "Instructions");
  const conversation = parseSection(fileText, "Conversation");
  const turns = parseTurns(conversation);
  const recent = turns.slice(-maxTurns);

  console.log("Loaded existing topic context:");
  console.log(`- Folder instructions: ${compactSingleLine(sharedInstructions, 260)}`);
  console.log(`- Topic instructions: ${compactSingleLine(instructions, 260)}`);
  console.log(`- Recent conversation (${recent.length}/${turns.length} turns):`);

  if (!recent.length) {
    console.log("  (no conversation turns yet)");
  } else {
    for (const t of recent) {
      if (t.user) console.log(`  USER: ${compactSingleLine(t.user, 180)}`);
      if (t.assistant) console.log(`  ASSISTANT: ${compactSingleLine(t.assistant, 180)}`);
      console.log("");
    }
  }
}

async function initializeEmptyTopicIfNeeded({ filePath, title, rl }) {
  const existing = safeRead(filePath);
  if (existing.trim().length > 0) return false;

  console.log("This .coden file is empty.");
  const instructions = (await rl.question("Minimal instructions for this topic> ")).trim();
  const template = buildCodenTemplate({ title, instructions });
  atomicWrite(filePath, template);
  console.log("Initialized topic sections in the file.\n");
  return true;
}

function appendTurnToFile(codenPath, userMessage, assistantMessage) {
  const text = ensureBaseStructure(codenPath);
  const stamp = nowStamp();
  const block =
`=== ${stamp} START ===
USER: ${userMessage}

ASSISTANT:
${assistantMessage.trim()}

=== ${stamp} END ===

`;
  atomicWrite(codenPath, text + block);
}

function upsertSummary(codenPath, newSummary) {
  let text = ensureBaseStructure(codenPath);

  if (!/^##\s+Summary\s*$/m.test(text)) {
    if (/^##\s+Conversation\s*$/m.test(text)) {
      text = text.replace(/^##\s+Conversation\s*$/m, `## Summary\n\n${newSummary.trim()}\n\n## Conversation`);
    } else {
      text = text.trim() + `\n\n## Summary\n\n${newSummary.trim()}\n`;
    }
    atomicWrite(codenPath, text);
    return;
  }

  text = text.replace(
    /^##\s+Summary\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/m,
    `## Summary\n\n${newSummary.trim()}\n\n`
  );
  atomicWrite(codenPath, text);
}

async function runCodexOnce({ workdir, prompt, modelOverride, codexBin, stream }) {
  const outFile = path.join(os.tmpdir(), `coden_last_${crypto.randomBytes(8).toString("hex")}.txt`);

  const args = [
    "exec",
    "--cd", workdir,
    "--skip-git-repo-check",
    "--sandbox", DEFAULTS.sandbox,
    "--color", "never",
    "--output-last-message", outFile,
  ];

  if (stream) args.push("--json");
  if (modelOverride) args.push("--model", modelOverride);

  // Read prompt from stdin
  args.push("-");

  return await new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: workdir,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: false,
      // On Windows, npm-installed CLIs are often .cmd shims and need shell dispatch.
      shell: process.platform === "win32",
    });

    child.stdin.write(prompt, "utf8");
    child.stdin.end();

    let streamedAny = false;
    let jsonBuffer = "";

    const handleJsonLine = (line) => {
      if (!line) return;
      try {
        const evt = JSON.parse(line);

        // Try a few likely shapes; if none match, ignore.
        const delta =
          (evt && typeof evt.delta === "string" ? evt.delta : null) ||
          (evt && evt.type === "assistant_message_delta" && typeof evt.delta === "string" ? evt.delta : null) ||
          (evt && evt.type === "message_delta" && typeof evt.text === "string" ? evt.text : null) ||
          (evt && evt.type === "response.output_text.delta" && typeof evt.delta === "string" ? evt.delta : null) ||
          null;

        if (delta) {
          streamedAny = true;
          process.stdout.write(delta);
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    child.stdout.on("data", (chunk) => {
      if (!stream) return;
      jsonBuffer += chunk.toString("utf8");
      const lines = jsonBuffer.split(/\r?\n/);
      jsonBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleJsonLine(line);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      let finalMsg = "";
      try {
        finalMsg = fs.readFileSync(outFile, "utf8");
      } catch {
        // If output-last-message failed, use a fallback
        finalMsg = "";
      }
      try { fs.unlinkSync(outFile); } catch {}

      if (code !== 0) {
        return reject(new Error(`codex exec exited with code ${code}.`));
      }

      // Fallback: if JSON deltas were not parsed, still show assistant text in terminal.
      if (stream && !streamedAny && finalMsg.trim()) {
        process.stdout.write(finalMsg.trim() + "\n");
      }

      // If we streamed, the terminal already showed output; still return final message for persistence.
      resolve(finalMsg.trim());
    });
  });
}

async function summarizeIfNeeded({ codenPath, title, parsed, workdir, codexBin, modelOverride, turnCount, force }) {
  const stats = fs.statSync(codenPath);
  const should =
    force ||
    (DEFAULTS.autoSummarize &&
      (turnCount % DEFAULTS.summarizeEveryTurns === 0 || stats.size >= DEFAULTS.maxFileBytesBeforeSummarize));

  if (!should) return null;

  const turnsTail = parsed.turns.slice(-DEFAULTS.tailTurns);

  const summaryPrompt = [
    `You are updating the rolling summary for a persistent topic chat stored in a .coden file.`,
    `Topic: ${title}`,
    ``,
    `Update the rolling summary to reflect the current state. Keep it compact, factual, and useful for continuing later.`,
    `Use bullet points. Include: user preferences, ongoing threads, key decisions, and stable facts.`,
    ``,
    `=== Existing summary (may be empty) ===`,
    parsed.summary?.trim() || "(none)",
    ``,
    `=== Recent conversation (most recent last) ===`,
    ...turnsTail.flatMap(t => [
      t.user ? `USER: ${t.user}` : "",
      t.assistant ? `ASSISTANT: ${t.assistant}` : "",
      ""
    ]).filter(Boolean),
    `Return ONLY the new summary bullets (no headings).`,
  ].join("\n");

  const newSummary = await runCodexOnce({
    workdir,
    prompt: summaryPrompt,
    modelOverride,
    codexBin,
    stream: false,
  });

  if (newSummary) {
    upsertSummary(codenPath, newSummary);
    return newSummary;
  }
  return null;
}

async function main() {
  const codenPathArg = process.argv[2];
  if (!codenPathArg) {
    console.error("Usage: node coden.mjs <file.coden>");
    process.exit(1);
  }

  const absPath = path.resolve(codenPathArg);
  const workdir = path.dirname(absPath);
  const title = path.basename(absPath, path.extname(absPath));
  const lockPath = absPath + ".lock";

  if (!ensureLock(lockPath)) {
    console.error(`\nThis topic is already open (lock exists):\n  ${lockPath}\n`);
    console.error("If you are sure no session is running, delete the .lock file and try again.");
    process.exit(2);
  }

  const rl = readline.createInterface({ input, output });

  // session config that can change at runtime
  const session = {
    codexBin: DEFAULTS.codexBin,
    model: null,
    tailTurns: DEFAULTS.tailTurns,
    lastAssistant: "",
  };

  const showHelp = () => {
    console.log(`
Commands:
  :help               Show this help
  :exit / :quit / :q  Exit the session
  :summary            Force a rolling summary refresh
  :tail N             Set how many recent turns are sent (4..200)
  :model NAME         Override model for this session (e.g. :model o3)
  :reload             Re-read the .coden file next turn (default behavior)
  :open               Open the .coden in Notepad
  :fork               Duplicate topic file next to it
  :export             Save last assistant reply to <topic>.last.txt
`.trim() + "\n");
  };

  try {
    const wasInitialized = await initializeEmptyTopicIfNeeded({ filePath: absPath, title, rl });
    const fileTextOnLoad = ensureBaseStructure(absPath);
    const startupShared = loadSharedAgentInstructions(workdir);

    console.log("====================================");
    console.log(`CODEN Topic: ${title}`);
    console.log(`File: ${absPath}`);
    if (startupShared.text) {
      console.log(`Shared instructions: ${path.basename(startupShared.path)}`);
    } else {
      console.log("Shared instructions: (none found)");
    }
    console.log("Available commands:");
    showHelp();
    console.log("====================================\n");

    if (!wasInitialized) {
      showStartupSnapshot({ fileText: fileTextOnLoad, sharedInstructions: startupShared.text });
      console.log("");
    }

    while (true) {
      const raw = await rl.question("You> ");
      const msg = raw.trim();
      if (!msg) continue;

      const low = msg.toLowerCase();

      if (EXIT_COMMANDS.has(low)) {
        console.log("\nBye.\n");
        break;
      }

      if (low === ":help" || low === ":h") {
        showHelp();
        continue;
      }

      if (low.startsWith(":tail ")) {
        const n = Number(msg.slice(6).trim());
        if (Number.isFinite(n) && n >= 4 && n <= 200) {
          session.tailTurns = Math.floor(n);
          console.log(`OK. tailTurns=${session.tailTurns}\n`);
        } else {
          console.log("tail must be a number between 4 and 200.\n");
        }
        continue;
      }

      if (low.startsWith(":model ")) {
        const m = msg.slice(7).trim();
        session.model = m || null;
        console.log(`OK. model=${session.model ?? "(default)"}\n`);
        continue;
      }

      if (low === ":open") {
        spawn("notepad", [absPath], { detached: true, stdio: "ignore" }).unref();
        continue;
      }

      if (low === ":reload") {
        console.log("Reload is automatic on every turn; no action needed.\n");
        continue;
      }

      if (low === ":summary") {
        const fileText = ensureBaseStructure(absPath);
        const currentSummary = parseSection(fileText, "Summary");
        const conversation = parseSection(fileText, "Conversation");
        const turns = parseTurns(conversation);
        await summarizeIfNeeded({
          codenPath: absPath,
          title,
          parsed: { summary: currentSummary, turns },
          workdir,
          codexBin: session.codexBin,
          modelOverride: session.model,
          turnCount: turns.length,
          force: true,
        });
        console.log("(Summary updated.)\n");
        continue;
      }

      if (low === ":fork") {
        const forkPath = path.join(workdir, `${title} (fork).coden`);
        fs.copyFileSync(absPath, forkPath);
        console.log(`Forked to: ${forkPath}\n`);
        continue;
      }

      if (low === ":export") {
        const outPath = path.join(workdir, `${title}.last.txt`);
        fs.writeFileSync(outPath, session.lastAssistant || "", "utf8");
        console.log(`Exported to: ${outPath}\n`);
        continue;
      }

      // Parse current file state each turn (so edits take effect immediately)
      const fileText = ensureBaseStructure(absPath);
      const instructions = parseSection(fileText, "Instructions");
      const pinned = parseSection(fileText, "Pinned");
      const summary = parseSection(fileText, "Summary");
      const conversation = parseSection(fileText, "Conversation");
      const shared = loadSharedAgentInstructions(workdir);
      const turns = parseTurns(conversation);

      const turnsTail = turns.slice(-session.tailTurns);
      const prompt = buildPrompt({
        title,
        sharedInstructions: shared.text,
        instructions,
        pinned,
        summary,
        turnsTail,
        userMessage: msg,
      });

      console.log("\nASSISTANT>\n");

      try {
        // Stream live while generating
        const assistant = await runCodexOnce({
          workdir,
          prompt,
          modelOverride: session.model,
          codexBin: session.codexBin,
          stream: true,
        });

        session.lastAssistant = assistant;

        // If streaming already printed deltas, ensure we end with a newline
        process.stdout.write("\n\n");

        appendTurnToFile(absPath, msg, assistant);

        // Auto summary update
        const parsedForSummary = { summary, turns };
        const totalTurns = turns.length + 1; // after append
        await summarizeIfNeeded({
          codenPath: absPath,
          title,
          parsed: parsedForSummary,
          workdir,
          codexBin: session.codexBin,
          modelOverride: session.model,
          turnCount: totalTurns,
          force: false,
        });
      } catch (e) {
        process.stdout.write("\n");
        console.error("Turn failed:", e?.message ?? e);
        console.error("Check that Codex CLI is installed and available in PATH.\n");
        continue;
      }
    }
  } catch (e) {
    console.error("\nERROR:", e?.message ?? e);
  } finally {
    rl.close();
    releaseLock(lockPath);
  }
}

main();
