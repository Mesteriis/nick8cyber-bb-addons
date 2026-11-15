import { accessSync, constants, lstatSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KNOWN_BAD_VERSIONS = ["3000.12.57"];

function isExecutableFile(path) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function extractVersionFromPath(resolvedPath) {
  const parts = resolvedPath.split(/[/\\]/);
  for (const part of parts) {
    if (/^\d+\.\d+\.\d+$/.test(part)) {
      return part;
    }
  }
  return null;
}

function parseSemver(v) {
  return v.split(".").map((n) => Number.parseInt(n, 10));
}

function compareSemverDesc(a, b) {
  const [ma, na, pa] = parseSemver(a);
  const [mb, nb, pb] = parseSemver(b);
  if (ma !== mb) return mb - ma;
  if (na !== nb) return nb - na;
  return pb - pa;
}

export function resolveDevinBin(options = {}) {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const usrLocalBin = options.usrLocalBin !== undefined ? options.usrLocalBin : (env.BB_DEVIN_USR_LOCAL_BIN !== undefined ? (env.BB_DEVIN_USR_LOCAL_BIN || null) : "/usr/local/bin/devin");

  let badVersions = KNOWN_BAD_VERSIONS;
  if (typeof env.BB_DEVIN_KNOWN_BAD_VERSIONS === "string") {
    const val = env.BB_DEVIN_KNOWN_BAD_VERSIONS.trim();
    badVersions = val === "" ? [] : val.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // 1. Explicit pin via BB_DEVIN_BIN
  const pin = env.BB_DEVIN_BIN;
  if (typeof pin === "string" && pin.trim().length > 0) {
    const trimmed = pin.trim();
    if (isExecutableFile(trimmed)) {
      return trimmed;
    }
  }

  // 2. Active user binary (~/.local/bin/devin, then /usr/local/bin/devin)
  const activeCandidates = [
    join(home, ".local", "bin", "devin"),
  ];
  if (usrLocalBin) {
    activeCandidates.push(usrLocalBin);
  }

  let rejectedCandidate = null;

  for (const candidate of activeCandidates) {
    if (!isExecutableFile(candidate)) {
      continue;
    }
    let realPath = candidate;
    try {
      realPath = realpathSync(candidate);
    } catch {}

    const version = extractVersionFromPath(realPath);
    if (version !== null && badVersions.includes(version)) {
      if (rejectedCandidate === null) {
        rejectedCandidate = candidate;
      }
      continue;
    }
    return candidate;
  }

  // 3. Automatic rollback in ~/.local/share/devin/cli/_versions/<ver>/bin/devin
  const versionsDir = join(home, ".local", "share", "devin", "cli", "_versions");
  try {
    const entries = readdirSync(versionsDir);
    const validVersions = [];

    for (const entry of entries) {
      if (!/^\d+\.\d+\.\d+$/.test(entry)) {
        continue;
      }
      if (badVersions.includes(entry)) {
        continue;
      }
      const entryPath = join(versionsDir, entry);
      try {
        const lst = lstatSync(entryPath);
        if (!lst.isDirectory() || lst.isSymbolicLink()) {
          continue;
        }
      } catch {
        continue;
      }

      const binPath = join(entryPath, "bin", "devin");
      if (isExecutableFile(binPath)) {
        validVersions.push(entry);
      }
    }

    if (validVersions.length > 0) {
      validVersions.sort(compareSemverDesc);
      return join(versionsDir, validVersions[0], "bin", "devin");
    }
  } catch {}

  // 4. Extreme fallback
  if (rejectedCandidate !== null) {
    process.stderr.write(
      `devin: warning: active binary "${rejectedCandidate}" matches known bad version; no healthy fallback found in _versions\n`
    );
    return rejectedCandidate;
  }

  return "devin";
}
