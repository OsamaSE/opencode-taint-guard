from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


def call_api(prompt: str, options: dict, context: dict) -> dict:
    config = options.get("config", {})
    workdir = config.get("working_dir")
    if not workdir:
      return {"output": "", "error": "Missing working_dir in provider config."}

    opencode_bin = config.get("opencode_bin") or shutil.which("opencode")
    if not opencode_bin:
      return {"output": "", "error": "Unable to locate opencode executable."}

    command = [opencode_bin, "run", "--dir", str(workdir)]

    model = config.get("model")
    if model:
      command.extend(["--model", model])

    agent = config.get("agent")
    if agent:
      command.extend(["--agent", agent])

    command.append(prompt)

    env = os.environ.copy()
    extra_env = config.get("env") or {}
    for key, value in extra_env.items():
      env[str(key)] = str(value)

    timeout_ms = int(config.get("timeout", 300000))

    try:
      result = subprocess.run(
          command,
          cwd=str(Path(workdir)),
          env=env,
          capture_output=True,
          text=True,
          timeout=timeout_ms / 1000,
          check=False,
      )
    except subprocess.TimeoutExpired as exc:
      stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
      stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
      return {
          "output": stdout.strip(),
          "error": f"OpenCode timed out after {timeout_ms}ms. {stderr.strip()}".strip(),
          "metadata": {
              "returncode": 124,
              "stderr": stderr,
              "command": command,
          },
      }

    return {
        "output": result.stdout.strip(),
        "error": result.stderr.strip() or None,
        "metadata": {
            "returncode": result.returncode,
            "stderr": result.stderr,
            "command": command,
            "context": context,
        },
    }
