import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  handleMessageDispatch,
  type RoleDecisionProbes,
} from "../src/roles.js";
import { buildAgentConfiguration } from "../src/agent-config.js";
import { parsePolicy, type PolicyLoad } from "../src/policy.js";
import {
  cancelHelper,
  createHelperWatchdog,
  runHelper,
  runRoleSet,
  type HelperCallerFacts,
  type HelperDeps,
  type HelpersSettings,
  type HelperThreads,
  type SpawnHelperArgs,
} from "../src/helper.js";
import { runMerge, type MergeDeps } from "../src/merge.js";
import { createWatchdog, type WatchdogThreadDto } from "../src/watchdog.js";
import { createT } from "../src/i18n/index.js";
import { OrchestratorError } from "../src/errors.js";

/**
 * §19.7 rehearsals — every scenario through the real entry points:
 * `runHelper`/`cancelHelper`/`runRoleSet` (the tool/CLI bodies), the
 * dispatch hook, `configure`, the helper watchdog, the delegation
 * watchdog's `evaluateIdle`/`checkTimers`, and `runMerge`.
 */

const T = createT("en");
const T0 = 1_700_000_000_000;

const POLICY_JSON = JSON.stringify({
  version: 1,
  levels: { simple: { chain: ["s"] } },
  routes: {
    s: { preset: "opus", provider: "p", firstResponseSeconds: 30 },
  },
});
const POLICY = parsePolicy(POLICY_JSON).policy!;

const goodLoad: PolicyLoad = {
  policy: POLICY,
  errors: [],
  warnings: [],
  unavailableRoutes: [],
};
const badLoad: PolicyLoad = {
  policy: null,
  errors: [{ path: "routes", message: "bad" }],
  warnings: [],
  unavailableRoutes: [],
};

type SpawnArgs = Record<string, unknown>;

function makeDeps(
  over: {
    helpers?: HelpersSettings;
    load?: PolicyLoad;
    caller?: Partial<HelperCallerFacts>;
    children?: { id: string; meta?: Record<string, unknown> }[];
  } = {},
) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  let nowMs = T0;
  const spawnCalls: SpawnArgs[] = [];
  const sends: { threadId: string; text: string }[] = [];
  const stops: string[] = [];
  const threadDtos = new Map<string, Record<string, unknown>>();
  const eventLog = new Map<string, { seq: number; type: string; createdAt: number; data: Record<string, unknown> }[]>();
  const queues = new Map<string, unknown[]>();
  const meta = new Map<string, Record<string, unknown>>();
  const metadataUpdates: {
    threadId: string;
    set?: Record<string, unknown>;
    remove?: string[];
  }[] = [];
  const threads = {
    get: async ({ threadId }: { threadId: string }) =>
      (threadDtos.get(threadId) ?? {
        id: threadId,
        status: "idle",
      }) as { id: string; status: string },
    spawn: async (a: SpawnHelperArgs) => {
      spawnCalls.push(a as unknown as SpawnArgs);
      const id = `thr_h${spawnCalls.length}`;
      threadDtos.set(id, {
        id,
        status: "idle",
        parentThreadId: a.parentThreadId,
        visibility: a.visibility,
      });
      meta.set(id, (a.pluginMetadata as Record<string, unknown>) ?? {});
      return { id };
    },
    send: async (a: {
      threadId: string;
      input: { type: string; text: string }[];
    }) => {
      sends.push({ threadId: a.threadId, text: a.input[0]!.text });
      return {};
    },
    stop: async (a: { threadId: string }) => {
      stops.push(a.threadId);
      return {};
    },
    list: async (a: { parentThreadId?: string; limit?: number }) =>
      (over.children ?? []).map((c) => ({ id: c.id })).slice(0, a.limit ?? 100),
    getPluginMetadata: async ({ threadId }: { threadId: string }) =>
      meta.get(threadId) ??
      over.children?.find((c) => c.id === threadId)?.meta ??
      null,
    updatePluginMetadata: async (a: {
      threadId: string;
      set?: Record<string, unknown>;
      remove?: string[];
    }) => {
      metadataUpdates.push(a);
      return {};
    },
    archive: async () => ({}),
    events: {
      list: async (a: {
        threadId: string;
        afterSeq?: number;
        limit?: string | number;
        order?: "asc" | "desc";
      }) => {
        let rows = eventLog.get(a.threadId) ?? [];
        if (a.afterSeq !== undefined) rows = rows.filter((r) => r.seq > a.afterSeq!);
        if (a.order === "desc") rows = [...rows].reverse();
        return rows.slice(0, Number(a.limit ?? 50));
      },
    },
    queuedMessages: {
      list: async ({ threadId }: { threadId: string }) => queues.get(threadId) ?? [],
    },
    output: async () => ({ output: null }),
    update: async () => ({}),
  } as HelperThreads;
  const caller: HelperCallerFacts = {
    threadId: "thr_caller",
    parentThreadId: null,
    sourceThreadId: null,
    originPluginId: null,
    projectId: "proj_a",
    environmentId: "env_1",
    ...over.caller,
  };
  const deps: HelperDeps = {
    store,
    threads,
    enqueue: (fn) => fn(),
    loadPolicy: async () => over.load ?? goodLoad,
    helpers: () => over.helpers ?? { maxActive: 3, defaultLevel: "simple" },
    callerFacts: async () => caller,
    t: T,
    now: () => nowMs,
  };
  const callerLines: string[] = [];
  const wdDeps = {
    ...deps,
    callerSend: async (_t: string, text: string) => {
      callerLines.push(text);
      return {};
    },
  };
  return {
    db,
    store,
    deps,
    caller,
    threads,
    spawnCalls,
    sends,
    stops,
    threadDtos,
    eventLog,
    queues,
    meta,
    callerLines,
    metadataUpdates,
    helperWd: () => createHelperWatchdog(wdDeps),
    setNow: (v: number) => {
      nowMs = v;
    },
    helpersCount: () =>
      (db.prepare(`SELECT COUNT(*) c FROM helpers`).get() as { c: number }).c,
  };
}

const errCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof OrchestratorError, `unexpected error ${e}`);
    return e.code;
  }
  throw new Error("expected an OrchestratorError");
};

/** A running executor: role row + a `running` delegation on thr_caller. */
function executorCaller(h: ReturnType<typeof makeDeps>) {
  h.store.setThreadRole("thr_caller", "executor", "hook");
  const row = h.store.insert({
    taskKey: "PLUG-1",
    projectId: "proj_a",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "s",
    preset: "opus",
    provider: "p",
  });
  h.store.setThreadInfo(row.id, "thr_caller");
  h.store.setStatus(row.id, "running");
  return row;
}

// ── §19.7.1: an honest helper call ──────────────────────────────────

test("§19.7.1: helper success — hidden parent-linked child on the caller's env", async () => {
  const h = makeDeps();
  const delegation = executorCaller(h);
  const res = await runHelper(
    { prompt: "find the memory leak in src/db.ts", threadId: "thr_caller" },
    h.deps,
  );
  assert.equal(res.helperId, 1);
  assert.equal(res.threadId, "thr_h1");
  assert.equal(res.preset, "opus");
  assert.equal(res.route, "s");
  assert.equal(res.level, "simple");

  const call = h.spawnCalls[0]!;
  assert.deepEqual(call.environment, {
    type: "reuse",
    environmentId: "env_1",
  });
  assert.equal(call.parentThreadId, "thr_caller");
  assert.equal(call.parentNotifications, "auto");
  assert.equal(call.lifecycleOwnerThreadId, "thr_caller");
  assert.equal(call.visibility, "hidden");
  assert.deepEqual(call.pluginMetadata, { helperId: 1 });
  assert.match(call.title as string, /^helper#1 · find the memory leak/);
  assert.ok((call.title as string).length <= 120);

  // The helper's role row is written by the plugin — never the picker.
  const role = h.store.threadRole("thr_h1")!;
  assert.equal(role.role, "helper");
  assert.equal(role.source, "delegate");

  const helper = h.store.helper(1)!;
  assert.equal(helper.status, "running");
  assert.equal(helper.thread_id, "thr_h1");
  assert.equal(helper.caller_delegation_id, delegation.id);
  assert.equal(helper.coordinator_thread_id, "thr_coord");

  // §19.1: the launch line is the RESULT — the caller's own turn is
  // not woken by a plugin message.
  assert.match(res.message, /helper#1/);
  assert.equal(h.sends.length, 0);
});

test("§19.7.1: orchestrator root may also launch helpers", async () => {
  const h = makeDeps();
  h.store.setThreadRole("thr_caller", "orchestrator", "hook");
  const res = await runHelper(
    { prompt: "summarise the repo", threadId: "thr_caller" },
    h.deps,
  );
  assert.equal(res.helperId, 1);
  assert.equal(h.store.helper(1)!.coordinator_thread_id, "thr_caller");
});

test("§19.7.1: done — the helper's idle ends the row, no result line", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "count files", threadId: "thr_caller" }, h.deps);
  const wd = h.helperWd();
  // §19.1: `done` stands on the journal's clean `turn/completed` — a
  // bare idle without it keeps the helper running.
  h.eventLog.set("thr_h1", [
    { seq: 1, type: "turn/started", createdAt: T0 + 100, data: {} },
    { seq: 2, type: "turn/completed", createdAt: T0 + 200, data: {} },
  ]);
  await wd.onThreadIdle({ id: "thr_h1", status: "idle" });
  assert.equal(h.store.helper(1)!.status, "done");
  // §19.1: the result reaches the caller via BB parent notifications —
  // the plugin delivers NO ordinary result lines.
  assert.equal(h.callerLines.length, 0);
  assert.equal(h.sends.length, 0);
});

test("§19.7.2: failed → one caller line; a restart does not repeat it", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const wd = h.helperWd();
  await wd.onThreadFailed({ id: "thr_h1" }, { message: "provider exploded" });
  assert.equal(h.store.helper(1)!.status, "failed");
  assert.equal(h.callerLines.length, 1);
  assert.match(h.callerLines[0]!, /helper#1/);
  // A fresh watchdog instance (plugin restart) — `notified_at` dedupes.
  const wd2 = h.helperWd();
  await wd2.reconcile();
  assert.equal(h.callerLines.length, 1);
});

test("§19.7.2: quota errors land as `quota`", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  await h
    .helperWd()
    .onThreadFailed({ id: "thr_h1" }, { message: "insufficient credits" });
  assert.equal(h.store.helper(1)!.status, "quota");
  assert.equal(h.callerLines.length, 1);
});

test("§19.7.2: interrupted → one continuation; a second → failed", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const wd = h.helperWd();
  // §19.1: an interruption (a restart marker, no typed failure) gets
  // exactly one continuation.
  h.eventLog.set("thr_h1", [
    { seq: 1, type: "turn/started", createdAt: T0 + 100, data: {} },
    {
      seq: 2,
      type: "system/thread/interrupted",
      createdAt: T0 + 200,
      data: { reason: "restart" },
    },
  ]);
  await wd.onTurnFailed({ threadId: "thr_h1" });
  assert.equal(h.store.helper(1)!.status, "running");
  // The continuation went to the HELPER thread, not the caller.
  assert.equal(h.sends.filter((s) => s.threadId === "thr_h1").length, 1);
  // A second interruption is `failed` — NOT stalled (the review
  // correction): the slot frees and the thread is stopped.
  h.eventLog.set("thr_h1", [
    { seq: 3, type: "turn/started", createdAt: T0 + 300, data: {} },
    {
      seq: 4,
      type: "system/thread/interrupted",
      createdAt: T0 + 400,
      data: { reason: "restart" },
    },
  ]);
  await wd.onTurnFailed({ threadId: "thr_h1" });
  assert.equal(h.store.helper(1)!.status, "failed");
  assert.deepEqual(h.stops, ["thr_h1"]);
  assert.equal(h.callerLines.length, 1);
});

