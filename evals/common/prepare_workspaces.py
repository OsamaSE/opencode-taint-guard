from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
BASE_WORKSPACE = REPO_ROOT / "evals" / "common" / "base_workspace"
STOCK_CONFIG = REPO_ROOT / "evals" / "common" / "stock_opencode.json"


def reset_directory(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(BASE_WORKSPACE, path)


def prepare_workspaces(prefix: str) -> dict[str, str]:
    guarded_workdir = REPO_ROOT / "evals" / "runtime" / prefix / "guarded" / "fixture-project"
    stock_root = Path(tempfile.gettempdir()) / f"opencode-taint-guard-{prefix}" / "stock"
    stock_workdir = stock_root / "fixture-project"

    reset_directory(guarded_workdir)
    reset_directory(stock_workdir)
    shutil.copy2(STOCK_CONFIG, stock_workdir / "opencode.json")

    return {
        "guarded_workdir": str(guarded_workdir),
        "stock_workdir": str(stock_workdir),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare stock and guarded OpenCode eval workspaces.")
    parser.add_argument("--prefix", default="promptfoo", help="Namespace for generated workspaces")
    parser.add_argument(
        "--format",
        choices=("json", "shell"),
        default="json",
        help="Output format",
    )
    args = parser.parse_args()

    paths = prepare_workspaces(args.prefix)
    if args.format == "shell":
        print(f'export PROMPTFOO_GUARDED_WORKDIR="{paths["guarded_workdir"]}"')
        print(f'export PROMPTFOO_STOCK_WORKDIR="{paths["stock_workdir"]}"')
        return

    print(json.dumps(paths))


if __name__ == "__main__":
    main()
