// variation-c.jsx — "The stave"
// A bold, music-teacher-native UI. The session sits ON a musical stave.
// The student's pitch is tracked as a moving note on the stave relative
// to a target; the teacher's guidance note floats alongside.
// Controls become musical artefacts: tuning fork (mute), metronome
// (tempo/chat), a fermata (pause), a double-bar (end).

const VariationC = ({role, tweaks}) => {
  const isTeacher = role === 'teacher';
  const remoteLevel = window.useAudio(isTeacher ? 'student' : 'teacher', 0.45);
  const selfLevel = window.useAudio(isTeacher ? 'teacher' : 'student', 0.35);
  const elapsed = window.useElapsed();
  const Remote = isTeacher ? window.StudentPortrait : window.TeacherPortrait;
  const remoteName = isTeacher ? 'Alex Price' : 'Ms. Eleanor Hart';
  const lessonTitle = isTeacher ? 'Aria · Caro mio ben' : 'Your lesson · Caro mio ben';

  // Fake pitch tracking: target pitch is A4 (y=mid-stave), student pitch wobbles
  const [pitchCents, setPitchCents] = React.useState(0);
  React.useEffect(() => {
    let raf, t0 = performance.now();
    const tick = (now) => {
      const t = (now - t0) / 1000;
      // wanders around target, with a couple of sharp/flat excursions
      const v = Math.sin(t * 0.9) * 25 + Math.sin(t * 2.3) * 10 + (Math.random()-0.5) * 6;
      setPitchCents(v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div style={vc.root}>
      {/* Top row: lesson identity */}
      <div style={vc.top}>
        <div>
          <div style={vc.eyebrow}>{isTeacher ? 'TEACHING' : 'LESSON IN PROGRESS'} · {window.fmtTime(elapsed)}</div>
          <div style={vc.lessonTitle}>
            <span style={vc.clef}>𝄞</span>
            <span style={{fontFamily:"var(--sb-font-display)", fontStyle:"italic"}}>{lessonTitle}</span>
          </div>
        </div>
        <div style={vc.withBlock}>
          <div style={vc.withAvatar}>
            <Remote level={remoteLevel}/>
          </div>
          <div>
            <div style={{fontSize:11, letterSpacing:".14em", textTransform:"uppercase", color:"var(--sb-ink-3)"}}>{isTeacher ? 'With' : 'With'}</div>
            <div style={{fontFamily:"var(--sb-font-display)", fontSize:18, fontWeight:500}}>{remoteName}</div>
          </div>
        </div>
      </div>

      {/* Stave canvas */}
      <div style={vc.stave}>
        <Stave pitchCents={pitchCents} remoteLevel={remoteLevel} selfLevel={selfLevel} showMeter={tweaks.showMeter} isTeacher={isTeacher}/>
      </div>

      {/* Footer controls — musical artefacts */}
      <div style={vc.footer}>
        <div style={vc.selfRow}>
          <div style={vc.selfAvatar}>
            {isTeacher ? <window.TeacherPortrait level={selfLevel}/> : <window.StudentPortrait level={selfLevel}/>}
          </div>
          <div>
            <div style={{fontSize:11, letterSpacing:".14em", textTransform:"uppercase", color:"var(--sb-ink-3)"}}>You</div>
            <div style={{fontFamily:"var(--sb-font-display)", fontSize:16}}>{isTeacher ? 'Ms. Eleanor Hart' : 'Alex Price'}</div>
          </div>
          <div style={vc.hpChip}>♪ Headphones</div>
        </div>
        <div style={vc.musical}>
          <MusicalBtn label="Mute" glyph={<TuningFork/>}/>
          <MusicalBtn label="Video" glyph={<Eye/>}/>
          <MusicalBtn label="Tempo" glyph={<Metronome/>}/>
          <MusicalBtn label="Chat" glyph={<Quill/>}/>
          <MusicalBtn label="End" glyph={<DoubleBar/>} danger/>
        </div>
      </div>
    </div>
  );
};

// --- Stave ---
const Stave = ({pitchCents, remoteLevel, selfLevel, showMeter, isTeacher}) => {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    let raf, t0 = performance.now();
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * devicePixelRatio;
      canvas.height = r.height * devicePixelRatio;
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas);

    const draw = (now) => {
      const W = canvas.width, H = canvas.height;
      const ctx = canvas.getContext('2d');
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);

      // Background cream
      ctx.fillStyle = '#F3ECE0';
      ctx.fillRect(0, 0, W, H);

      // Stave — 5 lines centred
      const lineGap = Math.min(18, H / 14) * devicePixelRatio;
      const midY = H / 2;
      ctx.strokeStyle = 'rgba(15,23,32,0.55)';
      ctx.lineWidth = 1 * devicePixelRatio;
      for (let i = -2; i <= 2; i++) {
        const y = midY + i * lineGap;
        ctx.beginPath(); ctx.moveTo(40 * devicePixelRatio, y); ctx.lineTo(W - 40 * devicePixelRatio, y); ctx.stroke();
      }
      // Bar lines at quarters
      for (let b = 1; b < 4; b++) {
        const x = (W - 80 * devicePixelRatio) * b / 4 + 40 * devicePixelRatio;
        ctx.beginPath(); ctx.moveTo(x, midY - 2 * lineGap); ctx.lineTo(x, midY + 2 * lineGap); ctx.stroke();
      }
      // Treble clef
      ctx.fillStyle = '#0F1720';
      ctx.font = `${lineGap * 5.2}px serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText('𝄞', 50 * devicePixelRatio, midY + lineGap * 0.3);

      // Time signature
      ctx.font = `${lineGap * 2.2}px 'Fraunces', serif`;
      ctx.fillText('4', 120 * devicePixelRatio, midY - lineGap * 0.9);
      ctx.fillText('4', 120 * devicePixelRatio, midY + lineGap * 1.1);

      // Target note — A4 at mid-stave, notehead floats horizontally
      const noteX = W * 0.55;
      const noteR = lineGap * 0.7;
      // Target ghost (teacher's guidance)
      ctx.fillStyle = 'rgba(26,96,174,0.18)';
      drawNotehead(ctx, noteX, midY, noteR * 1.15);
      ctx.strokeStyle = '#1A60AE';
      ctx.lineWidth = 1.2 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(noteX + noteR, midY); ctx.lineTo(noteX + noteR, midY - lineGap * 3.5); ctx.stroke();
      // Target label
      ctx.font = `${11 * devicePixelRatio}px Poppins, sans-serif`;
      ctx.fillStyle = '#1A60AE';
      ctx.textAlign = 'center';
      ctx.fillText('target · A4', noteX, midY - lineGap * 4);

      // Student pitch notehead — offset by pitchCents mapped to y
      const maxCentsVisible = 100;
      const pitchY = midY - (pitchCents / maxCentsVisible) * lineGap * 2.2;
      const flat = pitchCents < -10, sharp = pitchCents > 10;
      // Glow ring modulated by level
      const glowR = noteR * 1.6 + remoteLevel * noteR * 1.2;
      const glowC = Math.abs(pitchCents) < 10 ? 'rgba(111,154,122,0.35)' : 'rgba(225,127,139,0.45)';
      ctx.fillStyle = glowC;
      ctx.beginPath(); ctx.arc(noteX, pitchY, glowR, 0, Math.PI*2); ctx.fill();
      // Main notehead
      ctx.fillStyle = Math.abs(pitchCents) < 10 ? '#6F9A7A' : '#E17F8B';
      drawNotehead(ctx, noteX, pitchY, noteR);
      // Stem
      ctx.strokeStyle = '#0F1720';
      ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(noteX + noteR, pitchY); ctx.lineTo(noteX + noteR, pitchY - lineGap * 3); ctx.stroke();

      // Cents readout
      if (showMeter) {
        ctx.font = `${12 * devicePixelRatio}px Poppins, sans-serif`;
        ctx.fillStyle = '#0F1720';
        ctx.textAlign = 'right';
        const sign = pitchCents > 0 ? '+' : '';
        ctx.fillText(`${sign}${pitchCents.toFixed(0)}¢ ${flat ? 'flat' : sharp ? 'sharp' : 'in tune'}`,
                     W - 50 * devicePixelRatio, midY + lineGap * 4.5);
      }

      // Running waveform strip under the stave
      ctx.strokeStyle = 'rgba(15,23,32,0.4)';
      ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.beginPath();
      const stripY = H - 40 * devicePixelRatio;
      for (let x = 0; x <= W; x += 2) {
        const u = x / W;
        const amp = 18 * devicePixelRatio * remoteLevel * Math.sin(u * Math.PI);
        const y = stripY + Math.sin(u * 30 + t * 6) * amp;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Self echo below
      ctx.strokeStyle = 'rgba(15,23,32,0.2)';
      ctx.lineWidth = 1 * devicePixelRatio;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const u = x / W;
        const amp = 12 * devicePixelRatio * selfLevel * Math.sin(u * Math.PI);
        const y = stripY + 14 * devicePixelRatio + Math.sin(u * 22 - t * 5) * amp;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [pitchCents, remoteLevel, selfLevel, showMeter]);

  return <canvas ref={ref} style={{width:"100%", height:"100%", display:"block"}}/>;
};

const drawNotehead = (ctx, x, y, r) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.32);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.1, r * 0.78, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// Musical control glyphs
const TuningFork = () => <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 2v7a3 3 0 006 0V2"/><path d="M10 12v6"/><path d="M8 18h4"/></svg>;
const Eye = () => <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="10" cy="10" r="2.5"/></svg>;
const Metronome = () => <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2h8l3 16H3z"/><path d="M10 5l-3 12"/></svg>;
const Quill = () => <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 17L15 5"/><path d="M12 2l6 6-6 4-4-4z"/></svg>;
const DoubleBar = () => <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 3v14M11 3v14M14 3v14"/></svg>;

const MusicalBtn = ({label, glyph, danger}) => (
  <button style={{
    display:"flex", flexDirection:"column", alignItems:"center", gap:3,
    width:56, height:56,
    border:"1px solid " + (danger ? "var(--sb-clay)" : "rgba(15,23,32,0.15)"),
    background: danger ? "var(--sb-clay)" : "#fff",
    color: danger ? "#fff" : "var(--sb-ink)",
    borderRadius:12, cursor:"pointer",
    fontFamily:"var(--sb-font-ui)",
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
  }}>
    {glyph}
    <span style={{fontSize:9, fontWeight:600, letterSpacing:".1em", textTransform:"uppercase"}}>{label}</span>
  </button>
);

const vc = {
  root: { position:"absolute", inset:0, display:"flex", flexDirection:"column", padding:"18px", background:"var(--sb-ink)", color:"var(--sb-paper)" },
  top: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:14, padding:"4px 6px 14px" },
  eyebrow: { fontSize:10, letterSpacing:".22em", textTransform:"uppercase", color:"rgba(251,246,239,0.55)", fontWeight:600 },
  lessonTitle: { fontSize:20, fontWeight:400, display:"flex", alignItems:"center", gap:8, marginTop:4, letterSpacing:"-.01em" },
  clef: { fontSize:34, lineHeight:0.8, color:"var(--sb-rose)" },
  withBlock: { display:"flex", gap:10, alignItems:"center" },
  withAvatar: { width:44, height:44, borderRadius:"50%", overflow:"hidden", background:"#000", border:"2px solid var(--sb-paper)", flexShrink:0 },
  stave: { flex:"1 1 auto", borderRadius:12, overflow:"hidden", background:"#F3ECE0", minHeight:0, border:"1px solid rgba(251,246,239,0.08)" },
  footer: { display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, padding:"14px 4px 0", flexWrap:"wrap" },
  selfRow: { display:"flex", alignItems:"center", gap:10 },
  selfAvatar: { width:42, height:42, borderRadius:"50%", overflow:"hidden", background:"#000", flexShrink:0 },
  hpChip: { marginLeft:6, fontSize:10, letterSpacing:".12em", textTransform:"uppercase", color:"rgba(251,246,239,0.65)", padding:"4px 10px", borderRadius:999, border:"1px solid rgba(251,246,239,0.2)" },
  musical: { display:"flex", gap:8 }
};

window.VariationC = VariationC;
