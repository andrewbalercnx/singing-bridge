# File: sidecar/Dockerfile
# Purpose: Production sidecar image — Python 3.12 + FluidSynth + Audiveris + ghostscript.
# Last updated: Sprint 20 (2026-04-26) -- libxtst6/xdg-utils deps; dpkg --unpack to skip postinst

FROM python:3.12-slim

# System dependencies: FluidSynth + FluidR3 GM soundfont (from apt), ghostscript,
# Java 21 (for Audiveris), curl, unzip.
# libxtst6 + xdg-utils: required by the Audiveris Ubuntu deb but absent in python:3.12-slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fluidsynth \
    fluid-soundfont-gm \
    ghostscript \
    openjdk-21-jre-headless \
    libxtst6 \
    xdg-utils \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

ENV PIANO_SF2=/usr/share/sounds/sf2/FluidR3_GM.sf2

# Install Audiveris 5.10.2 via Ubuntu 24.04 deb (compatible with Debian Trixie).
# Use --unpack (not -i) to extract files without running the post-install script,
# which calls xdg-desktop-menu and fails in headless containers.
RUN curl -fsSL \
    "https://github.com/Audiveris/audiveris/releases/download/5.10.2/Audiveris-5.10.2-ubuntu24.04-x86_64.deb" \
    -o /tmp/audiveris.deb \
    && dpkg --unpack /tmp/audiveris.deb \
    && rm /tmp/audiveris.deb

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV SIDECAR_SECRET=""
ENV PYTHONUNBUFFERED=1

EXPOSE 5050

CMD ["gunicorn", "--bind", "0.0.0.0:5050", "--workers", "2", "--timeout", "300", "app:app"]
