/**
 * bb-plugin-orchestrator — Frontend entry (spec §13.2 п.1): the «Роль»
 * picker in the new-thread composer's action row. The pick persists per
 * project in `pending_roles` via the plugin's RPC; the `message.dispatch`
 * hook applies it to the thread's first message.
 */
import {
  definePluginApp,
  useComposerView,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ChangeEvent } from "react";
import type { rpcContract } from "./server";
import { createT, resolveLang } from "./src/i18n/index.js";

type Contract = typeof rpcContract;

// §19.3 (r33): «Без плагина» / "No plugin" — FIRST in the list; the
// stored pick or the server default role fills the select, nothing is
// written until the user actually changes it.
const ROLE_OPTIONS = [
  { id: "none", labelKey: "app.roleNone" },
  { id: "orchestrator", labelKey: "app.roleOrchestrator" },
  { id: "executor", labelKey: "app.roleExecutor" },
  { id: "auditor", labelKey: "app.roleAuditor" },
] as const;
type RoleId = (typeof ROLE_OPTIONS)[number]["id"];
const DEFAULT_ROLE: RoleId = "executor";

function RoleSelect() {
  const view = useComposerView();
  const rpc = useRpc<Contract>();
  const { values } = useSettings();
  const t = createT(resolveLang(values?.language));
  const scope = view.scope;
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  const [role, setRole] = useState<RoleId>(DEFAULT_ROLE);

  const report = (next: RoleId) => {
    void rpc
      .call("setPendingRole", { projectId, role: next })
      .catch(() => undefined);
  };

  // §19.3 (r33): the select READS the remembered pick (or shows the
  // server default) and writes ONLY on a user change — the window's own
  // open used to write `orchestrator`, which is exactly the default
  // r33 removed. A transient read failure retries once after a second.
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const apply = (next: RoleId) => {
      if (alive) setRole(next);
    };
    const load = () =>
      rpc
        .call("pendingRole", { projectId })
        .then((res) => apply(res?.role ?? DEFAULT_ROLE))
        .catch(() => {
          retryTimer = setTimeout(() => {
            if (!alive) return;
            void rpc
              .call("pendingRole", { projectId })
              .then((res) => apply(res?.role ?? DEFAULT_ROLE))
              .catch(() => apply(DEFAULT_ROLE));
          }, 1000);
        });
    void load();
    return () => {
      alive = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [projectId]);

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as RoleId;
    setRole(next);
    report(next);
  };

  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        opacity: 0.85,
        whiteSpace: "nowrap",
      }}
    >
      {t("app.role")}
      <select
        value={role}
        onChange={onChange}
        style={{
          font: "inherit",
          color: "inherit",
          background: "transparent",
          border: "1px solid rgba(128,128,128,.4)",
          borderRadius: 6,
          padding: "2px 4px",
          colorScheme: "dark",
        }}
      >
        {ROLE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "orchestrator-role",
    scopes: ["new-thread"],
    actions: [{ id: "role-select", component: RoleSelect }],
  });
});
