/**
 * bb.host артефакт: ACP-мост bb с диалектом Devin. Копия моста собирается
 * скриптом scripts/vendor-acp-bridge.mjs из @get-bb/plugin-sdk (npm run vendor).
 */
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_acpProviderBridge as inner } from "./src/vendor/acp-bridge.js";
import {
  applyDisabled,
  applyRestore,
  parseSubagentsEnabled,
  writeConfigFileSafely,
} from "./src/subagent-gate.mjs";
import { resolveDevinBin } from "./src/resolve-devin-bin.mjs";

let dataDir = "";
const DEVIN_CONFIG = join(homedir(), ".config", "devin", "config.json");
const gateStatePath = () => join(dataDir, "subagents-gate.json");

function log(message: string) {
  if (dataDir === "") return;
  try {
    appendFileSync(join(dataDir, "subagents-gate.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function readGateState() {
  try {
    const parsed = JSON.parse(readFileSync(gateStatePath(), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * enabled=false → stamp `subagents_enabled:false` (записываем prior один раз).
 * enabled=true  → откат ровно нашего стемпа; чужой конфиг не трогаем.
 */
function applySubagentGate(enabled: boolean) {
  const state = readGateState();
  let text = "";
  try {
    text = readFileSync(DEVIN_CONFIG, "utf8");
  } catch {}
  if (!enabled) {
    if (parseSubagentsEnabled(text) === false) return; // уже выключено — не наш стемп
    if (state === null) {
      try {
        writeConfigFileSafely(gateStatePath(), JSON.stringify({ prior: parseSubagentsEnabled(text) }));
      } catch {}
    }
    const next = applyDisabled(text);
    if (next !== text) {
      writeConfigFileSafely(DEVIN_CONFIG, next);
      log("subagents_enabled=false applied (bb central setting)");
    }
    return;
  }
  if (state === null) return; // мы не стемпили — чужой выбор уважаем
  const next = applyRestore(text, state.prior ?? null);
  if (next !== text) {
    writeConfigFileSafely(DEVIN_CONFIG, next);
    log(`subagents_enabled restored (prior=${JSON.stringify(state.prior ?? null)})`);
  }
  try {
    rmSync(gateStatePath(), { force: true });
  } catch {}
}

/**
 * devin acp exposes no local memory lever in this version: its Memory Drive /
 * auto-notes are cloud-side features with no user-config key (the config
 * schema has `disabled_tools`, but no memory tool is registered to disable —
 * stamping speculative names there would claim an effect we cannot verify).
 * Nothing is written; a real lever lands here when devin ships one.
 */
function applyMemoryGate(enabled: boolean) {
  if (!enabled) {
    log("memory gate: OFF requested, but devin acp has no local memory lever (cloud Memory Drive/notes only); nothing applied");
  }
}

const GATE_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const LAUNCH_SPEC_OPTIONS_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
  "turn/steer",
]);
const LAUNCH_SPEC_PROVIDER_METHODS = new Set([
  "model/list",
  "provider/health",
  "provider/usage",
  "provider/installation/status",
  "provider/installation/run",
]);

export const experimental_providerBridge = {
  ...inner,
  start(context: { pluginId: string; dataDir: string; tempDir: string }) {
    dataDir = context.dataDir ?? "";
    inner.start?.(context);
  },
  handleLine(line: string) {
    try {
      const msg = JSON.parse(line);
      if (msg !== null && typeof msg === "object") {
        if (GATE_METHODS.has(msg.method)) {
          const enabled = msg.params?.options?.providerOptions?.providerSubagentsEnabled;
          if (typeof enabled === "boolean") applySubagentGate(enabled);
          const memoryEnabled = msg.params?.options?.providerOptions?.providerMemoryEnabled;
          if (typeof memoryEnabled === "boolean") applyMemoryGate(memoryEnabled);
        }
        let updated = false;
        if (LAUNCH_SPEC_OPTIONS_METHODS.has(msg.method)) {
          const spec = msg.params?.options?.providerOptions?.acpLaunchSpec;
          if (spec && typeof spec === "object") {
            spec.command = resolveDevinBin();
            updated = true;
          }
        } else if (LAUNCH_SPEC_PROVIDER_METHODS.has(msg.method)) {
          const spec = msg.params?.providerOptions?.acpLaunchSpec;
          if (spec && typeof spec === "object") {
            spec.command = resolveDevinBin();
            updated = true;
          }
        }
        if (updated) {
          inner.handleLine(JSON.stringify(msg));
          return;
        }
      }
    } catch {}
    inner.handleLine(line);
  },
};
