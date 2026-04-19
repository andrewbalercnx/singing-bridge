# File: spike/pdf_to_piano_audio/Dockerfile
# Purpose: Containerise the spike so it can be trialled on any host with Docker.
# Role: Bundles Python + Flask + music21 with Audiveris (Java OMR), FluidSynth,
#       and a GM SoundFont -- the three external tools the pipeline needs.
# Last updated: 2026-04-19 -- initial spike

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIANO_SF2=/usr/share/sounds/sf2/FluidR3_GM.sf2

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
        python3 python3-pip \
        fluidsynth fluid-soundfont-gm \
        tesseract-ocr tesseract-ocr-eng \
        libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

# ---- Audiveris -----------------------------------------------------------
# Resolves the ubuntu 24.04 .deb asset for the pinned release from the
# GitHub API, installs it, then cleans up. Pin or bump AUDIVERIS_VERSION as
# needed; if the asset naming changes upstream, update the jq filter below.
ARG AUDIVERIS_VERSION=5.10.2
RUN set -eux; \
    url=$(curl -fsSL "https://api.github.com/repos/Audiveris/audiveris/releases/tags/${AUDIVERIS_VERSION}" \
        | python3 -c "import json,sys; \
assets=json.load(sys.stdin)['assets']; \
cand=[a for a in assets if a['name'].endswith('.deb') and ('ubuntu24' in a['name'].lower() or 'ubuntu-24' in a['name'].lower())]; \
cand=cand or [a for a in assets if a['name'].endswith('.deb')]; \
assert cand, 'no .deb asset in release'; \
print(cand[0]['browser_download_url'])"); \
    echo "Downloading $url"; \
    curl -fsSLo /tmp/audiveris.deb "$url"; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/audiveris.deb; \
    rm -rf /tmp/audiveris.deb /var/lib/apt/lists/*; \
    # The .deb installs a launcher under /opt/audiveris/; find it and link
    # it as `audiveris` on PATH for the subprocess wrapper.
    launcher=$(find /opt -maxdepth 4 -type f -name 'Audiveris' 2>/dev/null | head -1); \
    if [ -n "$launcher" ]; then ln -sf "$launcher" /usr/local/bin/audiveris; \
    else echo 'WARN: Audiveris launcher not found -- set AUDIVERIS_CMD at runtime'; fi

# ---- App -----------------------------------------------------------------
WORKDIR /app
COPY requirements.txt /app/spike/pdf_to_piano_audio/requirements.txt
RUN pip3 install -r /app/spike/pdf_to_piano_audio/requirements.txt

COPY . /app/spike/pdf_to_piano_audio/
RUN touch /app/spike/__init__.py

ENV SPIKE_SCRATCH=/tmp \
    PYTHONPATH=/app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

# Single gunicorn worker with threads: Audiveris is CPU-heavy and we want
# requests to queue rather than fan out. Raise --workers when the host has
# cores to spare.
CMD ["gunicorn", "-w", "1", "-k", "gthread", "--threads", "4", \
     "--timeout", "180", "-b", "0.0.0.0:8080", \
     "spike.pdf_to_piano_audio.app:app"]
