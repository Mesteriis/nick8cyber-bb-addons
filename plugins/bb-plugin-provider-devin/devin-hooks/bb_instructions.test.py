#!/usr/bin/env python3
"""Тесты хука bb_instructions.py:
1. Инжекция правил bb после сжатия контекста (PostCompaction -> PostToolUse / UserPromptSubmit).
2. Права 0700 на каталоги состояния и 0600 на файлы меток и журналов.
3. Запрет chmod на внешний родительский каталог при DEVIN_BB_LOG=/tmp/...
4. Строгая валидация BB_THREAD_ID (^thr_[a-z0-9]+$) и session_id (^[A-Za-z0-9_-]{1,128}$).
5. Безопасная обработка не-словарного JSON и невалидного ввода.
"""
import atexit
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "bb_instructions.py")

GLOBAL_TMP_HOME = tempfile.mkdtemp(prefix="devin-bb-inst-home-")
atexit.register(lambda: shutil.rmtree(GLOBAL_TMP_HOME, ignore_errors=True))

REAL_COMPACTED = os.path.expanduser("~/.local/state/bb-devin/compacted")
real_marks_before = set(os.listdir(REAL_COMPACTED)) if os.path.exists(REAL_COMPACTED) else set()

fails = 0


def report(ok, title, details=""):
    global fails
    fails += not ok
    status = "ok  " if ok else "FAIL"
    msg = f"{status} {title}"
    if details:
        msg += f" ({details})"
    print(msg)


def run_hook(payload, env_extra=None):
    if not isinstance(payload, str):
        payload = json.dumps(payload)
    env = os.environ.copy()
    env["HOME"] = GLOBAL_TMP_HOME
    env.pop("BB_DEVIN_STATE_DIR", None)
    env.pop("DEVIN_BB_LOG", None)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run([sys.executable, "-I", HOOK], input=payload, capture_output=True, text=True, env=env)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


print("=== 1. Проверка: не-словарный и невалидный JSON завершается 0 без трассировки ===")
for bad_input in ("[]", "\"hello\"", "123", "{bad json"):
    rc, stdout, stderr = run_hook(bad_input, {"BB_THREAD_ID": "thr_test1"})
    report(rc == 0 and not stderr and not stdout, f"safe exit on invalid root: {bad_input[:20]}", f"rc={rc}")

print("\n=== 2. Проверка: валидация BB_THREAD_ID и session_id ===")
invalid_cases = [
    ({"hook_event_name": "PostCompaction", "session_id": "ses1"}, {"BB_THREAD_ID": "invalid_id"}),
    ({"hook_event_name": "PostCompaction", "session_id": "ses1"}, {"BB_THREAD_ID": "thr_UPPERCASE"}),
    ({"hook_event_name": "PostCompaction", "session_id": "ses1"}, {"BB_THREAD_ID": ""}),
    ({"hook_event_name": "PostCompaction", "session_id": "../evil"}, {"BB_THREAD_ID": "thr_valid1"}),
    ({"hook_event_name": "PostCompaction", "session_id": ""}, {"BB_THREAD_ID": "thr_valid1"}),
    ({"hook_event_name": "PostCompaction", "session_id": None}, {"BB_THREAD_ID": "thr_valid1"}),
]
for payload, env in invalid_cases:
    rc, stdout, stderr = run_hook(payload, env)
    report(rc == 0 and not stdout, f"rejected invalid id: sess={payload.get('session_id')!r}, thr={env.get('BB_THREAD_ID')!r}")

