from __future__ import annotations

import sys

from .app import main as terminal_main
from .floating import main as floating_main


if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--terminal" in argv:
        argv = [arg for arg in argv if arg != "--terminal"]
        sys.argv = [sys.argv[0], *argv]
        raise SystemExit(terminal_main())
    raise SystemExit(floating_main())
