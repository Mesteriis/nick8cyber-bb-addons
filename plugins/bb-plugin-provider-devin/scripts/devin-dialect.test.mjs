// node --test scripts/devin-dialect.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const fakeHome = fsSync.mkdtempSync(path.join(tmpdir(), "devin-dialect-"));
const fakeOs = { homedir: () => fakeHome };

after(() => {
  try {
    fsSync.rmSync(fakeHome, { recursive: true, force: true });
  } catch {}
});

const code = readFileSync(new URL("../src/devin-dialect.js", import.meta.url), "utf8");
const delegationPresentation = (args) => ({
  label: { pending: "Running subagent", completed: "Subagent finished" },
  title: args.label,
  ...(args.detail === undefined ? {} : { detail: args.detail }),
});
const {
  devinClassifyToolCall,
  DEVIN_ACP_DIALECT,
  persistDevinBbInstructions,
  isBbSystemNotice,
  applyDevinAcpSessionMode,
  DEVIN_ACP_MODE_BY_PERMISSION_MODE,
  isDevinResourceExhaustedError,
} = new Function(
  "devinFsSync",
  "devinFsPromises",
  "devinOs",
  "devinPath",
  "resolveDevinBin",
  "delegationPresentation",
  `${code}\nreturn { devinClassifyToolCall, DEVIN_ACP_DIALECT, persistDevinBbInstructions, isBbSystemNotice, applyDevinAcpSessionMode, DEVIN_ACP_MODE_BY_PERMISSION_MODE, isDevinResourceExhaustedError };`,
)(fsSync, fsPromises, fakeOs, path, () => "devin", delegationPresentation);

// Реальное событие из bb (<thread> seq 2346), до выключения субагентов.
const backgroundSubagent = {
  sessionUpdate: "tool_call",
  toolCallId: "da222f19db-i1197",
  title: "Ran general subagent Tracker: PLUG-122/124/125",
  status: "pending",
  rawInput: {
    title: "Tracker: PLUG-122/124/125",
    task: "You are a monitoring agent ...",
    profile: "subagent_general",
    is_background: true,
  },
};

test("background subagent -> delegation", () => {
  const r = devinClassifyToolCall(backgroundSubagent);
  assert.deepEqual(r.item, {
    type: "delegation",
    childRef: "da222f19db-i1197",
    label: "Tracker: PLUG-122/124/125",
    background: true,
  });
  assert.equal(r.presentation.detail, "general · в фоне");
});

test("foreground explore subagent -> delegation", () => {
  const r = devinClassifyToolCall({
    ...backgroundSubagent,
    toolCallId: "x1",
    title: "Ran explore subagent Find auth",
    rawInput: { title: "Find auth", task: "find", profile: "subagent_explore", is_background: false },
  });
  assert.equal(r.item.background, false);
  assert.equal(r.item.label, "Find auth");
  assert.equal(r.presentation.detail, "explore");
});

test("read shell / exec / other tools stay generic", () => {
  assert.equal(devinClassifyToolCall({ toolCallId: "a", title: "Read shell", rawInput: { shell_id: "c8", timeout: 30000 } }), undefined);
  assert.equal(devinClassifyToolCall({ toolCallId: "b", title: "Run command", rawInput: { command: "ls" } }), undefined);
  assert.equal(devinClassifyToolCall({ toolCallId: "c", title: "x", rawInput: undefined }), undefined);
  // поле task без профиля и без слова subagent — не субагент
  assert.equal(devinClassifyToolCall({ toolCallId: "d", title: "Todo", rawInput: { task: "write tests" } }), undefined);
});

test("dialect id", () => {
  assert.equal(DEVIN_ACP_DIALECT.id, "devin");
  assert.equal(typeof DEVIN_ACP_DIALECT.classifyToolCall, "function");
});

test("bb instructions persisted per thread, 0600, dir 0700, junk ids ignored", () => {
  persistDevinBbInstructions("thr_abc123", "RULES-TEXT");
  persistDevinBbInstructions("../evil", "X");
  persistDevinBbInstructions("thr_def456", undefined);

  const dir = path.join(fakeHome, ".local", "state", "bb-devin", "instructions");
  const file = path.join(dir, "thr_abc123.md");
  assert.equal(fsSync.readFileSync(file, "utf8"), "RULES-TEXT");
  assert.equal(fsSync.statSync(file).mode & 0o777, 0o600);
  assert.equal(fsSync.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fsSync.readdirSync(dir), ["thr_abc123.md"]);
});

test("persistDevinBbInstructions: nested non-existent BB_DEVIN_STATE_DIR gets 0700 under umask", () => {
  const customStateDir = path.join(fakeHome, "nested-base", "custom-state-dir");
  process.env.BB_DEVIN_STATE_DIR = customStateDir;
  try {
    persistDevinBbInstructions("thr_nested123", "NESTED-INSTRUCTIONS");
    assert.equal(fsSync.statSync(customStateDir).mode & 0o777, 0o700);
    const instructionsDir = path.join(customStateDir, "instructions");
    assert.equal(fsSync.statSync(instructionsDir).mode & 0o777, 0o700);
    const file = path.join(instructionsDir, "thr_nested123.md");
    assert.equal(fsSync.readFileSync(file, "utf8"), "NESTED-INSTRUCTIONS");
    assert.equal(fsSync.statSync(file).mode & 0o777, 0o600);
  } finally {
    delete process.env.BB_DEVIN_STATE_DIR;
  }
});

