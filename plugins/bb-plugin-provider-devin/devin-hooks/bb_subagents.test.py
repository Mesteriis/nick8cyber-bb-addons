#!/usr/bin/env python3
"""Тесты хука bb_subagents.py и его установки в install.py.

Запуск:
    python3 devin-hooks/bb_subagents.test.py
    python3 -I devin-hooks/bb_subagents.test.py
"""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "bb_subagents.py")
INSTALL = os.path.join(HERE, "install.py")
USER_HOME = os.path.expanduser("~")

REAL_LOG = os.path.expanduser("~/.local/state/bb-devin/hooks.log")
LEGACY_LOG = os.path.expanduser("~/.local/state/devin-bb-hooks.log")
real_log_before = open(REAL_LOG, "rb").read() if os.path.exists(REAL_LOG) else None
legacy_log_before = open(LEGACY_LOG, "rb").read() if os.path.exists(LEGACY_LOG) else None

TEMP_DIR = tempfile.TemporaryDirectory()
TEST_LOG = os.path.join(TEMP_DIR.name, "devin-hooks-test.log")

fails = 0


def report(ok, title, details=""):
    global fails
    fails += not ok
    status = "ok  " if ok else "FAIL"
    msg = f"{status} {title}"
    if details:
        msg += f" ({details})"
    print(msg)


def run_hook(event, tool_name, tool_input, env_extra=None, cwd=None, raw_payload=None, proc_cwd=None):
    if raw_payload is not None:
        payload = raw_payload
    else:
        payload_dict = {
            "hook_event_name": event,
            "tool_name": tool_name,
            "tool_input": tool_input,
        }
        if cwd is not None:
            payload_dict["cwd"] = cwd
        payload = json.dumps(payload_dict)
    env = os.environ.copy()
    env["DEVIN_BB_LOG"] = TEST_LOG
    if env_extra:
        env.update(env_extra)
    p = subprocess.run([sys.executable, "-I", HOOK], input=payload, capture_output=True, text=True, env=env, cwd=proc_cwd or os.path.dirname(HERE))
    return p.returncode, p.stdout.strip(), p.stderr.strip()


print("=== 1. Проверка: bb thread spawn проходит без изменений ===")
spawn_cases = [
    "bb thread spawn --preset complex",
    "bb thread create --preset medium",
    "bb thread spawn --preset simple-alt --instructions 'test'",
    "echo hello; bb thread spawn --preset complex",
    "/usr/local/bin/bb thread spawn --preset complex",
]
for cmd in spawn_cases:
    rc, stdout, _ = run_hook("PreToolUse", "exec", {"command": cmd}, env_extra={"BB_THREAD_ID": "thr_coord123"})
    passed_unchanged = (rc == 0) and ("updatedInput" not in stdout) and ("decision" not in stdout)
    report(passed_unchanged, f"spawn unchanged: {cmd[:40]}", f"rc={rc}, out={stdout!r}")


print("\n=== 2. Проверка: bb tasks dispatch не вызывает bb thread update ===")
with tempfile.TemporaryDirectory() as tmpdir:
    bb_log = os.path.join(tmpdir, "bb_calls.log")
    spy_bb = os.path.join(tmpdir, "bb")
    with open(spy_bb, "w", encoding="utf-8") as f:
        f.write(f"""#!/bin/sh
echo "$@" >> "{bb_log}"
exit 0
""")
    os.chmod(spy_bb, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP)

    test_env = {
        "BB_CLI": spy_bb,
        "PATH": f"{tmpdir}:{os.environ.get('PATH', '')}",
        "BB_THREAD_ID": "thr_coordinator",
    }

    dispatch_cmd = "bb tasks dispatch PLUG-151 --preset complex"

    rc_pre, out_pre, _ = run_hook("PreToolUse", "exec", {"command": dispatch_cmd}, env_extra=test_env)
    report(rc_pre == 0 and "decision" not in out_pre, "dispatch PreToolUse passes through", f"rc={rc_pre}")

    rc_post, out_post, _ = run_hook("PostToolUse", "exec", {"command": dispatch_cmd}, env_extra=test_env)
    report(rc_post == 0 and "hookSpecificOutput" not in out_post, "dispatch PostToolUse produces no extra context", f"rc={rc_post}")

    bb_called = os.path.exists(bb_log)
    bb_calls = open(bb_log).read() if bb_called else ""
    update_called = "thread update" in bb_calls
    report(not update_called and not bb_called, "no bb CLI / bb thread update invoked", f"calls: {bb_calls.strip()!r}")


