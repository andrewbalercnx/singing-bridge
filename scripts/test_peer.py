#!/usr/bin/env python3
# File: scripts/test_peer.py
# Purpose: Playwright bot that emulates a teacher or student for manual UX testing.
#          Reads one-time token from stdin, exchanges it for a session cookie (teacher
#          mode), then runs a scripted sequence of TTS phrases + actions.
# Role: Subprocess spawned by GET /test-peer; exits within 180 s regardless.
# Depends: playwright, gtts, pydub (or ffmpeg), wave, struct, asyncio
# Invariants: Hard timeout of 180 s; exits cleanly on timeout or completion.
#             Token read from stdin (not CLI arg) to avoid process-listing exposure.
# Last updated: Sprint 25 (2026-04-27) -- initial implementation

import argparse
import asyncio
import os
import struct
import sys
import tempfile
import wave

import httpx
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description='singing-bridge test peer bot')
    p.add_argument('--server', required=True)
    p.add_argument('--slug', required=True)
    p.add_argument('--mode', required=True, choices=['teacher', 'student'])
    p.add_argument('--asset-id', type=int, default=None)
    p.add_argument('--variant-id', type=int, default=None)
    return p.parse_args()


# ---------------------------------------------------------------------------
# TTS + WAV helpers
# ---------------------------------------------------------------------------

PHRASES = {
    'teacher': [
        "Good morning. Let's begin with Somewhere Over the Rainbow.",
        "Well done. Let's try that again from the top.",
        "That's all for today. Great work.",
    ],
    'student': [
        "Hello, I'm ready.",
        "Sorry, can we slow that down a little?",
        "Thank you, that was really helpful.",
    ],
}

# Silence gap between phrases (seconds).
GAP_SECS = 2
# Sample rate for generated WAV.
SAMPLE_RATE = 16000


def _silence_frames(secs: float) -> bytes:
    n = int(SAMPLE_RATE * secs)
    return struct.pack('<' + 'h' * n, *([0] * n))


def _phrase_to_wav(text: str, wav_path: str) -> None:
    """Convert text to speech using gtts, then to WAV via pydub or ffmpeg."""
    mp3_path = wav_path + '.mp3'
    from gtts import gTTS
    gTTS(text=text, lang='en').save(mp3_path)

    try:
        from pydub import AudioSegment
        seg = AudioSegment.from_mp3(mp3_path)
        seg = seg.set_frame_rate(SAMPLE_RATE).set_channels(1).set_sample_width(2)
        seg.export(wav_path, format='wav')
    except Exception:
        # Fallback: 2 s silence placeholder when audio conversion unavailable.
        _write_wav(wav_path, _silence_frames(2.0))
    finally:
        try:
            os.unlink(mp3_path)
        except OSError:
            pass


def _write_wav(path: str, pcm_bytes: bytes) -> None:
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)


def build_phrase_wav(mode: str, tmp_dir: str) -> str:
    """Stitch all phrases + silence gaps into a single WAV file."""
    phrases = PHRASES[mode]
    parts = []
    for i, text in enumerate(phrases):
        phrase_path = os.path.join(tmp_dir, f'phrase_{i}.wav')
        _phrase_to_wav(text, phrase_path)
        # Read raw PCM frames.
        with wave.open(phrase_path, 'rb') as wf:
            parts.append(wf.readframes(wf.getnframes()))
        parts.append(_silence_frames(GAP_SECS))

    combined = b''.join(parts)
    out_path = os.path.join(tmp_dir, 'phrases.wav')
    _write_wav(out_path, combined)
    return out_path


# ---------------------------------------------------------------------------
# Bot flows
# ---------------------------------------------------------------------------

async def teacher_bot(page, server: str, slug: str, token: str,
                      asset_id: int, variant_id: int) -> None:
    """Teacher-bot flow: the human is the student."""
    # Exchange one-time token for a session cookie.
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f'{server}/test-peer/session',
            json={'token': token},
        )
        r.raise_for_status()
        raw_cookie = None
        for c in r.headers.get_list('set-cookie'):
            if 'sb_session=' in c:
                raw_cookie = c.split('sb_session=')[1].split(';')[0]
                break

    if not raw_cookie:
        raise RuntimeError('no sb_session cookie from /test-peer/session')

    # Set the cookie using the server hostname so this works even when the
    # page is still at about:blank (before any navigation).
    cookie_domain = urlparse(server).hostname or 'localhost'
    await page.context.add_cookies([{
        'name': 'sb_session',
        'value': raw_cookie,
        'domain': cookie_domain,
        'path': '/',
    }])

    await page.goto(f'{server}/teach/{slug}/session')

    # Wait for a student to join the lobby (up to 60 s).
    await page.locator('[data-testid="admit-btn"]').first.wait_for(
        state='visible', timeout=60_000
    )
    await page.locator('[data-testid="admit-btn"]').first.click()

    # Phrase 0: "Good morning..." — plays via fake mic from phrases.wav.
    await asyncio.sleep(2)

    # Trigger accompaniment play via bot API.
    await asyncio.sleep(3)
    await page.evaluate(
        f"window._sbSend({{ type: 'accompaniment_play', asset_id: {asset_id},"
        f" variant_id: {variant_id}, position_ms: 0 }})"
    )

    await asyncio.sleep(45)  # Phrase 1: "Well done..."
    await asyncio.sleep(90)  # Phrase 2: "That's all for today..."
    await asyncio.sleep(20)


async def student_bot(page, server: str, slug: str) -> None:
    """Student-bot flow: the human is the teacher."""
    await page.goto(f'{server}/teach/{slug}')

    await page.fill('#join-email', 'test-bot@singing-bridge.dev')
    await page.locator('#join-form button[type="submit"]').click()

    # Wait for session to become visible (admitted by human teacher).
    await page.locator('[data-testid="session-active"]').wait_for(
        state='visible', timeout=90_000
    )

    await asyncio.sleep(2)   # Phrase 0: "Hello, I'm ready."
    await asyncio.sleep(20)  # Phrase 1: "Sorry, can we slow that down..."
    await asyncio.sleep(30)  # Phrase 2: "Thank you, that was really helpful."
    await asyncio.sleep(20)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    args = parse_args()
    token = sys.stdin.readline().strip()

    with tempfile.TemporaryDirectory(prefix='sb_test_peer_') as tmp_dir:
        wav_path = build_phrase_wav(args.mode, tmp_dir)

        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=[
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                f'--use-file-for-fake-audio-capture={wav_path}',
                '--allow-running-insecure-content',
                '--no-sandbox',
            ])
            context = await browser.new_context(
                permissions=['microphone', 'camera'],
            )
            page = await context.new_page()

            if args.mode == 'teacher':
                await teacher_bot(
                    page, args.server, args.slug, token,
                    args.asset_id, args.variant_id,
                )
            else:
                await student_bot(page, args.server, args.slug)

            await browser.close()


if __name__ == '__main__':
    try:
        asyncio.run(asyncio.wait_for(main(), timeout=180))
    except (asyncio.TimeoutError, KeyboardInterrupt):
        sys.exit(0)
