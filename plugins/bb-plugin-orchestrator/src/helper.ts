/**
 * Helpers (spec §19.1–§19.6, r33): plugin-created worker threads — a
 * hidden child of the caller, running in the caller's OWN environment
 * (`{type:"reuse"}`), supervised by the watchdog, with the result
 * delivered by BB's parent notifications. No tracker task is created
 * or attached; the helper role is fixed (`helper`).
 *
 * Caller authorization (§19.1): a root `orchestrator`, a root
 * `executor`, a delegation's running executor thread, or a fork/side
 * chat inheriting one of those roles through `sourceThreadId`. Every
 * other caller (a helper itself, `none`, auditor, a role-less thread)
 * gets a stable refusal code; manual `bb thread spawn`/`bb tasks
 * dispatch` children are refused by the §19.5 hook gate instead.
 */

import { OrchestratorError } from "./errors.js";
import { pickRoute, type PolicyLoad } from "./policy.js";
import { NO_ROLE, isRoleId } from "./roles.js";
import type { SpawnThreadArgs } from "./delegate.js";
import type {
  DelegationStore,
  HelperRow,
} from "./store.js";
import type { T } from "./i18n/index.js";

/** §19.1: active helper statuses (dispatching counts — a spawn in
 * flight occupies its slot). */
const HELPER_ACTIVE = new Set(["dispatching", "running"]);

/** §19.1: a dispatching row without a found child is declared lost
 * after two minutes — same window as §4's fresh-dispatching marker. */
const HELPER_DISPATCH_GRACE_MS = 2 * 60 * 1000;

/** §19.6: a terminal helper's thread is archived after 24 h — never
 * deleted. */
const HELPER_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

/** §19.1: the caller facts `runHelper` needs — the gate inputs plus the
 * reuse target (`environmentId`) and the child's project. */
export interface HelperCallerFacts {
  threadId: string;
  parentThreadId: string | null;
  sourceThreadId?: string | null;
  originPluginId: string | null;
  projectId: string;
  environmentId: string | null;
}

/** The `helpers` setting (§19.1 config): the per-caller and global
 * caps and the default level. */
export interface HelpersSettings {
  maxActive?: number;
  maxPerCaller: number;
  defaultLevel?: string;
}

export const DEFAULT_HELPERS: HelpersSettings = {
  maxActive: undefined,
  maxPerCaller: 3,
};

/** `helpers` setting JSON — `{maxActive?, maxPerCaller?, defaultLevel?}`;
 * bad values read as warnings and fall back to defaults (setup/status
 * surface the errors). */
export function parseHelpersSettings(
  raw: string,
  t: T,
): { config: HelpersSettings; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = [];
  const cfg: HelpersSettings = { ...DEFAULT_HELPERS };
  const trimmed = raw.trim();
  if (!trimmed) return { config: cfg, errors };
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch (e) {
    errors.push({
      path: "helpers",
      message: e instanceof Error ? e.message : String(e),
    });
    return { config: cfg, errors };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    errors.push({ path: "helpers", message: t("set.helpersNotObject") });
    return { config: cfg, errors };
  }
  const o = doc as Record<string, unknown>;
  const int = (key: "maxActive" | "maxPerCaller") => {
    const v = o[key];
    if (v === undefined) return;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
      if (key === "maxActive") cfg.maxActive = v;
      else cfg.maxPerCaller = v;
    } else {
      errors.push({
        path: `helpers.${key}`,
        message: t("set.helpersBadInt"),
      });
    }
  };
  int("maxActive");
  int("maxPerCaller");
  if (o.defaultLevel !== undefined) {
    if (typeof o.defaultLevel === "string" && o.defaultLevel.trim()) {
      cfg.defaultLevel = o.defaultLevel.trim();
    } else {
      errors.push({
        path: "helpers.defaultLevel",
        message: t("set.helpersBadLevel"),
      });
    }
  }
  return { config: cfg, errors };
}

export interface SpawnHelperArgs extends SpawnThreadArgs {
  /** §19.1: the caller owns the helper's lifecycle — its archive/delete
   * cascades to the helper. */
  lifecycleOwnerThreadId?: string;
}

