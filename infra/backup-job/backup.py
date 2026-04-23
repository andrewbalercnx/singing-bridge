# File: infra/backup-job/backup.py
# Purpose: VACUUM INTO backup of singing-bridge.db → Azure Blob Storage via managed identity.
# Role: Production recovery mechanism for the SQLite database (teacher accounts, session history,
#       recording metadata, accompaniment library). Invoked by the sb-backup-job Container App Job.
# Last updated: Sprint 16 (2026-04-23) -- initial
#
# Reads DB_PATH, BACKUP_STORAGE_ACCOUNT, BACKUP_CONTAINER from environment.
# Uses DefaultAzureCredential (managed identity in production).
# VACUUM INTO produces a consistent single-file copy without requiring a WAL
# checkpoint or app quiescence.
#
# Storage model and accepted risk:
# The singing-bridge server stores BOTH the SQLite DB and application blobs (WAVs,
# PDFs, page images) under SB_DATA_DIR (/data), which is an NFS Azure Files Premium
# share. This backup job copies only the SQLite file. If the NFS share is lost or
# corrupted, blob content is also lost. Accepted risk: WAVs can be re-synthesized
# from PDFs and re-uploaded via the accompaniment pipeline; PDFs must be re-uploaded
# by the teacher. The DB (teacher accounts + metadata) is the harder loss; this job
# protects it. Blob backup may be added in a future sprint if re-upload burden becomes
# unacceptable. See knowledge/decisions/0001-mvp-architecture.md.

import os
import sqlite3
import tempfile
import datetime

from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient

def run_backup(db_path: str, storage_account: str, container: str) -> str:
    """Back up db_path to blob storage. Returns the blob name on success."""
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
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
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


if __name__ == "__main__":
    db_path = os.environ["DB_PATH"]
    storage_account = os.environ["BACKUP_STORAGE_ACCOUNT"]
    container = os.environ["BACKUP_CONTAINER"]
    blob_name = run_backup(db_path, storage_account, container)
    print(f"Backup uploaded: {blob_name}")
