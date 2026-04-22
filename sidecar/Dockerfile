# File: sidecar/Dockerfile
# Purpose: Production sidecar image — Python 3.12 + FluidSynth + Audiveris + ghostscript.
# Last updated: Sprint 13 (2026-04-22) -- openjdk-21 (17 dropped from Debian Trixie)

FROM python:3.12-slim

# System dependencies: FluidSynth, ghostscript, Java 21 (for Audiveris), curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    fluidsynth \
    ghostscript \
    openjdk-21-jre-headless \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Download FluidR3_GM SoundFont (MIT-licensed)
RUN mkdir -p /opt/sf2 && \
    curl -fsSL "https://member.keymusician.com/Member/FluidR3_GM/FluidR3_GM.sf2" \
         -o /opt/sf2/piano.sf2 || \
    # Fallback: smaller GeneralUser soundfont if FluidR3 unavailable
    curl -fsSL "https://www.schristiancollins.com/generaluser/GeneralUser_GS_1.471.zip" \
         -o /tmp/gu.zip && unzip /tmp/gu.zip -d /tmp/gu && \
    cp /tmp/gu/*.sf2 /opt/sf2/piano.sf2 || true

ENV PIANO_SF2=/opt/sf2/piano.sf2

# Download Audiveris (latest release jar)
RUN mkdir -p /opt/audiveris && \
    curl -fsSL "https://github.com/Audiveris/audiveris/releases/download/5.3.1/Audiveris_5.3.1.zip" \
         -o /tmp/audiveris.zip && \
    unzip /tmp/audiveris.zip -d /opt/audiveris && \
    rm /tmp/audiveris.zip && \
    find /opt/audiveris -name "Audiveris*.jar" | head -1 > /opt/audiveris/jar_path.txt

# Create audiveris wrapper script
RUN jar_path=$(cat /opt/audiveris/jar_path.txt) && \
    printf '#!/bin/sh\nexec java -jar "%s" "$@"\n' "$jar_path" > /usr/local/bin/audiveris && \
    chmod +x /usr/local/bin/audiveris

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV SIDECAR_SECRET=""
ENV PYTHONUNBUFFERED=1

EXPOSE 5050

CMD ["gunicorn", "--bind", "0.0.0.0:5050", "--workers", "2", "--timeout", "300", "app:app"]
