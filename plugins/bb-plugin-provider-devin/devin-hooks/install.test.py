#!/usr/bin/env python3
"""Тесты установщика install.py:
1. Режим --check без subagents_enabled и при отсутствующем config.json.
2. Чтение JSONC с комментариями и создание <realTarget>.bak с правами 0600.
3. Сохранение симлинка (os.path.realpath) и сохранение прав файла (0644 или 0600 для нового).
4. Единый matcher для инструментов.
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
INSTALL = os.path.join(HERE, "install.py")

fails = 0


def report(ok, title, details=""):
    global fails
    fails += not ok
    status = "ok  " if ok else "FAIL"
    msg = f"{status} {title}"
    if details:
        msg += f" ({details})"
    print(msg)


def run_installer(args=None, env_extra=None):
    cmd = [sys.executable, "-I", INSTALL] + (args or [])
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def extract_json(stdout):
    start = stdout.find("{")
    end = stdout.rfind("}")
    if start != -1 and end != -1:
        return json.loads(stdout[start:end + 1])
    return {}


print("=== 1. Проверка: --check при отсутствующем config.json ===")
with tempfile.TemporaryDirectory() as tmpdir:
    conf_path = os.path.join(tmpdir, "nonexistent", "config.json")
    env = {
        "DEVIN_CONFIG_PATH": conf_path,
        "DEVIN_HOOKS_DEST": os.path.join(tmpdir, "hooks"),
        "DEVIN_LEGACY_HOOKS": os.path.join(tmpdir, "legacy_hooks"),
    }
    rc, stdout, stderr = run_installer(["--check"], env)
    report(rc == 0 and not stderr, "--check on missing config returns 0", f"rc={rc}")
    try:
        out_json = extract_json(stdout)
        keys = out_json.get("would_write_keys", {})
        has_expected = "hooks" in keys and "read_config_from" in keys and "subagents_enabled" not in keys
    except Exception:
        has_expected = False
    report(has_expected, "--check output contains would_write_keys without subagents_enabled")
    report(not os.path.exists(conf_path), "missing config was not written during --check")

print("\n=== 2. Проверка: --check без subagents_enabled в существующем конфиге ===")
with tempfile.TemporaryDirectory() as tmpdir:
    conf_path = os.path.join(tmpdir, "config.json")
    with open(conf_path, "w", encoding="utf-8") as f:
        json.dump({"custom_setting": 123}, f)
    env = {
        "DEVIN_CONFIG_PATH": conf_path,
        "DEVIN_HOOKS_DEST": os.path.join(tmpdir, "hooks"),
        "DEVIN_LEGACY_HOOKS": os.path.join(tmpdir, "legacy_hooks"),
    }
    rc, stdout, stderr = run_installer(["--check"], env)
    report(rc == 0 and "KeyError" not in stderr, "--check without subagents_enabled does not raise KeyError")
    try:
        out_json = extract_json(stdout)
        keys = out_json.get("would_write_keys", {})
        ok_keys = "hooks" in keys and "subagents_enabled" not in keys
    except Exception:
        ok_keys = False
    report(ok_keys, "--check output keys match spec")

print("\n=== 3. Проверка: чтение JSONC с комментариями и создание .bak (0600) ===")
with tempfile.TemporaryDirectory() as tmpdir:
    conf_path = os.path.join(tmpdir, "config.json")
    jsonc_content = """{
  // начальный комментарий пользователя
  "read_config_from": {
    /* многострочный комментарий */
    "custom": true,
  },
  "other": "val",
}
"""
    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(jsonc_content)
    os.chmod(conf_path, 0o644)

    env = {
        "DEVIN_CONFIG_PATH": conf_path,
        "DEVIN_HOOKS_DEST": os.path.join(tmpdir, "hooks"),
        "DEVIN_LEGACY_HOOKS": os.path.join(tmpdir, "legacy_hooks"),
    }
    rc, stdout, stderr = run_installer([], env)
    report(rc == 0 and not stderr, "installer successfully parsed JSONC", f"rc={rc}")

    # Проверяем бэкап .bak
    bak_path = conf_path + ".bak"
    report(os.path.exists(bak_path), ".bak file was created for JSONC with comments")
    if os.path.exists(bak_path):
        bak_mode = stat.S_IMODE(os.stat(bak_path).st_mode)
        report(bak_mode == 0o600, f".bak file has mode 0600 (got {oct(bak_mode)})")
        with open(bak_path, "r", encoding="utf-8") as f:
            bak_content = f.read()
        report("// начальный комментарий" in bak_content and "/* многострочный" in bak_content,
               ".bak contains original comments")

    # Проверяем новый конфиг (чистый JSON)
    with open(conf_path, "r", encoding="utf-8") as f:
        new_data = json.load(f)
    report(new_data.get("other") == "val" and new_data.get("read_config_from", {}).get("claude") is True,
           "new config is valid JSON with preserved keys and claude=True")

    # 3b. Однократность .bak: повторный запуск при изменении файла не перезаписывает исходный .bak
    second_jsonc = """{
  // второй комментарий
  "read_config_from": {"claude": false},
  "other": "val2"
}"""
    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(second_jsonc)
    run_installer([], env)
    with open(bak_path, "r", encoding="utf-8") as f:
        bak_after = f.read()
    report("// начальный комментарий" in bak_after and "// второй комментарий" not in bak_after,
           "existing .bak is preserved once created (not overwritten on rerun)")

    # 3c. Сохранение комментариев при new == config (файл уже настроен -> перезапись не требуется)
    with open(conf_path, "r", encoding="utf-8") as f:
        configured_data = json.load(f)
    configured_with_comments = """{
  // этот комментарий пользователя должен сохраниться
  "hooks": """ + json.dumps(configured_data["hooks"]) + """,
  "read_config_from": """ + json.dumps(configured_data["read_config_from"]) + """,
  "other": "val2"
}"""
    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(configured_with_comments)
    os.remove(bak_path)
    rc_noop, stdout_noop, _ = run_installer([], env)
    report(rc_noop == 0 and "config.json уже настроен" in stdout_noop,
           "installer detects already configured config even with comments")
    with open(conf_path, "r", encoding="utf-8") as f:
        current_conf = f.read()
    report("// этот комментарий пользователя должен сохраниться" in current_conf,
           "comments preserved when new == config (file was not overwritten)")
    report(not os.path.exists(bak_path), "no .bak created when new == config")

print("\n=== 3d. Проверка: чтение JSONC с UTF-8 BOM (\\ufeff) ===")
with tempfile.TemporaryDirectory() as tmpdir:
    conf_path = os.path.join(tmpdir, "config.json")
    bom_content = "\ufeff{\n  // комментарий с BOM\n  \"bom_key\": \"bom_val\",\n}\n"
    with open(conf_path, "wb") as f:
        f.write(bom_content.encode("utf-8"))
    env = {
        "DEVIN_CONFIG_PATH": conf_path,
        "DEVIN_HOOKS_DEST": os.path.join(tmpdir, "hooks"),
        "DEVIN_LEGACY_HOOKS": os.path.join(tmpdir, "legacy_hooks"),
    }
    rc, stdout, stderr = run_installer([], env)
    report(rc == 0 and not stderr, "installer handles UTF-8 BOM without error", f"rc={rc}")
    with open(conf_path, "r", encoding="utf-8") as f:
        new_data = json.load(f)
    report(new_data.get("bom_key") == "bom_val", "BOM config parsed and updated correctly")

print("\n=== 4. Проверка: сохранение симлинка и прав существующего/нового файла ===")
with tempfile.TemporaryDirectory() as tmpdir:
    dotfiles_dir = os.path.join(tmpdir, "dotfiles")
    os.makedirs(dotfiles_dir, mode=0o755, exist_ok=True)
    os.chmod(dotfiles_dir, 0o755)

    real_file = os.path.join(dotfiles_dir, "real_config.json")
    with open(real_file, "w", encoding="utf-8") as f:
        json.dump({"x": 1}, f)
    os.chmod(real_file, 0o644)

    symlink_file = os.path.join(tmpdir, "symlink_config.json")
    os.symlink(real_file, symlink_file)

    env = {
        "DEVIN_CONFIG_PATH": symlink_file,
        "DEVIN_HOOKS_DEST": os.path.join(tmpdir, "hooks"),
        "DEVIN_LEGACY_HOOKS": os.path.join(tmpdir, "legacy_hooks"),
    }
    rc, stdout, stderr = run_installer([], env)
    report(rc == 0, "run installer with symlinked config", f"rc={rc}")
    report(os.path.islink(symlink_file), "config path remains a symlink")
    report(os.path.realpath(symlink_file) == os.path.realpath(real_file), "symlink points to real file")
    real_mode = stat.S_IMODE(os.stat(real_file).st_mode)
    report(real_mode == 0o644, f"existing file mode 0644 preserved (got {oct(real_mode)})")

    # Проверка, что права существующего каталога 0755 не сменились на 0700
    dotfiles_mode = stat.S_IMODE(os.stat(dotfiles_dir).st_mode)
    report(dotfiles_mode == 0o755, f"existing directory mode 0755 preserved (got {oct(dotfiles_mode)})")

    # Проверка прав для нового каталога (0700) и нового файла (0600)
    brand_new_dir = os.path.join(tmpdir, "brand_new_dir")
    new_conf_path = os.path.join(brand_new_dir, "new_config.json")
    env["DEVIN_CONFIG_PATH"] = new_conf_path
    rc_new, _, _ = run_installer([], env)
    report(rc_new == 0, "installed new config file", f"rc={rc_new}")
    dir_mode_new = stat.S_IMODE(os.stat(brand_new_dir).st_mode)
    report(dir_mode_new == 0o700, f"newly created directory mode is 0700 (got {oct(dir_mode_new)})")
    new_mode = stat.S_IMODE(os.stat(new_conf_path).st_mode)
    report(new_mode == 0o600, f"new config file mode is 0600 (got {oct(new_mode)})")

print("\n=== 4b. Проверка: fix_legacy_link при отсутствии каталога LEGACY ===")
with tempfile.TemporaryDirectory() as tmpdir:
    deep_legacy = os.path.join(tmpdir, "nested_legacy", "hooks")
    env = {
        "DEVIN_CONFIG_PATH": os.path.join(tmpdir, "config.json"),
        "DEVIN_HOOKS_DEST": os.path.join(tmpdir, "hooks"),
        "DEVIN_LEGACY_HOOKS": deep_legacy,
    }
    rc, stdout, stderr = run_installer([], env)
    report(rc == 0, "installer created legacy symlink with missing parent", f"rc={rc}")
    report(os.path.islink(deep_legacy), "legacy link was created")
    parent_mode = stat.S_IMODE(os.stat(os.path.dirname(deep_legacy)).st_mode)
    report(parent_mode == 0o700, f"created legacy parent directory mode is 0700 (got {oct(parent_mode)})")
    report(f"{deep_legacy} -> {os.path.join(tmpdir, 'hooks')}" in stdout, "installer printed legacy link message")

print("\n=== 5. Проверка: единый matcher инструментов ===")
spec = importlib.util.spec_from_file_location("devin_install", INSTALL)
install_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_mod)

hooks_dict = install_mod.our_hooks()
expected_matcher = "^(exec|write|edit|MultiEdit|apply_patch|notebook_edit|NotebookEdit|write_file|edit_file)$"
pre_tool_matchers = [entry.get("matcher") for entry in hooks_dict.get("PreToolUse", [])]
report(expected_matcher in pre_tool_matchers,
       f"matcher in install.py matches spec ({expected_matcher})")

print(f"\nИтог install.test.py: fails={fails}")
sys.exit(1 if fails else 0)