export interface HelperThreadDto {
  id: string;
  status?: string | null;
  createdAt?: number | null;
  parentThreadId?: string | null;
  originPluginId?: string | null;
  environmentId?: string | null;
  projectId?: string | null;
  visibility?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

export interface HelperThreadEvent {
  seq: number;
  type: string;
  createdAt: number;
  data: Record<string, unknown>;
}

/** The `bb.sdk.threads` surface the helper paths use. */
export interface HelperThreads {
  get(args: { threadId: string }): Promise<HelperThreadDto>;
  spawn(args: SpawnHelperArgs): Promise<{ id?: string }>;
  send(args: {
    threadId: string;
    mode?: string;
    input: { type: string; text: string; mentions?: unknown[] }[];
  }): Promise<unknown>;
  stop(args: { threadId: string }): Promise<unknown>;
  list(args: {
    parentThreadId?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<{ id: string; createdAt?: number | null }[]>;
  getPluginMetadata?(args: {
    threadId: string;
  }): Promise<Record<string, unknown> | null | undefined>;
  archive?(args: { threadId: string }): Promise<unknown>;
  events: {
    list(args: {
      threadId: string;
      afterSeq?: number;
      limit?: string | number;
      types?: readonly string[];
    }): Promise<HelperThreadEvent[]>;
  };
}

export interface HelperDeps {
  store: DelegationStore;
  threads: HelperThreads;
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  /** The live parsed policy (§19.1 needs-configuration input). */
  loadPolicy(): Promise<PolicyLoad>;
  helpers(): HelpersSettings;
  callerFacts(threadId: string): Promise<HelperCallerFacts>;
  t: T;
  now?: () => number;
  log?: { warn?(m: string): void };
}

export interface HelperInput {
  prompt: string;
  title?: string;
  level?: string;
  preset?: string;
  /** The calling thread — tool's `ctx.threadId` or CLI's. */
  threadId?: string;
}

export interface HelperResult {
  helperId: number;
  threadId?: string;
  preset: string;
  route: string;
  level: string;
}

/** §19.1: `helper#<id> · <title>` at most 120 characters; without an
 * explicit title the first prompt words make it. */
export function helperTitle(id: number, base: string): string {
  const prefix = `helper#${id} · `;
  const room = Math.max(0, 120 - prefix.length);
  const cleaned = base.replace(/\s+/g, " ").trim();
  return prefix + cleaned.slice(0, room).trim();
}

const firstPromptWords = (prompt: string): string =>
  prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 10).join(" ");

/**
 * §19.1 caller gate — the recorded role decides (the hook already
 * resolved forks/side chats through `sourceThreadId`; a missing row on
 * a fork falls back to the source's role here).
 */
async function authorizeCaller(
  input: HelperInput,
  deps: HelperDeps,
): Promise<{ caller: HelperCallerFacts; role: string }> {
  if (!input.threadId) {
    throw new OrchestratorError(
      "no-caller-thread",
      "helper works only from a bb thread (BB_THREAD_ID is absent)",
      "run it inside a thread, or via the orchestrator_helper tool",
    );
  }
  const caller = await deps.callerFacts(input.threadId);
  let role = deps.store.threadRole(input.threadId)?.role;
  if (
    role === undefined &&
    caller.sourceThreadId !== null &&
    caller.sourceThreadId !== undefined
  ) {
    role = deps.store.threadRole(caller.sourceThreadId)?.role;
  }
  if (role === undefined || role === null) {
    throw new OrchestratorError(
      "no-role",
      `calling thread ${input.threadId} has no orchestrator role`,
      "a role is assigned on the thread's first message — or pick one in the new-chat window",
    );
  }
  if (role === "helper") {
    throw new OrchestratorError(
      "helper-of-helper",
      "a helper cannot launch helpers",
    );
  }
  const isRoot =
    caller.parentThreadId === null || caller.parentThreadId === undefined;
  const runningDelegation = deps.store.byThreadId(input.threadId);
  const executorOk =
    isRoot || runningDelegation?.status === "running";
  const allowed =
    (role === "orchestrator" && isRoot) ||
    (role === "executor" && executorOk);
  if (!allowed) {
    throw new OrchestratorError(
      "caller-not-allowed",
      `role ${role} may not launch helpers`,
      "allowed: a root orchestrator, a root executor, a running delegation executor",
    );
  }
  return { caller, role };
}

/** §19.1: resolve the route — a named preset maps to the policy route
 * carrying it (`preset-not-allowed` for foreign presets); a level goes
 * through `pickRoute`'s chain. Neither → `helpers.defaultLevel`. */
function resolveRoute(
  input: HelperInput,
  policy: NonNullable<PolicyLoad["policy"]>,
  load: PolicyLoad,
  deps: HelperDeps,
): { level: string; routeName: string; preset: string } {
  const cfg = deps.helpers();
  const level = input.level ?? cfg.defaultLevel;
  if (input.preset !== undefined) {
    const found = Object.entries(policy.routes).find(
      ([, r]) => r.preset === input.preset,
    );
    if (!found) {
      throw new OrchestratorError(
        "preset-not-allowed",
        `preset "${input.preset}" is not in the policy`,
        "helpers run only on policy routes (ADR r33)",
      );
    }
    const [name, route] = found;
    if (load.unavailableRoutes.includes(name)) {
      throw new OrchestratorError(
        "route-unavailable",
        `route "${name}" is unavailable (missing preset or route/quota hold)`,
      );
    }
    if (level !== undefined && !policy.levels[level]) {
      throw new OrchestratorError(
        "unknown-level",
        `level "${level}" is not in the policy`,
        `levels: ${Object.keys(policy.levels).join(", ")}`,
      );
    }
    return { level: level ?? name, routeName: name, preset: route.preset };
  }
  if (level === undefined) {
    throw new OrchestratorError(
      "invalid-arguments",
      "helper needs --level <level> or --preset <id> " +
        "(or helpers.defaultLevel in the settings)",
    );
  }
  const picked = pickRoute(policy, level, {
    unavailableRoutes: new Set(load.unavailableRoutes),
    heldGroups: deps.store.heldGroups(deps.now?.() ?? Date.now()),
  });
  return { level, routeName: picked.name, preset: picked.route.preset };
}

/** §19.1: the whole admission — gate, policy, route, the atomic
 * limit-checked row, the reuse spawn, the role write, the launch
 * notice. Runs inside `enqueue` so a concurrent `delegate`/`helper`
 * cannot race the limits. */
export async function runHelper(
  input: HelperInput,
  deps: HelperDeps,
): Promise<HelperResult> {
  return deps.enqueue(async () => {
    const { caller } = await authorizeCaller(input, deps);
    const load = await deps.loadPolicy();
    if (!load.policy) {
      throw new OrchestratorError(
        "needs-configuration",
        "the policy is not configured or is invalid",
        "setup — the orchestrator-setup skill, then `bb orchestrator policy validate`",
      );
    }
    const route = resolveRoute(input, load.policy, load, deps);
    if (caller.environmentId === null || caller.environmentId === undefined) {
      throw new OrchestratorError(
        "needs-configuration",
        `calling thread ${input.threadId} has no environment to reuse`,
        "helpers run inside the caller's environment — the caller must be running",
      );
    }
    const cfg = deps.helpers();
    const delegation = deps.store.byThreadId(input.threadId!);
    const row = deps.store.insertHelperChecked(
      {
        callerThreadId: input.threadId!,
        callerDelegationId:
          delegation &&
          (delegation.status === "running" ||
            delegation.status === "dispatching")
            ? delegation.id
            : null,
        coordinatorThreadId:
          delegation?.coordinator_thread_id ?? input.threadId!,
        projectId: caller.projectId,
        preset: route.preset,
        route: route.routeName,
        level: route.level,
        title: input.title ?? null,
      },
      {
        perCaller: cfg.maxPerCaller,
        helpersMax: cfg.maxActive,
        sharedMax: load.policy.limits?.maxActive,
      },
    );
    const title = helperTitle(
      row.id,
      input.title ?? firstPromptWords(input.prompt) ?? "helper",
    );
    let spawned: { id?: string } | undefined;
    try {
      spawned = await deps.threads.spawn({
        projectId: caller.projectId,
        environment: { type: "reuse", environmentId: caller.environmentId },
        title,
        prompt: input.prompt,
        parentThreadId: input.threadId,
        parentNotifications: "auto",
        lifecycleOwnerThreadId: input.threadId,
        visibility: "hidden",
        pluginMetadata: { helperId: row.id },
      });
    } catch (e) {
      deps.store.setHelperStatus(row.id, "failed");
      throw new OrchestratorError(
        "dispatch-failed",
        `helper spawn refused: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const threadId = spawned?.id;
    if (threadId) {
      deps.store.setHelperThread(row.id, threadId);
      deps.store.setThreadRole(threadId, "helper", "delegate");
      deps.store.setHelperTurnStarted(row.id, deps.now?.() ?? Date.now());
      deps.store.setHelperStatusIf(row.id, "dispatching", "running");
      // §19.1: the launch notice — the helper's own result arrives via
      // BB parent notifications; the plugin does not wait for it.
      await deps.threads
        .send({
          threadId: input.threadId!,
          mode: "queue-if-active",
          input: [
            {
              type: "text",
              text: `[orchestrator] ${deps.t("wd.helperStarted", {
                id: row.id,
                title,
                thread: threadId,
              })}`,
              mentions: [],
            },
          ],
        })
        .catch((e) =>
          deps.log?.warn?.(
            `orchestrator: helper launch notice: ${describeErr(e)}`,
          ),
        );
    }
    // No id → the row stays `dispatching`; the watchdog reconciles it by
    // `pluginMetadata.helperId` within the grace window (§19.1).
    return {
      helperId: row.id,
      threadId,
      preset: route.preset,
      route: route.routeName,
      level: route.level,
    };
  });
}

/** §19.1 cancellation: mark the row BEFORE stopping the thread, so the
 * watchdog reads the stop as plugin-owned. Without a known `thread_id`
 * the reconcile pass stops the child when it surfaces. */
export async function cancelHelper(
  ref: string,
  deps: HelperDeps,
  callerThreadId?: string,
): Promise<{ helperId: number; threadId?: string; already?: boolean }> {
  return deps.enqueue(async () => {
    const row = /^\d+$/.test(ref)
      ? deps.store.helper(Number(ref))
      : deps.store.helperByThreadId(ref);
    if (!row) {
      throw new OrchestratorError(
        "not-found",
        deps.t("cli.noHelper", { ref }),
      );
    }
    if (
      callerThreadId &&
      callerThreadId !== row.caller_thread_id &&
      callerThreadId !== row.coordinator_thread_id
    ) {
      throw new OrchestratorError(
        "caller-not-allowed",
        `thread ${callerThreadId} may not cancel helper#${row.id}`,
        "only the helper's caller or its delegation coordinator may cancel",
      );
    }
    if (!HELPER_ACTIVE.has(row.status)) {
      return { helperId: row.id, threadId: row.thread_id ?? undefined, already: true };
    }
    for (const from of ["dispatching", "running"] as const) {
      if (deps.store.setHelperStatusIf(row.id, from, "cancelled")) break;
    }
    if (row.thread_id) {
      await deps.threads
        .stop({ threadId: row.thread_id })
        .catch((e) =>
          deps.log?.warn?.(
            `orchestrator: helper#${row.id} stop: ${describeErr(e)}`,
          ),
        );
    }
    return { helperId: row.id, threadId: row.thread_id ?? undefined };
  });
}

/** §19.4 `role set <thread> <role>` — a manual role write: refuses
 * while active delegations/helpers make the change unsafe, refuses
 * `orchestrator` on non-root or plugin-born threads, records
 * `role.manual`. */
export async function runRoleSet(
  input: { threadId: string; role: string; actor?: string },
  deps: HelperDeps,
): Promise<{ threadId: string; role: string; previous: string | null }> {
  return deps.enqueue(async () => {
    const allowed = new Set(["none", "orchestrator", "executor", "auditor"]);
    if (!allowed.has(input.role)) {
      throw new OrchestratorError(
        "role-not-allowed",
        `role "${input.role}" cannot be set manually`,
        `allowed: ${[...allowed].join(", ")}`,
      );
    }
    const busy = deps.store.activeRoleParticipation(input.threadId);
    const active = Object.entries(busy).filter(([, v]) => v !== null);
    if (active.length) {
      throw new OrchestratorError(
        "role-active",
        `thread ${input.threadId} participates in active work: ` +
          active.map(([k, v]) => `${k}#${v}`).join(", "),
        "finish or cancel the delegations/helpers first",
      );
    }
    const previous = deps.store.threadRole(input.threadId)?.role ?? null;
    if (input.role === "orchestrator") {
      // Strict r33: a coordinator is only ever a ROOT thread of a human
      // or app — a child or a plugin-born thread cannot be promoted.
      const thread = await deps.threads.get({ threadId: input.threadId });
      if (thread.parentThreadId || thread.originPluginId) {
        throw new OrchestratorError(
          "role-not-allowed",
          "only a root human thread can take the orchestrator role",
        );
      }
    }
    deps.store.setRoleManual(
      input.threadId,
      input.role,
      input.actor ?? "cli",
    );
    return { threadId: input.threadId, role: input.role, previous };
  });
}

export const describeErr = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ── Helper watchdog (§19.1 table + cascades) ─────────────────────────

export interface HelperWatchdogDeps extends HelperDeps {
  /** §19.1 outcomes: the caller gets exactly one line per terminal
   * outcome — the `notified_at` mark dedupes restarts. */
  callerSend(threadId: string, text: string): Promise<unknown>;
}

export function createHelperWatchdog(deps: HelperWatchdogDeps) {
  /** In-memory once-per-process marks — `notified_at` covers the
   * restart-durable terminal lines; an approval reminder may repeat
   * once after a plugin restart (bounded, harmless). */
  const approvalReminded = new Set<number>();


  const row = (id: number) => deps.store.helper(id);

  /** The one terminal line per outcome (`notified_at` dedupes). */
  const notifyOnce = async (r: HelperRow, text: string) => {
    if (r.notified_at !== null) return;
    deps.store.setHelperNotified(r.id, deps.now?.() ?? Date.now());
    await deps.callerSend(r.caller_thread_id, text).catch((e) =>
      deps.log?.warn?.(`orchestrator: helper#${r.id} notice: ${describeErr(e)}`),
    );
  };

  const finish = async (r: HelperRow, status: HelperRow["status"], text?: string) => {
    if (!HELPER_ACTIVE.has(r.status)) return;
    deps.store.setHelperStatus(r.id, status);
    if (text) await notifyOnce({ ...r, status }, text);
  };

  const cancelRow = async (r: HelperRow) => {
    for (const from of ["dispatching", "running"] as const) {
      if (deps.store.setHelperStatusIf(r.id, from, "cancelled")) {
        if (r.thread_id) {
          await deps.threads
            .stop({ threadId: r.thread_id })
            .catch(() => undefined);
        }
        return;
      }
    }
  };

  /** §19.1 cascade: every active helper of a caller that left its
   * running state — archive/delete or a delegation outcome — is
   * cancelled. */
  const cancelHelpersOfCaller = async (callerThreadId: string) => {
    for (const r of deps.store.activeHelpersByCaller(callerThreadId)) {
      await cancelRow(r);
    }
  };
  const cancelHelpersOfDelegation = async (delegationId: number) => {
    for (const r of deps.store.activeHelpersByDelegation(delegationId)) {
      await cancelRow(r);
    }
  };

  /** §19.1 dispatching reconcile: find the child by
   * `pluginMetadata.helperId` among the caller's children; link it and
   * finish setup — or stop it when the row was cancelled meanwhile. */
  const tryRelink = async (r: HelperRow): Promise<boolean> => {
    let children: { id: string }[] = [];
    try {
      children = await deps.threads.list({
        parentThreadId: r.caller_thread_id,
        includeHidden: true,
        limit: 50,
      });
    } catch {
      return false;
    }
    for (const c of children) {
      let meta: Record<string, unknown> | null | undefined;
      try {
        meta = await deps.threads.getPluginMetadata?.({ threadId: c.id });
      } catch {
        continue;
      }
      if (meta?.helperId !== r.id) continue;
      if (!HELPER_ACTIVE.has(r.status)) {
        await deps.threads.stop({ threadId: c.id }).catch(() => undefined);
        return true;
      }
      deps.store.setHelperThread(r.id, c.id);
      deps.store.setThreadRole(c.id, "helper", "delegate");
      deps.store.setHelperTurnStarted(r.id, deps.now?.() ?? Date.now());
      deps.store.setHelperStatusIf(r.id, "dispatching", "running");
      return true;
    }
    return false;
  };

  const t = () => deps.t;

  return {
    cancelHelpersOfCaller,
    cancelHelpersOfDelegation,

    /** Helper thread went idle → the turn ended normally → `done`.
     * BB's parent notification carries the result; no plugin line. */
    onThreadIdle: async (thread: { id: string; status?: string | null }) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (!r || !HELPER_ACTIVE.has(r.status)) return;
      if (thread.status !== "idle") return;
      deps.store.clearHelperTurn(r.id);
      await finish(r, "done");
    },

    onThreadActive: async (thread: { id: string }) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (r && HELPER_ACTIVE.has(r.status) && r.turn_started_at === null) {
        deps.store.setHelperTurnStarted(r.id, deps.now?.() ?? Date.now());
      }
    },

