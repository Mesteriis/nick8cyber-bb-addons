import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";

import {
  parseResetTimeMs,
  classifyFailure,
  loadBackends,
  withStateLock,
  MODELS,
} from "../acp-server.mjs";

const require = createRequire(import.meta.url);
const driver = require("../src/gemini-driver.js");
const {
  selectModelAndThinking,
  ModelUnavailable,
  RESET_REGEX_EXTENDED,
} = driver;

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("1. Syntax and hygiene checks across plugin files", () => {
  function getFiles(dir) {
    const res = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        res.push(...getFiles(full));
      } else {
        res.push(full);
      }
    }
    return res;
  }

  const allFiles = getFiles(PLUGIN_ROOT);
  const jsFiles = allFiles.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));

  for (const jsFile of jsFiles) {
    assert.doesNotThrow(() => {
      execSync(`node --check "${jsFile}"`, { stdio: "pipe" });
    }, `Syntax error in ${path.relative(PLUGIN_ROOT, jsFile)}`);
  }

  // Check forbidden substrings in all files (dynamically constructed to avoid self-match)
  const forbiddenSubstrings = ["/" + "home/", "t" + "hr_", "p" + "roj_", "e" + "nv_"];
  for (const file of allFiles) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const sub of forbiddenSubstrings) {
      assert.equal(
        content.includes(sub),
        false,
        `File ${path.relative(PLUGIN_ROOT, file)} contains forbidden substring "${sub}"`
      );
    }

    // Check for real personal email addresses (allow example.com, @get-bb, @zahed)
    const emails = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    for (const em of emails) {
      assert.match(
        em,
        /@(?:example\.com|example\.org|users\.noreply\.github\.com)$/,
        `File ${path.relative(PLUGIN_ROOT, file)} contains non-example email: ${em}`
      );
    }
  }
});

test("2. parseResetTimeMs parses English and Russian quota reset formats", () => {
  const baseNow = new Date("2026-11-16T00:00:00.000Z").getTime();

  // English 12h
  const t1 = parseResetTimeMs("Limit resets 2:19 AM", baseNow);
  assert.ok(t1 !== null);
  const d1 = new Date(t1 - 2 * 60_000);
  assert.equal(d1.getHours(), 2);
  assert.equal(d1.getMinutes(), 19);

  // English with Month & Date
  const t2 = parseResetTimeMs("Limit resets Oct 15, 2:19 AM", baseNow);
  assert.ok(t2 !== null);
  const d2 = new Date(t2 - 2 * 60_000);
  assert.equal(d2.getMonth(), 9); // Oct is 9
  assert.equal(d2.getDate(), 15);
  assert.equal(d2.getHours(), 2);
  assert.equal(d2.getMinutes(), 19);

  // English with tomorrow
  const t3 = parseResetTimeMs("Limit resets tomorrow at 11:00 AM", baseNow);
  assert.ok(t3 !== null);
  const d3 = new Date(t3 - 2 * 60_000);
  assert.equal(d3.getHours(), 11);
  assert.equal(d3.getMinutes(), 0);

  // Russian format
  const t4 = parseResetTimeMs("Лимит обновится в 14:30", baseNow);
  assert.ok(t4 !== null);
  const d4 = new Date(t4 - 2 * 60_000);
  assert.equal(d4.getHours(), 14);
  assert.equal(d4.getMinutes(), 30);

  // Russian format with tomorrow
  const t5 = parseResetTimeMs("Лимит сбросится завтра в 09:15", baseNow);
  assert.ok(t5 !== null);
  const d5 = new Date(t5 - 2 * 60_000);
  assert.equal(d5.getHours(), 9);
  assert.equal(d5.getMinutes(), 15);

  // Unrelated string
  assert.equal(parseResetTimeMs("Everything is normal"), null);
});

test("3. classifyFailure correctly classifies errors", () => {
  // rate-limit from limit reset message
  const c1 = classifyFailure(new Error("Limit resets 2:19 AM"));
  assert.equal(c1.category, "rate-limit");
  assert.equal(c1.rotatable, true);
  assert.ok(c1.cooldownMs > 0);

  // rate-limit from thinking level
  const c2 = classifyFailure(new Error("Thinking level is rate-limited"));
  assert.equal(c2.category, "rate-limit");
  assert.equal(c2.rotatable, true);

  // model-unavailable
  const c3 = classifyFailure(new Error("model is unavailable"));
  assert.equal(c3.category, "model-unavailable");
  assert.equal(c3.rotatable, true);
  assert.equal(c3.cooldownMs, 6 * 3600_000);

  // transient stream timeout (540s and 900s caps)
  const c4 = classifyFailure(new Error("generation still running after 540s cap — answer truncated"));
  assert.equal(c4.category, "transient");
  assert.equal(c4.rotatable, true);
  assert.equal(c4.cooldownMs, 0);

  const c4b = classifyFailure(new Error("generation still running after 900s cap — answer truncated"));
  assert.equal(c4b.category, "transient");
  assert.equal(c4b.rotatable, true);
  assert.equal(c4b.cooldownMs, 0);

  // auth-dead
  const c5 = classifyFailure(new Error("not logged in"));
  assert.equal(c5.category, "auth-dead");
  assert.equal(c5.rotatable, true);
  assert.equal(c5.cooldownMs, 7 * 24 * 3600_000);
});