test("§19.7.2: silence past the first-response window → stalled", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const wd = h.helperWd();
  h.setNow(T0 + 2 * 60 * 1000);
  h.queues.set("thr_h1", []);
  await wd.checkTimers();
  assert.equal(h.store.helper(1)!.status, "stalled");
  assert.equal(h.callerLines.length, 1);
});

test("§19.7.2: dispatching past the grace window without a thread → failed", async () => {
  const h = makeDeps();
  executorCaller(h);
  // A spawn that returns no id — the row stays `dispatching`.
  h.threads.spawn = async () => {
    h.spawnCalls.push({});
    return {};
  };
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  assert.equal(h.store.helper(1)!.status, "dispatching");
  // created_at comes from Date.now() — jump the watchdog clock past it.
  h.setNow(Date.now() + 3 * 60 * 1000);
  await h.helperWd().checkTimers();
  assert.equal(h.store.helper(1)!.status, "failed");
  assert.equal(h.callerLines.length, 1);
});

test("§19.7.2: reconcile relinks a dispatching row by pluginMetadata.helperId", async () => {
  const h = makeDeps({
    children: [{ id: "thr_lost", meta: { helperId: 1 } }],
  });
  executorCaller(h);
  h.threads.spawn = async () => {
    h.spawnCalls.push({});
    return {};
  };
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const wd = h.helperWd();
  await wd.reconcile();
  const row = h.store.helper(1)!;
  assert.equal(row.thread_id, "thr_lost");
  assert.equal(row.status, "running");
  assert.equal(h.store.threadRole("thr_lost")!.role, "helper");
});

// ── §19.7.3: the refusal matrix ─────────────────────────────────────

test("§19.7.3: every refusal — stable code, no spawn, no helper row", async () => {
  const spawnless = async (
    h: ReturnType<typeof makeDeps>,
    input: Parameters<typeof runHelper>[0],
  ) => {
    const code = await errCode(() => runHelper(input, h.deps));
    assert.equal(h.spawnCalls.length, 0, `${code}: a spawn escaped`);
    assert.equal(h.helpersCount(), 0, `${code}: a helper row escaped`);
    return code;
  };

  // No thread at all (bare shell / CLI outside a thread).
  {
    const h = makeDeps();
    assert.equal(await spawnless(h, { prompt: "x" }), "no-caller-thread");
  }
  // A thread with no recorded role.
  {
    const h = makeDeps();
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "no-role",
    );
  }
  // helper-of-helper.
  {
    const h = makeDeps();
    h.store.setThreadRole("thr_caller", "helper", "delegate");
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "helper-of-helper",
    );
  }
  // §19.1: `none` shares the `no-role` code with a missing row;
  // auditor and release-auditor are `caller-not-allowed`.
  {
    const h = makeDeps();
    h.store.setThreadRole("thr_caller", "none", "hook");
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "no-role",
    );
  }
  for (const role of ["auditor", "release-auditor"]) {
    const h = makeDeps();
    h.store.setThreadRole("thr_caller", role, "hook");
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "caller-not-allowed",
      role,
    );
  }
  // An orchestrator that is NOT a root thread.
  {
    const h = makeDeps({ caller: { parentThreadId: "thr_p" } });
    h.store.setThreadRole("thr_caller", "orchestrator", "hook");
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "caller-not-allowed",
    );
  }
  // An executor child whose delegation is not running.
  {
    const h = makeDeps({ caller: { parentThreadId: "thr_p" } });
    h.store.setThreadRole("thr_caller", "executor", "hook");
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "caller-not-allowed",
    );
  }
  // Invalid policy.
  {
    const h = makeDeps({ load: badLoad });
    executorCaller(h);
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "needs-configuration",
    );
  }
  // A caller with no environment to reuse.
  {
    const h = makeDeps({ caller: { environmentId: null } });
    executorCaller(h);
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "no-environment",
    );
  }
  // A preset the policy does not declare.
  {
    const h = makeDeps();
    executorCaller(h);
    assert.equal(
      await spawnless(h, {
        prompt: "x",
        threadId: "thr_caller",
        preset: "foreign",
      }),
      "preset-not-allowed",
    );
  }
  // No level and no defaultLevel.
  {
    const h = makeDeps({ helpers: { maxActive: 3 } });
    executorCaller(h);
    assert.equal(
      await spawnless(h, { prompt: "x", threadId: "thr_caller" }),
      "invalid-arguments",
    );
  }
});

test("§19.7.3: per-caller limit — the second launch is refused atomically", async () => {
  const h = makeDeps({ helpers: { maxActive: 1, defaultLevel: "simple" } });
  executorCaller(h);
  await runHelper({ prompt: "one", threadId: "thr_caller" }, h.deps);
  const code = await errCode(() =>
    runHelper({ prompt: "two", threadId: "thr_caller" }, h.deps),
  );
  assert.equal(code, "helper-limit");
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.helpersCount(), 1);
});

test("§19.7.3: another caller's helper occupies the shared limits.maxActive slot", async () => {
  const tight = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { simple: { chain: ["s"] } },
      routes: { s: { preset: "opus", provider: "p" } },
      limits: { maxActive: 1 },
    }),
  ).policy!;
  const h = makeDeps({
    load: { policy: tight, errors: [], warnings: [], unavailableRoutes: [] },
    caller: { threadId: "thr_c2" },
  });
  h.store.setThreadRole("thr_c2", "orchestrator", "hook");
  // Someone else's active helper occupies the only shared slot.
  h.store.insertHelperChecked(
    {
      callerThreadId: "thr_other",
      coordinatorThreadId: "thr_other",
      preset: "opus",
    },
    { perCaller: 3 },
  );
  const code = await errCode(() =>
    runHelper({ prompt: "x", threadId: "thr_c2" }, h.deps),
  );
  assert.equal(code, "limit");
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.helpersCount(), 1);
});

