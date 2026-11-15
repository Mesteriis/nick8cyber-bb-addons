// node --test scripts/subagent-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSubagentsEnabled,
  applyDisabled,
  applyRestore,
  writeConfigFileSafely,
} from "../src/subagent-gate.mjs";

test("parse: absent / true / false", () => {
  assert.equal(parseSubagentsEnabled("{}"), null);
  assert.equal(parseSubagentsEnabled('{"subagents_enabled": true}'), true);
  assert.equal(parseSubagentsEnabled('{ "subagents_enabled":false }'), false);
});

test("disable on absent key inserts after the opening brace", () => {
  const out = applyDisabled('{\n  "permissions": {}\n}\n');
  assert.equal(parseSubagentsEnabled(out), false);
  assert.ok(out.includes('"permissions"'), "other keys preserved");
});

test("disable flips true in place (comments survive)", () => {
  const src = '{\n  // user note\n  "subagents_enabled": true,\n  "x": 1\n}\n';
  const out = applyDisabled(src);
  assert.equal(parseSubagentsEnabled(out), false);
  assert.ok(out.includes("// user note"), "JSONC comment preserved");
  assert.ok(out.includes('"x": 1'), "other keys preserved");
});

test("disable is a no-op when already false", () => {
  const src = '{"subagents_enabled": false}';
  assert.equal(applyDisabled(src), src);
});

test("disable on empty file produces a valid minimal config", () => {
  const out = applyDisabled("");
  assert.equal(parseSubagentsEnabled(out), false);
  JSON.parse(out);
});

test("restore with prior=true flips back to true", () => {
  const out = applyRestore('{"subagents_enabled": false, "x": 1}', true);
  assert.equal(parseSubagentsEnabled(out), true);
  assert.ok(out.includes('"x": 1'));
});

test("restore with prior=null removes the inserted key", () => {
  const stamped = applyDisabled('{\n  "permissions": {}\n}\n');
  const back = applyRestore(stamped, null);
  assert.equal(parseSubagentsEnabled(back), null);
  assert.ok(back.includes('"permissions"'));
});

test("roundtrip: insert then restore leaves the other content intact", () => {
  const src = '{\n  "a": 1,\n  "b": {"c": 2}\n}\n';
  const back = applyRestore(applyDisabled(src), null);
  assert.equal(parseSubagentsEnabled(back), null);
  assert.ok(back.includes('"b": {"c": 2}'));
});

test("JSONC with leading comments containing braces // { and /* { } */", () => {
  const src = `// Leading comment with { braces }
/* Multi-line comment
   with { opening and closing } braces */
{
  "theme": "dark"
}
`;
  const out = applyDisabled(src);
  assert.equal(parseSubagentsEnabled(out), false);
  assert.ok(out.includes("// Leading comment with { braces }"));
  assert.ok(out.includes("/* Multi-line comment"));
  assert.ok(out.includes('"theme": "dark"'));

  // Ensure inserted subagents_enabled is inside the JSON object, not in comments
  const lines = out.split("\n");
  const braceLineIdx = lines.findIndex((l) => l.trim() === "{");
  assert.ok(braceLineIdx !== -1);
  assert.ok(lines[braceLineIdx + 1].includes('"subagents_enabled": false,'));
});

test("writeConfigFileSafely: creates new file with 0600 mode and dir with 0700", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-write-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const subDir = join(tmp, "subdir");
  const target = join(subDir, "config.json");

  writeConfigFileSafely(target, '{\n  "subagents_enabled": false\n}\n');

  assert.ok(existsSync(target));
  const content = readFileSync(target, "utf8");
  assert.ok(content.includes('"subagents_enabled": false'));
  const st = statSync(target);
  assert.equal(st.mode & 0o777, 0o600);
  const dirSt = statSync(subDir);
  assert.equal(dirSt.mode & 0o777, 0o700);
});

test("writeConfigFileSafely: preserves existing file permissions (0664 under umask)", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-write-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const target = join(tmp, "config.json");

  writeFileSync(target, '{\n  "existing": true\n}\n', { mode: 0o664 });
  chmodSync(target, 0o664);

  writeConfigFileSafely(target, '{\n  "existing": true,\n  "subagents_enabled": false\n}\n');

  assert.ok(existsSync(target));
  const st = statSync(target);
  assert.equal(st.mode & 0o777, 0o664);
});

test("writeConfigFileSafely: preserves symlink, writes real target, does not chmod existing external dir", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-write-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const externalDir = join(tmp, "external-dir");
  mkdirSync(externalDir, { mode: 0o755 });
  chmodSync(externalDir, 0o755);

  const realFile = join(externalDir, "real-config.json");
  const symlinkFile = join(tmp, "symlink-config.json");

  writeFileSync(realFile, '{\n  "real": true\n}\n', { mode: 0o600 });
  symlinkSync(realFile, symlinkFile);

  assert.ok(lstatSync(symlinkFile).isSymbolicLink());

  writeConfigFileSafely(symlinkFile, '{\n  "real": true,\n  "subagents_enabled": false\n}\n');

  // Verify symlink still exists and points to realFile
  assert.ok(lstatSync(symlinkFile).isSymbolicLink());
  assert.equal(readFileSync(realFile, "utf8"), '{\n  "real": true,\n  "subagents_enabled": false\n}\n');
  assert.equal(readFileSync(symlinkFile, "utf8"), '{\n  "real": true,\n  "subagents_enabled": false\n}\n');
  // External dir permissions should not be altered
  assert.equal(statSync(externalDir).mode & 0o777, 0o755);
});
