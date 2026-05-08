#!/usr/bin/env python3
# File: scripts/synthetic_peers.py
# Purpose: Standalone synthetic peer runner — launches a student bot and/or a teacher bot
#          against any singing-bridge server (local or deployed).
#          Student bot: no auth required; navigates to the student join page and waits to be admitted.
#          Teacher bot: authenticates via POST /api/synthetic-auth using SB_SYNTHETIC_PEER_SECRET,
#          then opens the teacher session page and admits the student from the lobby.
# Role: CLI tool. Run locally; targets --server URL (localhost or deployed HTTPS).
# Exports: None (CLI only)
# Depends: playwright, httpx, asyncio, argparse
# Invariants: --mode both requires --secret (teacher auth).
#             Exits 0 on success, 1 on any bot failure or timeout.
#             Hard timeout: 180 s per bot.
# Last updated: Sprint 27 (2026-05-08) -- initial implementation

"""
Usage examples:

  # Teacher is a real human; spawn a synthetic student that joins their room:
  python3 scripts/synthetic_peers.py --server https://sb.example.com --slug myroom --mode student

  # Fully synthetic session (no humans needed); requires SB_SYNTHETIC_PEER_SECRET:
  python3 scripts/synthetic_peers.py --server https://sb.example.com --slug myroom \\
      --mode both --secret $SB_SYNTHETIC_PEER_SECRET

  # Against local dev server:
  python3 scripts/synthetic_peers.py --server http://localhost:8080 --slug myroom --mode both \\
      --secret dev-secret-for-testing-only
"""

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
    p = argparse.ArgumentParser(
        description='singing-bridge synthetic peer runner',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument('--server', required=True,
                   help='Base URL of the singing-bridge server (e.g. https://sb.example.com)')
    p.add_argument('--slug', required=True,
                   help='Teacher room slug')
    p.add_argument('--mode', required=True, choices=['student', 'teacher', 'both'],
                   help='Which bot(s) to run')
    p.add_argument('--secret',
                   help='Value of SB_SYNTHETIC_PEER_SECRET (required for teacher/both mode)')
    p.add_argument('--email', default='synthetic-student@singing-bridge.dev',
                   help='Email address the student bot uses to join')
    p.add_argument('--session-secs', type=int, default=60,
                   help='Seconds to hold the session open after both peers connect (default: 60)')
    args = p.parse_args()

    if args.mode in ('teacher', 'both') and not args.secret:
        p.error('--secret is required for teacher and both modes')

    return args


# ---------------------------------------------------------------------------
# WAV helpers (silent audio so Chromium fake-mic has something to send)
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16_000


def _write_silence_wav(path: str, secs: float) -> None:
    n = int(SAMPLE_RATE * secs)
    frames = struct.pack('<' + 'h' * n, *([0] * n))
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(frames)


# ---------------------------------------------------------------------------
# Teacher auth
# ---------------------------------------------------------------------------

async def fetch_teacher_cookie(server: str, slug: str, secret: str) -> str:
    """POST /api/synthetic-auth → return raw session cookie value."""
    async with httpx.AsyncClient(follow_redirects=False) as client:
        r = await client.post(
            f'{server}/api/synthetic-auth',
            json={'secret': secret, 'slug': slug},
        )
    if r.status_code != 200:
        raise RuntimeError(
            f'/api/synthetic-auth returned {r.status_code}: {r.text[:200]}'
        )
    for header in r.headers.get_list('set-cookie'):
        if 'sb_session=' in header:
            return header.split('sb_session=')[1].split(';')[0]
    raise RuntimeError('/api/synthetic-auth did not set sb_session cookie')


# ---------------------------------------------------------------------------
# Bot flows
# ---------------------------------------------------------------------------

async def student_bot(page, server: str, slug: str, email: str,
                      session_secs: int, admitted: asyncio.Event) -> None:
    """Navigate to the student join page, submit the form, wait to be admitted."""
    await page.goto(f'{server}/teach/{slug}')

    await page.fill('#join-email', email)
    await page.locator('#join-form button[type="submit"]').click()

    print(f'[student] waiting in lobby for {slug}…', flush=True)
    await page.locator('[data-testid="session-active"]').wait_for(
        state='visible', timeout=90_000
    )
    print('[student] admitted — session active', flush=True)
    admitted.set()
    await asyncio.sleep(session_secs)
    print('[student] session hold complete', flush=True)


async def teacher_bot(page, server: str, slug: str, secret: str,
                      session_secs: int, admitted: asyncio.Event) -> None:
    """Authenticate, open the teacher session page, admit the waiting student."""
    cookie_value = await fetch_teacher_cookie(server, slug, secret)

    cookie_domain = urlparse(server).hostname or 'localhost'
    await page.context.add_cookies([{
        'name': 'sb_session',
        'value': cookie_value,
        'domain': cookie_domain,
        'path': '/',
    }])

    await page.goto(f'{server}/teach/{slug}/session')
    print(f'[teacher] waiting for student to appear in lobby…', flush=True)

    await page.locator('[data-testid="admit-btn"]').first.wait_for(
        state='visible', timeout=90_000
    )
    await page.locator('[data-testid="admit-btn"]').first.click()
    print('[teacher] student admitted', flush=True)

    # Wait until the student signals it's in session, then hold.
    await asyncio.wait_for(admitted.wait(), timeout=30)
    await asyncio.sleep(session_secs)
    print('[teacher] session hold complete', flush=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    args = parse_args()

    with tempfile.TemporaryDirectory(prefix='sb_synthetic_') as tmp:
        wav_path = os.path.join(tmp, 'silence.wav')
        _write_silence_wav(wav_path, 120.0)

        chromium_args = [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-audio-capture={wav_path}',
            '--allow-running-insecure-content',
            '--no-sandbox',
        ]

        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=chromium_args)
            admitted = asyncio.Event()

            coros = []
            if args.mode in ('student', 'both'):
                ctx_s = await browser.new_context(permissions=['microphone', 'camera'])
                page_s = await ctx_s.new_page()
                coros.append(student_bot(
                    page_s, args.server, args.slug,
                    args.email, args.session_secs, admitted,
                ))
            if args.mode in ('teacher', 'both'):
                ctx_t = await browser.new_context(permissions=['microphone', 'camera'])
                page_t = await ctx_t.new_page()
                coros.append(teacher_bot(
                    page_t, args.server, args.slug,
                    args.secret, args.session_secs, admitted,
                ))

            await asyncio.gather(*coros)
            await browser.close()


if __name__ == '__main__':
    try:
        asyncio.run(asyncio.wait_for(main(), timeout=180))
        print('synthetic peers: done', flush=True)
        sys.exit(0)
    except asyncio.TimeoutError:
        print('synthetic peers: timed out after 180 s', file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f'synthetic peers: error: {e}', file=sys.stderr)
        sys.exit(1)