print("\n=== 3. Проверка: запись в ~/.config/devin/config.json блокируется ===")
block_cases = [
    # exec write variants
    ("exec", {"command": "echo '{}' > ~/.config/devin/config.json"}),
    ("exec", {"command": "cat foo | tee ~/.config/devin/config.json"}),
    ("exec", {"command": "rm ~/.config/devin/config.json"}),
    ("exec", {"command": "sed -i 's/a/b/' ~/.config/devin/config.json"}),
    ("exec", {"command": "mv new.json ~/.config/devin/config.json"}),
    ("exec", {"command": "cp new.json ~/.config/devin/config.json"}),
    ("exec", {"command": "python3 -c \"open('~/.config/devin/config.json', 'w').write('{}')\""}),
    # structured tools
    ("write", {"file_path": os.path.join(USER_HOME, ".config", "devin", "config.json"), "content": "{}"}),
    ("edit", {"file_path": os.path.join(USER_HOME, ".config", "devin", "config.json"), "old_string": "a", "new_string": "b"}),
    ("apply_patch", {"patch": "--- ~/.config/devin/config.json\n+++ ~/.config/devin/config.json\n@@ -1 +1 @@\n-old\n+new"}),
]

for tool_name, tool_input in block_cases:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    blocked = (rc == 2)
    try:
        data = json.loads(stdout)
        has_decision = data.get("decision") == "block"
        has_reason = bool(data.get("reason"))
    except Exception:
        has_decision = False
        has_reason = False
    ok = blocked and has_decision and has_reason
    cmd_desc = tool_input.get("command") or tool_input.get("file_path") or tool_input.get("patch")[:30]
    report(ok, f"blocked write ({tool_name}): {cmd_desc}", f"rc={rc}")


print("\n=== 4. Проверка: защита других конфигов и разрешение безопасного чтения ===")
other_blocked = [
    ("exec", {"command": "echo 'rule' > ~/.claude/CLAUDE.md"}),
    ("exec", {"command": "echo '{}' > ~/.claude/settings.json"}),
    ("exec", {"command": "echo 'pass' > ~/.claude/hooks/guard.py"}),
    ("exec", {"command": "echo 'x' > plugins/bb-plugin-provider-devin/devin-hooks/bb_subagents.py"}),
    ("exec", {"command": "echo 'x' > ~/.local/share/bb-devin/hooks/bb_subagents.py"}),
]
for tool_name, tool_input in other_blocked:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    ok = (rc == 2 and '"decision": "block"' in stdout)
    report(ok, f"blocked protected file ({tool_input['command'][:40]})", f"rc={rc}")

allowed_reads = [
    "cat ~/.config/devin/config.json",
    "cat ~/.config/devin/config.json 2>/dev/null",
    "ls -la ~/.config/devin/",
    "cat ~/.claude/CLAUDE.md",
    "grep foo plugins/bb-plugin-provider-devin/devin-hooks/bb_subagents.py",
    "git status",
]
for cmd in allowed_reads:
    rc, stdout, _ = run_hook("PreToolUse", "exec", {"command": cmd})
    ok = (rc == 0 and "decision" not in stdout)
    report(ok, f"allowed read/exec: {cmd[:40]}", f"rc={rc}")


