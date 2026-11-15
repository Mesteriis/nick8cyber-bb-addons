#!/usr/bin/env python3
"""Ставит хуки Devin из этого каталога текущему пользователю.

Хуки КОПИРУЮТСЯ в постоянный каталог ~/.local/share/bb-devin/hooks/ и config.json
указывает туда, а не в рабочий чекаут: чекаут переключают на другие ветки, и
хук, которого нет на диске, сломал бы Devin все команды. Обновление хуков —
повторный запуск установщика.

    python3 -I devin-hooks/install.py          # установить / обновить
    python3 -I devin-hooks/install.py --check  # показать, что будет, не писать

В ~/.config/devin/config.json (с резервной копией config.json.bak):
  - hooks: наши записи заменяются, ЧУЖИЕ хуки пользователя сохраняются
      bb_subagents.py   PreToolUse(exec/write/edit/...) — защита конфигов и правил
      bb_instructions.py SessionStart/PostCompaction/PostToolUse/UserPromptSubmit
      no_blocking_wait.py PreToolUse(exec) — только если у пользователя есть
                        ~/.claude/hooks/no-blocking-wait.py (это правило его Claude)
  - read_config_from.claude = true  (Devin читает ~/.claude/CLAUDE.md, как Claude)
  - subagents_enabled НЕ трогаем — ключом единолично управляет
      центральная настройка bb subagentsDisabled (host-gate плагина
      provider-devin); иначе каждый rerun перетирал бы стампы гейта
~/.config/devin/hooks — ссылка на постоянный каталог (старые сессии держат этот путь).
"""
import datetime
import json
import os
import random
import shutil
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.environ.get("DEVIN_HOOKS_DEST") or os.path.expanduser("~/.local/share/bb-devin/hooks")
CONFIG = os.environ.get("DEVIN_CONFIG_PATH") or os.path.expanduser("~/.config/devin/config.json")
LEGACY = os.environ.get("DEVIN_LEGACY_HOOKS") or os.path.expanduser("~/.config/devin/hooks")
SCRIPTS = ("bb_subagents.py", "bb_instructions.py", "no_blocking_wait.py")
OURS = tuple(f"/{name}" for name in SCRIPTS)


def cmd(script, timeout):
    return {"type": "command", "command": f"/usr/bin/python3 -I {os.path.join(DEST, script)}", "timeout": timeout}


def our_hooks():
    pre = [{"matcher": "^(exec|write|edit|MultiEdit|apply_patch|notebook_edit|NotebookEdit|write_file|edit_file)$", "hooks": [cmd("bb_subagents.py", 10)]}]
    claude_nbw = os.environ.get("CLAUDE_NO_BLOCKING_WAIT_PATH") or os.path.expanduser("~/.claude/hooks/no-blocking-wait.py")
    if os.path.exists(claude_nbw):
        pre.append({"matcher": "^exec$", "hooks": [cmd("no_blocking_wait.py", 10)]})
    ins = [cmd("bb_instructions.py", 10)]
    return {
        "PreToolUse": pre,
        "PostToolUse": [
            {"matcher": "", "hooks": ins},
        ],
        "PostCompaction": [{"matcher": "", "hooks": ins}],
        "SessionStart": [{"matcher": "", "hooks": ins}],
        "UserPromptSubmit": [{"matcher": "", "hooks": ins}],
    }


def is_ours(entry):
    return any(any(mark in str(h.get("command", "")) for mark in OURS) for h in entry.get("hooks") or [])


def merged_hooks(existing):
    result = {}
    for event, entries in (existing or {}).items():
        kept = [e for e in entries if not is_ours(e)]
        if kept:
            result[event] = kept
    for event, entries in our_hooks().items():
        result[event] = result.get(event, []) + entries
    return result


def strip_jsonc_comments(text):
    out = []
    has_comments = False
    i = 0
    n = len(text)
    in_string = False
    escape = False

    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '"':
                in_string = False
            i += 1
        else:
            if c == '"':
                in_string = True
                out.append(c)
                i += 1
            elif c == '/' and i + 1 < n and text[i + 1] == '/':
                has_comments = True
                i += 2
                while i < n and text[i] != '\n':
                    i += 1
            elif c == '/' and i + 1 < n and text[i + 1] == '*':
                has_comments = True
                i += 2
                while i + 1 < n and not (text[i] == '*' and text[i + 1] == '/'):
                    i += 1
                i += 2
            else:
                out.append(c)
                i += 1

    return "".join(out), has_comments


