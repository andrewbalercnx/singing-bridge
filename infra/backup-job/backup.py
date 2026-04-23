# File: infra/backup-job/backup.py
# Purpose: VACUUM INTO backup of singing-bridge.db → Azure Blob Storage via managed identity.
# Role: Production recovery mechanism — backs up the SQLite database that holds teacher accounts,
#       session history, recording metadata, and accompaniment library. Azure Blob files (WAVs,
#       PDFs, page images) use LRS (3 copies) and are not backed up here; re-upload or
#       re-synthesis can recover them if needed.
# Last updated: Sprint 16 (2026-04-23) -- initial
#
# Reads DB_PATH, BACKUP_STORAGE_ACCOUNT, BACKUP_CONTAINER from environment.
# Uses DefaultAzureCredential (managed identity in production).
# VACUUM INTO produces a consistent single-file copy without requiring a WAL
# checkpoint or app quiescence.

import os
import sqlite3
import tempfile
import datetime

from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient

def run_backup(db_path: str, storage_account: str, container: str) -> str:
    """Back up db_path to blob storage. Returns the blob name on success."""
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    blob_name = f"singing-bridge-{timestamp}.db"

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db")
    os.close(tmp_fd)
    os.unlink(tmp_path)  # VACUUM INTO requires the destination to not exist

    try:
        with sqlite3.connect(db_path) as conn:
            conn.execute(f"VACUUM INTO '{tmp_path}'")

        credential = DefaultAzureCredential()
        account_url = f"https://{storage_account}.blob.core.windows.net"
        client = BlobServiceClient(account_url=account_url, credential=credential)
        blob_client = client.get_blob_client(container=container, blob=blob_name)

        with open(tmp_path, "rb") as f:
            blob_client.upload_blob(f, overwrite=False)

        return blob_name
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    db_path = os.environ["DB_PATH"]
    storage_account = os.environ["BACKUP_STORAGE_ACCOUNT"]
    container = os.environ["BACKUP_CONTAINER"]
    blob_name = run_backup(db_path, storage_account, container)
    print(f"Backup uploaded: {blob_name}")
