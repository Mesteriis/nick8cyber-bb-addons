// src/devin-dialect.js (вставляется в вендорную копию моста src/vendor/acp-bridge.js)
//
// Собственные импорты диалекта (docs/specs/provider-devin.md §5.2)
// Не зависят от внутренних идентификаторов бандла esbuild.

function devinSubagentDetail(input) {
  const parts = [];
  if (input.profile !== void 0) {
    parts.push(input.profile.replace(/^subagent_/u, ""));
  }
  if (input.is_background === true) {
    parts.push("в фоне");
  }
  return parts.length === 0 ? void 0 : parts.join(" · ");
}

function devinClassifyToolCall(event) {
  const raw = event.rawInput;
  if (!raw || typeof raw !== "object") {
    return void 0;
  }
  const task = typeof raw.task === "string" ? raw.task : void 0;
  if (task === void 0) {
    return void 0;
  }
  const profile = typeof raw.profile === "string" ? raw.profile : void 0;
  const isBackground = raw.is_background === true;
  const title = typeof raw.title === "string" ? raw.title : (typeof event.title === "string" ? event.title : void 0);

  if (profile === void 0 && !/subagent/iu.test(event.title ?? "")) {
    return void 0;
  }
  const label = title ?? "Devin subagent";
  const detail = devinSubagentDetail({ profile, is_background: isBackground });
  return {
    item: {
      type: "delegation",
      childRef: event.toolCallId,
      label,
      background: isBackground
    },
    presentation: delegationPresentation({ label, ...detail === void 0 ? {} : { detail } })
  };
}

var DEVIN_ACP_DIALECT = {
  id: "devin",
  classifyToolCall: devinClassifyToolCall
};

function getDevinStateDir() {
  return process.env.BB_DEVIN_STATE_DIR || devinPath.join(devinOs.homedir(), ".local", "state", "bb-devin");
}

function persistDevinBbInstructions(bbThreadId, instructions) {
  if (typeof instructions !== "string" || instructions.length === 0 || !/^thr_[a-z0-9]+$/u.test(bbThreadId)) {
    return;
  }
  const stateDir = getDevinStateDir();
  const dir = devinPath.join(stateDir, "instructions");
  try {
    devinFsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      devinFsSync.chmodSync(stateDir, 0o700);
    } catch {}
    try {
      devinFsSync.chmodSync(dir, 0o700);
    } catch {}
    const file = devinPath.join(dir, `${bbThreadId}.md`);
    const rand = Math.random().toString(36).slice(2, 10);
    const tmp = devinPath.join(dir, `${bbThreadId}.${process.pid}.${rand}.tmp`);
    devinFsSync.writeFileSync(tmp, instructions, { mode: 0o600 });
    try {
      devinFsSync.chmodSync(tmp, 0o600);
    } catch {}
    devinFsSync.renameSync(tmp, file);
  } catch (err) {}
}

function isBbSystemNotice(input) {
  const first = Array.isArray(input) ? input.find((item) => item && item.type === "text") : void 0;
  const text = typeof first?.text === "string" ? first.text : "";
  return text.startsWith("[bb system]") || text.startsWith("[orchestrator]");
}

var DEVIN_ACP_MODE_BY_PERMISSION_MODE = {
  "accept-edits": "accept-edits",
  auto: "smart",
  full: "bypass",
  "workspace-write": "accept-edits"
};

function findDevinAcpModeConfigOption(configOptions) {
  const options = configOptions ?? [];
  return options.find((option) => option.category === "mode") ?? options.find((option) => option.id === "mode");
}