test("bb system and orchestrator notices are soft, owner and agent messages are not", () => {
  const t = (text) => [{ type: "text", text }];
  assert.equal(isBbSystemNotice(t("[bb system]\n\n@thread:thr_a completed:\n\nok")), true);
  assert.equal(isBbSystemNotice(t("[bb system]\n\n@thread:thr_a is now a child of this thread.")), true);
  assert.equal(isBbSystemNotice(t("[orchestrator]\n\nстатус волны: 2/3")), true);
  assert.equal(isBbSystemNotice(t("[bb message from thread:thr_x]\n\nстоп")), false);
  assert.equal(isBbSystemNotice(t("стоп, не деплой")), false);
  assert.equal(isBbSystemNotice(t("не [orchestrator] в начале")), false);
  assert.equal(isBbSystemNotice([{ type: "image", url: "x" }]), false);
  assert.equal(isBbSystemNotice(undefined), false);
});

const acpModeOption = {
  id: "mode",
  type: "select",
  options: ["accept-edits", "smart", "ask", "plan", "bypass"].map((value) => ({ value })),
};

function fakeAcpConnection(requests, fail, returnUpdatedConfig = false) {
  return {
    request({ method, params }) {
      requests.push({ method, params });
      if (fail) {
        return Promise.reject(new Error("set_config_option rejected"));
      }
      if (returnUpdatedConfig) {
        return Promise.resolve({
          configOptions: [{ id: "mode", type: "select", options: acpModeOption.options, currentValue: params.value }],
        });
      }
      return Promise.resolve(null);
    },
  };
}

function captureStderr(fn) {
  const warnings = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    warnings.push(String(chunk));
    return true;
  };
  return fn().finally(() => {
    process.stderr.write = original;
  }).then((result) => ({ result, warnings }));
}

test("permissionMode maps to ACP session mode (including workspace-write and auto)", async () => {
  for (const [permissionMode, mode] of [
    ["full", "bypass"],
    ["accept-edits", "accept-edits"],
    ["workspace-write", "accept-edits"],
    ["auto", "smart"],
  ]) {
    const requests = [];
    const { warnings } = await captureStderr(() => applyDevinAcpSessionMode({
      connection: fakeAcpConnection(requests, false),
      sessionId: "s1",
      permissionMode,
      configOptions: [acpModeOption],
      agentLabel: "devin",
    }));
    assert.deepEqual(requests, [{
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "mode", value: mode },
    }]);
    assert.deepEqual(warnings, []);
  }
});

test("applyDevinAcpSessionMode updates session.nativeConfig.configOptions if returned", async () => {
  const requests = [];
  const session = { nativeConfig: { configOptions: [acpModeOption] } };
  await applyDevinAcpSessionMode({
    session,
    connection: fakeAcpConnection(requests, false, true),
    sessionId: "s1",
    permissionMode: "full",
    configOptions: [acpModeOption],
    agentLabel: "devin",
  });
  assert.equal(session.nativeConfig.configOptions[0].currentValue, "bypass");
});

test("mode option found by category too", async () => {
  const requests = [];
  await applyDevinAcpSessionMode({
    connection: fakeAcpConnection(requests, false),
    sessionId: "s1",
    permissionMode: "full",
    configOptions: [{ id: "m1", category: "mode", type: "select", options: acpModeOption.options }],
    agentLabel: "devin",
  });
  assert.equal(requests[0].params.configId, "m1");
  assert.equal(requests[0].params.value, "bypass");
});

test("no mode option or missing value -> one warning, no request", async () => {
  for (const configOptions of [
    [],
    [{ id: "mode", type: "select", options: [{ value: "smart" }] }],
    [{ id: "model", category: "model", type: "select", options: [{ value: "bypass" }] }],
  ]) {
    const requests = [];
    const { warnings } = await captureStderr(() => applyDevinAcpSessionMode({
      connection: fakeAcpConnection(requests, false),
      sessionId: "s1",
      permissionMode: "full",
      configOptions,
      agentLabel: "devin",
    }));
    assert.deepEqual(requests, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /does not offer session mode "bypass"/);
  }
});

test("set_config_option error is fail-open: warning, no throw", async () => {
  const requests = [];
  const { warnings } = await captureStderr(() => applyDevinAcpSessionMode({
    connection: fakeAcpConnection(requests, true),
    sessionId: "s1",
    permissionMode: "full",
    configOptions: [acpModeOption],
    agentLabel: "devin",
  }));
  assert.equal(requests.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to set ACP session mode "bypass"/);
});

test("isDevinResourceExhaustedError identifies quota and resource exhausted errors", () => {
  assert.equal(isDevinResourceExhaustedError({ code: -32011, message: "Your daily usage quota has been exhausted. Visit https://app.devin.ai/settings/usage" }), true);
  assert.equal(isDevinResourceExhaustedError({ data: { "cognition.ai/errorKind": "resource_exhausted" } }), true);
  assert.equal(isDevinResourceExhaustedError({ message: "Daily usage quota exhausted" }), true);
  assert.equal(isDevinResourceExhaustedError(new Error("resource_exhausted: out of tokens")), true);
  assert.equal(isDevinResourceExhaustedError({ code: -32603, message: "Internal server error" }), false);
  assert.equal(isDevinResourceExhaustedError(null), false);
  assert.equal(isDevinResourceExhaustedError(undefined), false);
});
