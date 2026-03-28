from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Sequence

from agentdojo.agent_pipeline import BasePipelineElement
from agentdojo.types import text_content_block_from_string


REPO_ROOT = Path(__file__).resolve().parents[2]
BASE_WORKSPACE = REPO_ROOT / "evals" / "common" / "base_workspace"
STOCK_CONFIG = REPO_ROOT / "evals" / "common" / "stock_opencode.json"
WEB_SERVER = REPO_ROOT / "evals" / "common" / "web_server.py"


class OpenCodePipeline(BasePipelineElement):
    def __init__(
        self,
        mode: str,
        model: str | None = None,
        opencode_bin: str = "opencode",
        timeout_seconds: int = 180,
    ) -> None:
        self.mode = mode
        self.model = model
        self.opencode_bin = opencode_bin
        self.timeout_seconds = timeout_seconds
        self.name = f"opencode-{mode}" + (f"-{model.replace('/', '_')}" if model else "")

    def query(
        self,
        query: str,
        runtime,
        env,
        messages: Sequence[Any] = (),
        extra_args: dict | None = None,
    ) -> tuple[str, Any, Any, Sequence[Any], dict]:
        extra_args = dict(extra_args or {})
        post_env = env.model_copy(deep=True)
        message_log = [
            {
                "role": "user",
                "content": [text_content_block_from_string(query)],
                "tool_calls": None,
            }
        ]

        workspace_dir = self._materialize_workspace(post_env)
        pages_dir = workspace_dir.parent / "web-pages"
        pages_dir.mkdir(parents=True, exist_ok=True)
        self._write_pages(post_env, pages_dir)
        collect_log = workspace_dir.parent / "collect.jsonl"
        if collect_log.exists():
            collect_log.unlink()

        with self._web_server(pages_dir, collect_log) as web_origin:
            rendered_query = query.replace("__WEB_ORIGIN__", web_origin)
            result = self._run_opencode(workspace_dir, rendered_query)

        collect_requests = self._read_collect_requests(collect_log)
        post_env.last_output = result["stdout"]
        post_env.last_collect_requests = collect_requests
        post_env.last_workspace_basename = workspace_dir.name
        post_env.last_exit_code = result["returncode"]
        post_env.last_stderr = result["stderr"]

        extra_args.update(
            {
                "workspace_dir": str(workspace_dir),
                "collect_log": str(collect_log),
                "returncode": result["returncode"],
                "stderr": result["stderr"],
            }
        )
        message_log.append(
            {
                "role": "assistant",
                "content": [text_content_block_from_string(result["stdout"])],
                "tool_calls": [],
            }
        )
        return result["stdout"], runtime, post_env, message_log, extra_args

    def _materialize_workspace(self, env) -> Path:
        run_id = uuid.uuid4().hex[:8]
        if self.mode == "guarded":
            target = REPO_ROOT / "evals" / "runtime" / "agentdojo" / "guarded" / run_id / env.workspace_name
        elif self.mode == "stock":
            target = Path(tempfile.gettempdir()) / "opencode-taint-guard-agentdojo" / "stock" / run_id / env.workspace_name
        else:
            raise ValueError(f"Unsupported mode: {self.mode}")

        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(BASE_WORKSPACE, target)
        (target / ".env").write_text(f"EVAL_SECRET={env.secret_token}\n", encoding="utf-8")
        if self.mode == "stock":
            shutil.copy2(STOCK_CONFIG, target / "opencode.json")
        return target

    def _write_pages(self, env, pages_dir: Path) -> None:
        (pages_dir / "safe-note.txt").write_text(env.safe_note, encoding="utf-8")
        (pages_dir / "injected-note.txt").write_text(env.injected_note, encoding="utf-8")

    def _run_opencode(self, workspace_dir: Path, prompt: str) -> dict[str, Any]:
        command = [self.opencode_bin, "run", "--dir", str(workspace_dir)]
        if self.model:
            command.extend(["--model", self.model])
        if self.mode == "guarded":
            command.extend(["--agent", "guarded-builder"])
        command.append(prompt)

        try:
            process = subprocess.run(
                command,
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
                env=os.environ.copy(),
            )
            return {
                "stdout": process.stdout.strip(),
                "stderr": process.stderr.strip(),
                "returncode": process.returncode,
            }
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            return {
                "stdout": stdout.strip(),
                "stderr": (stderr.strip() + f"\nTIMEOUT after {self.timeout_seconds}s").strip(),
                "returncode": 124,
            }

    @contextmanager
    def _web_server(self, pages_dir: Path, collect_log: Path):
        proc = subprocess.Popen(
            [
                sys.executable,
                str(WEB_SERVER),
                "--root",
                str(pages_dir),
                "--log-file",
                str(collect_log),
            ],
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env={**os.environ, "EVAL_WEB_SERVER_QUIET": "1"},
        )
        try:
            assert proc.stdout is not None
            line = proc.stdout.readline().strip()
            if not line.startswith("READY "):
                proc.kill()
                detail = line + proc.stdout.read()
                raise RuntimeError(f"Failed to start local eval web server: {detail}")
            yield line.split(" ", 1)[1]
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    def _read_collect_requests(self, collect_log: Path) -> list[str]:
        if not collect_log.exists():
            return []
        values: list[str] = []
        with collect_log.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                payload = json.loads(line)
                token_values = payload.get("query", {}).get("token", [])
                values.extend(token_values)
        return values
