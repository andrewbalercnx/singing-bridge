/**
 * File: spike/pdf_to_piano_audio/static/app.js
 *
 * Purpose: Drive the four-step UI for the PDF -> piano-audio spike.
 * Sequential state machine: upload -> omr -> select -> render.
 *
 * Last updated: 2026-04-21 -- replace Verovio SVG tracking with PDF panel tracking
 */
(() => {
  const state = window._spikeState = {
    sessionId: null, kind: null,
    barTimings: [],   // [{idx, bar_num, start_sec, dur_sec}, ...]
    barCoords: [],    // [{page, bar_seq, x_frac, y_frac, w_frac, h_frac}, ...]
    activeBarIdx: -1,
    renderTempoPct: 100,
  };

  // Verovio toolkit — initialised once on first use.
  let vrvTk = null;
  const vrvReady = new Promise((resolve) => {
    const init = () => {
      verovio.module.onRuntimeInitialized = () => { vrvTk = new verovio.toolkit(); resolve(vrvTk); };
      if (verovio.module.calledRun) { vrvTk = new verovio.toolkit(); resolve(vrvTk); }
    };
    if (window.verovio) { init(); }
    else {
      const poll = setInterval(() => { if (window.verovio) { clearInterval(poll); init(); } }, 150);
    }
  });

  const renderNotation = async (scoreUrl) => {
    const box = el("notation");
    box.innerHTML = '<p class="notation-loading">Rendering notation…</p>';
    box.hidden = false;
    try {
      const [xml] = await Promise.all([fetch(scoreUrl).then(r => r.text()), vrvReady]);
      vrvTk.setOptions({
        adjustPageWidth: 1, adjustPageHeight: 1, scale: 35,
        pageMarginTop: 40, pageMarginBottom: 40, pageMarginLeft: 40, pageMarginRight: 40,
      });
      vrvTk.loadData(xml);
      const pages = vrvTk.getPageCount();
      let svgs = "";
      for (let p = 1; p <= pages; p++) svgs += vrvTk.renderToSVG(p, {});
      box.innerHTML = svgs;
    } catch (err) {
      box.innerHTML = `<p class="status err">Notation render failed: ${escapeHtml(err.message)}</p>`;
    }
  };

  // ── PDF panel ────────────────────────────────────────────────────────────

  const populatePdfPanel = async () => {
    const panel = el("pdf-panel");
    panel.innerHTML = '<p class="pdf-loading">Loading score pages…</p>';
    panel.hidden = false;
    try {
      const data = await fetch(`/${state.sessionId}/pages`).then(r => r.json());
      if (!data.count) { panel.hidden = true; return; }
      let html = "";
      for (let i = 1; i <= data.count; i++) {
        html += `<img src="/${state.sessionId}/pages/${i}" alt="Page ${i}" loading="lazy">`;
      }
      html += '<div id="bar-highlight"></div>';
      panel.innerHTML = html;
    } catch (_) {
      panel.hidden = true;
    }
  };

  // Position the highlight box over the measure at `idx` in the PDF panel.
  const highlightBar = (idx) => {
    const timing = state.barTimings[idx];
    if (!timing) return;
    const coord = state.barCoords[timing.orig_written_pos];
    if (!coord) return;

    const panel = el("pdf-panel");
    const hl = document.getElementById("bar-highlight");
    if (!hl || panel.hidden) return;

    const imgs = panel.querySelectorAll("img");
    const img = imgs[coord.page - 1];
    if (!img || !img.clientWidth) return;

    // img CSS: width:100% height:auto — compute rendered height from aspect ratio.
    const dispW = img.clientWidth;
    const dispH = img.naturalHeight
      ? dispW * (img.naturalHeight / img.naturalWidth)
      : img.clientHeight;

    hl.style.left   = (img.offsetLeft + coord.x_frac * dispW) + "px";
    hl.style.top    = (img.offsetTop  + coord.y_frac * dispH) + "px";
    hl.style.width  = (coord.w_frac * dispW) + "px";
    hl.style.height = (coord.h_frac * dispH) + "px";
    hl.style.display = "block";

    // Scroll so the highlighted bar sits in the upper third of the panel.
    const targetScroll = parseFloat(hl.style.top) - panel.clientHeight / 3;
    panel.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
  };

  // ── Shared helpers ───────────────────────────────────────────────────────

  const el = (id) => document.getElementById(id);
  const steps = {
    upload: el("step-upload"), omr: el("step-omr"),
    select: el("step-select"), render: el("step-render"),
  };

  const activate  = (name) => { Object.entries(steps).forEach(([k, n]) => { n.classList.remove("is-active"); if (k === name) n.classList.add("is-active"); }); };
  const markDone   = (name) => steps[name].classList.add("is-done");
  const unmarkDone = (name) => steps[name].classList.remove("is-done");

  const setStatus = (id, msg, kind = "") => {
    const node = el(id);
    node.textContent = msg;
    node.className = "status" + (kind ? " " + kind : "");
  };

  const postJson = async (url, body) => {
    const init = { method: "POST" };
    if (body instanceof FormData) { init.body = body; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "Content-Type": "application/json" }; }
    const res = await fetch(url, init);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
    return data;
  };

  // ── Step 1: upload ───────────────────────────────────────────────────────

  const afterUpload = async () => {
    markDone("upload");
    if (state.kind === "pdf") {
      el("omr-btn").disabled = false;
      el("omr-btn").textContent = "Run OMR";
      activate("omr");
    } else {
      activate("omr");
      setStatus("omr-status", "Parsing MusicXML…");
      await runOmr();
    }
  };

  el("upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = el("file-input").files[0];
    if (!file) return;
    setStatus("upload-status", "Uploading…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await postJson("/upload", fd);
      state.sessionId = data.session_id;
      state.kind = data.kind;
      setStatus("upload-status", `Uploaded ${file.name} (${data.kind}).`, "ok");
      await afterUpload();
    } catch (err) { setStatus("upload-status", `Upload failed: ${err.message}`, "err"); }
  });

  el("fixture-btn").addEventListener("click", async () => {
    setStatus("upload-status", "Loading fixture…");
    try {
      const data = await postJson("/fixture");
      state.sessionId = data.session_id;
      state.kind = data.kind;
      setStatus("upload-status", "Loaded two-part fixture.", "ok");
      await afterUpload();
    } catch (err) { setStatus("upload-status", `Fixture failed: ${err.message}`, "err"); }
  });

  // ── Step 2: OMR ──────────────────────────────────────────────────────────

  const runOmr = async () => {
    el("omr-btn").disabled = true;
    try {
      const data = await postJson(`/${state.sessionId}/omr`);
      const list = el("parts-list");
      list.innerHTML = "";
      if (!data.parts.length) {
        list.innerHTML = `<p class="empty">No parts found.</p>`;
        setStatus("omr-status", "No parts detected.", "err");
        return;
      }
      for (const p of data.parts) {
        const label = document.createElement("label");
        label.innerHTML = `
          <input type="checkbox" name="part" value="${p.index}" ${p.has_notes ? "" : "disabled"}>
          <span class="name">${escapeHtml(p.name)}</span>
          <span class="instr">${escapeHtml(p.instrument)}${p.has_notes ? "" : " (empty)"}</span>`;
        list.appendChild(label);
      }
      list.addEventListener("change", () => {
        el("select-btn").disabled = !document.querySelector('input[name="part"]:checked');
      });
      setStatus("omr-status", `Found ${data.parts.length} part(s).`, "ok");
      markDone("omr");
      activate("select");
    } catch (err) {
      setStatus("omr-status", `Failed: ${err.message}`, "err");
      el("omr-btn").disabled = false;
    }
  };

  el("omr-btn").addEventListener("click", async () => { setStatus("omr-status", "Working…"); await runOmr(); });

  // ── Step 3: select parts ─────────────────────────────────────────────────

  el("select-btn").addEventListener("click", async () => {
    const checked = [...document.querySelectorAll('input[name="part"]:checked')];
    if (!checked.length) return;
    const indices = checked.map(c => parseInt(c.value, 10));
    el("select-btn").disabled = true;
    setStatus("select-status", "Extracting MIDI…");
    try {
      const data = await postJson(`/${state.sessionId}/select`, { part_indices: indices });
      const label = indices.length === 1
        ? `Part ${indices[0]} extracted as piano MIDI.`
        : `Parts ${indices.join(", ")} merged as piano MIDI.`;
      setStatus("select-status", label, "ok");
      state.barTimings = data.bar_timings || [];
      state.barCoords  = data.bar_coords  || [];
      state.activeBarIdx = -1;
      markDone("select");
      el("render-btn").disabled = false;
      el("downloads").innerHTML = `<a href="${data.midi_url}" download>Download MIDI</a>`;
      unmarkDone("render");
      el("audio-player").hidden = true;
      setStatus("render-status", "");
      el("pdf-panel").hidden = true;
      activate("render");
      if (data.score_url) renderNotation(data.score_url);
    } catch (err) {
      setStatus("select-status", `Failed: ${err.message}`, "err");
      el("select-btn").disabled = false;
    }
  });

  // ── Step 4: reselect ─────────────────────────────────────────────────────

  el("reselect-btn").addEventListener("click", () => {
    unmarkDone("render");
    unmarkDone("select");
    el("render-btn").disabled = true;
    el("audio-player").hidden = true;
    el("notation").hidden = true;
    el("notation").innerHTML = "";
    setStatus("render-status", "");
    setStatus("select-status", "");
    el("transpose-input").value = 0;
    el("transpose-display").textContent = "0";
    state.barTimings = [];
    state.barCoords = [];
    state.activeBarIdx = -1;
    el("pdf-panel").hidden = true;
    el("select-btn").disabled = !document.querySelector('input[name="part"]:checked');
    activate("select");
  });

  // ── Step 4: tempo / transpose ────────────────────────────────────────────

  const _markRenderStale = (msg) => {
    if (!el("audio-player").hidden) {
      el("audio-player").hidden = true;
      el("render-btn").disabled = false;
      unmarkDone("render");
      setStatus("render-status", msg);
    }
  };

  el("tempo-input").addEventListener("input", () => {
    el("tempo-display").textContent = el("tempo-input").value;
    _markRenderStale("Tempo changed — click Render to apply.");
  });

  el("transpose-input").addEventListener("input", () => {
    const v = parseInt(el("transpose-input").value, 10);
    el("transpose-display").textContent = v > 0 ? `+${v}` : `${v}`;
    _markRenderStale("Pitch changed — click Render to apply.");
  });

  // ── Step 4: render ───────────────────────────────────────────────────────

  el("render-btn").addEventListener("click", async () => {
    el("render-btn").disabled = true;
    setStatus("render-status", "Rendering audio…");
    const tempo = parseInt(el("tempo-input").value, 10);
    const transpose = parseInt(el("transpose-input").value, 10);
    try {
      const data = await postJson(`/${state.sessionId}/render`, { tempo, transpose });
      state.renderTempoPct = tempo;
      state.activeBarIdx = -1;
      const audio = el("audio-player");
      audio.src = data.audio_url;
      audio.hidden = false;
      audio.play().catch(() => {});
      setStatus("render-status", "Ready. Press play.", "ok");
      markDone("render");
      if (state.kind === "pdf" && el("pdf-panel").hidden) populatePdfPanel();
      el("downloads").innerHTML =
        (el("downloads").innerHTML.split("·")[0] || "") +
        ` &middot; <a href="${data.audio_url}" download>Download WAV</a>`;
    } catch (err) {
      setStatus("render-status", `Failed: ${err.message}`, "err");
      el("render-btn").disabled = false;
    }
  });

  // ── Playback tracking ────────────────────────────────────────────────────

  el("audio-player").addEventListener("timeupdate", () => {
    if (!state.barTimings.length) return;
    const LOOKAHEAD_SEC = 0.6;
    const t = el("audio-player").currentTime + LOOKAHEAD_SEC;
    const scale = 100 / (state.renderTempoPct || 100);
    // Binary search: find last bar whose adjusted start_sec <= t.
    let lo = 0, hi = state.barTimings.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (state.barTimings[mid].start_sec * scale <= t) { idx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (idx !== state.activeBarIdx) {
      state.activeBarIdx = idx;
      if (state.barCoords.length) highlightBar(idx);
    }
  });

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
