# File: infra/backup-job/test_backup.py
# Purpose: Unit tests for the VACUUM INTO + blob upload contract in backup.py.
# Role: Test suite for the production backup script; validates snapshot consistency,
#       upload wire-up, and temp-file cleanup on both success and failure paths.
# Last updated: Sprint 16 (2026-04-23) -- initial

import sqlite3
import tempfile
import os
import pytest
from unittest.mock import MagicMock, patch

from backup import run_backup


# ---- Fixtures ----

@pytest.fixture
def source_db(tmp_path):
    """Pytest-managed temp SQLite DB with a known row."""
    path = tmp_path / "test.db"
    with sqlite3.connect(str(path)) as conn:
        conn.execute("CREATE TABLE t (v INTEGER)")
        conn.execute("INSERT INTO t VALUES (42)")
    return str(path)


# ---- Tests ----

def test_vacuum_into_produces_consistent_copy(source_db, tmp_path):
    """VACUUM INTO creates a valid, readable SQLite copy with the original data."""
    dst_path = str(tmp_path / "copy.db")
    with sqlite3.connect(source_db) as conn:
        conn.execute(f"VACUUM INTO '{dst_path}'")
    with sqlite3.connect(dst_path) as conn:
        row = conn.execute("SELECT v FROM t").fetchone()
    assert row == (42,)



def test_run_backup_uploads_blob(source_db):
    """run_backup calls upload_blob with a non-empty file."""
    captured_content = []

    mock_blob_client = MagicMock()
    mock_service_client = MagicMock()
    mock_service_client.get_blob_client.return_value = mock_blob_client
    # Capture content while the file handle is still open
    mock_blob_client.upload_blob.side_effect = lambda f, **kw: captured_content.append(f.read())

    with patch("backup.DefaultAzureCredential"), \
         patch("backup.BlobServiceClient", return_value=mock_service_client):
        blob_name = run_backup(source_db, "my-account", "backups")

    assert blob_name.startswith("singing-bridge-")
    assert blob_name.endswith(".db")
    mock_service_client.get_blob_client.assert_called_once_with(
        container="backups", blob=blob_name
    )
    mock_blob_client.upload_blob.assert_called_once()
    assert len(captured_content) == 1 and len(captured_content[0]) > 0, \
        "backup file should not be empty"


def test_run_backup_deletes_temp_file_on_success(source_db):
    """Temporary file is removed after a successful upload."""
    created_tmp = []

    real_mkstemp = tempfile.mkstemp

    def capturing_mkstemp(*args, **kwargs):
        fd, path = real_mkstemp(*args, **kwargs)
        created_tmp.append(path)
        return fd, path

    with patch("backup.DefaultAzureCredential"), \
         patch("backup.BlobServiceClient") as mock_svc, \
         patch("tempfile.mkstemp", side_effect=capturing_mkstemp):
        mock_svc.return_value.get_blob_client.return_value = MagicMock()
        run_backup(source_db, "my-account", "backups")

    for path in created_tmp:
        assert not os.path.exists(path), f"temp file not cleaned up: {path}"


def test_run_backup_deletes_temp_file_on_upload_failure(source_db):
    """Temporary file is removed even if the upload raises."""
    created_tmp = []

    real_mkstemp = tempfile.mkstemp

    def capturing_mkstemp(*args, **kwargs):
        fd, path = real_mkstemp(*args, **kwargs)
        created_tmp.append(path)
        return fd, path

    mock_blob_client = MagicMock()
    mock_blob_client.upload_blob.side_effect = RuntimeError("upload failed")

    with patch("backup.DefaultAzureCredential"), \
         patch("backup.BlobServiceClient") as mock_svc, \
         patch("tempfile.mkstemp", side_effect=capturing_mkstemp):
        mock_svc.return_value.get_blob_client.return_value = mock_blob_client
        with pytest.raises(RuntimeError, match="upload failed"):
            run_backup(source_db, "my-account", "backups")

    for path in created_tmp:
        assert not os.path.exists(path), f"temp file not cleaned up after failure: {path}"