test("4. gemini-driver strict selectModelAndThinking and no fallback", async () => {
  // Source check: no responses[responses.length - 1] fallback
  const driverSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "src/gemini-driver.js"), "utf8");
  assert.equal(
    driverSrc.includes("responses[responses.length - 1]"),
    false,
    "gemini-driver.js must not fallback to responses[responses.length - 1]"
  );
  assert.ok(
    driverSrc.includes("const target = responses[idx];"),
    "gemini-driver.js must use responses[idx]"
  );
  assert.ok(
    driverSrc.includes("const last = responses[idx];"),
    "gemini-driver.js must check hasFinishedContent with responses[idx]"
  );

  // Mock page for selectModelAndThinking
  const mockPage = {
    $: async (sel) => {
      if (sel.includes("thinking_level")) {
        return {
          hover: async () => {},
          getAttribute: async (attr) => (attr === "aria-expanded" ? "true" : "sub1"),
          click: async () => {},
        };
      }
      return null;
    },
    $$: async () => {
      return [
        {
          innerText: async () => "Thinking\nLimit resets 2:19 AM",
          evaluate: async () => true, // isDisabled = true
          click: async () => {},
        },
      ];
    },
    waitForSelector: async () => ({
      innerText: async () => "Fast",
      getAttribute: async () => "Fast",
      click: async () => {},
    }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };

  await assert.rejects(
    async () => {
      await selectModelAndThinking(mockPage, null, "thinking", true);
    },
    (err) => {
      assert.ok(err instanceof ModelUnavailable);
      assert.match(err.message, /thinking level is rate-limited/i);
      return true;
    }
  );
});

