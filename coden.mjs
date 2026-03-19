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
 *   :help, :exit, :summary, :tail N, :model NAME, :reload, :open, :fork, :export, :file
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const DEFAULTS = {
  codexBin: process.platform === "win32" ? "codex.cmd" : "codex",
  sandbox: "workspace-write",
  bypassSandboxWhenAdmin: true,
  tailTurns: 24,
  autoSummarize: true,
  summarizeEveryTurns: 12,
  minTurnsBetweenLargeFileSummaries: 4,
  maxFileBytesBeforeSummarize: 250_000,
};

const EXIT_COMMANDS = new Set([":q", ":quit", ":exit"]);
const REQUIRED_SECTIONS = ["Instructions", "Pinned", "Summary", "Conversation"];
const SUMMARY_META_RE = /^<!--\s*CODEN-SUMMARY-META\s+(\{.*\})\s*-->\s*\n?/i;

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

function readLockInfo(lock) {
  const text = safeRead(lock).trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}

  const [pidLine = "", stampLine = ""] = text.split(/\r?\n/);
  return {
    pid: Number(pidLine) || null,
    stamp: stampLine || "",
    host: "",
    user: "",
  };
}

function writeLockInfo(lock) {
  const info = {
    pid: process.pid,
    stamp: nowStamp(),
    host: os.hostname(),
    user: getRunningUser(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(lock, JSON.stringify(info, null, 2) + "\n", { flag: "wx" });
  return info;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && (e.code === "EPERM" || e.code === "EACCES")) return true;
    return false;
  }
}

function acquireLock(lock) {
  try {
    writeLockInfo(lock);
    return { ok: true, recovered: false, previous: null };
  } catch (e) {
    if (!e || e.code !== "EEXIST") {
      return { ok: false, recovered: false, previous: null, error: e };
    }
  }

  const existing = readLockInfo(lock);
  const sameHost = existing?.host && existing.host.toLowerCase() === os.hostname().toLowerCase();
  const alive = sameHost && isProcessAlive(existing?.pid);
  if (sameHost && !alive) {
    try {
      fs.unlinkSync(lock);
      writeLockInfo(lock);
      return { ok: true, recovered: true, previous: existing };
    } catch (e) {
      return { ok: false, recovered: false, previous: existing, error: e };
    }
  }

  return { ok: false, recovered: false, previous: existing, error: null };
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

function getTopLevelHeadings(fileText) {
  const normalized = fileText.replace(/\r\n/g, "\n");
  const headingRe = /^##\s+([^\n]+)\s*$/gm;
  const headings = [];
  let m;
  while ((m = headingRe.exec(normalized))) {
    headings.push({
      name: (m[1] || "").trim(),
      index: m.index,
    });
  }
  return headings;
}

function inspectTopicStructure(fileText) {
  const headings = getTopLevelHeadings(fileText);
  const counts = new Map();
  for (const heading of headings) {
    const key = heading.name.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const missingSections = REQUIRED_SECTIONS.filter((name) => !counts.has(name.toLowerCase()));
  const duplicateSections = REQUIRED_SECTIONS.filter((name) => (counts.get(name.toLowerCase()) || 0) > 1);
  const unexpectedSections = headings
    .map((heading) => heading.name)
    .filter((name) => !REQUIRED_SECTIONS.some((expected) => expected.toLowerCase() === name.toLowerCase()));

  return {
    missingSections,
    duplicateSections,
    unexpectedSections,
    headings,
  };
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
    const stamp = (m[1] || "").trim();
    const body = (m[2] || "");
    const { user, assistant } = extractTurn(body);
    if (user || assistant) blocks.push({ stamp, user, assistant });
  }

  // Fallback if markers were missing
  if (blocks.length === 0) {
    const parts = conversationText.split(/^USER:\s*/m).slice(1);
    for (const p of parts) {
      const [u, ...rest] = p.split(/^ASSISTANT:\s*/m);
      blocks.push({ stamp: "", user: (u ?? "").trim(), assistant: rest.join("ASSISTANT: ").trim() });
    }
  }

  // Keep stamped conversation blocks in chronological order even if older files
  // were written with the newest turn at the top.
  const stampedCount = blocks.filter((b) => b.stamp).length;
  if (stampedCount === blocks.length && blocks.length > 1) {
    blocks.sort((a, b) => a.stamp.localeCompare(b.stamp));
  }
  return blocks;
}

function parseSummaryBody(summaryBody) {
  const normalized = (summaryBody || "").replace(/\r\n/g, "\n");
  const match = normalized.match(SUMMARY_META_RE);
  if (!match) {
    return {
      meta: { turnCount: 0, updatedAt: "" },
      text: normalized.trim(),
    };
  }

  let meta = { turnCount: 0, updatedAt: "" };
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && typeof parsed === "object") {
      meta = {
        turnCount: Number(parsed.turnCount) || 0,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    }
  } catch {}

  return {
    meta,
    text: normalized.slice(match[0].length).trim(),
  };
}

