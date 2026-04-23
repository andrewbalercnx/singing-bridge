# File: infra/backup-job/backup.py
# Purpose: VACUUM INTO backup of singing-bridge.db → Azure Blob Storage via managed identity.
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

DB_PATH = os.environ["DB_PATH"]
STORAGE_ACCOUNT = os.environ["BACKUP_STORAGE_ACCOUNT"]
CONTAINER = os.environ["BACKUP_CONTAINER"]

timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
blob_name = f"singing-bridge-{timestamp}.db"

with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
    tmp_path = tmp.name

try:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(f"VACUUM INTO '{tmp_path}'")
    conn.close()

    credential = DefaultAzureCredential()
    account_url = f"https://{STORAGE_ACCOUNT}.blob.core.windows.net"
    client = BlobServiceClient(account_url=account_url, credential=credential)
    blob_client = client.get_blob_client(container=CONTAINER, blob=blob_name)

    with open(tmp_path, "rb") as f:
        blob_client.upload_blob(f, overwrite=False)

    print(f"Backup uploaded: {blob_name}")
finally:
    os.unlink(tmp_path)
