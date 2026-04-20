# File: spike/pdf_to_piano_audio/Dockerfile
# Purpose: Containerise the spike so it can be trialled on any host with Docker.
# Role: Bundles Python + Flask + music21 with Audiveris (Java OMR), FluidSynth,
#       and a GM SoundFont -- the three external tools the pipeline needs.
# Last updated: 2026-04-20 -- switch Audiveris install to zip bundle (deb had unmet deps)

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIANO_SF2=/usr/share/sounds/sf2/FluidR3_GM.sf2

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip \
        python3 python3-pip \
        openjdk-21-jre-headless \
        fluidsynth fluid-soundfont-gm \
        tesseract-ocr tesseract-ocr-eng \
        libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

# ---- Audiveris -----------------------------------------------------------
# Audiveris ships as a cross-platform zip bundle (no Debian package).
# We download the zip from the GitHub release, extract it under /opt/audiveris,
# and symlink the launcher onto PATH. Bump AUDIVERIS_VERSION to upgrade.
ARG AUDIVERIS_VERSION=5.10.2
RUN set -eux; \
    url=$(curl -fsSL "https://api.github.com/repos/Audiveris/audiveris/releases/tags/${AUDIVERIS_VERSION}" \
        | python3 -c "import json,sys; \
assets=json.load(sys.stdin)['assets']; \
cand=[a for a in assets if a['name'].endswith('.zip')]; \
assert cand, 'no .zip asset in release ${AUDIVERIS_VERSION}'; \
print(cand[0]['browser_download_url'])"); \
    echo "Downloading $url"; \
    curl -fsSLo /tmp/audiveris.zip "$url"; \
    unzip -q /tmp/audiveris.zip -d /opt/audiveris-unpack; \
    rm -f /tmp/audiveris.zip; \
    # The zip typically unpacks as Audiveris-X.Y.Z/bin/Audiveris (shell script).
    launcher=$(find /opt/audiveris-unpack -maxdepth 5 -type f \
                   \( -name 'Audiveris' -o -name 'audiveris' \) \
                   ! -name '*.bat' ! -name '*.cmd' 2>/dev/null | head -1); \
    if [ -n "$launcher" ]; then \
        chmod +x "$launcher"; \
        ln -sf "$launcher" /usr/local/bin/audiveris; \
        echo "Linked $launcher -> /usr/local/bin/audiveris"; \
    else \
        echo 'WARN: Audiveris launcher not found in zip -- set AUDIVERIS_CMD at runtime'; \
    fi

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