test("§19.7.3: helpers count against the shared policy limit", async () => {
  const tight = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { simple: { chain: ["s"] } },
      routes: { s: { preset: "opus", provider: "p" } },
      limits: { maxActive: 1 },
    }),
  ).policy!;
  const h = makeDeps({
    load: { policy: tight, errors: [], warnings: [], unavailableRoutes: [] },
    caller: { threadId: "thr_c2" },
  });
  h.store.setThreadRole("thr_c2", "orchestrator", "hook");
  // One running delegation already consumes the shared slot.
  const row = h.store.insert({
    taskKey: "PLUG-9",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "s",
    preset: "opus",
    provider: "p",
  });
  h.store.setStatus(row.id, "running");
  const code = await errCode(() =>
    runHelper({ prompt: "x", threadId: "thr_c2" }, h.deps),
  );
  assert.equal(code, "limit");
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.helpersCount(), 0);
});

test("§19.7.3: the dispatch hook rejects a manual child of a role thread", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.setThreadRole("thr_parent", "orchestrator", "hook");
  const rejected: string[] = [];
  const probes: RoleDecisionProbes = {
    threadRole: (id) => store.threadRole(id),
    pendingRole: () => undefined,
    activeDelegationByTaskKey: () => undefined,
  };
  const hook = (allowForeignChildren = false) =>
    handleMessageDispatch(
      makeMessageDispatchHookContext({
        thread: {
          id: "thr_kid",
          status: "pending",
          parentThreadId: "thr_parent",
          originPluginId: null,
        },
        attempt: "start-turn",
        project: { id: "proj_a" },
      }),
      probes,
      (id, role) => store.setThreadRole(id, role, "hook"),
      undefined,
      { onRejectedChild: (id) => rejected.push(id) },
    );

  // The parent has a plugin role → the manual child is rejected.
  const decision = hook();
  assert.equal(decision.action, "reject");
  assert.ok("message" in decision && decision.message!.length > 0);
  assert.deepEqual(rejected, ["thr_kid"]);
  assert.equal(store.threadRole("thr_kid"), undefined);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) c FROM helpers`).get() as { c: number }).c,
    0,
  );

  // allowForeignChildren lets the operator override.
  const allowProbes: RoleDecisionProbes = {
    ...probes,
    allowForeignChildren: () => true,
  };
  const ok = handleMessageDispatch(
    makeMessageDispatchHookContext({
      thread: {
        id: "thr_kid2",
        status: "pending",
        parentThreadId: "thr_parent",
        originPluginId: null,
      },
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
    allowProbes,
    (id, role) => store.setThreadRole(id, role, "hook"),
  );
  assert.equal(ok.action, "proceed");

  // Plugin-born children (originPluginId = orchestrator) pass.
  const pluginChild = handleMessageDispatch(
    makeMessageDispatchHookContext({
      thread: {
        id: "thr_kid3",
        status: "pending",
        parentThreadId: "thr_parent",
        originPluginId: "orchestrator",
        title: "helper#7 · work",
      },
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
    { ...probes, helperById: () => ({ status: "running" }) },
    (id, role) => store.setThreadRole(id, role, "hook"),
  );
  assert.equal(pluginChild.action, "proceed");
  assert.equal(store.threadRole("thr_kid3")!.role, "helper");
});

// ── §19.7.4: the `none` role and the CLI no-parent rule ─────────────

test("§19.7.4: a `none` role thread gets nothing at configure", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.setThreadRole("thr_n", "none", "hook");
  const config = buildAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: "thr_n", title: null, parentThreadId: null },
      project: { id: "proj_a" },
    }),
    {
      injectInstructions: true,
      instructionsText: "RULE",
      probes: {
        delegationByThreadId: () => undefined,
        hasFreshDispatching: () => false,
        roleByThreadId: (id) => store.threadRole(id)?.role,
      },
    },
  );
  assert.deepEqual(config.tools, []);
  assert.deepEqual(config.skills, []);
  assert.equal(config.instructions, undefined);
});

test("§19.7.4: a CLI thread without a parent gets no role", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const probes: RoleDecisionProbes = {
    threadRole: (id) => store.threadRole(id),
    pendingRole: () => undefined,
    activeDelegationByTaskKey: () => undefined,
  };
  handleMessageDispatch(
    makeMessageDispatchHookContext({
      thread: { id: "thr_cli", status: "pending", parentThreadId: null },
      attempt: "start-turn",
      origin: "cli",
      project: { id: "proj_a" },
    }),
    probes,
    (id, role) => store.setThreadRole(id, role, "hook"),
  );
  assert.equal(store.threadRole("thr_cli")!.role, "none");
});

test("§19.7.4: a `none` role set writes the row, the event, and clears the badge", async () => {
  const h = makeDeps();
  h.threadDtos.set("thr_x", { id: "thr_x", status: "idle" });
  h.store.setThreadRole("thr_x", "executor", "hook");
  const res = await runRoleSet(
    { threadId: "thr_x", role: "none", actor: "cli" },
    h.deps,
  );
  assert.equal(res.role, "none");
  assert.equal(res.previous, "executor");
  assert.equal(h.store.threadRole("thr_x")!.role, "none");
  // The pluginMetadata.role badge is cleared — the UI shows «Без плагина».
  assert.deepEqual(h.metadataUpdates, [
    { threadId: "thr_x", remove: ["role"] },
  ]);
  const events = h.db
    .prepare(`SELECT kind, payload FROM events WHERE kind = 'role.manual'`)
    .all() as { kind: string; payload: string }[];
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0]!.payload) as {
    thread: string;
    role: string;
    actor: string;
  };
  assert.equal(payload.thread, "thr_x");
  assert.equal(payload.role, "none");
  assert.equal(payload.actor, "cli");
});

test("§19.7.4: role set allows ONLY none — every other target refuses", async () => {
  const h = makeDeps();
  h.threadDtos.set("thr_x", { id: "thr_x", status: "idle" });
  for (const role of ["helper", "executor", "auditor", "orchestrator"]) {
    assert.equal(
      await errCode(() =>
        runRoleSet({ threadId: "thr_x", role }, h.deps),
      ),
      "role-not-allowed",
      role,
    );
  }
  // …even on a root thread — §19.4: no manual promotion, ever.
  h.threadDtos.set("thr_root", {
    id: "thr_root",
    status: "idle",
    parentThreadId: null,
  });
  assert.equal(
    await errCode(() =>
      runRoleSet({ threadId: "thr_root", role: "orchestrator" }, h.deps),
    ),
    "role-not-allowed",
  );
  // A helper-role thread refuses even the none downgrade.
  h.threadDtos.set("thr_h", { id: "thr_h", status: "idle" });
  h.store.setThreadRole("thr_h", "helper", "delegate");
  assert.equal(
    await errCode(() =>
      runRoleSet({ threadId: "thr_h", role: "none" }, h.deps),
    ),
    "role-not-allowed",
  );
  // A missing thread is not-found — no phantom role row.
  const realGet = h.threads.get;
  h.threads.get = async ({ threadId }: { threadId: string }) => {
    if (threadId === "thr_ghost") throw new Error("no such thread");
    return realGet({ threadId });
  };
  assert.equal(
    await errCode(() =>
      runRoleSet({ threadId: "thr_ghost", role: "none" }, h.deps),
    ),
    "not-found",
  );
  assert.equal(h.store.threadRole("thr_ghost"), undefined);
  // A thread inside active work keeps its role.
  const row = h.store.insert({
    taskKey: "PLUG-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "s",
    preset: "opus",
    provider: "p",
  });
  h.store.setThreadInfo(row.id, "thr_busy");
  h.store.setStatus(row.id, "running");
  h.threadDtos.set("thr_busy", { id: "thr_busy", status: "idle" });
  assert.equal(
    await errCode(() =>
      runRoleSet({ threadId: "thr_busy", role: "none" }, h.deps),
    ),
    "role-active",
  );
});

// ── §19.7.5: cascades, the delegation gate, and the merge refusal ───

test("§19.7.5: helper cancel is idempotent and stops the thread", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const first = await cancelHelper("1", h.deps, "thr_caller");
  assert.equal(first.helperId, 1);
  assert.deepEqual(h.stops, ["thr_h1"]);
  assert.equal(h.store.helper(1)!.status, "cancelled");
  const second = await cancelHelper("1", h.deps, "thr_caller");
  assert.equal(second.already, true);
  assert.equal(h.stops.length, 1);
  // A stranger cannot cancel.
  assert.equal(
    await errCode(() => cancelHelper("1", h.deps, "thr_stranger")),
    "caller-not-allowed",
  );
});

test("§19.7.5: a gone caller cascades to its active helpers", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  await h.helperWd().onThreadGone({ id: "thr_caller" }, "archived");
  assert.equal(h.store.helper(1)!.status, "cancelled");
  assert.deepEqual(h.stops, ["thr_h1"]);
});

test("§19.7.5: a gone helper thread → cancelled + one «removed» line", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  await h.helperWd().onThreadGone({ id: "thr_h1" }, "deleted");
  assert.equal(h.store.helper(1)!.status, "cancelled");
  assert.equal(h.callerLines.length, 1);
  assert.match(h.callerLines[0]!, /removed|deleted|cancel/i);
});

test("§19.7.5: a delegation outcome cascades to its helpers", async () => {
  const h = makeDeps();
  const delegation = executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  await h.helperWd().cancelHelpersOfDelegation(delegation.id);
  assert.equal(h.store.helper(1)!.status, "cancelled");
  assert.deepEqual(h.stops, ["thr_h1"]);
});

test("§19.7.5: evaluateIdle keeps a delegation running while helpers work", async () => {
  const h = makeDeps();
  executorCaller(h);
  const res = await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  assert.ok(res.threadId);

  // The real delegation watchdog on the same store.
  const bbCli = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const wd = createWatchdog({
    store: h.store,
    bbCli,
    threads: h.threads,
    loadPolicy: h.deps.loadPolicy,
    dispatchToRoute: async () => {
      throw new Error("unreachable");
    },
    dispatchSteps: async () => {
      throw new Error("unreachable");
    },
    retrySetup: async () => [],
    enqueue: (fn: () => Promise<unknown>) => fn(),
    t: T,
    now: () => T0,
  } as never);

  const delegation = h.store.byThreadId("thr_caller")!;
  h.store.setTurnStarted(delegation.id, T0);
  h.threadDtos.set("thr_caller", {
    id: "thr_caller",
    status: "idle",
  });
  h.eventLog.set("thr_caller", [
    { seq: 1, type: "turn/started", createdAt: T0, data: {} },
    { seq: 2, type: "turn/completed", createdAt: T0 + 10, data: {} },
  ]);
  h.queues.set("thr_caller", []);

  await wd.onThreadIdle({
    id: "thr_caller",
    status: "idle",
  } as WatchdogThreadDto);
  const fresh = h.store.get(delegation.id)!;
  assert.equal(fresh.status, "running", "active helpers hold `done`");
  assert.ok(
    h.store.findSetupError(fresh, "helpers-pending"),
    "the wait is marked",
  );

  // Helpers finish → the timer lifts the mark inside the window (the
  // executor gets firstMs to resume; the row keeps running).
  h.store.setHelperStatus(res.helperId, "done");
  await wd.checkTimers();
  const after = h.store.get(delegation.id)!;
  assert.equal(after.status, "running");
});

test("§19.7.5: merge refuses helpers-active while its helpers work", async () => {
  const h = makeDeps();
  const delegation = executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  h.store.setStatus(delegation.id, "done");
  const deps: MergeDeps = {
    store: h.store,
    bbCli: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as MergeDeps["bbCli"],
    git: async () => {
      throw new Error("unreachable");
    },
    environment: async () => ({ path: "/tmp/x" }),
    threads: { send: async () => ({}) },
    delegate: async () => ({ delegationId: 0, threadId: null }),
    t: T,
  } as MergeDeps;
  const code = await errCode(() =>
    runMerge(
      { ref: String(delegation.id), callerThreadId: "thr_coord" },
      deps,
    ),
  );
  assert.equal(code, "helpers-active");
  // Once the helper is done the refusal lifts — the next failure is
  // further down the merge path, not helpers-active.
  h.store.setHelperStatus(1, "done");
  const next = await errCode(() =>
    runMerge(
      { ref: String(delegation.id), callerThreadId: "thr_coord" },
      deps,
    ),
  );
  assert.notEqual(next, "helpers-active");
});

// ── §19.7.6: the r33 migration ──────────────────────────────────────

test("§19.7.6: the r33 migration wipes pending_roles and stamps the mark", () => {
  // An install on the last pre-r33 schema: apply the migrations up to
  // the helpers-table statement, plant a stale pick, apply the rest.
  const idx = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS helpers"));
  assert.ok(idx > 0);
  const db = new Database(":memory:");
  for (const m of MIGRATIONS.slice(0, idx)) db.exec(m);
  db.prepare(
    `INSERT INTO pending_roles (project_id, role, updated_at) VALUES (?,?,?)`,
  ).run("proj_a", "orchestrator", T0);
  for (const m of MIGRATIONS.slice(idx)) db.exec(m);
  const left = db.prepare(`SELECT COUNT(*) c FROM pending_roles`).get() as {
    c: number;
  };
  assert.equal(left.c, 0);
  const store = new DelegationStore(db);
  assert.ok(store.metaGet("migration-r33"));
  // And the helpers table stands.
  db.prepare(
    `SELECT COUNT(*) c FROM helpers`,
  ).get();
});

// ── Review regressions (r33 round-2 fixes) ──────────────────────────

test("review: the route's preset resolves into the spawn arguments", async () => {
  const h = makeDeps();
  executorCaller(h);
  h.deps.presetShow = async (name) => {
    assert.equal(name, "opus");
    return {
      providerId: "prov_1",
      modelId: "model_1",
      reasoningLevel: "high",
      permissionMode: "yolo",
    };
  };
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const call = h.spawnCalls[0]!;
  assert.equal(call.providerId, "prov_1");
  assert.equal(call.model, "model_1");
  assert.equal(call.reasoningLevel, "high");
  assert.equal(call.permissionMode, "yolo");
});

test("review: an explicit --preset is not overridden by helpers.defaultLevel", async () => {
  const h = makeDeps({
    helpers: { maxActive: 3, defaultLevel: "ghost-level" },
  });
  executorCaller(h);
  // --preset bypasses the level machinery entirely — an invalid
  // defaultLevel must NOT surface here.
  const res = await runHelper(
    { prompt: "x", threadId: "thr_caller", preset: "opus" },
    h.deps,
  );
  assert.equal(res.preset, "opus");
  assert.equal(res.route, "s");
});

test("review: helpers.defaultLevel outside the policy → needs-configuration", async () => {
  const h = makeDeps({ helpers: { maxActive: 3, defaultLevel: "ghost" } });
  executorCaller(h);
  const code = await errCode(() =>
    runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps),
  );
  assert.equal(code, "needs-configuration");
  assert.equal(h.spawnCalls.length, 0);
});

test("review: an unknown --level → unknown-level", async () => {
  const h = makeDeps();
  executorCaller(h);
  const code = await errCode(() =>
    runHelper(
      { prompt: "x", threadId: "thr_caller", level: "ghost" },
      h.deps,
    ),
  );
  assert.equal(code, "unknown-level");
});

test("review: a 4xx spawn refusal fails the row; a network failure leaves it dispatching", async () => {
  {
    const h = makeDeps();
    executorCaller(h);
    h.threads.spawn = async () => {
      const e = new Error("schema: field `visibility` refused") as Error & {
        status?: number;
      };
      e.status = 400;
      throw e;
    };
    const code = await errCode(() =>
      runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps),
    );
    assert.equal(code, "dispatch-failed");
    assert.equal(h.store.helper(1)!.status, "failed");
  }
  {
    const h = makeDeps();
    executorCaller(h);
    h.threads.spawn = async () => {
      throw new Error("socket hangup");
    };
    const res = await runHelper(
      { prompt: "x", threadId: "thr_caller" },
      h.deps,
    );
    // The outcome is UNKNOWN — the child may exist; the row stays
    // dispatching and the reconcile relinks it by helperId.
    assert.equal(res.threadId, undefined);
    assert.equal(h.store.helper(1)!.status, "dispatching");
    assert.match(res.message, /helper#1/);
  }
});

test("review: cancel before thread_id still stops the late-surfaced child", async () => {
  const h = makeDeps({
    children: [{ id: "thr_late", meta: { helperId: 1 } }],
  });
  executorCaller(h);
  h.threads.spawn = async () => {
    h.spawnCalls.push({});
    return {};
  };
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  await cancelHelper("1", h.deps, "thr_caller");
  assert.equal(h.store.helper(1)!.status, "cancelled");
  assert.equal(h.stops.length, 0);
  // The child surfaces on a later reconcile — it must be stopped.
  await h.helperWd().reconcile();
  assert.deepEqual(h.stops, ["thr_late"]);
});

test("review: typed quota via turn.failed errorInfo → quota + stop", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  await h.helperWd().onTurnFailed({
    threadId: "thr_h1",
    errorInfo: { category: "rate-limit" },
  });
  assert.equal(h.store.helper(1)!.status, "quota");
  assert.deepEqual(h.stops, ["thr_h1"]);
  assert.equal(h.callerLines.length, 1);
});

test("review: an idle helper whose turn ended in error is failed, not done", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  h.eventLog.set("thr_h1", [
    { seq: 1, type: "turn/started", createdAt: T0 + 100, data: {} },
    {
      seq: 2,
      type: "turn.failed",
      createdAt: T0 + 200,
      data: { message: "provider exploded" },
    },
  ]);
  await h.helperWd().onThreadIdle({ id: "thr_h1", status: "idle" });
  assert.equal(h.store.helper(1)!.status, "failed");
  assert.deepEqual(h.stops, ["thr_h1"]);
  assert.equal(h.callerLines.length, 1);
});

test("review: a plain idle with no turn verdict stays running — not done", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  // No turn/completed in the journal — the turn is not proven ended.
  await h.helperWd().onThreadIdle({ id: "thr_h1", status: "idle" });
  assert.equal(h.store.helper(1)!.status, "running");
});

test("review: a busy helper's silence clock follows its last journal event", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const wd = h.helperWd();
  // Route s carries firstResponseSeconds: 30 — the silence window.
  // An event at T+40 s must move the clock WITH it; the COALESCE bug
  // kept the spawn-time stamp and stalled the helper mid-work.
  h.eventLog.set("thr_h1", [
    {
      seq: 1,
      type: "item/agentMessage/delta",
      createdAt: T0 + 40_000,
      data: {},
    },
  ]);
  h.setNow(T0 + 45_000);
  await wd.checkTimers();
  assert.equal(h.store.helper(1)!.status, "running");
  // Real silence past the window afterwards — stalled + stopped.
  h.setNow(T0 + 40_000 + 31_000);
  await wd.checkTimers();
  assert.equal(h.store.helper(1)!.status, "stalled");
  assert.deepEqual(h.stops, ["thr_h1"]);
});

test("review: helpers-pending — the window starts when helpers finish, not at executor idle", async () => {
  const h = makeDeps();
  executorCaller(h);
  const res = await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const bbCli = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  let nowMs = T0;
  const wd = createWatchdog({
    store: h.store,
    bbCli,
    threads: h.threads,
    loadPolicy: h.deps.loadPolicy,
    dispatchToRoute: async () => {
      throw new Error("unreachable");
    },
    dispatchSteps: async () => {
      throw new Error("unreachable");
    },
    retrySetup: async () => [],
    enqueue: (fn: () => Promise<unknown>) => fn(),
    t: T,
    now: () => nowMs,
  } as never);

  const delegation = h.store.byThreadId("thr_caller")!;
  h.store.setTurnStarted(delegation.id, T0);
  h.threadDtos.set("thr_caller", { id: "thr_caller", status: "idle" });
  h.eventLog.set("thr_caller", [
    { seq: 1, type: "turn/started", createdAt: T0, data: {} },
    { seq: 2, type: "turn/completed", createdAt: T0 + 10, data: {} },
  ]);
  h.queues.set("thr_caller", []);
  await wd.onThreadIdle({ id: "thr_caller", status: "idle" } as WatchdogThreadDto);
  assert.equal(h.store.get(delegation.id)!.status, "running");
  // The mark is a plain "waiting" — the window has not started.
  const mark0 = h.store.findSetupError(
    h.store.get(delegation.id)!,
    "helpers-pending",
  );
  assert.equal(mark0?.message, "waiting");

  // The helper works LONGER than the first-response window (route s:
  // firstResponseSeconds 30 s). The delegation must not collapse.
  nowMs = T0 + 10 * 60 * 1000;
  await wd.checkTimers();
  assert.equal(h.store.get(delegation.id)!.status, "running");

  // The helper finishes — the post-helper window starts NOW.
  h.store.setHelperTerminal(res.helperId, "done");
  await wd.checkTimers();
  assert.equal(h.store.get(delegation.id)!.status, "running");
  const mark1 = h.store.findSetupError(
    h.store.get(delegation.id)!,
    "helpers-pending",
  );
  assert.ok(mark1 && mark1.message !== "waiting", "zero-time stamped");

  // Inside the window — still running; past it — the outcome path runs
  // and lifts the mark.
  nowMs += 20_000;
  await wd.checkTimers();
  assert.equal(h.store.get(delegation.id)!.status, "running");
  nowMs += 20_000;
  await wd.checkTimers();
  const fresh = h.store.get(delegation.id)!;
  assert.equal(
    h.store.findSetupError(fresh, "helpers-pending"),
    undefined,
    "the expired window hands over to the outcome path",
  );
});

test("review: a terminal delegation cancels its helpers through the store hook", async () => {
  const h = makeDeps();
  const delegation = executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const fired: number[] = [];
  h.store.onDelegationFinished = (id) => {
    fired.push(id);
    void h.helperWd().cancelHelpersOfDelegation(id);
  };
  h.store.setStatus(delegation.id, "failed");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fired, [delegation.id]);
  assert.equal(h.store.helper(1)!.status, "cancelled");
  assert.deepEqual(h.stops, ["thr_h1"]);
});

test("review: the finished hook fires on reissue too", async () => {
  const h = makeDeps();
  const delegation = executorCaller(h);
  const fired: [number, string][] = [];
  h.store.onDelegationFinished = (id, status) => {
    fired.push([id, status]);
  };
  h.store.setStatus(delegation.id, "stalled");
  const next = h.store.reissue(delegation.id, {
    route: "s",
    preset: "opus",
    provider: "p",
  });
  assert.ok(next);
  assert.deepEqual(fired, [
    [delegation.id, "stalled"],
    [delegation.id, "reissued"],
  ]);
});

test("review: the CLI helper call needs an ACTIVE calling thread", async () => {
  const h = makeDeps({ caller: { status: "idle" } });
  executorCaller(h);
  const code = await errCode(() =>
    runHelper(
      { prompt: "x", threadId: "thr_caller", via: "cli" },
      h.deps,
    ),
  );
  assert.equal(code, "caller-not-allowed");
  // The tool path has no such requirement.
  const h2 = makeDeps({ caller: { status: "idle" } });
  executorCaller(h2);
  const res = await runHelper(
    { prompt: "x", threadId: "thr_caller", via: "tool" },
    h2.deps,
  );
  assert.equal(res.helperId, 1);
});

test("review: a row-less pre-r33 coordinator keeps the helper via the fallback", async () => {
  const h = makeDeps();
  h.deps.isCoordinatorFallback = () => true;
  const res = await runHelper(
    { prompt: "x", threadId: "thr_caller" },
    h.deps,
  );
  assert.equal(res.helperId, 1);
  // Without the fallback the same row-less caller is `no-role`.
  const h2 = makeDeps();
  h2.deps.isCoordinatorFallback = () => false;
  assert.equal(
    await errCode(() =>
      runHelper({ prompt: "x", threadId: "thr_caller" }, h2.deps),
    ),
    "no-role",
  );
});

test("review: a side chat inherits the source thread's role", async () => {
  const h = makeDeps({ caller: { sourceThreadId: "thr_src" } });
  h.store.setThreadRole("thr_src", "orchestrator", "hook");
  const res = await runHelper(
    { prompt: "x", threadId: "thr_caller" },
    h.deps,
  );
  assert.equal(res.helperId, 1);
  const h2 = makeDeps({ caller: { sourceThreadId: "thr_src2" } });
  h2.store.setThreadRole("thr_src2", "executor", "hook");
  const res2 = await runHelper(
    { prompt: "x", threadId: "thr_caller" },
    h2.deps,
  );
  assert.equal(res2.helperId, 1);
});

test("review: a manually stopped helper reads as cancelled, not done", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  h.eventLog.set("thr_h1", [
    { seq: 1, type: "turn/started", createdAt: T0 + 100, data: {} },
    {
      seq: 2,
      type: "system/thread/interrupted",
      createdAt: T0 + 200,
      data: { reason: "manual-stop" },
    },
  ]);
  await h.helperWd().onThreadIdle({ id: "thr_h1", status: "idle" });
  assert.equal(h.store.helper(1)!.status, "cancelled");
  assert.equal(h.callerLines.length, 1);
});

test("review: the helpers-pending mark is not duplicated", async () => {
  const h = makeDeps();
  executorCaller(h);
  await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  const delegation = h.store.byThreadId("thr_caller")!;
  // Two idle evaluations while helpers work — one mark, not two.
  const bbCli = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const wd = createWatchdog({
    store: h.store,
    bbCli,
    threads: h.threads,
    loadPolicy: h.deps.loadPolicy,
    dispatchToRoute: async () => {
      throw new Error("unreachable");
    },
    dispatchSteps: async () => {
      throw new Error("unreachable");
    },
    retrySetup: async () => [],
    enqueue: (fn: () => Promise<unknown>) => fn(),
    t: T,
    now: () => T0,
  } as never);
  h.store.setTurnStarted(delegation.id, T0);
  h.threadDtos.set("thr_caller", { id: "thr_caller", status: "idle" });
  h.eventLog.set("thr_caller", [
    { seq: 1, type: "turn/started", createdAt: T0, data: {} },
    { seq: 2, type: "turn/completed", createdAt: T0 + 10, data: {} },
  ]);
  h.queues.set("thr_caller", []);
  await wd.onThreadIdle({ id: "thr_caller", status: "idle" } as WatchdogThreadDto);
  await wd.onThreadIdle({ id: "thr_caller", status: "idle" } as WatchdogThreadDto);
  const errors = JSON.parse(
    h.store.get(delegation.id)!.setup_errors,
  ) as { step: string }[];
  assert.equal(
    errors.filter((e) => e.step === "helpers-pending").length,
    1,
  );
});

test("review: `HLP-1 · …` from tasks is an executor, not a helper", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.insert({
    taskKey: "HLP-1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "s",
    preset: "opus",
    provider: "p",
  });
  const probes: RoleDecisionProbes = {
    threadRole: (id) => store.threadRole(id),
    pendingRole: () => undefined,
    activeDelegationByTaskKey: (key) =>
      store.activeByTaskKey(key),
    helperById: () => undefined,
  };
  handleMessageDispatch(
    makeMessageDispatchHookContext({
      thread: {
        id: "thr_hlp",
        status: "pending",
        parentThreadId: null,
        originPluginId: "tasks",
        title: "HLP-1 · clean up the helpers",
      },
      attempt: "start-turn",
      project: { id: "proj_a" },
    }),
    probes,
    (id, role) => store.setThreadRole(id, role, "hook"),
  );
  assert.equal(store.threadRole("thr_hlp")!.role, "executor");
});

test("review: archived helper lifts the executor's wait within the window", async () => {
  const h = makeDeps();
  executorCaller(h);
  const res = await runHelper({ prompt: "x", threadId: "thr_caller" }, h.deps);
  // The helper thread is archived — the helper watchdog cancels it…
  await h.helperWd().onThreadGone({ id: "thr_h1" }, "archived");
  assert.equal(h.store.helper(res.helperId)!.status, "cancelled");
  // …and the delegation's wait mark resolves on the next beat: stamped
  // zero-time, then the window/outcome path — not a stuck "waiting".
  const delegation = h.store.byThreadId("thr_caller")!;
  h.store.addSetupError(delegation.id, "helpers-pending", "waiting");
  const bbCli = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  let nowMs = T0;
  const wd = createWatchdog({
    store: h.store,
    bbCli,
    threads: h.threads,
    loadPolicy: h.deps.loadPolicy,
    dispatchToRoute: async () => {
      throw new Error("unreachable");
    },
    dispatchSteps: async () => {
      throw new Error("unreachable");
    },
    retrySetup: async () => [],
    enqueue: (fn: () => Promise<unknown>) => fn(),
    t: T,
    now: () => nowMs,
  } as never);
  h.store.setTurnStarted(delegation.id, T0);
  await wd.checkTimers();
  const mark = h.store.findSetupError(
    h.store.get(delegation.id)!,
    "helpers-pending",
  );
  assert.ok(mark && mark.message !== "waiting");
});
