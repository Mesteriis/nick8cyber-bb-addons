/**
 * subagent-gate — apply bb's central "Disable provider subagents" decision to
 * Devin by managing `subagents_enabled` in the Devin user config.
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const KEY_RE = /"subagents_enabled"\s*:\s*(true|false)/;

function stripComments(text) {
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;
  let result = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
        result += ch;
      } else {
        result += " ";
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        i++;
      } else {
        result += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      i++;
      continue;
    }

    result += ch;
  }
  return result;
}

export function findRootBraceIndex(text) {
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "{") {
      return i;
    }
  }

  return -1;
}

/** @returns {boolean | null} current value, null when the key is absent. */
export function parseSubagentsEnabled(text) {
  if (typeof text !== "string") return null;
  const stripped = stripComments(text);
  const m = KEY_RE.exec(stripped);
  if (m === null) return null;
  return m[1] === "true";
}

/** Return config text with `subagents_enabled: false` applied. */
export function applyDisabled(text) {
  const prior = parseSubagentsEnabled(text);
  if (prior === false) return text;
  if (prior === true) {
    const stripped = stripComments(text);
    const m = KEY_RE.exec(stripped);
    if (m) {
      const start = m.index;
      const end = start + m[0].length;
      return text.slice(0, start) + '"subagents_enabled": false' + text.slice(end);
    }
  }

  const braceIdx = findRootBraceIndex(text);
  if (braceIdx === -1) {
    return '{\n  "subagents_enabled": false\n}\n';
  }
  return text.slice(0, braceIdx + 1) + '\n  "subagents_enabled": false,' + text.slice(braceIdx + 1);
}

/**
 * Undo a stamp we made. `prior` is the value recorded before stamping:
 * `true` → flip the value back; `null` → remove the key we inserted.
 */
export function applyRestore(text, prior) {
  if (prior === true) {
    const stripped = stripComments(text);
    const m = KEY_RE.exec(stripped);
    if (m) {
      const start = m.index;
      const end = start + m[0].length;
      return text.slice(0, start) + '"subagents_enabled": true' + text.slice(end);
    }
    return text;
  }
  let next = text.replace(/"subagents_enabled"\s*:\s*false\s*,\s*\n?\s*/, "");
  if (next === text) next = text.replace(/,(\s*\n?\s*)"subagents_enabled"\s*:\s*false/, "");
  if (next === text) next = text.replace(/"subagents_enabled"\s*:\s*false\s*\n?\s*/, "");
  return next;
}

/**
 * Atomic, symlink-safe, permission-preserving file write.
 */
export function writeConfigFileSafely(targetPath, content) {
  const targetDir = dirname(targetPath);
  const targetDirExisted = existsSync(targetDir);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  if (!targetDirExisted) {
    try {
      chmodSync(targetDir, 0o700);
    } catch {}
  }

  let realTarget = targetPath;
  let mode = 0o600;

  try {
    if (existsSync(targetPath)) {
      realTarget = realpathSync(targetPath);
      const st = statSync(realTarget);
      mode = st.mode & 0o777;
    }
  } catch {}

  const realDir = dirname(realTarget);
  const realDirExisted = existsSync(realDir);
  mkdirSync(realDir, { recursive: true, mode: 0o700 });
  if (!realDirExisted) {
    try {
      chmodSync(realDir, 0o700);
    } catch {}
  }

  const tmpFile = join(
    realDir,
    `${basename(realTarget)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );

  try {
    writeFileSync(tmpFile, content, { mode });
    try {
      chmodSync(tmpFile, mode);
    } catch {}
    renameSync(tmpFile, realTarget);
  } catch (err) {
    try {
      rmSync(tmpFile, { force: true });
    } catch {}
    throw err;
  }
}
