/**
 * bb-plugin-hide-dispatched — скрывает из сайдбара служебные треды
 * (visibility: "hidden"): любой тред с родителем и треды от отслеживаемых
 * плагинов (bb tasks dispatch). Форки не трогаем по умолчанию (hideForks).
 *
 * Серверная часть. Подписки на thread.created, experimental_thread.parentChanged
 * и thread.active (запасной путь для серверов без parentChanged и повтор после
 * ошибки update) плюс CLI `bb hide-dispatched`.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

interface KvState {
  enabled: boolean;
  tracked: string[];
  hiddenCount: number;
  /** id -> ts записи. Треды, которые плагин скрыл или нашёл уже скрытыми — второй раз не трогаем. */
  hidden: Record<string, number>;
}

interface HideSettings {
  hideChildren: boolean;
  hideForks: boolean;
}

interface ThreadLike {
  id: string;
  parentThreadId: string | null;
  originKind: "fork" | null;
  originPluginId: string | null;
  visibility: "hidden" | "visible";
}

const DEFAULT_TRACKED = ["tasks"];
const KV_KEY = "hide-dispatched:state";
const HIDDEN_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const pruneHidden = (hidden: Record<string, number>): Record<string, number> => {
  const cutoff = Date.now() - HIDDEN_RECORD_TTL_MS;
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(hidden)) {
    if (typeof ts === "number" && ts > cutoff) out[id] = ts;
  }
  return out;
};

