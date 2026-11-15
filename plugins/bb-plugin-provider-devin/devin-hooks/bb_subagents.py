#!/usr/bin/env python3
"""Хук Devin CLI: защита конфигурации Devin, хуков и общих правил от перезаписи.

Зачем: Deny Write(...) в config.json не останавливает команды exec (Devin может
переписать config.json или хуки через shell-команды вроде `>`, sed, mv, tee и т.п.).
Хук проверяет PreToolUse для exec и файловых инструментов write/edit/apply_patch/notebook_edit.

Раздача задач и привязка исполнителей теперь выполняются плагином orchestrator
(`bb orchestrator delegate`), поэтому хук больше не переписывает `bb thread spawn`
и не обрабатывает `bb tasks dispatch`.

PreToolUse(exec|write|edit|...): блокирует попытки модификации ~/.config/devin,
                                 ~/.claude (CLAUDE.md, settings.json, hooks)
                                 и хуков плагина provider-devin.

Домашние пути матчатся с домашним якорем и динамически относительно expanduser("~").
Для write/edit/apply_patch/notebook_edit проверяются пути назначения, не содержимое.
"""
import datetime
import json
import os
import re
import sys

STATE_DIR = os.environ.get("BB_DEVIN_STATE_DIR") or os.path.expanduser("~/.local/state/bb-devin")
DEFAULT_LOG = os.path.join(STATE_DIR, "hooks.log")
LOG = os.environ.get("DEVIN_BB_LOG") or DEFAULT_LOG
IS_DEFAULT_LOG = not bool(os.environ.get("DEVIN_BB_LOG"))

HOME = r"(?:~|\$HOME|\$\{HOME\}|/home/[^\s/'\"]+|/Users/[^\s/'\"]+|/root|%USERPROFILE%)"
GUARD_RE = re.compile(
    HOME + r"/\.config/devin(?:/|\b)"
    r"|" + HOME + r"/\.claude/(?:CLAUDE\.md|hooks\b|settings(?:\.local)?\.json)"
    r"|bb-plugin-provider-devin/devin-hooks\b|\.local/share/bb-devin/hooks\b"
    r"|\.local/share/devin/hooks\b"
)
DEVIN_HOOKS_RE = re.compile(
    r"(?:^|/)(?:bb-plugin-provider-devin/)?devin-hooks/(?:bb_subagents|bb_instructions|no_blocking_wait|install)\.py(?:\b|$)"
)
WRITE_RE = re.compile(
    r">|\btee\b|\bsed\s+(?:-\w*\s+)*-i|\bmv\b|\bcp\b|\brm\b|\bchmod\b|\bchown\b|\btruncate\b|\bln\b"
    r"|\binstall\b|\bdd\b|open\([^)]*['\"][wax+]|write_text|write_bytes|json\.dump|\bperl\s+-\w*i"
)
GUARD_REASON = (
    "Файлы ~/.config/devin (config.json, hooks, AGENTS.md) и общие правила агентов "
    "~/.claude (CLAUDE.md, hooks, settings.json), хуки плагина provider-devin правит только владелец. "
    "Нужна правка — опиши её владельцу."
)

TOOL_MATCHER = re.compile(r"^(exec|write|edit|MultiEdit|apply_patch|notebook_edit|NotebookEdit|write_file|edit_file)$")
FILE_TOOLS = {"write", "edit", "MultiEdit", "apply_patch", "notebook_edit", "NotebookEdit", "write_file", "edit_file"}

PATCH_PREFIXES = (
    "+++ ",
    "--- ",
    "*** Update File:",
    "*** Add File:",
    "*** Delete File:",
    "*** Move to:",
)


def log(msg):
    try:
        log_dir = os.path.dirname(LOG)
        if IS_DEFAULT_LOG:
            os.makedirs(log_dir, mode=0o700, exist_ok=True)
            try:
                os.chmod(log_dir, 0o700)
            except OSError:
                pass
        else:
            os.makedirs(log_dir, exist_ok=True)

        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        fd = os.open(LOG, flags, 0o600)
        try:
            with open(fd, "a", encoding="utf-8", closefd=True) as f:
                ts = datetime.datetime.now().isoformat(timespec="seconds")
                thread = os.environ.get("BB_THREAD_ID", "-")
                f.write(f"{ts} [{thread}] {msg}\n")
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
    except OSError:
        pass


def is_path_guarded(p):
    if GUARD_RE.search(p):
        return True
    if DEVIN_HOOKS_RE.search(p):
        return True
    home_dirs = set()
    for h in (os.path.expanduser("~"), os.environ.get("HOME")):
        if h:
            home_dirs.add(os.path.abspath(h))
            home_dirs.add(os.path.realpath(h))
    for h in home_dirs:
        h_norm = os.path.normpath(h)
        devin_conf = os.path.join(h_norm, ".config", "devin")
        if p == devin_conf or p.startswith(devin_conf + os.sep):
            return True
        claude_md = os.path.join(h_norm, ".claude", "CLAUDE.md")
        if p == claude_md:
            return True
        claude_settings = os.path.join(h_norm, ".claude", "settings.json")
        claude_settings_local = os.path.join(h_norm, ".claude", "settings.local.json")
        if p in (claude_settings, claude_settings_local):
            return True
        claude_hooks = os.path.join(h_norm, ".claude", "hooks")
        if p == claude_hooks or p.startswith(claude_hooks + os.sep):
            return True
        for hook_sub in (".local/share/devin/hooks", ".local/share/bb-devin/hooks"):
            hd = os.path.join(h_norm, *hook_sub.split("/"))
            if p == hd or p.startswith(hd + os.sep):
                return True
    return False


