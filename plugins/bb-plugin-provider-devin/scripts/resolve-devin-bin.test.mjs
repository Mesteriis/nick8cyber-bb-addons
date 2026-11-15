// node --test scripts/resolve-devin-bin.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDevinBin, KNOWN_BAD_VERSIONS } from "../src/resolve-devin-bin.mjs";

function createExecFile(filePath, content = "#!/bin/sh\nexit 0\n") {
  writeFileSync(filePath, content, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

test("1. priority of BB_DEVIN_BIN", (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "devin-bin-test-"));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const customBin = join(fakeHome, "my-devin");
  createExecFile(customBin);

  const res = resolveDevinBin({
    env: { BB_DEVIN_BIN: customBin },
    homeDir: fakeHome,
    usrLocalBin: null,
  });
  assert.equal(res, customBin);

  // When BB_DEVIN_BIN is a symlink, return un-dereferenced path as is (no realpathSync)
  const symlinkBin = join(fakeHome, "my-devin-link");
  symlinkSync(customBin, symlinkBin);
  const resSymlink = resolveDevinBin({
    env: { BB_DEVIN_BIN: symlinkBin },
    homeDir: fakeHome,
    usrLocalBin: null,
  });
  assert.equal(resSymlink, symlinkBin);
});

test("2. priority of healthy symlink ~/.local/bin/devin over newer _versions", (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "devin-bin-test-"));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const localBinDir = join(fakeHome, ".local", "bin");
  const versionsDir = join(fakeHome, ".local", "share", "devin", "cli", "_versions");
  mkdirSync(localBinDir, { recursive: true });
  mkdirSync(join(versionsDir, "3000.11.0", "bin"), { recursive: true });
  mkdirSync(join(versionsDir, "3000.13.0", "bin"), { recursive: true });

  const olderBin = join(versionsDir, "3000.11.0", "bin", "devin");
  const newerBin = join(versionsDir, "3000.13.0", "bin", "devin");
  createExecFile(olderBin);
  createExecFile(newerBin);

  // User manually symlinks ~/.local/bin/devin -> older healthy version 3000.11.0
  const symlinkPath = join(localBinDir, "devin");
  symlinkSync(olderBin, symlinkPath);

  const res = resolveDevinBin({
    env: {},
    homeDir: fakeHome,
    usrLocalBin: null,
  });
  // Must return the user's active symlink path, not newer 3000.13.0 from _versions
  assert.equal(res, symlinkPath);
});

test("3. skipping symlink pointing to 3000.12.57 and selecting newest healthy in _versions", (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "devin-bin-test-"));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const localBinDir = join(fakeHome, ".local", "bin");
  const versionsDir = join(fakeHome, ".local", "share", "devin", "cli", "_versions");
  const usrLibDir = join(fakeHome, "usr", "lib", "devin", "3000.12.57", "bin");
  mkdirSync(localBinDir, { recursive: true });
  mkdirSync(usrLibDir, { recursive: true });
  mkdirSync(join(versionsDir, "3000.12.57", "bin"), { recursive: true });
  mkdirSync(join(versionsDir, "3000.12.50", "bin"), { recursive: true });
  mkdirSync(join(versionsDir, "3000.12.55", "bin"), { recursive: true });

  const badBin = join(versionsDir, "3000.12.57", "bin", "devin");
  const badUsrBin = join(usrLibDir, "devin");
  const goodBin50 = join(versionsDir, "3000.12.50", "bin", "devin");
  const goodBin55 = join(versionsDir, "3000.12.55", "bin", "devin");
  createExecFile(badBin);
  createExecFile(badUsrBin);
  createExecFile(goodBin50);
  createExecFile(goodBin55);

  const symlinkPath = join(localBinDir, "devin");
  symlinkSync(badBin, symlinkPath);

  const usrLocalSymlink = join(fakeHome, "usr-devin");
  symlinkSync(badUsrBin, usrLocalSymlink);

  const res = resolveDevinBin({
    env: {},
    homeDir: fakeHome,
    usrLocalBin: usrLocalSymlink,
  });
  // 3000.12.57 is rejected from both candidates, highest healthy in _versions is 3000.12.55
  assert.equal(res, goodBin55);
});

test("4. ignoring symlink current, _download, _update.lock, and empty binaries", (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "devin-bin-test-"));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const versionsDir = join(fakeHome, ".local", "share", "devin", "cli", "_versions");
  mkdirSync(join(versionsDir, "3000.10.0", "bin"), { recursive: true });
  mkdirSync(join(versionsDir, "3000.11.0", "bin"), { recursive: true });
  mkdirSync(join(versionsDir, "_download"), { recursive: true });

  // Symlink current -> 3000.11.0 (must be ignored as directory candidate)
  symlinkSync(join(versionsDir, "3000.11.0"), join(versionsDir, "current"));

  // File _update.lock
  writeFileSync(join(versionsDir, "_update.lock"), "lock");

  // Empty binary in 3000.11.0
  const emptyBin = join(versionsDir, "3000.11.0", "bin", "devin");
  writeFileSync(emptyBin, "");
  chmodSync(emptyBin, 0o755);

  // Good binary in 3000.10.0
  const goodBin = join(versionsDir, "3000.10.0", "bin", "devin");
  createExecFile(goodBin);

  const res = resolveDevinBin({
    env: {},
    homeDir: fakeHome,
    usrLocalBin: null,
  });
  assert.equal(res, goodBin);
});

test("5. extreme fallback to rejected candidate if no healthy versions exist", (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "devin-bin-test-"));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const localBinDir = join(fakeHome, ".local", "bin");
  const versionsDir = join(fakeHome, ".local", "share", "devin", "cli", "_versions");
  mkdirSync(localBinDir, { recursive: true });
  mkdirSync(join(versionsDir, "3000.12.57", "bin"), { recursive: true });

  const badBin = join(versionsDir, "3000.12.57", "bin", "devin");
  createExecFile(badBin);

  const symlinkPath = join(localBinDir, "devin");
  symlinkSync(badBin, symlinkPath);

  const warnings = [];
  const originalStderr = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    const res = resolveDevinBin({
      env: {},
      homeDir: fakeHome,
      usrLocalBin: null,
    });
    assert.equal(res, symlinkPath);
    assert.ok(warnings.some((w) => w.includes("matches known bad version")));
  } finally {
    process.stderr.write = originalStderr;
  }
});