print("\n=== 4b. Регрессия: упоминание пути в содержимом не блокирует; назначение блокирует ===")
dummy_proj_dir = os.path.join(tempfile.gettempdir(), "test_repo")
content_mention_cases = [
    ("write", {"file_path": os.path.join(dummy_proj_dir, "plugins/bb-plugin-provider-devin/src/x.mjs"),
               "content": "// обновляет ~/.config/devin/config.json\nconst a = 1"}),
    ("edit", {"file_path": os.path.join(dummy_proj_dir, "plugins/bb-plugin-provider-devin/src/x.mjs"),
              "old_string": "a", "new_string": "смотри ~/.config/devin/config.json"}),
    ("edit", {"file_path": os.path.join(dummy_proj_dir, "plugins/bb-plugin-provider-devin/src/subagent-gate.mjs"),
              "old_string": "a", "new_string": "b"}),
    ("apply_patch", {"patch": "--- plugins/bb-plugin-provider-devin/src/x.mjs\n"
                             "+++ plugins/bb-plugin-provider-devin/src/x.mjs\n"
                             "@@ -1 +1 @@\n-// ~/.config/devin/config.json\n+// new"}),
]
for tool_name, tool_input in content_mention_cases:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    ok = (rc == 0 and "decision" not in stdout)
    desc = tool_input.get("file_path") or "patch-body-mention"
    report(ok, f"allowed content-mention ({tool_name}): {desc[-55:]}", f"rc={rc}")

dest_blocked = [
    ("edit", {"file_path": "~/.config/devin/config.json", "old_string": "a", "new_string": "b"}),
    ("write", {"file_path": os.path.join(USER_HOME, ".claude", "settings.json"), "content": "{}"}),
    ("edit", {"file_path": os.path.join(dummy_proj_dir, "plugins/bb-plugin-provider-devin/devin-hooks/bb_subagents.py"),
              "old_string": "a", "new_string": "b"}),
]
for tool_name, tool_input in dest_blocked:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    ok = (rc == 2 and '"decision": "block"' in stdout)
    report(ok, f"blocked dest ({tool_input['file_path'][:60]})", f"rc={rc}")


print("\n=== 4c. Проверка: строковый tool_input в apply_patch ===")
raw_patch_blocked = """*** Update File: ~/.config/devin/config.json
@@ -1 +1 @@
-old
+new
"""
rc, stdout, _ = run_hook("PreToolUse", "apply_patch", raw_patch_blocked)
report(rc == 2 and '"decision": "block"' in stdout, "raw patch string blocking ~/.config/devin", f"rc={rc}")

raw_patch_allowed = """*** Update File: src/safe_module.py
@@ -1 +1 @@
-old
+new
"""
rc, stdout, _ = run_hook("PreToolUse", "apply_patch", raw_patch_allowed)
report(rc == 0 and "decision" not in stdout, "raw patch string allowing safe file", f"rc={rc}")

diff_str_blocked = """--- a/.claude/settings.json\t2026-01-01 00:00:00
+++ b/.claude/settings.json\t2026-01-01 00:00:00
@@ -1 +1 @@
-old
+new
"""
rc, stdout, _ = run_hook("PreToolUse", "apply_patch", diff_str_blocked, cwd=USER_HOME)
report(rc == 2 and '"decision": "block"' in stdout, "diff string blocking .claude/settings.json with cwd=HOME", f"rc={rc}")


print("\n=== 4d. Проверка: блокировка относительных путей при cwd=$HOME ===")
rel_cases = [
    ("write", {"file_path": ".config/devin/config.json", "content": "{}"}),
    ("edit", {"file_path": ".claude/settings.json", "old_string": "a", "new_string": "b"}),
    ("apply_patch", {"patch": "--- .config/devin/config.json\n+++ .config/devin/config.json\n@@ -1 +1 @@\n-a\n+b"}),
]
for tool_name, tool_input in rel_cases:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input, cwd=USER_HOME)
    report(rc == 2 and '"decision": "block"' in stdout, f"relative path blocked with cwd=HOME ({tool_name})", f"rc={rc}")


print("\n=== 4e. Проверка: notebook_edit и NotebookEdit ===")
nb_cases = [
    ("notebook_edit", {"notebook_path": "~/.config/devin/config.json"}, True),
    ("NotebookEdit", {"file_path": "~/.claude/settings.json"}, True),
    ("notebook_edit", {"notebook_path": "analysis.ipynb"}, False),
]
for tool_name, tool_input, should_block in nb_cases:
    rc, stdout, _ = run_hook("PreToolUse", tool_name, tool_input)
    is_blocked = (rc == 2 and '"decision": "block"' in stdout)
    report(is_blocked == should_block, f"{'blocked' if should_block else 'allowed'} {tool_name}", f"rc={rc}")


