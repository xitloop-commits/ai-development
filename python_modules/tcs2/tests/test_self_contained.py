"""TCS2 - the isolation rule, enforced rather than merely written down.

Spec: docs/systems/14_tcs2.md  D7, D14, D27, D42, D43

Partha, 2026-09-25: build exclusively for TCS2; do not use the existing programs
and scripts created for TFA.

This file turns that instruction into something the test suite checks. Every
other module in this package is scanned for an import of another in-repo
package, and nothing outside a small declared allowlist is permitted - not in the
runtime modules, and not in the tests either.

Why it is a test and not a note in the spec: the failure mode is quiet. Someone
needing a gzip reader or a Greeks helper finds one already written a directory
away, imports it, and TCS2 silently acquires a dependency on code that gets
restarted, refactored, or - as T195 showed - is wrong in a way TCS2 would then
inherit.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parent.parent
PYTHON_MODULES = PACKAGE.parent

# Other packages in python_modules/. TCS2 may import NONE of them.
FORBIDDEN_PREFIXES = (
    "tick_feature_agent",
    "claude_cohort",
    "blast_model",
    "sma_model",
    "signal_engine_agent",
    "model_training_agent",
    "market_screen",
    "_shared",
    "env_loader",
    "holdout_utils",
    "internal_api",
    "market_calendar",
)

# Everything TCS2 is allowed to depend on, deliberately short.
ALLOWED_THIRD_PARTY = {"numpy", "websockets", "pymongo", "pytest"}


def _modules() -> list[Path]:
    return sorted(p for p in PACKAGE.rglob("*.py") if "__pycache__" not in p.parts)


def _imported_roots(path: Path) -> set[str]:
    """Top-level package name of every import in a file, including inside functions."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                roots.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level:            # relative import, i.e. within tcs2
                continue
            if node.module:
                roots.add(node.module.split(".")[0])
    return roots


def test_the_package_has_modules_to_check():
    """Guard against this file silently passing because it found nothing."""
    assert len(_modules()) >= 8


@pytest.mark.parametrize("path", _modules(), ids=lambda p: p.name)
def test_no_module_imports_another_in_repo_package(path: Path):
    """D43: TCS2 imports nothing from TFA or the research packages.

    Applies to the tests too. A test that reaches into another package makes the
    suite fail whenever that package is mid-refactor, and quietly treats it as a
    standard TCS2 should be measured against - which D42 rejects.
    """
    offenders = sorted(r for r in _imported_roots(path)
                       if r.startswith(FORBIDDEN_PREFIXES))
    assert not offenders, (
        f"{path.name} imports {offenders} from another package. "
        f"TCS2 is self-contained (D43): write what is needed inside tcs2/, or "
        f"consult the other code and re-derive it - never import it."
    )


@pytest.mark.parametrize("path", _modules(), ids=lambda p: p.name)
def test_third_party_dependencies_stay_declared(path: Path):
    """Keep the dependency list short enough to hold in your head.

    Anything new here is a decision, not an accident: scipy was deliberately
    avoided by implementing the normal CDF in numpy (D39), and that choice is
    only durable if adding a dependency is visible.
    """
    import sys
    stdlib = set(sys.stdlib_module_names)
    extras = sorted(r for r in _imported_roots(path)
                    if r not in stdlib
                    and r not in ALLOWED_THIRD_PARTY
                    and not r.startswith(FORBIDDEN_PREFIXES)
                    and r != "tcs2")
    assert not extras, (
        f"{path.name} pulls in {extras}. Add it to ALLOWED_THIRD_PARTY here and "
        f"to python_modules/requirements.txt if it is genuinely wanted."
    )


def test_tcs2_owns_the_things_it_could_have_borrowed():
    """The concrete list, so this cannot quietly regress to imports later.

    Each of these exists elsewhere in the repo. TCS2 has its own.
    """
    import tcs2.flow
    import tcs2.greeks
    import tcs2.wire

    assert callable(tcs2.wire.parse_packet)      # vs tick_feature_agent/feed
    assert callable(tcs2.flow.classify)          # vs features/ofi.py, claude_cohort
    assert callable(tcs2.greeks.implied_vol)     # exists nowhere else at all
    assert callable(tcs2.greeks.price_and_greeks)  # vs blast_model/greeks.py


# -- D52: where the data lands must not depend on the cwd ----------------

def test_data_paths_are_absolute_and_anchored_to_the_repo():
    """Found live 2026-09-25, mid-session.

    `startup/tcs2.bat` changed into `python_modules` so that `tcs2` imported as a
    top-level package. Every data path was relative, so a SECOND data tree
    appeared at `python_modules/data/tcs2/` holding 4 MB of nifty ticks, while the
    real recording looked stalled.

    The second symptom was worse: those processes also watched the wrong
    directory for their stop sentinel, so `--stop` could not reach them and they
    appeared unkillable.

    Where a day's ticks land must never depend on where the process was launched.
    """
    from tcs2 import config as cfg

    for name in ("DATA_ROOT", "SCRIP_DIR", "SCRIP_CSV", "TICKS_DIR",
                 "ANALYSER_DIR", "HEALTH_DIR", "LOGS_DIR", "RESOLVED_DIR"):
        path = getattr(cfg, name)
        assert path.is_absolute(), f"cfg.{name} is relative: {path}"

    # And anchored to this repository, not to wherever Python happens to be.
    assert cfg.REPO_ROOT.name and (cfg.REPO_ROOT / "python_modules").is_dir()
    assert cfg.DATA_ROOT == cfg.REPO_ROOT / "data" / "tcs2"
    assert "python_modules" not in cfg.DATA_ROOT.parts, (
        "the data tree must not sit inside python_modules")


def test_paths_do_not_move_when_the_cwd_changes():
    """The actual failure, reproduced: import, chdir, and check nothing moved."""
    import importlib
    import os
    from pathlib import Path

    from tcs2 import config as cfg
    before = cfg.TICKS_DIR

    cwd = os.getcwd()
    try:
        os.chdir(Path(cfg.REPO_ROOT) / "python_modules")
        importlib.reload(cfg)
        assert cfg.TICKS_DIR == before, (
            "changing directory moved the data tree - this is the 2026-09-25 bug")
    finally:
        os.chdir(cwd)
        importlib.reload(cfg)