const errMsg = (err: unknown): string => (err as Error)?.message ?? String(err);

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-hide-dispatched loaded");

  const settings = bb.settings.define({
    hideChildren: {
      type: "boolean",
      label: "Hide child threads",
      description:
        "Скрывать любой тред с родителем, кем бы он ни был создан. Выкл — поведение r1: только треды от отслеживаемых плагинов.",
      default: true,
    },
    hideForks: {
      type: "boolean",
      label: "Hide fork threads",
      description:
        "Скрывать и форки (originKind = fork). Форк делает человек из интерфейса, поэтому по умолчанию он остаётся видимым.",
      default: false,
    },
  });

  const readState = async (): Promise<KvState> => {
    const state = await bb.storage.kv.get<KvState>(KV_KEY);
    return {
      enabled: state?.enabled ?? true,
      tracked: state?.tracked?.length ? state.tracked : DEFAULT_TRACKED,
      hiddenCount: state?.hiddenCount ?? 0,
      hidden: pruneHidden(state?.hidden ?? {}),
    };
  };

  const writeState = async (state: KvState): Promise<void> => {
    state.hidden = pruneHidden(state.hidden);
    await bb.storage.kv.set(KV_KEY, state);
  };

  const recordHidden = async (threadId: string, counted: boolean): Promise<void> => {
    const state = await readState();
    state.hidden[threadId] = Date.now();
    if (counted) state.hiddenCount += 1;
    await writeState(state);
  };

  const isTracked = (state: KvState, originPluginId: string | null | undefined): boolean => {
    if (!originPluginId) return false;
    return state.tracked.includes(originPluginId);
  };

  const shouldHide = (state: KvState, cfg: HideSettings, thread: ThreadLike): boolean => {
    if (isTracked(state, thread.originPluginId)) return true;
    if (!cfg.hideChildren) return false;
    if (!thread.parentThreadId) return false;
    if (thread.originKind === "fork" && !cfg.hideForks) return false;
    return true;
  };

  const considerThread = async (thread: ThreadLike, reason: string): Promise<void> => {
    try {
      const [state, cfg] = await Promise.all([readState(), settings.get()]);
      if (!state.enabled) return;
      // Уже обработан плагином (скрыт нами или найден скрытым) — не трогаем,
      // даже если человек сделал его видимым вручную.
      if (state.hidden[thread.id] !== undefined) return;
      // Решения пока нет (нет родителя, не tracked) — перепроверим на следующем событии.
      if (!shouldHide(state, cfg, thread)) return;
      if (thread.visibility === "hidden") {
        // Скрыт до нас (например, создан с visibility: hidden) — API не трогаем,
        // но запоминаем, иначе после ручного показа скрыли бы обратно.
        await recordHidden(thread.id, false);
        bb.log.info(`Recorded already-hidden thread ${thread.id} (${reason})`);
        return;
      }
      try {
        await bb.sdk.threads.update({ threadId: thread.id, visibility: "hidden" });
      } catch (err) {
        // Повтор — на следующем thread.active, не чаще одного раза на событие.
        bb.log.error(`hide-dispatched: failed to hide thread ${thread.id}: ${errMsg(err)}`);
        return;
      }
      await recordHidden(thread.id, true);
      bb.log.info(
        `Hidden thread ${thread.id} (${reason}; parent=${thread.parentThreadId ?? "none"}, originPluginId=${thread.originPluginId ?? "none"})`,
      );
    } catch (err) {
      // Падение подписчика не должно ломать создание тредов.
      bb.log.error(`hide-dispatched: failed to process thread ${thread.id}: ${errMsg(err)}`);
    }
  };

  bb.events.on("thread.created", async ({ thread }) => considerThread(thread, "thread.created"));
  bb.events.on("experimental_thread.parentChanged", async ({ thread }) =>
    considerThread(thread, "experimental_thread.parentChanged"),
  );
  // Запасной путь: сервер/SDK без experimental_thread.parentChanged и повтор
  // после ошибки update — не чаще одного скрытия на тред защищает множество.
  bb.events.on("thread.active", async ({ thread }) => considerThread(thread, "thread.active"));

  const renderStatus = (state: KvState, cfg: HideSettings) =>
    `enabled: ${state.enabled}\n` +
    `hideChildren: ${cfg.hideChildren}\n` +
    `hideForks: ${cfg.hideForks}\n` +
    `tracked originPluginIds: ${state.tracked.join(", ") || "(none)"}\n` +
    `hidden total: ${state.hiddenCount}\n`;

  bb.cli.register({
    name: "hide-dispatched",
    summary: "Automatically hide child threads and dispatched threads from the sidebar",
    commands: [
      {
        name: "status",
        summary: "Show whether hiding is on, the hideChildren/hideForks settings, tracked originPluginIds, and how many threads were hidden in total",
        usage: "bb hide-dispatched status [--json]",
      },
      {
        name: "on",
        summary: "Enable hiding",
        usage: "bb hide-dispatched on [--json]",
      },
      {
        name: "off",
        summary: "Disable hiding",
        usage: "bb hide-dispatched off [--json]",
      },
      {
        name: "sweep",
        summary: "Hide existing visible non-archived threads that match the hide rules (--dry-run only prints candidates)",
        usage: "bb hide-dispatched sweep [--dry-run] [--json]",
      },
    ],
    async run(argv, _ctx) {
      const json = argv.includes("--json");
      const cmd = argv.find((a) => a !== "--json" && a !== "--dry-run");

      if (!cmd || cmd === "status") {
        const [state, cfg] = await Promise.all([readState(), settings.get()]);
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify({ ...state, ...cfg }, null, 2) + "\n" };
        }
        return { exitCode: 0, stdout: renderStatus(state, cfg) };
      }

      if (cmd === "on" || cmd === "off") {
        const state = await readState();
        const enabled = cmd === "on";
        await writeState({ ...state, enabled });
        const result = { ...state, enabled };
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" };
        }
        return {
          exitCode: 0,
          stdout: `Hide-dispatched is now ${enabled ? "ENABLED" : "DISABLED"}.\n`,
        };
      }

      if (cmd === "sweep") {
        const dryRun = argv.includes("--dry-run");
        const [state, cfg] = await Promise.all([readState(), settings.get()]);

        // list() по умолчанию отдаёт только видимые треды. Архивные исключаем
        // явно: они и так не в сайдбаре, а скрытие мешало бы искать их в архиве.
        const threads = await bb.sdk.threads.list({ includeHidden: false, archived: false });
        const candidates = threads.filter(
          (t) =>
            t.visibility !== "hidden" &&
            state.hidden[t.id] === undefined &&
            shouldHide(state, cfg, t),
        );

        if (dryRun) {
          const list = candidates.map((t) => ({
            id: t.id,
            parentThreadId: t.parentThreadId,
            originKind: t.originKind,
            originPluginId: t.originPluginId,
            visibility: t.visibility,
            title: t.title ?? t.titleFallback ?? null,
          }));
          if (json) {
            return { exitCode: 0, stdout: JSON.stringify({ dryRun: true, count: list.length, threads: list }, null, 2) + "\n" };
          }
          let out = `Dry run: ${candidates.length} candidate thread(s) would be hidden.\n`;
          for (const t of list) {
            out += `  ${t.id} (${t.title ?? "(untitled)"}) parent=${t.parentThreadId ?? "none"} originKind=${t.originKind ?? "none"} originPluginId=${t.originPluginId ?? "none"}\n`;
          }
          return { exitCode: 0, stdout: out };
        }

        let hiddenNow = 0;
        for (const t of candidates) {
          try {
            await bb.sdk.threads.update({ threadId: t.id, visibility: "hidden" });
            await recordHidden(t.id, true);
            hiddenNow++;
          } catch (err) {
            bb.log.error(`hide-dispatched: sweep failed for ${t.id}: ${errMsg(err)}`);
          }
        }

        const final = await readState();
        const result = { dryRun: false, hiddenNow, hiddenTotal: final.hiddenCount };
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" };
        }
        return {
          exitCode: 0,
          stdout: `Sweep: hid ${hiddenNow} thread(s). Hidden in total: ${final.hiddenCount}.\n`,
        };
      }

      return {
        exitCode: 1,
        stderr: `Unknown subcommand '${cmd}'. Commands: status, on, off, sweep [--dry-run]\n`,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-hide-dispatched disposed");
  });
}