def remove_trailing_commas(text):
    out = []
    i = 0
    n = len(text)
    in_string = False
    escape = False

    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '"':
                in_string = False
            i += 1
        else:
            if c == '"':
                in_string = True
                out.append(c)
                i += 1
            elif c == ',':
                j = i + 1
                while j < n and text[j] in " \t\r\n":
                    j += 1
                if j < n and text[j] in "}]":
                    i += 1
                else:
                    out.append(c)
                    i += 1
            else:
                out.append(c)
                i += 1
    return "".join(out)


def copy_scripts(check):
    changed = []
    for name in SCRIPTS:
        src, dst = os.path.join(HERE, name), os.path.join(DEST, name)
        with open(src, "rb") as f:
            data = f.read()
        if os.path.exists(dst) and open(dst, "rb").read() == data:
            continue
        changed.append(name)
        if not check:
            os.makedirs(DEST, mode=0o755, exist_ok=True)
            tmp = f"{dst}.{os.getpid()}.{random.randint(100000, 999999)}.tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            try:
                with open(fd, "wb", closefd=True) as f:
                    f.write(data)
                try:
                    os.chmod(tmp, 0o644)
                except OSError:
                    pass
                os.replace(tmp, dst)
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
    return changed


def fix_legacy_link(check):
    if os.path.islink(LEGACY) and os.path.realpath(LEGACY) == os.path.realpath(DEST):
        return False
    if check:
        return True
    if os.path.islink(LEGACY):
        try:
            os.remove(LEGACY)
        except OSError:
            pass
    elif os.path.isdir(LEGACY):
        shutil.move(LEGACY, LEGACY + ".bak-" + datetime.datetime.now().strftime("%Y%m%dT%H%M%S"))
    try:
        parent_dir = os.path.dirname(LEGACY)
        dir_existed = os.path.exists(parent_dir)
        os.makedirs(parent_dir, mode=0o700, exist_ok=True)
        if not dir_existed:
            try:
                os.chmod(parent_dir, 0o700)
            except OSError:
                pass
        os.symlink(DEST, LEGACY)
        return True
    except OSError as exc:
        sys.stderr.write(f"warning: failed to create legacy symlink {LEGACY} -> {DEST}: {exc}\n")
        return False


def main():
    check = "--check" in sys.argv[1:]
    changed = copy_scripts(check)
    print(f"хуки в {DEST}: {'обновить ' + ', '.join(changed) if changed else 'актуальны'}")
    if fix_legacy_link(check):
        print(f"{LEGACY} -> {DEST}")

    exists = os.path.exists(CONFIG)
    has_comments = False
    if exists:
        with open(CONFIG, "r", encoding="utf-8-sig") as f:
            raw_text = f.read()
        cleaned, has_comments = strip_jsonc_comments(raw_text)
        cleaned_no_commas = remove_trailing_commas(cleaned)
        if cleaned_no_commas.strip():
            config = json.loads(cleaned_no_commas)
        else:
            config = {}
    else:
        config = {}

    new = dict(config)
    new["hooks"] = merged_hooks(config.get("hooks"))
    rcf = dict(new.get("read_config_from") or {})
    rcf["claude"] = True
    rcf.setdefault("agents_standard", True)
    new["read_config_from"] = rcf

    if check:
        would_write = {k: new[k] for k in ("hooks", "subagents_enabled", "read_config_from") if k in new}
        print(json.dumps({"would_write_keys": would_write}, ensure_ascii=False, indent=2))
        print("--check: не записано")
        return 0

    if exists and new == config:
        print("config.json уже настроен")
        return 0

    target = os.path.realpath(CONFIG)
    target_dir = os.path.dirname(target)
    dir_existed = os.path.exists(target_dir)
    os.makedirs(target_dir, mode=0o700, exist_ok=True)
    if not dir_existed:
        try:
            os.chmod(target_dir, 0o700)
        except OSError:
            pass

    if exists and has_comments:
        bak_path = target + ".bak"
        if not os.path.exists(bak_path):
            shutil.copy2(target, bak_path)
            try:
                os.chmod(bak_path, 0o600)
            except OSError:
                pass
            print(f"сохранена копия с комментариями: {bak_path}")

    if os.path.exists(target):
        mode = stat.S_IMODE(os.stat(target).st_mode)
    else:
        mode = 0o600

    pid = os.getpid()
    rand = random.randint(100000, 999999)
    tmp = f"{target}.{pid}.{rand}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with open(fd, "w", encoding="utf-8", closefd=True) as f:
            json.dump(new, f, indent=2, ensure_ascii=False)
            f.write("\n")
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    print(f"записано: {CONFIG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
