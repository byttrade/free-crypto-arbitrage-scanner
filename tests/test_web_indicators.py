import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="нет node")
@pytest.mark.parametrize("check", ["indicators", "ladder"])
def test_web_checks(check):
    out = subprocess.run(["node", f"tests/{check}.check.ts"], cwd=Path(__file__).parent.parent,
                         capture_output=True, text=True, timeout=60)
    if "Unknown file extension" in out.stderr or "ERR_UNKNOWN_FILE_EXTENSION" in out.stderr:
        pytest.skip("node без поддержки .ts (нужен 22.18+)")
    assert out.returncode == 0, out.stderr