test("5. Full JSON-RPC cycle of acp-server.mjs in ARGON_FAKE=1 mode with lease retention and selective cancel", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argon-test-state-"));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "fake-acc-1",
          email: "fake1@example.com",
          profileDir: path.join(tmpDir, "p1"),
          cdpPort: 9222,
          priority: 10,
        },
      ],
    })
  );

  const serverProc = spawn("node", ["acp-server.mjs"], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ARGON_FAKE: "1",
      ARGON_FAKE_DELAY_MS: "300",
      ARGON_STATE_DIR: tmpDir,
      ARGON_POOL_FILE: poolFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  serverProc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) {
        try {
          lines.push(JSON.parse(line.trim()));
        } catch {}
      }
    }
  });

  function sendReq(req) {
    serverProc.stdin.write(JSON.stringify(req) + "\n");
  }

  async function waitForResponse(id, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.id === id);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for response id=${id}`);
  }

  async function waitForNotification(method, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.method === method);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for notification ${method}`);
  }

  // 1. initialize
  sendReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const r1 = await waitForResponse(1);
  assert.equal(r1.result.agentInfo.name, "argon-gemini");
  assert.equal(r1.result.agentInfo.version, "0.2.0");

  // 2. session/new
  sendReq({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
  const r2 = await waitForResponse(2);
  const sessionId = r2.result.sessionId;
  assert.ok(sessionId.startsWith("argon-"));
  assert.ok(r2.result.models.availableModels.includes("argon"));
  assert.ok(r2.result.models.availableModels.includes("pro"));

  // 3. session/set_model
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/set_model",
    params: { sessionId, modelId: "argon" },
  });
  const r3 = await waitForResponse(3);
  assert.ok(r3.result.configOptions);

  // 4. session/set_config_option
  sendReq({
    jsonrpc: "2.0",
    id: 4,
    method: "session/set_config_option",
    params: { sessionId, configId: "thought_level", value: "high" },
  });
  const r4 = await waitForResponse(4);
  assert.ok(r4.result.configOptions);

  // 5. session/prompt (streaming with lease retention check during execution)
  sendReq({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Hello from test suite" }],
    },
  });

  const update = await waitForNotification("session/update");
  assert.equal(update.params.sessionId, sessionId);
  assert.ok(
    update.params.update?.content?.text?.includes("FAKE_ARGON_ECHO") ||
    update.params.update?.text?.includes("FAKE_ARGON_ECHO")
  );

  // Verify lease is actively held while execution is delayed
  const statePath = path.join(tmpDir, "accounts-state.json");
  assert.ok(fs.existsSync(statePath), "accounts-state.json must exist during execution");
  const stDuring = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(stDuring.leases && stDuring.leases["fake-acc-1"], "Lease must be held during prompt execution");
  assert.equal(stDuring.leases["fake-acc-1"].pid, serverProc.pid);

  const r5 = await waitForResponse(5);
  assert.equal(r5.result.stopReason, "end_turn");

  // Verify lease released after prompt completes
  const stAfter = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(stAfter.leases || {}, {}, "Lease must be released after completion");

  // 6. Selective cancel: cancelling a different session ID does NOT cancel the running prompt
  sendReq({
    jsonrpc: "2.0",
    id: 6,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Prompt to test selective cancel" }],
    },
  });
  await waitForNotification("session/update");

  // Send cancel for a non-matching session
  sendReq({
    jsonrpc: "2.0",
    id: 7,
    method: "session/cancel",
    params: { sessionId: "non-existent-session" },
  });
  const r7 = await waitForResponse(7);
  assert.equal(r7.result.stopReason, "cancelled");

  // Prompt 6 must complete normally with end_turn because non-matching cancel was ignored
  const r6 = await waitForResponse(6);
  assert.equal(r6.result.stopReason, "end_turn");

  // 7. Matching session/cancel returns stopReason: "cancelled"
  sendReq({
    jsonrpc: "2.0",
    id: 8,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Prompt to be cancelled" }],
    },
  });
  await waitForNotification("session/update");

  sendReq({
    jsonrpc: "2.0",
    id: 9,
    method: "session/cancel",
    params: { sessionId },
  });
  const r9 = await waitForResponse(9);
  assert.equal(r9.result.stopReason, "cancelled");

  const r8 = await waitForResponse(8);
  assert.equal(r8.result.stopReason, "cancelled");

  const stCancel = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(stCancel.leases || {}, {}, "Leases must be empty after cancel");

  // 8. Close stdin and verify clean exit
  serverProc.stdin.end();
  await new Promise((resolve) => serverProc.on("exit", resolve));

  if (fs.existsSync(statePath)) {
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(st.leases || {}, {}, "Leases must be empty after server exit");
  }

  // Cleanup tmpDir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("6. Automatic lease release upon SIGTERM during prompt execution", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argon-term-test-"));
  const poolFile = path.join(tmpDir, "pool.json");
  fs.writeFileSync(
    poolFile,
    JSON.stringify({
      accounts: [
        {
          id: "fake-acc-term",
          email: "term@example.com",
          profileDir: path.join(tmpDir, "p1"),
          cdpPort: 9222,
          priority: 10,
        },
      ],
    })
  );

  const serverProc = spawn("node", ["acp-server.mjs"], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ARGON_FAKE: "1",
      ARGON_FAKE_DELAY_MS: "1200",
      ARGON_STATE_DIR: tmpDir,
      ARGON_POOL_FILE: poolFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  serverProc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) {
        try {
          lines.push(JSON.parse(line.trim()));
        } catch {}
      }
    }
  });

  function sendReq(req) {
    serverProc.stdin.write(JSON.stringify(req) + "\n");
  }

  async function waitForNotification(method, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = lines.findIndex((l) => l.method === method);
      if (idx >= 0) {
        return lines.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for notification ${method}`);
  }

  sendReq({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  sendReq({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/tmp" },
  });
  sendReq({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId: "argon-1",
      prompt: [{ type: "text", text: "Long turn before term" }],
    },
  });

  // Wait until prompt starts and emits chunk
  await waitForNotification("session/update");

  // Verify lease is held
  const statePath = path.join(tmpDir, "accounts-state.json");
  assert.ok(fs.existsSync(statePath));
  const stBefore = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(stBefore.leases && stBefore.leases["fake-acc-term"], "Lease must be held during execution before SIGTERM");
  assert.equal(stBefore.leases["fake-acc-term"].pid, serverProc.pid);

  // Send SIGTERM
  serverProc.kill("SIGTERM");
  await new Promise((resolve) => serverProc.on("exit", resolve));

  if (fs.existsSync(statePath)) {
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(st.leases || {}, {}, "Leases must be empty after SIGTERM");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
