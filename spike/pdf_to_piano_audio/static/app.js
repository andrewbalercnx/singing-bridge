/**
 * File: spike/pdf_to_piano_audio/static/app.js
 *
 * Purpose: Drive the four-step UI for the PDF -> piano-audio spike.
 * Sequential state machine: upload -> omr -> select -> render.
 *
 * Last updated: 2026-04-20 -- multi-select parts, back nav, tempo control
 */
(() => {
  const state = { sessionId: null, kind: null };

  const el = (id) => document.getElementById(id);
  const steps = {
    upload: el("step-upload"),
    omr: el("step-omr"),
    select: el("step-select"),
    render: el("step-render"),
  };

  const activate = (name) => {
    for (const [key, node] of Object.entries(steps)) {
      node.classList.remove("is-active");
      if (key === name) node.classList.add("is-active");
    }
  };
  const markDone = (name) => steps[name].classList.add("is-done");
  const unmarkDone = (name) => steps[name].classList.remove("is-done");

  const setStatus = (id, msg, kind = "") => {
    const node = el(id);
    node.textContent = msg;
    node.className = "status" + (kind ? " " + kind : "");
  };

  const postJson = async (url, body) => {
    const init = { method: "POST" };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    const res = await fetch(url, init);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const detail = data.detail || data.error || res.statusText;
      throw new Error(detail);
    }
    return data;
  };

  // After upload/fixture: PDFs need the user to click "Run OMR"; MusicXML
  // files are parsed automatically (no OCR wait, no user action needed).
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

  // Step 1: upload
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
    } catch (err) {
      setStatus("upload-status", `Upload failed: ${err.message}`, "err");
    }
  });

  el("fixture-btn").addEventListener("click", async () => {
    setStatus("upload-status", "Loading fixture…");
    try {
      const data = await postJson("/fixture");
      state.sessionId = data.session_id;
      state.kind = data.kind;
      setStatus("upload-status", "Loaded two-part fixture.", "ok");
      await afterUpload();
    } catch (err) {
      setStatus("upload-status", `Fixture failed: ${err.message}`, "err");
    }
  });

  // Step 2: OMR / parse
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
        const anyChecked = !!document.querySelector('input[name="part"]:checked');
        el("select-btn").disabled = !anyChecked;
      });
      setStatus("omr-status", `Found ${data.parts.length} part(s).`, "ok");
      markDone("omr");
      activate("select");
    } catch (err) {
      setStatus("omr-status", `Failed: ${err.message}`, "err");
      el("omr-btn").disabled = false;
    }
  };

  el("omr-btn").addEventListener("click", async () => {
    setStatus("omr-status", "Working…");
    await runOmr();
  });

  // Step 3: select parts
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
      markDone("select");
      el("render-btn").disabled = false;
      el("downloads").innerHTML = `<a href="${data.midi_url}" download>Download MIDI</a>`;
      // Reset render state in case the user is re-selecting
      unmarkDone("render");
      el("audio-player").hidden = true;
      setStatus("render-status", "");
      activate("render");
    } catch (err) {
      setStatus("select-status", `Failed: ${err.message}`, "err");
      el("select-btn").disabled = false;
    }
  });

  // Step 4: back to selection
  el("reselect-btn").addEventListener("click", () => {
    unmarkDone("render");
    unmarkDone("select");
    el("render-btn").disabled = true;
    el("audio-player").hidden = true;
    setStatus("render-status", "");
    setStatus("select-status", "");
    // Re-enable select-btn (was disabled after the previous submission)
    const anyChecked = !!document.querySelector('input[name="part"]:checked');
    el("select-btn").disabled = !anyChecked;
    activate("select");
  });

  // Step 4: tempo display
  el("tempo-input").addEventListener("input", () => {
    el("tempo-display").textContent = el("tempo-input").value;
    // Reset render state so the user re-renders with the new tempo
    if (!el("audio-player").hidden) {
      el("audio-player").hidden = true;
      el("render-btn").disabled = false;
      unmarkDone("render");
      setStatus("render-status", "Tempo changed — click Render to apply.");
    }
  });

  // Step 4: render
  el("render-btn").addEventListener("click", async () => {
    el("render-btn").disabled = true;
    setStatus("render-status", "Rendering audio…");
    const tempo = parseInt(el("tempo-input").value, 10);
    try {
      const data = await postJson(`/${state.sessionId}/render`, { tempo });
      const audio = el("audio-player");
      audio.src = data.audio_url;
      audio.hidden = false;
      audio.play().catch(() => {});
      setStatus("render-status", "Ready. Press play.", "ok");
      markDone("render");
      el("downloads").innerHTML =
        (el("downloads").innerHTML.split("·")[0] || "") +
        ` &middot; <a href="${data.audio_url}" download>Download WAV</a>`;
    } catch (err) {
      setStatus("render-status", `Failed: ${err.message}`, "err");
      el("render-btn").disabled = false;
    }
  });

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