print("\n=== 4f. Проверка: симлинки на защищённые файлы (включая временный HOME) ===")
with tempfile.TemporaryDirectory() as custom_home, tempfile.TemporaryDirectory() as work_dir:
    custom_devin = os.path.join(custom_home, ".config", "devin")
    os.makedirs(custom_devin, exist_ok=True)
    custom_conf = os.path.join(custom_devin, "config.json")
    with open(custom_conf, "w", encoding="utf-8") as f:
        f.write("{}")

    # Симлинк на защищённый файл из другого каталога
    link_path = os.path.join(work_dir, "symlink_to_conf.json")
    os.symlink(custom_conf, link_path)

    custom_env = {"HOME": custom_home}

    # Попытка редактирования через симлинк
    rc, stdout, _ = run_hook("PreToolUse", "edit", {"file_path": link_path, "old_string": "{", "new_string": "{"}, env_extra=custom_env)
    report(rc == 2 and '"decision": "block"' in stdout, "symlink to protected file blocked with custom HOME", f"rc={rc}")

    # Защита devin-hooks скриптов при кастомном HOME
    custom_hook = os.path.join(work_dir, "devin-hooks", "bb_subagents.py")
    os.makedirs(os.path.dirname(custom_hook), exist_ok=True)
    with open(custom_hook, "w", encoding="utf-8") as f:
        f.write("# hook")
    rc2, stdout2, _ = run_hook("PreToolUse", "write", {"file_path": custom_hook, "content": "bad"}, env_extra=custom_env)
    report(rc2 == 2 and '"decision": "block"' in stdout2, "devin-hooks script blocked in custom checkout", f"rc={rc2}")


print("\n=== 4g. Проверка: не-словарный JSON возвращает 0 ===")
for bad_json in ("[]", "\"just string\"", "123", "{not a valid json"):
    rc, stdout, stderr = run_hook("PreToolUse", "exec", {}, raw_payload=bad_json)
    report(rc == 0 and not stdout and not stderr, f"non-dict root passes safely: {bad_json[:20]}", f"rc={rc}")


print("\n=== 4h. Проверка: безопасная обработка не-строковых cwd и command ===")
# При не-строковом cwd (например 123) запись в .config/devin/config.json всё равно блокируется кодом 2
rc_cwd123, stdout_cwd123, _ = run_hook("PreToolUse", "write", {"file_path": ".config/devin/config.json", "content": "{}"}, cwd=123, proc_cwd=USER_HOME)
report(rc_cwd123 == 2 and '"decision": "block"' in stdout_cwd123, "write to .config/devin/config.json blocked with non-string cwd=123", f"rc={rc_cwd123}")

# При не-строковом command в exec хук не падает с TypeError и завершается 0
rc_cmd123, stdout_cmd123, stderr_cmd123 = run_hook("PreToolUse", "exec", {"command": 123})
report(rc_cmd123 == 0 and not stderr_cmd123 and "decision" not in stdout_cmd123, "exec with non-string command (123) exits safely with rc=0", f"rc={rc_cmd123}")


print("\n=== 4i. Проверка: точный диапазон защищённых путей .claude при кастомном HOME ===")
# grep в .claude/projects/... > /tmp/out разрешён
rc_grep, stdout_grep, _ = run_hook("PreToolUse", "exec", {"command": "grep foo ~/.claude/projects/x > /tmp/out"})
report(rc_grep == 0 and "decision" not in stdout_grep, "grep ~/.claude/projects/x > /tmp/out is allowed (rc=0)", f"rc={rc_grep}")

with tempfile.TemporaryDirectory() as custom_home:
    custom_env = {"HOME": custom_home}
    # Запись в settings.json в кастомном HOME блокируется
    cmd_blocked = f"cp x {custom_home}/.claude/settings.json"
    rc_cp, stdout_cp, _ = run_hook("PreToolUse", "exec", {"command": cmd_blocked}, env_extra=custom_env)
    report(rc_cp == 2 and '"decision": "block"' in stdout_cp, "cp to custom_home/.claude/settings.json is blocked (rc=2)", f"rc={rc_cp}")

    # Чтение с редиректом из projects в кастомном HOME разрешено
    cmd_allowed = f"grep foo {custom_home}/.claude/projects/x > /tmp/out"
    rc_grep_custom, stdout_grep_custom, _ = run_hook("PreToolUse", "exec", {"command": cmd_allowed}, env_extra=custom_env)
    report(rc_grep_custom == 0 and "decision" not in stdout_grep_custom, "grep custom_home/.claude/projects/x > /tmp/out is allowed (rc=0)", f"rc={rc_grep_custom}")