    /** thread.failed → `failed` (a quota-shaped error → `quota`). */
    onThreadFailed: async (
      thread: { id: string },
      error?: { message?: string },
    ) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (!r || !HELPER_ACTIVE.has(r.status)) return;
      const msg = error?.message ?? "";
      const quota = /quota|rate.?limit|insufficient|credits/i.test(msg);
      await finish(
        r,
        quota ? "quota" : "failed",
        t()(quota ? "wd.helperQuota" : "wd.helperFailed", {
          id: r.id,
          detail: msg.slice(0, 200),
        }),
      );
    },

    /** §19.1 `interrupted`: one continuation; a second interruption is
     * `stalled`. `resume_count` counts issued continuations. */
    onTurnFailed: async (event: { threadId: string }) => {
      const r = deps.store.helperByThreadId(event.threadId);
      if (!r || !HELPER_ACTIVE.has(r.status) || !r.thread_id) return;
      if (r.resume_count >= 1) {
        await finish(
          r,
          "stalled",
          t()("wd.helperStalled", { id: r.id }),
        );
        return;
      }
      deps.store.bumpHelperResume(r.id);
      deps.store.setHelperTurnStarted(r.id, deps.now?.() ?? Date.now());
      await deps.threads
        .send({
          threadId: r.thread_id,
          mode: "queue-if-active",
          input: [
            {
              type: "text",
              text: t()("wd.helperResume"),
              mentions: [],
            },
          ],
        })
        .catch((e) =>
          deps.log?.warn?.(
            `orchestrator: helper#${r.id} resume: ${describeErr(e)}`,
          ),
        );
    },

