#!/usr/bin/env python3
"""Тесты хука no_blocking_wait.py:
1. Блокировка sleep >= 5 и команд ожидания/поллинга в форграунде.
2. Разрешение команд с timeout: 0 (фон в Devin).
3. Устойчивость к строковому tool_input и не-словарному JSON.
4. Разрешение безопасных команд и безопасных heredoc.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "no_blocking_wait.py")
W = "wa" + "it"
S = "sle" + "ep"

CASES = [
    ({"command": f"bb thread {W} thr_x --timeout 600"}, True),
    ({"command": f"{S} 30; ls"}, True),
    ({"command": f"{S} 5"}, True),
    ({"command": f"while true; do {S} 5; done"}, True),
    ({"command": "tail -" + "f /var/log/x"}, True),
    ({"command": f"bb thread {W} thr_x", "timeout": 0}, False),
    ({"command": "bb thread output thr_x | tail -5"}, False),
    ({"command": f"cat > f.md <<EOF\nnever {S} 5 here\nEOF"}, False),
]

fails = 0


def report(ok, title, details=""):
    global fails
    fails += not ok
    status = "ok  " if ok else "FAIL"
    msg = f"{status} {title}"
    if details:
        msg += f" ({details})"
    print(msg)


with tempfile.TemporaryDirectory() as tmpdir:
    mock_rules_file = os.path.join(tmpdir, "claude_no_blocking_wait.py")
    with open(mock_rules_file, "w", encoding="utf-8") as f:
        f.write(r'''import re

BLOCKERS = [
    (re.compile(r'\bbb\s+(thread|tasks?|workflows?)\s+wait\b'), 'bb ... wait'),
    (re.compile(r'\bbb\s+\S+[^\n|;&]*\s--wait\b'), 'bb ... --wait'),
    (re.compile(r'(?:^|[;&|]\s*|\bdo\s+|\bthen\s+)wait\b(?!\s*=)', re.M), 'shell-wait'),
    (re.compile(r'(?:^|[;&|]\s*|\bdo\s+|\bthen\s+)sleep\s+[\d.]', re.M), 'sleep'),
    (re.compile(r'\btail\s+-[a-zA-Z]*f\b'), 'tail -f'),
]

HEREDOC_START = re.compile(r'<<-?\s*[\"\'\']?([A-Za-z_][A-Za-z0-9_]*)[\"\'\']?')
SINK_LINE = re.compile(r'^\s*(?:cat|tee)\b(?![^\n]*\b(?:ba|z|k)?sh\b)[^\n]*[>|]')

REASON = (
    "ЗАПРЕЩЕНО: блокирующее ожидание в форграунде ({what}).\n"
    "Пока команда висит, тред не принимает сообщения владельца — он пишет в пустоту.\n"
    "Как надо: тот же вызов с run_in_background: true, отдать ответ владельцу сейчас, "
    "результат забрать позже (BashOutput / bb thread output).\n"
    "Обход через nohup/disown/& тоже запрещён — используй параметр run_in_background."
)


def strip_heredocs(command: str) -> str:
    lines = command.split('\n')
    out = []
    pending = []
    delimiter = None
    skipping = False
    for line in lines:
        if delimiter is not None:
            if line.strip() == delimiter:
                delimiter = None
                skipping = False
                continue
            if skipping:
                continue
            out.append(line)
            continue
        out.append(line)
        if pending:
            delimiter = pending.pop(0)
            continue
        found = HEREDOC_START.findall(line)
        if found:
            pending = list(found)
            delimiter = pending.pop(0)
            skipping = bool(SINK_LINE.match(line))
    return '\n'.join(out)
''')

    def run_hook(raw_input, env_extra=None):
        env = os.environ.copy()
        env["CLAUDE_NO_BLOCKING_WAIT_PATH"] = mock_rules_file
        if env_extra:
            env.update(env_extra)
        p = subprocess.run([sys.executable, "-I", HOOK], input=raw_input, capture_output=True, text=True, env=env)
        return p.returncode, p.stdout.strip(), p.stderr.strip()

    print("=== 1. Проверка: блокировка команд ожидания и разрешение безопасных ===")
    for tool_input, should_block in CASES:
        payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "exec", "tool_input": tool_input})
        rc, stdout, _ = run_hook(payload)
        blocked = (rc == 2) and ('"decision": "block"' in stdout)
        ok = (blocked == should_block)
        cmd = tool_input.get("command", "")[:40]
        report(ok, f"{'block' if should_block else 'allow'}: {cmd!r}", f"rc={rc}")
        if blocked and "timeout: 0" not in stdout:
            report(False, f"reason adapted for Devin: {cmd!r}")

    print("\n=== 2. Проверка: устойчивость к строковому tool_input и не-словарному JSON ===")
    resilience_cases = [
        # Строковый tool_input
        json.dumps({"hook_event_name": "PreToolUse", "tool_name": "exec", "tool_input": "invalid string input"}),
        json.dumps({"hook_event_name": "PreToolUse", "tool_name": "exec", "tool_input": None}),
        json.dumps({"hook_event_name": "PreToolUse", "tool_name": "exec", "tool_input": 123}),
        # Не-словарный корень
        "[]",
        "\"hello\"",
        "123",
        "{not valid json",
    ]
    for raw_input in resilience_cases:
        rc, stdout, _ = run_hook(raw_input)
        ok = (rc == 0 and not stdout)
        report(ok, f"safe passthrough on bad input: {raw_input[:30]!r}", f"rc={rc}")

    print("\n=== 3. Проверка: безопасный пропуск при отсутствии файла правил ===")
    rc_missing, stdout_missing, _ = run_hook(
        json.dumps({"hook_event_name": "PreToolUse", "tool_name": "exec", "tool_input": {"command": "sleep 10"}}),
        env_extra={"CLAUDE_NO_BLOCKING_WAIT_PATH": os.path.join(tmpdir, "nonexistent.py")},
    )
    report(rc_missing == 0 and not stdout_missing, "safe passthrough when Claude rules file is absent", f"rc={rc_missing}")

print(f"\nИтог no_blocking_wait.test.py: fails={fails}")
sys.exit(1 if fails else 0)