print("\n=== 5. Проверка install.py: очистка старой PostToolUse регистрации ===")
spec = importlib.util.spec_from_file_location("devin_install", INSTALL)
install_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_mod)

fake_dest = os.path.join(USER_HOME, ".local", "share", "bb-devin", "hooks")
old_hooks_config = {
    "PreToolUse": [
        {"matcher": "^(exec|write|edit|apply_patch|notebook_edit)$",
         "hooks": [{"type": "command", "command": f"/usr/bin/python3 -I {fake_dest}/bb_subagents.py", "timeout": 10}]},
        {"matcher": "^exec$",
         "hooks": [{"type": "command", "command": f"/usr/bin/python3 -I {fake_dest}/no_blocking_wait.py", "timeout": 10}]},
    ],
    "PostToolUse": [
        {"matcher": "^exec$",
         "hooks": [{"type": "command", "command": f"/usr/bin/python3 -I {fake_dest}/bb_subagents.py", "timeout": 120}]},
        {"matcher": "",
         "hooks": [{"type": "command", "command": f"/usr/bin/python3 -I {fake_dest}/bb_instructions.py", "timeout": 10}]},
    ],
    "PostCompaction": [
        {"matcher": "",
         "hooks": [{"type": "command", "command": f"/usr/bin/python3 -I {fake_dest}/bb_instructions.py", "timeout": 10}]},
    ],
    "SessionStart": [
        {"matcher": "",
         "hooks": [{"type": "command", "command": f"/usr/bin/python3 -I {fake_dest}/bb_instructions.py", "timeout": 10}]},
    ],
    "UserPromptSubmit": [
        {"matcher": "",
         "hooks": [{"type": "command", "command": f"/usr/bin/python3 -I {fake_dest}/bb_instructions.py", "timeout": 10}]},
    ],
}

new_hooks = install_mod.merged_hooks(old_hooks_config)

pre_has_subagents = any(
    any("bb_subagents.py" in str(h.get("command", "")) for h in entry.get("hooks", []))
    for entry in new_hooks.get("PreToolUse", [])
)
report(pre_has_subagents, "install.py keeps bb_subagents in PreToolUse")

post_has_subagents = any(
    any("bb_subagents.py" in str(h.get("command", "")) for h in entry.get("hooks", []))
    for entry in new_hooks.get("PostToolUse", [])
)
report(not post_has_subagents, "install.py removes bb_subagents from PostToolUse")

post_has_instructions = any(
    any("bb_instructions.py" in str(h.get("command", "")) for h in entry.get("hooks", []))
    for entry in new_hooks.get("PostToolUse", [])
)
report(post_has_instructions, "install.py keeps bb_instructions in PostToolUse")

repeated_hooks = install_mod.merged_hooks(new_hooks)
report(repeated_hooks == new_hooks, "install.py repeated run is idempotent")


print("\n=== 6. Проверка: реальный лог не изменился, лог теста записан во временный файл ===")
real_log_after = open(REAL_LOG, "rb").read() if os.path.exists(REAL_LOG) else None
legacy_log_after = open(LEGACY_LOG, "rb").read() if os.path.exists(LEGACY_LOG) else None

report(real_log_after == real_log_before and legacy_log_after == legacy_log_before,
       "real logs were not modified")
report(os.path.exists(TEST_LOG) and os.path.getsize(TEST_LOG) > 0,
       "test log received blocked events",
       f"size={os.path.getsize(TEST_LOG) if os.path.exists(TEST_LOG) else 0}")

TEMP_DIR.cleanup()

print(f"\nИтог bb_subagents.test.py: fails={fails}")
sys.exit(1 if fails else 0)