function serializeSummaryBody(summaryText, meta) {
  const normalizedMeta = {
    turnCount: Number(meta?.turnCount) || 0,
    updatedAt: typeof meta?.updatedAt === "string" ? meta.updatedAt : "",
  };
  const cleanText = (summaryText || "").trim();
  const metaLine = `<!-- CODEN-SUMMARY-META ${JSON.stringify(normalizedMeta)} -->`;
  return cleanText ? `${metaLine}\n${cleanText}\n` : `${metaLine}\n`;
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

function buildTemplateInstructionsBlock(instructions) {
  const cleanInstructions = (instructions || "").trim();
  if (cleanInstructions) return cleanInstructions;

  return [
    "Goal:",
    "- State the exact objective of this topic.",
    "- Say what you want Codex to help you produce or decide.",
    "",
    "Deliverable:",
    "- Define what a successful result looks like.",
    "- Mention whether you want code changes, analysis, review, documentation, or instructions only.",
    "",
    "Working style:",
    "- Be concrete and implementation-focused.",
    "- Prefer changes that fit this repo's current structure and Windows-first workflow.",
    "- Call out risks before changing parsing, prompt assembly, launcher behavior, lock handling, or sandbox behavior.",
    "",
    "Out of scope:",
    "- List anything this topic should avoid doing or changing.",
  ].join("\n");
}

function buildMissingSectionBody(sectionName) {
  switch (sectionName) {
    case "Instructions":
      return buildTemplateInstructionsBlock("");
    case "Pinned":
      return [
        "- Relevant files: coden.mjs, coden-open.cmd, coden-setup.bat, README.txt",
        "- Stable facts: This topic lives in the CODEN system folder and should follow the shared AGENTS.md guidance.",
        "- Constraints: Keep `.coden` files human-editable and treat them as the source of truth for this topic.",
        "- Preferences: Add any durable user preferences, paths, environment facts, or naming conventions here.",
      ].join("\n");
    case "Summary":
      return "";
    case "Conversation":
      return "";
    default:
      return "";
  }
}

function buildSectionBlock(sectionName) {
  const body = buildMissingSectionBody(sectionName);
  return body ? `## ${sectionName}\n${body}\n` : `## ${sectionName}\n`;
}

function ensureBaseStructure(filePath) {
  const existing = safeRead(filePath);
  if (!existing.trim()) return existing;

  const inspection = inspectTopicStructure(existing);
  if (!inspection.missingSections.length) return existing;

  const addition = inspection.missingSections
    .map((sectionName) => buildSectionBlock(sectionName))
    .join("\n");
  const merged = `${existing.trimEnd()}\n\n${addition.trimEnd()}\n`;
  atomicWrite(filePath, merged);
  return merged;
}

function buildCodenTemplate({ title, instructions }) {
  return (
`# CODEN v1
# title: ${title}

## Instructions
${buildTemplateInstructionsBlock(instructions)}

## Pinned
- Relevant files: coden.mjs, coden-open.cmd, coden-setup.bat, README.txt
- Stable facts: This topic lives in the CODEN system folder and should follow the shared AGENTS.md guidance.
- Constraints: Keep \`.coden\` files human-editable and treat them as the source of truth for this topic.
- Preferences: Add any durable user preferences, paths, environment facts, or naming conventions here.

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

function isRunningAsAdmin() {
  if (process.platform !== "win32") return false;
  try {
    const out = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); " +
        "$principal = New-Object Security.Principal.WindowsPrincipal($identity); " +
        "[Console]::Out.Write($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      }
    );

    if (out.status !== 0) return false;
    return (out.stdout || "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

function getRunningUser() {
  if (process.platform === "win32") {
    const domain = process.env.USERDOMAIN || "";
    const user = process.env.USERNAME || "";
    if (domain && user) return `${domain}\\${user}`;
    if (user) return user;
  }

  return process.env.USER || process.env.LOGNAME || "(unknown)";
}

function getSandboxMode() {
  if (isRunningAsAdmin()) {
    // return "danger-full-access";
    return "workspace-write";
  }
  return DEFAULTS.sandbox;
}

function shouldBypassSandbox() {
  return isRunningAsAdmin() && DEFAULTS.bypassSandboxWhenAdmin;
}

function getEffectiveSandboxLabel() {
  return shouldBypassSandbox()
    ? "dangerously-bypass-approvals-and-sandbox"
    : getSandboxMode();
}

function listDirectoryFiles(workdir) {
  return fs.readdirSync(workdir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function resolveFileSelection(files, token, selectedIndex) {
  if (!token) {
    return Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < files.length
      ? selectedIndex
      : -1;
  }

  const index = Number(token);
  if (!Number.isInteger(index) || index < 1 || index > files.length) return -1;
  return index - 1;
}

function showFileList(workdir, selectedIndex) {
  const files = listDirectoryFiles(workdir);
  if (!files.length) {
    console.log("No files found in the current directory.\n");
    return files;
  }

  console.log("Files in current directory:");
  files.forEach((name, idx) => {
    const marker = idx === selectedIndex ? "*" : " ";
    console.log(` ${marker} ${idx + 1}. ${name}`);
  });
  console.log("");
  return files;
}

function showStartupSnapshot({ fileText, sharedInstructions = "", maxTurns = 5, inspection = null }) {
  const effectiveInspection = inspection || inspectTopicStructure(fileText);
  const instructions = parseSection(fileText, "Instructions");
  const pinned = parseSection(fileText, "Pinned");
  const summary = parseSummaryBody(parseSection(fileText, "Summary")).text;
  const conversation = parseSection(fileText, "Conversation");
  const turns = parseTurns(conversation);
  const recent = turns.slice(-maxTurns);

  console.log("Loaded existing topic context:");
  console.log(`- Folder instructions: ${compactSingleLine(sharedInstructions, 260)}`);
  console.log(`- Topic instructions: ${compactSingleLine(instructions, 260)}`);
  console.log(`- Pinned context: ${compactSingleLine(pinned, 260)}`);
  console.log(`- Rolling summary: ${compactSingleLine(summary, 260)}`);
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

  if (effectiveInspection.missingSections.length || effectiveInspection.duplicateSections.length || effectiveInspection.unexpectedSections.length) {
    console.log("Structure warnings:");
    if (effectiveInspection.missingSections.length) {
      console.log(`- Missing sections were added at the end: ${effectiveInspection.missingSections.join(", ")}`);
    }
    if (effectiveInspection.duplicateSections.length) {
      console.log(`- Duplicate required sections detected: ${effectiveInspection.duplicateSections.join(", ")}`);
    }
    if (effectiveInspection.unexpectedSections.length) {
      console.log(`- Unexpected top-level ## headings detected: ${effectiveInspection.unexpectedSections.join(", ")}`);
      console.log("  These can break parsing if they were intended to be nested inside a section body.");
    }
  }
}

