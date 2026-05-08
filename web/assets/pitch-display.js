// File: web/assets/pitch-display.js
// Purpose: Pitch-display tuner widget — speedometer showing nearest note + cents deviation.
//          Exposes window.sbPitchDisplay = { mount, setNote, setActive }.
//          Receives data from pitch-engine.js (student local) or data-channel (teacher).
// Last updated: Sprint 27 (2026-05-08) -- live implementation (was mock)

'use strict';

window.sbPitchDisplay = (function () {
  var _root = null;
  var _active = false;

  function _intonationClass(cents) {
    var abs = Math.abs(cents);
    if (abs <= 15) return 'sb-pitch--intune';
    if (abs <= 35) return 'sb-pitch--close';
    return 'sb-pitch--off';
  }

  function _buildDOM() {
    // Semi-circle dial: centre (80,90) radius 65, viewBox 160×100
    // Needle points straight up at 0¢; rotates ±90° for ±50¢.
    // Tick lines are pre-rotated around (80,90) using SVG transform.
    return [
      '<svg class="sb-pitch-dial" viewBox="0 0 160 100" aria-hidden="true">',
        '<path class="sb-pitch-track" d="M 15 90 A 65 65 0 0 1 145 90" fill="none"/>',
        // Ticks at -50, -25, 0¢ (longer), +25, +50
        '<line class="sb-pitch-tick" x1="80" y1="25" x2="80" y2="17" transform="rotate(-90,80,90)"/>',
        '<line class="sb-pitch-tick" x1="80" y1="25" x2="80" y2="17" transform="rotate(-45,80,90)"/>',
        '<line class="sb-pitch-tick sb-pitch-tick--centre" x1="80" y1="23" x2="80" y2="13" transform="rotate(0,80,90)"/>',
        '<line class="sb-pitch-tick" x1="80" y1="25" x2="80" y2="17" transform="rotate(45,80,90)"/>',
        '<line class="sb-pitch-tick" x1="80" y1="25" x2="80" y2="17" transform="rotate(90,80,90)"/>',
        // Needle and pivot
        '<line class="sb-pitch-needle" id="sb-pitch-needle-line" x1="80" y1="90" x2="80" y2="32"/>',
        '<circle class="sb-pitch-pivot" cx="80" cy="90" r="4.5"/>',
      '</svg>',
      '<div class="sb-pitch-note" id="sb-pitch-note-label">—</div>',
      '<div class="sb-pitch-cents" id="sb-pitch-cents-label">±0¢</div>',
    ].join('');
  }

  function mount(el) {
    _root = el;
    el.className = 'sb-pitch-display';
    el.setAttribute('aria-label', 'Pitch tuner');
    el.innerHTML = _buildDOM();
    el.hidden = true;
  }

  function setNote(name, cents) {
    if (!_root || !_active) return;
    var clampedCents = Math.max(-50, Math.min(50, Math.round(cents)));
    var noteEl = _root.querySelector('#sb-pitch-note-label');
    var centsEl = _root.querySelector('#sb-pitch-cents-label');
    var needle = _root.querySelector('#sb-pitch-needle-line');
    if (!noteEl || !needle) return;

    _root.className = 'sb-pitch-display ' + _intonationClass(clampedCents);
    noteEl.textContent = name;
    centsEl.textContent = (clampedCents > 0 ? '+' : '') + clampedCents + '¢';
    // 1¢ = 1.8° rotation; pivot is at (80px, 90px) within the SVG element
    needle.style.transform = 'rotate(' + (clampedCents * 1.8) + 'deg)';
    needle.style.transformOrigin = '80px 90px';
  }

  function setActive(on) {
    _active = on;
    if (_root) _root.hidden = !on;
    if (!on) stopDemo();
  }

  return { mount: mount, setNote: setNote, setActive: setActive };
}());