def extract_patch_targets(text):
    if not isinstance(text, str):
        return []
    targets = []
    for line in text.splitlines():
        line = line.strip()
        matched_prefix = None
        for prefix in PATCH_PREFIXES:
            if line.startswith(prefix):
                matched_prefix = prefix
                break
        if not matched_prefix:
            continue
        p = line[len(matched_prefix):].strip()
        p = p.split("\t")[0].strip()
        p = p.strip("'\"")
        if not p or p in ("/dev/null", "dev/null"):
            continue
        if p.startswith("a/") or p.startswith("b/"):
            p = p[2:]
        if p:
            targets.append(p)
    return targets


def get_tool_targets(tool, tool_input, raw_patch_text):
    targets = []
    for field in ("file_path", "path", "notebook_path"):
        val = tool_input.get(field)
        if isinstance(val, str) and val:
            targets.append(val)
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        for e in edits:
            if isinstance(e, dict):
                for field in ("file_path", "path"):
                    val = e.get(field)
                    if isinstance(val, str) and val:
                        targets.append(val)
    patch_texts = []
    if raw_patch_text:
        patch_texts.append(raw_patch_text)
    for key in ("patch", "diff", "raw"):
        val = tool_input.get(key)
        if isinstance(val, str) and val:
            patch_texts.append(val)
    if tool in ("apply_patch", "MultiEdit") or raw_patch_text:
        for key in ("input", "content"):
            val = tool_input.get(key)
            if isinstance(val, str) and val:
                patch_texts.append(val)
    for pt in patch_texts:
        targets.extend(extract_patch_targets(pt))
    return targets


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0
    if data.get("hook_event_name") != "PreToolUse":
        return 0

    tool = data.get("tool_name")
    if not isinstance(tool, str) or not TOOL_MATCHER.match(tool):
        return 0

    raw_tool_input = data.get("tool_input")
    raw_patch_text = ""
    if isinstance(raw_tool_input, str):
        try:
            parsed = json.loads(raw_tool_input)
            if isinstance(parsed, dict):
                tool_input = parsed
            else:
                raw_patch_text = raw_tool_input
                tool_input = {}
        except Exception:
            raw_patch_text = raw_tool_input
            tool_input = {}
    elif isinstance(raw_tool_input, dict):
        tool_input = raw_tool_input
    else:
        tool_input = {}

    guarded = False
    if tool == "exec":
        raw_cmd = tool_input.get("command")
        cmd = raw_cmd if isinstance(raw_cmd, str) else ""
        probe = re.sub(r"\d?>>?\s*/dev/null|\d?>&\d", " ", cmd)
        guarded = bool(GUARD_RE.search(probe) and WRITE_RE.search(probe))
        if not guarded and WRITE_RE.search(probe):
            for h in (os.path.expanduser("~"), os.environ.get("HOME")):
                if h and h not in ("/", "/root", "/home"):
                    h_norm = os.path.normpath(h)
                    esc_h = re.escape(h_norm)
                    if (
                        re.search(esc_h + r"/\.config/devin(?:/|\b)", probe)
                        or re.search(esc_h + r"/\.claude/(?:CLAUDE\.md\b|hooks\b|settings(?:\.local)?\.json\b)", probe)
                        or f"{h_norm}/.local/share/devin/hooks" in probe
                        or f"{h_norm}/.local/share/bb-devin/hooks" in probe
                    ):
                        guarded = True
                        break
    elif tool in FILE_TOOLS:
        targets = get_tool_targets(tool, tool_input, raw_patch_text)
        raw_cwd = data.get("cwd")
        cwd = raw_cwd if isinstance(raw_cwd, str) and raw_cwd else os.getcwd()
        for t in targets:
            c = os.path.expanduser(os.path.expandvars(t))
            if not os.path.isabs(c):
                c = os.path.join(cwd, c)
            p_abs = os.path.abspath(c)
            p_real = os.path.realpath(c)
            if is_path_guarded(p_abs) or is_path_guarded(p_real):
                guarded = True
                break

    if guarded:
        cmd_desc = tool_input.get("command") or raw_patch_text or json.dumps(tool_input)
        log(f"guard blocked {tool}: {str(cmd_desc)[:200]!r}")
        print(json.dumps({"decision": "block", "reason": GUARD_REASON}, ensure_ascii=False))
        return 2

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"error: {exc!r}")
        sys.exit(0)
