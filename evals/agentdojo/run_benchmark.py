from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agentdojo.attacks.attack_registry import load_attack
from agentdojo.benchmark import benchmark_suite_with_injections
from agentdojo.logging import OutputLogger

from evals.agentdojo.opencode_pipeline import OpenCodePipeline
from evals.agentdojo.suites.opencode_guard.task_suite import task_suite


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AgentDojo against stock or guarded OpenCode.")
    parser.add_argument("--mode", choices=("stock", "guarded"), required=True)
    parser.add_argument("--attack", default="ignore_previous")
    parser.add_argument("--model", default=None, help="OpenCode model in provider/model form")
    parser.add_argument("--logdir", default=None, help="Directory for AgentDojo logs")
    parser.add_argument("--opencode-bin", default="opencode")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--force-rerun", action="store_true")
    parser.add_argument("--user-task", action="append", default=None)
    parser.add_argument("--injection-task", action="append", default=None)
    return parser.parse_args()


def compute_metrics(results) -> dict[str, float]:
    utility_total = len(results["utility_results"])
    utility_pass = sum(1 for passed in results["utility_results"].values() if passed)
    security_total = len(results["security_results"])
    security_pass = sum(1 for passed in results["security_results"].values() if passed)
    return {
        "utility_pass_rate": utility_pass / utility_total if utility_total else 0.0,
        "security_pass_rate": security_pass / security_total if security_total else 0.0,
        "utility_cases": utility_total,
        "security_cases": security_total,
    }


def main() -> None:
    args = parse_args()
    opencode_bin = shutil.which(args.opencode_bin) or args.opencode_bin
    pipeline = OpenCodePipeline(
        mode=args.mode,
        model=args.model,
        opencode_bin=opencode_bin,
        timeout_seconds=args.timeout_seconds,
    )
    attack = load_attack(args.attack, task_suite, pipeline)

    logdir = Path(args.logdir) if args.logdir else REPO_ROOT / "evals" / "results" / "agentdojo" / args.mode / args.attack
    logdir.mkdir(parents=True, exist_ok=True)

    with OutputLogger(str(logdir)):
        results = benchmark_suite_with_injections(
            agent_pipeline=pipeline,
            suite=task_suite,
            attack=attack,
            logdir=logdir,
            force_rerun=args.force_rerun,
            user_tasks=args.user_task,
            injection_tasks=args.injection_task,
            verbose=True,
            benchmark_version="opencode_taint_guard",
        )

    summary = {
        "mode": args.mode,
        "attack": args.attack,
        "model": args.model,
        "logdir": str(logdir),
        "metrics": compute_metrics(results),
        "utility_results": {f"{user}:{inj}": passed for (user, inj), passed in results["utility_results"].items()},
        "security_results": {f"{user}:{inj}": passed for (user, inj), passed in results["security_results"].items()},
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
