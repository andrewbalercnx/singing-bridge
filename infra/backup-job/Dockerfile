# File: infra/backup-job/Dockerfile
# Purpose: Backup image — sqlite3 + azure-storage-blob, runs as UID 65532:65532.
# Role: Container image for the sb-backup-job Container App Job (backup-job.bicep).
#       Mounts the NFS /data share read-only to run VACUUM INTO, uploads to Azure
#       Blob Storage, and exits. Must never run as root (NoRootSquash on NFS share).
# Last updated: Sprint 16 (2026-04-23) -- initial; pin base image by digest
#
# Digest pinned to python:3.12-slim (linux/amd64, 2026-04-23).
# Refresh with: docker pull python:3.12-slim --platform linux/amd64 &&
#               docker inspect --format='{{index .RepoDigests 0}}' python:3.12-slim
FROM python:3.12-slim@sha256:520153e2deb359602c9cffd84e491e3431d76e7bf95a3255c9ce9433b76ab99a

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backup.py .

# NFS share uses NoRootSquash. This container MUST run as UID 65532:65532 (never root)
# because root in-container would have root access on the NFS server with NoRootSquash.
USER 65532:65532

CMD ["python", "backup.py"]
