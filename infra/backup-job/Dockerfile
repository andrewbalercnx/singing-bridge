# File: infra/backup-job/Dockerfile
# Purpose: Backup image with sqlite3 + azure-storage-blob, runs as UID 65532.
# Last updated: Sprint 16 (2026-04-23) -- initial
#
# Pin the base image by digest before first production deploy:
#   docker pull python:3.12-slim --platform linux/amd64
#   docker inspect --format='{{index .RepoDigests 0}}'
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backup.py .

# Run as the same UID as the NFS volume owner (set by the init container in container-app.bicep).
# Compatible with RootSquash — UID 65532 maps to itself on the NFS server.
USER 65532:65532

CMD ["python", "backup.py"]