async function applyDevinAcpSessionMode(args) {
  const target = DEVIN_ACP_MODE_BY_PERMISSION_MODE[args.permissionMode];
  if (target === void 0) {
    return;
  }
  const modeOption = findDevinAcpModeConfigOption(args.configOptions);
  if (modeOption === void 0 || !(modeOption.options ?? []).some((option) => option.value === target)) {
    process.stderr.write(
      `acp bridge: ACP agent "${args.agentLabel}" does not offer session mode "${target}" for permissionMode "${args.permissionMode}"; leaving the agent's default mode\n`
    );
    return;
  }
  try {
    const res = await args.connection.request({
      method: "session/set_config_option",
      params: {
        sessionId: args.sessionId,
        configId: modeOption.id,
        value: target
      },
      resultSchema: {
        safeParse(value) {
          return { success: true, data: value };
        }
      },
      timeoutMs: typeof ACP_SESSION_CONFIG_TIMEOUT_MS === "number" ? ACP_SESSION_CONFIG_TIMEOUT_MS : 60000
    });
    if (res && typeof res === "object" && Array.isArray(res.configOptions)) {
      if (args.session?.nativeConfig) {
        args.session.nativeConfig.configOptions = res.configOptions;
      }
      if (args.session?.model) {
        args.session.model.applyConfigOptions(res.configOptions);
      }
      return res.configOptions;
    }
  } catch (error) {
    process.stderr.write(
      `acp bridge: failed to set ACP session mode "${target}" on "${args.agentLabel}": ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

// -------------------------------------------------------------
// Wedged sessions storage and LRU streak accounting (§7.4 п.2, §8)
// -------------------------------------------------------------

var stallStreakByProviderSession = new Map();

function noteDevinStallStreak(sessionId) {
  if (!sessionId) return 0;
  const current = (stallStreakByProviderSession.get(sessionId) ?? 0) + 1;
  stallStreakByProviderSession.delete(sessionId);
  stallStreakByProviderSession.set(sessionId, current);
  if (stallStreakByProviderSession.size > 200) {
    const firstKey = stallStreakByProviderSession.keys().next().value;
    stallStreakByProviderSession.delete(firstKey);
  }
  return current;
}

function getWedgedSessionsFilePath() {
  return devinPath.join(getDevinStateDir(), "wedged-sessions.json");
}

function readWedgedDevinSessions() {
  const filePath = getWedgedSessionsFilePath();
  try {
    const text = devinFsSync.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

var cachedWedgedStateDir = null;
var cachedWedgedSet = null;

function syncWedgedSessionsCache() {
  const stateDir = getDevinStateDir();
  const list = readWedgedDevinSessions();
  cachedWedgedStateDir = stateDir;
  cachedWedgedSet = new Set(list);
  return list;
}

function getWedgedSet() {
  const stateDir = getDevinStateDir();
  if (cachedWedgedSet === null || cachedWedgedStateDir !== stateDir) {
    syncWedgedSessionsCache();
  }
  return cachedWedgedSet;
}

function isDevinSessionWedged(sessionId) {
  if (!sessionId) return false;
  syncWedgedSessionsCache();
  return cachedWedgedSet.has(sessionId);
}

function addWedgedDevinSession(sessionId) {
  if (!sessionId) return;
  const stateDir = getDevinStateDir();
  try {
    devinFsSync.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { devinFsSync.chmodSync(stateDir, 0o700); } catch {}
  } catch {}
  const list = syncWedgedSessionsCache();
  const filtered = list.filter((id) => id !== sessionId);
  filtered.push(sessionId);
  const capped = filtered.slice(-200);
  const filePath = getWedgedSessionsFilePath();
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = `${filePath}.${process.pid}.${rand}.tmp`;
  try {
    devinFsSync.writeFileSync(tmp, JSON.stringify(capped, null, 2) + "\n", { mode: 0o600 });
    try { devinFsSync.chmodSync(tmp, 0o600); } catch {}
    devinFsSync.renameSync(tmp, filePath);
    cachedWedgedSet = new Set(capped);
    cachedWedgedStateDir = stateDir;
  } catch (err) {
    try { devinFsSync.rmSync(tmp, { force: true }); } catch {}
  }
}

function removeWedgedDevinSession(sessionId) {
  if (!sessionId) return;
  const set = getWedgedSet();
  if (!set.has(sessionId)) return;
  const list = readWedgedDevinSessions();
  const filtered = list.filter((id) => id !== sessionId);
  const filePath = getWedgedSessionsFilePath();
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = `${filePath}.${process.pid}.${rand}.tmp`;
  try {
    devinFsSync.writeFileSync(tmp, JSON.stringify(filtered, null, 2) + "\n", { mode: 0o600 });
    try { devinFsSync.chmodSync(tmp, 0o600); } catch {}
    devinFsSync.renameSync(tmp, filePath);
    cachedWedgedSet = new Set(filtered);
    cachedWedgedStateDir = getDevinStateDir();
  } catch (err) {
    try { devinFsSync.rmSync(tmp, { force: true }); } catch {}
  }
}

function clearDevinStallStreak(sessionId) {
  if (!sessionId) return;
  stallStreakByProviderSession.delete(sessionId);
  removeWedgedDevinSession(sessionId);
}

// -------------------------------------------------------------
// Phase Watchdog (§7.1, §7.2, §7.3)
// -------------------------------------------------------------

function getDevinLlmIdleMs() {
  const v = process.env.BB_DEVIN_LLM_IDLE_MS || process.env.BB_DEVIN_TURN_IDLE_MS;
  if (v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 75000;
}

function getDevinOpenWorkMaxMs() {
  const v = process.env.BB_DEVIN_OPEN_WORK_MAX_MS;
  if (v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3600000;
}

function getDevinCancelGraceMs() {
  const v = process.env.BB_DEVIN_CANCEL_GRACE_MS;
  if (v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10000;
}

var MAX_TURN_RECYCLES = 2;

function disarmDevinTurnWatchdog(session) {
  if (session.devinIdleTimer !== void 0) {
    clearTimeout(session.devinIdleTimer);
    session.devinIdleTimer = void 0;
  }
  if (session.devinOpenWorkTimer !== void 0) {
    clearTimeout(session.devinOpenWorkTimer);
    session.devinOpenWorkTimer = void 0;
  }
  if (session.devinGraceTimer !== void 0) {
    clearTimeout(session.devinGraceTimer);
    session.devinGraceTimer = void 0;
  }
}

function armDevinCancelGraceTimer(session) {
  if (
    session.activePromptKind === "turn" &&
    session.promptRequestPending === true &&
    !session.stopping &&
    !session.connection.exited
  ) {
    if (session.devinGraceTimer !== void 0) {
      clearTimeout(session.devinGraceTimer);
      session.devinGraceTimer = void 0;
    }
    const graceMs = getDevinCancelGraceMs();
    const ceiling = (session.devinCancelSentAtMs ?? Date.now()) + 3 * graceMs;
    const delay = Math.max(0, Math.min(graceMs, ceiling - Date.now()));
    session.devinGraceTimer = setTimeout(() => {
      session.devinGraceTimer = void 0;
      void session.connection.kill();
    }, delay);
  }
}

function onDevinTurnWatchdogTrigger(session, kind) {
  if (
    session.dialect.id !== "devin" ||
    session.activePromptKind !== "turn" ||
    !session.promptRequestPending ||
    session.stopping ||
    session.devinCancelSent ||
    session.connection.exited
  ) {
    return;
  }
  if (kind === "llm_idle" && agentTurnHasOpenWork(session)) {
    syncDevinTurnWatchdog(session);
    return;
  }
  if (kind === "open_work" && !session.model.hasUnfinishedToolCalls()) {
    syncDevinTurnWatchdog(session);
    return;
  }

  session.devinCancelSent = true;
  session.devinCancelSentAtMs = Date.now();
  if (session.devinIdleTimer !== void 0) {
    clearTimeout(session.devinIdleTimer);
    session.devinIdleTimer = void 0;
  }
  if (session.devinOpenWorkTimer !== void 0) {
    clearTimeout(session.devinOpenWorkTimer);
    session.devinOpenWorkTimer = void 0;
  }

  session.connection.notify("session/cancel", { sessionId: session.providerThreadId });
  armDevinCancelGraceTimer(session);
}

function syncDevinTurnWatchdog(session) {
  if (
    session.dialect.id !== "devin" ||
    session.activePromptKind !== "turn" ||
    !session.promptRequestPending ||
    session.stopping ||
    session.devinCancelSent ||
    session.connection.exited
  ) {
    return;
  }

  if (session.pendingPermissions.size > 0 || session.pendingElicitations.size > 0) {
    if (session.devinIdleTimer !== void 0) {
      clearTimeout(session.devinIdleTimer);
      session.devinIdleTimer = void 0;
    }
    if (session.devinOpenWorkTimer !== void 0) {
      clearTimeout(session.devinOpenWorkTimer);
      session.devinOpenWorkTimer = void 0;
    }
  } else if (session.model.hasUnfinishedToolCalls()) {
    if (session.devinIdleTimer !== void 0) {
      clearTimeout(session.devinIdleTimer);
      session.devinIdleTimer = void 0;
    }
    if (session.devinOpenWorkTimer !== void 0) {
      clearTimeout(session.devinOpenWorkTimer);
    }
    const openWorkMs = getDevinOpenWorkMaxMs();
    session.devinOpenWorkTimer = setTimeout(() => {
      onDevinTurnWatchdogTrigger(session, "open_work");
    }, openWorkMs);
  } else {
    if (session.devinOpenWorkTimer !== void 0) {
      clearTimeout(session.devinOpenWorkTimer);
      session.devinOpenWorkTimer = void 0;
    }
    if (session.devinIdleTimer !== void 0) {
      clearTimeout(session.devinIdleTimer);
    }
    const idleMs = getDevinLlmIdleMs();
    session.devinIdleTimer = setTimeout(() => {
      onDevinTurnWatchdogTrigger(session, "llm_idle");
    }, idleMs);
  }
}
