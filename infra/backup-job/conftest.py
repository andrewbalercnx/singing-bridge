# File: infra/backup-job/conftest.py
# Purpose: Stub azure SDK modules so backup.py can be imported without the real SDKs installed.
# Last updated: Sprint 16 (2026-04-23) -- fix CI ModuleNotFoundError
import sys
from unittest.mock import MagicMock

_azure = MagicMock()
for _mod in ("azure", "azure.identity", "azure.storage", "azure.storage.blob"):
    sys.modules.setdefault(_mod, _azure)