function replaceSection(fileText, sectionName, newBody) {
  const normalized = fileText.replace(/\r\n/g, "\n");
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `^##\\s+${escapedName}\\s*$([\\s\\S]*?)(?=^##\\s+|$)`,
    "m"
  );

  if (!sectionRe.test(normalized)) return normalized;
  return normalized.replace(sectionRe, `## ${sectionName}\n\n${newBody}`);
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

  const conversation = parseSection(text, "Conversation");
  const nextConversation = conversation.trim()
    ? `${conversation.trimEnd()}\n\n${block.trimEnd()}\n`
    : `${block.trimEnd()}\n`;
  const nextText = replaceSection(text, "Conversation", nextConversation).replace(/\n{3,}/g, "\n\n");
  atomicWrite(codenPath, nextText);
}

function upsertSummary(codenPath, newSummary, meta = {}) {
  let text = ensureBaseStructure(codenPath);
  const nextSummaryBody = serializeSummaryBody(newSummary, meta);

  if (!/^##\s+Summary\s*$/m.test(text)) {
    if (/^##\s+Conversation\s*$/m.test(text)) {
      text = text.replace(/^##\s+Conversation\s*$/m, `## Summary\n\n${nextSummaryBody.trimEnd()}\n\n## Conversation`);
    } else {
      text = text.trim() + `\n\n## Summary\n\n${nextSummaryBody.trimEnd()}\n`;
    }
    atomicWrite(codenPath, text);
    return;
  }

  text = replaceSection(text, "Summary", nextSummaryBody);
  atomicWrite(codenPath, text);
}

async function runCodexOnce({ workdir, prompt, modelOverride, codexBin, stream }) {
  const outFile = path.join(os.tmpdir(), `coden_last_${crypto.randomBytes(8).toString("hex")}.txt`);
  const sandboxMode = getSandboxMode();

  const args = [
    "exec",
    "--cd", workdir,
    "--skip-git-repo-check",
    "--color", "never",
    "--output-last-message", outFile,
  ];

  if (shouldBypassSandbox()) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", sandboxMode);
  }

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
  const priorSummary = parseSummaryBody(parsed.summary);
  const turnsSinceLastSummary = Math.max(0, turnCount - (priorSummary.meta.turnCount || 0));
  const should =
    force ||
    (DEFAULTS.autoSummarize &&
      (
        turnsSinceLastSummary >= DEFAULTS.summarizeEveryTurns ||
        (stats.size >= DEFAULTS.maxFileBytesBeforeSummarize &&
          turnsSinceLastSummary >= DEFAULTS.minTurnsBetweenLargeFileSummaries)
      ));

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
    priorSummary.text || "(none)",
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
    upsertSummary(codenPath, newSummary, { turnCount, updatedAt: nowStamp() });
    return newSummary;
  }
  return null;
}

