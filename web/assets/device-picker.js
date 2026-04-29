// File: web/assets/device-picker.js
// Purpose: In-app audio device picker — enumerates mic/speaker devices,
//          persists selection to localStorage, and wires deviceId into
//          getUserMedia (via audio.js) and setSinkId (via session-panels.js).
// Role: Loaded by teacher.html and student.html; self-initialises on mount().
// Exports: window.sbDevicePicker.{ mount, getInputDeviceId, getOutputDeviceId,
//                                   applySinkId, applyAllSinkIds }
// Depends: navigator.mediaDevices.enumerateDevices; HTMLMediaElement.setSinkId (optional)
// Invariants: Degrades gracefully when APIs are unavailable. Never throws.
//             Output selection is a no-op when setSinkId is unsupported (Firefox, Safari).
//             Input selection takes effect on the next getUserMedia call (session start).
// Last updated: Sprint 25+ (2026-04-29) -- initial implementation

(function () {
  'use strict';

  var INPUT_KEY = 'sb_audio_input';
  var OUTPUT_KEY = 'sb_audio_output';

  function get(key) {
    try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
  }

  function save(key, val) {
    try { localStorage.setItem(key, val); } catch (_) {}
  }

  function getInputDeviceId() { return get(INPUT_KEY); }
  function getOutputDeviceId() { return get(OUTPUT_KEY); }

  // Apply current output preference to one audio element.
  function applySinkId(el) {
    if (!el || typeof el.setSinkId !== 'function') return;
    var id = get(OUTPUT_KEY);
    if (!id) return;
    el.setSinkId(id).catch(function () {});
  }

  // Apply to every remote audio element on the page (marked with data-remote).
  function applyAllSinkIds() {
    var els = document.querySelectorAll('audio[data-remote]');
    for (var i = 0; i < els.length; i++) applySinkId(els[i]);
  }

  async function enumerate() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return { inputs: [], outputs: [] };
    }
    // A brief getUserMedia call is required to unlock device labels in browsers
    // that hide them until the user grants mic permission.
    try {
      var s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      s.getTracks().forEach(function (t) { t.stop(); });
    } catch (_) {}
    var devs = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devs.filter(function (d) { return d.kind === 'audioinput'; }),
      outputs: devs.filter(function (d) { return d.kind === 'audiooutput'; }),
    };
  }

  function buildSelect(devices, currentId, onChange) {
    var sel = document.createElement('select');
    sel.className = 'sb-input';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = 'System default';
    sel.appendChild(def);
    devices.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Device ' + d.deviceId.slice(0, 6) + '\u2026');
      if (d.deviceId === currentId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  function mount(containerId) {
    var wrap = document.getElementById(containerId);
    if (!wrap) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    enumerate().then(function (result) {
      var hasSink = typeof document.createElement('audio').setSinkId === 'function';
      var showInputs = result.inputs.length > 0;
      var showOutputs = hasSink && result.outputs.length > 0;
      if (!showInputs && !showOutputs) return;

      var details = document.createElement('details');
      details.className = 'sb-audio-settings';
      var summary = document.createElement('summary');
      summary.className = 'sb-audio-settings__toggle';
      summary.textContent = 'Audio settings';
      details.appendChild(summary);

      var inner = document.createElement('div');
      inner.className = 'sb-audio-settings__inner';

      if (showInputs) {
        var micRow = document.createElement('div');
        micRow.className = 'sb-field';
        var micLbl = document.createElement('label');
        micLbl.className = 'sb-label';
        micLbl.textContent = 'Microphone';
        micRow.appendChild(micLbl);
        micRow.appendChild(buildSelect(result.inputs, get(INPUT_KEY), function (id) {
          save(INPUT_KEY, id);
        }));
        inner.appendChild(micRow);
      }

      if (showOutputs) {
        var spkRow = document.createElement('div');
        spkRow.className = 'sb-field';
        var spkLbl = document.createElement('label');
        spkLbl.className = 'sb-label';
        spkLbl.textContent = 'Speaker / headphones';
        spkRow.appendChild(spkLbl);
        spkRow.appendChild(buildSelect(result.outputs, get(OUTPUT_KEY), function (id) {
          save(OUTPUT_KEY, id);
          applyAllSinkIds();
        }));
        inner.appendChild(spkRow);
      }

      details.appendChild(inner);
      wrap.appendChild(details);
    }).catch(function () {});
  }

  window.sbDevicePicker = {
    mount: mount,
    getInputDeviceId: getInputDeviceId,
    getOutputDeviceId: getOutputDeviceId,
    applySinkId: applySinkId,
    applyAllSinkIds: applyAllSinkIds,
  };
})();