    /** §19.1 `approval`: one reminder line to the caller. */
    onInteractionPending: async (thread: { id: string }) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (!r || !HELPER_ACTIVE.has(r.status)) return;
      if (approvalReminded.has(r.id)) return;
      approvalReminded.add(r.id);
      await deps.callerSend(
        r.caller_thread_id,
        `[orchestrator] ${t()("wd.helperApproval", { id: r.id })}`,
      ).catch(() => undefined);
    },

    /** §19.1 cascades on archive/delete: a helper thread that vanished
     * is `cancelled` + one «removed manually» line; a gone caller cancels
     * ALL its active helpers. */
    onThreadGone: async (thread: { id: string }, kind: string) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (r && HELPER_ACTIVE.has(r.status)) {
        deps.store.setHelperStatus(r.id, "cancelled");
        await notifyOnce(
          { ...r, status: "cancelled" },
          t()("wd.helperRemoved", { id: r.id, kind }),
        );
      }
      await cancelHelpersOfCaller(thread.id);
    },

    /** Silence + dispatch-grace checks on the short beat (no external
     * reads except the helper's own journal). */
    checkTimers: async () => {
      const now = deps.now?.() ?? Date.now();
      const load = await deps
        .loadPolicy()
        .catch(() => ({ policy: null }) as PolicyLoad);
      const firstMs =
        (load.policy?.firstResponseSeconds ?? 60) * 1000;
      for (const r of deps.store.listActiveHelpers()) {
        if (
          r.status === "dispatching" &&
          !r.thread_id &&
          now - r.created_at > HELPER_DISPATCH_GRACE_MS
        ) {
          await finish(
            r,
            "failed",
            t()("wd.helperDispatchLost", { id: r.id }),
          );
          continue;
        }
        if (r.status !== "running" || r.turn_started_at === null) continue;
        // Silence: no journal events since `turn_started_at` (which the
        // last-seen event time refreshes below).
        let latest = r.turn_started_at;
        try {
          const events = await deps.threads.events.list({
            threadId: r.thread_id!,
            afterSeq: r.last_seq ?? undefined,
            limit: 50,
          });
          if (events.length) {
            const last = events[events.length - 1]!;
            deps.store.advanceHelperLastSeq(r.id, last.seq);
            latest = Math.max(latest, last.createdAt);
            deps.store.setHelperTurnStarted(r.id, latest);
            continue;
          }
        } catch {
          continue;
        }
        if (now - latest > firstMs) {
          await finish(
            r,
            "stalled",
            t()("wd.helperStalled", { id: r.id }),
          );
        }
      }
    },

    /** The 60 s reconcile: relink dispatching rows, drop helpers whose
     * thread vanished, run the caller/delegation cascades, archive
     * terminal helpers after 24 h (never delete). */
    reconcile: async () => {
      const now = deps.now?.() ?? Date.now();
      const errors: string[] = [];
      for (const r of deps.store.listActiveHelpers()) {
        try {
          if (r.status === "dispatching") {
            if (!r.thread_id) await tryRelink(r);
          } else if (r.thread_id) {
            const thread = await deps.threads
              .get({ threadId: r.thread_id })
              .catch(() => undefined);
            if (!thread) {
              await finish(
                r,
                "failed",
                t()("wd.helperGone", { id: r.id }),
              );
            } else if (thread.archivedAt || thread.deletedAt) {
              deps.store.setHelperStatus(r.id, "cancelled");
              await notifyOnce(r, t()("wd.helperRemoved", { id: r.id, kind: "archived" }));
            }
          }
          // Cascades: the caller delegation left `running`, or the
          // caller thread vanished.
          const fresh = row(r.id);
          if (fresh && HELPER_ACTIVE.has(fresh.status)) {
            if (fresh.caller_delegation_id !== null) {
              const d = deps.store.get(fresh.caller_delegation_id);
              if (!d || (d.status !== "running" && d.status !== "dispatching")) {
                await cancelRow(fresh);
                continue;
              }
            }
            const caller = await deps.threads
              .get({ threadId: fresh.caller_thread_id })
              .catch(() => undefined);
            if (!caller || caller.archivedAt || caller.deletedAt) {
              await cancelHelpersOfCaller(fresh.caller_thread_id);
            }
          }
        } catch (e) {
          errors.push(`helper#${r.id}: ${describeErr(e)}`);
        }
      }
      // §19.6: terminal helpers' threads archived after 24 h — never
      // deleted.
      if (deps.threads.archive) {
        for (const r of deps.store.listHelpers({ limit: 100 })) {
          if (
            HELPER_ACTIVE.has(r.status) ||
            !r.thread_id ||
            now - r.updated_at < HELPER_ARCHIVE_AFTER_MS
          ) {
            continue;
          }
          await deps.threads
            .archive({ threadId: r.thread_id })
            .catch(() => undefined);
        }
      }
      return { errors };
    },
  };
}