print("\n=== 3. Проверка: инжекция правил после компакции и права 0700/0600 ===")
with tempfile.TemporaryDirectory() as tmp_root:
    tmp_state = os.path.join(tmp_root, "bb-devin")
    env = {
        "BB_DEVIN_STATE_DIR": tmp_state,
        "BB_THREAD_ID": "thr_test123",
        "DEVIN_BB_LOG": os.path.join(tmp_state, "hooks.log"),
    }
    # 3a. PostCompaction ставит метку
    rc, stdout, stderr = run_hook({"hook_event_name": "PostCompaction", "session_id": "ses_comp1"}, env)
    report(rc == 0, "PostCompaction exit 0", f"rc={rc}")

    mark_file = os.path.join(tmp_state, "compacted", "ses_comp1")
    report(os.path.exists(mark_file), "mark file created after compaction")

    compacted_dir = os.path.join(tmp_state, "compacted")
    dir_mode = stat.S_IMODE(os.stat(compacted_dir).st_mode)
    state_mode = stat.S_IMODE(os.stat(tmp_state).st_mode)
    file_mode = stat.S_IMODE(os.stat(mark_file).st_mode)
    report(dir_mode == 0o700, f"compacted dir mode is 0700 (got {oct(dir_mode)})")
    report(state_mode == 0o700, f"state dir mode is 0700 (got {oct(state_mode)})")
    report(file_mode == 0o600, f"mark file mode is 0600 (got {oct(file_mode)})")

    # 3b. Готовим файл инструкций
    instr_dir = os.path.join(tmp_state, "instructions")
    os.makedirs(instr_dir, mode=0o700, exist_ok=True)
    instr_file = os.path.join(instr_dir, "thr_test123.md")
    with open(instr_file, "w", encoding="utf-8") as f:
        f.write("test instructions content")
    os.chmod(instr_file, 0o600)

    # 3c. PostToolUse инжектирует правила и удаляет метку
    rc, stdout, stderr = run_hook({"hook_event_name": "PostToolUse", "session_id": "ses_comp1"}, env)
    report(rc == 0, "PostToolUse exit 0", f"rc={rc}")
    try:
        out_data = json.loads(stdout)
        ctx = out_data["hookSpecificOutput"]["additionalContext"]
        has_content = "test instructions content" in ctx and "<system_instructions>" in ctx
    except Exception:
        has_content = False
    report(has_content, "instructions injected in PostToolUse")
    report(not os.path.exists(mark_file), "mark file deleted after injection")

    # 3d. Повторный PostToolUse без сжатия ничего не инжектирует
    rc2, stdout2, _ = run_hook({"hook_event_name": "PostToolUse", "session_id": "ses_comp1"}, env)
    report(rc2 == 0 and not stdout2, "subsequent PostToolUse does not inject")

    # 3e. UserPromptSubmit тоже инжектирует правила при наличии метки
    run_hook({"hook_event_name": "PostCompaction", "session_id": "ses_comp2"}, env)
    report(os.path.exists(os.path.join(tmp_state, "compacted", "ses_comp2")), "second mark created")
    rc3, stdout3, _ = run_hook({"hook_event_name": "UserPromptSubmit", "session_id": "ses_comp2"}, env)
    has_content3 = "test instructions content" in stdout3
    report(rc3 == 0 and has_content3, "UserPromptSubmit re-injects instructions")
    report(not os.path.exists(os.path.join(tmp_state, "compacted", "ses_comp2")), "second mark deleted")

print("\n=== 4. Проверка: запрет chmod на внешний родительский каталог при DEVIN_BB_LOG ===")
with tempfile.TemporaryDirectory() as ext_dir:
    os.chmod(ext_dir, 0o755)
    mode_before = stat.S_IMODE(os.stat(ext_dir).st_mode)
    ext_log = os.path.join(ext_dir, "nested", "test_hooks.log")

    env = {
        "BB_THREAD_ID": "thr_logcheck1",
        "DEVIN_BB_LOG": ext_log,
        "BB_DEVIN_STATE_DIR": os.path.join(ext_dir, "state"),
    }
    rc, stdout, stderr = run_hook({"hook_event_name": "PostCompaction", "session_id": "ses_log1"}, env)
    mode_after = stat.S_IMODE(os.stat(ext_dir).st_mode)
    report(mode_before == 0o755 and mode_after == 0o755,
           f"parent directory permission untouched (remained {oct(mode_after)})")
    report(os.path.exists(ext_log), "custom log file was created")

real_marks_after = set(os.listdir(REAL_COMPACTED)) if os.path.exists(REAL_COMPACTED) else set()
new_ses_marks = [m for m in (real_marks_after - real_marks_before) if m.startswith("ses_")]
report(len(new_ses_marks) == 0, "no test marks leaked to real compacted dir", f"new={new_ses_marks}")

shutil.rmtree(GLOBAL_TMP_HOME, ignore_errors=True)
print(f"\nИтог bb_instructions.test.py: fails={fails}")
sys.exit(1 if fails else 0)
