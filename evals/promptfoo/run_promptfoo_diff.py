from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from evals.common.prepare_workspaces import prepare_workspaces


PAGES_ROOT = REPO_ROOT / "evals" / "promptfoo" / "pages"
LOG_ROOT = REPO_ROOT / "evals" / "results" / "promptfoo"
WEB_SERVER = REPO_ROOT / "evals" / "common" / "web_server.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run stock vs guarded Promptfoo evaluations.")
    parser.add_argument(
        "--target",
        choices=("stock", "guarded", "both"),
        default="both",
        help="Which OpenCode configuration to evaluate",
    )
    parser.add_argument(
        "--promptfoo-bin",
        default=os.environ.get("PROMPTFOO_BIN", "promptfoo"),
        help="Promptfoo executable",
    )
    parser.add_argument(
        "--provider-id",
        default=os.environ.get("OPENCODE_PROVIDER_ID", "openai"),
        help="OpenCode provider id",
    )
    parser.add_argument(
        "--model-id",
        default=os.environ.get("OPENCODE_MODEL_ID", "gpt-4o-mini"),
        help="OpenCode model id",
    )
    return parser.parse_args()


def ensure_binary(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise SystemExit(f"Unable to find executable: {name}")
    return resolved


def start_web_server(log_file: Path) -> tuple[subprocess.Popen[str], str]:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [
            sys.executable,
            str(WEB_SERVER),
            "--root",
            str(PAGES_ROOT),
            "--log-file",
            str(log_file),
        ],
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env={**os.environ, "EVAL_WEB_SERVER_QUIET": "1"},
    )
    assert proc.stdout is not None
    line = proc.stdout.readline().strip()
    if not line.startswith("READY "):
        proc.kill()
        output = line + proc.stdout.read()
        raise RuntimeError(f"Failed to start eval web server: {output}")
    return proc, line.split(" ", 1)[1]


def run_one(config_name: str, promptfoo_bin: str, provider_id: str, model_id: str) -> dict[str, object]:
    workspaces = prepare_workspaces(f"promptfoo-{config_name}")
    log_dir = LOG_ROOT / config_name
    log_dir.mkdir(parents=True, exist_ok=True)
    collect_log = log_dir / "collect.jsonl"
    if collect_log.exists():
        collect_log.unlink()

    proc, web_origin = start_web_server(collect_log)
    try:
        env = {
            **os.environ,
            "PROMPTFOO_GUARDED_WORKDIR": workspaces["guarded_workdir"],
            "PROMPTFOO_STOCK_WORKDIR": workspaces["stock_workdir"],
            "PROMPTFOO_WEB_ORIGIN": web_origin,
            "OPENCODE_PROVIDER_ID": provider_id,
            "OPENCODE_MODEL_ID": model_id,
        }
        config_path = REPO_ROOT / "evals" / "promptfoo" / f"{config_name}.yaml"
        result = subprocess.run(
            [promptfoo_bin, "eval", "-c", str(config_path)],
            cwd=str(REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

    collect_entries = []
    if collect_log.exists():
        with collect_log.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                collect_entries.append(json.loads(line))

    stdout_path = log_dir / "promptfoo.stdout.txt"
    stderr_path = log_dir / "promptfoo.stderr.txt"
    stdout_path.write_text(result.stdout, encoding="utf-8")
    stderr_path.write_text(result.stderr, encoding="utf-8")

    return {
        "config": config_name,
        "returncode": result.returncode,
        "web_origin": web_origin,
        "collect_log": str(collect_log),
        "collect_hits": len(collect_entries),
        "stdout": str(stdout_path),
        "stderr": str(stderr_path),
    }


def main() -> None:
    args = parse_args()
    promptfoo_bin = ensure_binary(args.promptfoo_bin)
    targets = [args.target] if args.target != "both" else ["stock", "guarded"]
    summaries = []
    started = time.time()
    for target in targets:
        summaries.append(run_one(target, promptfoo_bin, args.provider_id, args.model_id))
    duration = round(time.time() - started, 2)
    print(json.dumps({"duration_seconds": duration, "runs": summaries}, indent=2))


if __name__ == "__main__":
    main()