function buildLockMessage(lockPath, lockState) {
  const info = lockState?.previous;
  const lines = [
    "",
    `This topic is already open (lock exists):`,
    `  ${lockPath}`,
  ];

  if (info) {
    if (info.pid) lines.push(`Lock PID: ${info.pid}`);
    if (info.user) lines.push(`Lock user: ${info.user}`);
    if (info.host) lines.push(`Lock host: ${info.host}`);
    if (info.stamp) lines.push(`Lock created: ${info.stamp}`);
  }

  lines.push("");
  lines.push("If you are sure no session is running, delete the .lock file and try again.");
  return lines.join("\n");
}

function buildForkPath(workdir, title) {
  for (let i = 1; i < 1000; i += 1) {
    const suffix = i === 1 ? " (fork)" : ` (fork ${i})`;
    const candidate = path.join(workdir, `${title}${suffix}.coden`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  return path.join(workdir, `${title} (fork ${Date.now()}).coden`);
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

  const lockState = acquireLock(lockPath);
  if (!lockState.ok) {
    if (lockState.error) {
      console.error(`\nFailed to create topic lock:\n  ${lockPath}\n`);
      console.error(lockState.error?.message ?? lockState.error);
      process.exit(2);
    }
    console.error(buildLockMessage(lockPath, lockState));
    process.exit(2);
  }

  const rl = readline.createInterface({ input, output });

  // session config that can change at runtime
  const session = {
    codexBin: DEFAULTS.codexBin,
    model: null,
    tailTurns: DEFAULTS.tailTurns,
    lastAssistant: "",
    selectedFileIndex: -1,
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
  :file               List files in the current directory
  :file N             Select file N from the list
  :file open [N]      Open the selected file or file N
  :file path [N]      Print the full path of the selected file or file N
`.trim() + "\n");
  };

  try {
    const wasInitialized = await initializeEmptyTopicIfNeeded({ filePath: absPath, title, rl });
    const fileInspectionOnLoad = inspectTopicStructure(safeRead(absPath));
    const fileTextOnLoad = ensureBaseStructure(absPath);
    const startupShared = loadSharedAgentInstructions(workdir);

    console.log("====================================");
    console.log(`CODEN Topic: ${title}`);
    console.log(`File: ${absPath}`);
    console.log(`Launcher user: ${getRunningUser()}`);
    console.log(`Launcher admin: ${isRunningAsAdmin() ? "yes" : "no"}`);
    console.log(`Codex sandbox: ${getEffectiveSandboxLabel()}`);
    if (shouldBypassSandbox()) {
      console.log("Warning: admin launch bypasses Codex approvals and sandbox for this session.");
    }
    if (lockState.recovered && lockState.previous) {
      console.log(`Recovered stale lock from PID ${lockState.previous.pid ?? "(unknown)"}.`);
    }
    if (startupShared.text) {
      console.log(`Shared instructions: ${path.basename(startupShared.path)}`);
    } else {
      console.log("Shared instructions: (none found)");
    }
    console.log("Available commands:");
    showHelp();
    console.log("====================================\n");

    if (!wasInitialized) {
      showStartupSnapshot({
        fileText: fileTextOnLoad,
        sharedInstructions: startupShared.text,
        inspection: fileInspectionOnLoad,
      });
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

      if (low === ":file" || low.startsWith(":file ")) {
        const parts = msg.split(/\s+/);
        const action = (parts[1] || "").toLowerCase();
        const files = listDirectoryFiles(workdir);

        if (low === ":file") {
          showFileList(workdir, session.selectedFileIndex);
          continue;
        }

        if (action === "open" || action === "path") {
          const targetIndex = resolveFileSelection(files, parts[2], session.selectedFileIndex);
          if (targetIndex === -1) {
            console.log("Select a file first with :file N, or provide a valid file number.\n");
            continue;
          }

          const targetPath = path.join(workdir, files[targetIndex]);
          session.selectedFileIndex = targetIndex;

          if (action === "path") {
            console.log(`${targetPath}\n`);
            continue;
          }

          spawn("cmd", ["/c", "start", "", targetPath], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
          console.log(`Opened: ${files[targetIndex]}\n`);
          continue;
        }

        const targetIndex = resolveFileSelection(files, parts[1], session.selectedFileIndex);
        if (targetIndex === -1) {
          console.log("Usage: :file, :file N, :file open [N], :file path [N]\n");
          continue;
        }

        session.selectedFileIndex = targetIndex;
        console.log(`Selected file: ${files[targetIndex]}\n`);
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
        const forkPath = buildForkPath(workdir, title);
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
      const summary = parseSummaryBody(parseSection(fileText, "Summary")).text;
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

        // Re-read after persistence so summaries reflect the current on-disk state.
        const updatedFileText = ensureBaseStructure(absPath);
        const parsedForSummary = {
          summary: parseSection(updatedFileText, "Summary"),
          turns: parseTurns(parseSection(updatedFileText, "Conversation")),
        };
        await summarizeIfNeeded({
          codenPath: absPath,
          title,
          parsed: parsedForSummary,
          workdir,
          codexBin: session.codexBin,
          modelOverride: session.model,
          turnCount: parsedForSummary.turns.length,
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
