"""
Tests for memory_guard.py — Phase F headroom check (2026-06-21).

The function reads `psutil.virtual_memory()` for real free RAM,
so the tests monkey-patch psutil to inject predictable values.
"""
from __future__ import annotations

import os
import pytest
from unittest.mock import patch, MagicMock

from model_training_agent.memory_guard import (
    HeadroomCheck,
    check_headroom,
    assert_headroom_or_advise,
)


_GB = 1024 ** 3


def _fake_vm(available_gb: float, total_gb: float = 32.0):
    """Build a fake psutil.virtual_memory() return value."""
    vm = MagicMock()
    vm.available = int(available_gb * _GB)
    vm.total = int(total_gb * _GB)
    return vm


class TestCheckHeadroom:
    def test_estimates_grow_with_rows_and_features(self):
        with patch("psutil.virtual_memory", return_value=_fake_vm(32.0)):
            small = check_headroom(100_000, 100)
            big = check_headroom(1_000_000, 500)
        # 50x more cells -> ~50x estimated peak.
        ratio = big.estimated_peak_bytes / small.estimated_peak_bytes
        assert 45 <= ratio <= 55

    def test_safety_factor_default_5x(self):
        with patch("psutil.virtual_memory", return_value=_fake_vm(32.0)):
            c = check_headroom(1_000_000, 500)
        # row × col × 4 bytes × 5 safety = 10_000_000_000 bytes
        # / 1024**3 (binary GB used throughout) = 9.31 GB
        assert abs(c.estimated_peak_gb - 9.31) < 0.05

    def test_headroom_ok_when_plenty_free(self):
        with patch("psutil.virtual_memory", return_value=_fake_vm(20.0)):
            c = check_headroom(500_000, 200)
        assert c.headroom_ok
        assert c.margin_bytes > 0

    def test_headroom_fails_when_too_little_free(self):
        with patch("psutil.virtual_memory", return_value=_fake_vm(2.0)):
            c = check_headroom(2_000_000, 600)  # ~24 GB est peak
        assert not c.headroom_ok
        assert c.margin_bytes < 0


class TestAssertHeadroom:
    def test_passes_silently_when_ok(self, capsys):
        with patch("psutil.virtual_memory", return_value=_fake_vm(30.0)):
            assert_headroom_or_advise(
                instrument="nifty50",
                row_count=600_000, feature_count=470,
                is_parallel_mode=False,
            )
        # No exception, no diagnostic dump.
        captured = capsys.readouterr()
        assert "HEADROOM" not in captured.out

    def test_raises_with_diagnostic_when_insufficient(self, capsys):
        with patch("psutil.virtual_memory", return_value=_fake_vm(2.0)):
            with pytest.raises(RuntimeError, match="Insufficient memory headroom"):
                assert_headroom_or_advise(
                    instrument="crudeoil",
                    row_count=1_750_000, feature_count=470,
                    is_parallel_mode=False,
                )
        out = capsys.readouterr().out
        assert "MEMORY HEADROOM CHECK FAILED" in out
        assert "crudeoil" in out
        assert "Close other RAM-heavy apps" in out

    def test_parallel_mode_suggests_serial(self, capsys):
        with patch("psutil.virtual_memory", return_value=_fake_vm(2.0)):
            with pytest.raises(RuntimeError):
                assert_headroom_or_advise(
                    instrument="naturalgas",
                    row_count=1_750_000, feature_count=470,
                    is_parallel_mode=True,
                )
        out = capsys.readouterr().out
        assert "SERIALLY" in out
        assert "--instrument naturalgas" in out

    def test_env_override_bypasses_check(self, capsys, monkeypatch):
        monkeypatch.setenv("TFA_SKIP_MEMORY_GUARD", "1")
        with patch("psutil.virtual_memory", return_value=_fake_vm(0.1)):
            # No raise even though we have only 100 MB.
            assert_headroom_or_advise(
                instrument="nifty50",
                row_count=10_000_000, feature_count=1000,
                is_parallel_mode=False,
            )
        # No diagnostic printed.
        assert "HEADROOM" not in capsys.readouterr().out
