// hooks.jsx — shared state / fake audio amplitude / breathing timer

const useTweakState = () => {
  const defaults = /*EDITMODE-BEGIN*/{
    "variation": "A",
    "showMeter": true,
    "state": "live",
    "audioLevelTeacher": 0.55,
    "audioLevelStudent": 0.35
  }/*EDITMODE-END*/;

  const [tweaks, setTweaks] = React.useState(defaults);
  const [tweaksOpen, setTweaksOpen] = React.useState(false);

  React.useEffect(() => {
    const onMsg = (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === '__activate_edit_mode') setTweaksOpen(true);
      if (e.data.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const setTweak = (k, v) => {
    setTweaks(prev => {
      const next = { ...prev, [k]: v };
      window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*');
      return next;
    });
  };

  return { tweaks, setTweak, tweaksOpen, setTweaksOpen };
};

// Fake audio amplitude oscillator — phrase-shaped (attack / sustain / release)
const useAudio = (role, baseline = 0.5) => {
  const [level, setLevel] = React.useState(baseline);
  React.useEffect(() => {
    let raf, t0 = performance.now();
    // Different phase per role so teacher & student don't pulse in sync
    const phase = role === 'teacher' ? 0 : Math.PI * 0.6;
    const period = role === 'teacher' ? 3800 : 3200; // musical phrase length
    const tick = (now) => {
      const t = (now - t0) / period * Math.PI * 2 + phase;
      // phrase envelope: sin swell + subtle tremolo + noise
      const env = 0.5 + 0.5 * Math.sin(t);
      const trem = 0.06 * Math.sin(t * 11);
      const noise = 0.05 * (Math.random() - 0.5);
      const v = Math.max(0, Math.min(1, 0.22 + env * 0.6 + trem + noise));
      setLevel(v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [role]);
  return level;
};

// Simple clock ticker — returns elapsed seconds since mount
const useElapsed = () => {
  const [s, setS] = React.useState(847); // start at ~14 min for realism
  React.useEffect(() => {
    const id = setInterval(() => setS(v => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return s;
};
const fmtTime = (s) => {
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
};

Object.assign(window, { useTweakState, useAudio, useElapsed, fmtTime });
