/**
 * Spec §4 tests (docs/specs/hide-dispatched.md r2) against the fake plugin host.
 *
 *   node --experimental-strip-types --import ./tests/ts-resolver.mjs --test tests/*.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

const KV_KEY = "hide-dispatched:state";

type UpdateCall = { threadId: string; visibility?: string };

async function loadPlugin(options?: {
  settings?: Record<string, string | number | boolean>;
  updateImpl?: (args: UpdateCall) => Promise<unknown>;
  listThreads?: unknown[];
}) {
  const updateCalls: UpdateCall[] = [];
  const host = createFakePluginHost({
    pluginId: "hide-dispatched",
    settings: options?.settings,
    sdk: {
      threads: {
        update: async (args: UpdateCall) => {
          updateCalls.push(args);
          return options?.updateImpl
            ? options.updateImpl(args)
            : makeThreadResponse({ id: args.threadId, visibility: "hidden" });
        },
        list: async () => options?.listThreads ?? [],
      },
    },
  });
  await plugin(host.bb);
  return {
    host,
    updateCalls,
    emit: (event: string, arg: unknown) =>
      // pass { thread } for thread.* events or a full payload for parentChanged
      host.harness.emitThreadEvent(
        event as never,
        (arg !== null && typeof arg === "object" && "thread" in (arg as object)
          ? arg
          : { thread: arg }) as never,
      ),
    kv: () => host.bb.storage.kv.get<Record<string, unknown>>(KV_KEY),
    logs: () => host.harness.inspection.logEntries,
    runCli: (argv: string[]) => host.harness.runCli(argv),
  };
}

// §4 — тред с родителем (cli/sdk/plugin, любой источник) → скрыт
test("child thread from cli/sdk/plugin is hidden on creation", async () => {
  for (const originPluginId of [null, "some-plugin"]) {
    const { emit, updateCalls } = await loadPlugin();
    const thread = makeThreadResponse({
      id: `thr-child-${originPluginId ?? "cli"}`,
      parentThreadId: "thr-parent",
      originPluginId,
    });
    const { errors } = await emit("thread.created", thread);
    assert.deepEqual(errors, []);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].threadId, thread.id);
    assert.equal(updateCalls[0].visibility, "hidden");
  }
});

// §4 — без родителя от cli/app → не тронут
test("root thread without a parent is left alone", async () => {
  const { emit, updateCalls } = await loadPlugin();
  const { errors } = await emit(
    "thread.created",
    makeThreadResponse({ id: "thr-root", parentThreadId: null }),
  );
  assert.deepEqual(errors, []);
  assert.equal(updateCalls.length, 0);
});

// §4 — тред от отслеживаемого плагина скрывается и без родителя (r1)
test("thread from a tracked plugin is hidden even without a parent", async () => {
  const { emit, updateCalls } = await loadPlugin();
  await emit(
    "thread.created",
    makeThreadResponse({ id: "thr-task", originPluginId: "tasks" }),
  );
  assert.equal(updateCalls.length, 1);
});

// §4 — родитель назначен позже → скрыт по parentChanged
test("thread is hidden when a parent is assigned later via parentChanged", async () => {
  const { emit, updateCalls } = await loadPlugin();
  const thread = makeThreadResponse({ id: "thr-late", parentThreadId: null });
  await emit("thread.created", thread);
  assert.equal(updateCalls.length, 0);
  const { errors } = await emit("experimental_thread.parentChanged", {
    thread: { ...thread, parentThreadId: "thr-parent" },
    previousParentThreadId: null,
  });
  assert.deepEqual(errors, []);
  assert.equal(updateCalls.length, 1);
});

// §4 — без события parentChanged → запасной путь thread.active
test("fallback path: thread.active hides when parentChanged never fires", async () => {
  const { emit, updateCalls } = await loadPlugin();
  const thread = makeThreadResponse({ id: "thr-active", parentThreadId: null });
  await emit("thread.created", thread);
  assert.equal(updateCalls.length, 0);
  const { errors } = await emit("thread.active", {
    ...thread,
    parentThreadId: "thr-parent",
  });
  assert.deepEqual(errors, []);
  assert.equal(updateCalls.length, 1);
});

// §4 — не скрыт на создании → перепроверяется, а не «рассмотрен навсегда»
test("a thread not hidden at creation is re-checked on later events", async () => {
  const { emit, updateCalls } = await loadPlugin();
  const thread = makeThreadResponse({ id: "thr-recheck", parentThreadId: null });
  await emit("thread.created", thread);
  await emit("thread.active", thread); // still no parent -> no hide
  assert.equal(updateCalls.length, 0);
  await emit("thread.active", { ...thread, parentThreadId: "thr-parent" });
  assert.equal(updateCalls.length, 1);
});

// §4 — форк не трогаем; hideForks = true → скрыт
test("fork is not hidden by default, hidden when hideForks is on", async () => {
  const plain = await loadPlugin();
  await plain.emit(
    "thread.created",
    makeThreadResponse({
      id: "thr-fork",
      parentThreadId: "thr-parent",
      originKind: "fork",
    }),
  );
  assert.equal(plain.updateCalls.length, 0);

  const hiding = await loadPlugin({ settings: { hideForks: true } });
  await hiding.emit(
    "thread.created",
    makeThreadResponse({
      id: "thr-fork2",
      parentThreadId: "thr-parent",
      originKind: "fork",
    }),
  );
  assert.equal(hiding.updateCalls.length, 1);
});

// §4 — человек показал скрытый плагином тред → второй раз не скрывается
test("a thread the human re-showed is never hidden twice", async () => {
  const { emit, updateCalls } = await loadPlugin();
  const thread = makeThreadResponse({ id: "thr-reshow", parentThreadId: "thr-parent" });
  await emit("thread.created", thread);
  assert.equal(updateCalls.length, 1);
  // человек вернул видимость — следующие события тред уже в множестве
  const shown = { ...thread, visibility: "visible" };
  await emit("thread.active", shown);
  await emit("experimental_thread.parentChanged", {
    thread: shown,
    previousParentThreadId: "thr-parent",
  });
  assert.equal(updateCalls.length, 1);
});

// §4 — создан уже скрытым → записан без вызова API, после ручного показа не скрывается
test("an already-hidden thread is recorded without an API call", async () => {
  const { emit, updateCalls, kv } = await loadPlugin();
  const thread = makeThreadResponse({
    id: "thr-prehidden",
    parentThreadId: "thr-parent",
    visibility: "hidden",
  });
  await emit("thread.created", thread);
  assert.equal(updateCalls.length, 0);
  const state = await kv();
  const hidden = (state?.hidden ?? {}) as Record<string, number>;
  assert.ok(hidden["thr-prehidden"] !== undefined, "recorded in the hidden set");
  // человек показал тред — плагин не скрывает обратно
  await emit("thread.active", { ...thread, visibility: "visible" });
  assert.equal(updateCalls.length, 0);
});

// §4 — hideChildren = false → только tracked
test("hideChildren=false restores r1: only tracked plugins are hidden", async () => {
  const { emit, updateCalls } = await loadPlugin({ settings: { hideChildren: false } });
  await emit(
    "thread.created",
    makeThreadResponse({ id: "thr-child", parentThreadId: "thr-parent" }),
  );
  assert.equal(updateCalls.length, 0);
  await emit(
    "thread.created",
    makeThreadResponse({ id: "thr-task", originPluginId: "tasks" }),
  );
  assert.equal(updateCalls.length, 1);
});

// §4 — ошибка update → журнал, без исключения наружу; повтор на след. событии
test("update failure is logged, does not throw, and retries on next event", async () => {
  let failFirst = true;
  const { emit, updateCalls, logs } = await loadPlugin({
    updateImpl: async (args) => {
      if (failFirst) throw new Error("server exploded");
      return makeThreadResponse({ id: args.threadId, visibility: "hidden" });
    },
  });
  const thread = makeThreadResponse({ id: "thr-flaky", parentThreadId: "thr-parent" });
  const { errors } = await emit("thread.created", thread);
  assert.deepEqual(errors, []);
  assert.equal(updateCalls.length, 1);
  assert.ok(
    logs().some((l) => l.level === "error" && l.message.includes("thr-flaky")),
    "failure was logged",
  );
  // не в множестве → повторная попытка на следующем событии
  failFirst = false;
  await emit("thread.active", thread);
  assert.equal(updateCalls.length, 2);
});

// §4 — выключенный плагин ничего не делает
test("disabled plugin hides nothing", async () => {
  const { emit, updateCalls, runCli } = await loadPlugin();
  await runCli(["off"]);
  await emit(
    "thread.created",
    makeThreadResponse({ id: "thr-off", parentThreadId: "thr-parent" }),
  );
  assert.equal(updateCalls.length, 0);
});

// §3 — status показывает обе настройки
test("status shows hideChildren and hideForks", async () => {
  const { runCli } = await loadPlugin();
  const res = await runCli(["status"]);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /hideChildren: true/);
  assert.match(res.stdout, /hideForks: false/);
});

// §3 — sweep скрывает видимые неархивные треды по правилам §1, не трогает уже записанные
test("sweep hides matching visible threads and skips recorded ones", async () => {
  const child = makeThreadResponse({ id: "thr-sweep-child", parentThreadId: "thr-parent" });
  const root = makeThreadResponse({ id: "thr-sweep-root" });
  const recorded = makeThreadResponse({
    id: "thr-sweep-recorded",
    parentThreadId: "thr-parent",
  });
  const { emit, runCli, updateCalls } = await loadPlugin({
    listThreads: [child, root, recorded],
  });
  // записываем recorded через поток событий как уже скрытый
  await emit("thread.created", { ...recorded, visibility: "hidden" });
  assert.equal(updateCalls.length, 0);
  const res = await runCli(["sweep"]);
  assert.equal(res.exitCode, 0);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].threadId, "thr-sweep-child");
});
