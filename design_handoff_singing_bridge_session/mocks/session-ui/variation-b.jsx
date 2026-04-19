// variation-b.jsx — "The listening room"
// Audio-first: video is intentionally small and framed; the dominant
// element is a live waveform/scope drawn across the canvas that reacts
// to both voices. Controls are minimal, set into a warm paper dock.

const VariationB = ({role, tweaks}) => {
  const isTeacher = role === 'teacher';
  const remoteLevel = window.useAudio(isTeacher ? 'student' : 'teacher', 0.4);
  const selfLevel = window.useAudio(isTeacher ? 'teacher' : 'student', 0.3);
  const elapsed = window.useElapsed();
  const Remote = isTeacher ? window.StudentPortrait : window.TeacherPortrait;
  const remoteName = isTeacher ? 'Alex Price' : 'Ms. Eleanor Hart';

  return (
    <div style={vb.root}>
      {/* Cream paper surface */}
      <div style={vb.paper}>

        {/* Tiny video frame — like a passport photo */}
        <div style={vb.frame}>
          <div style={vb.frameInner}>
            <Remote level={remoteLevel}/>
          </div>
          <div style={vb.frameLabel}>
            <div style={vb.frameName}>{remoteName}</div>
            <div style={vb.frameMeta}>{isTeacher ? 'Student' : 'Teacher'} · <em>live</em></div>
          </div>
        </div>

        {/* BIG waveform scope */}
        <div style={vb.scope}>
          <WaveformScope remoteLevel={remoteLevel} selfLevel={selfLevel} showMeter={tweaks.showMeter}/>
        </div>

        {/* Heading + headphones confirm */}
        <div style={vb.heading}>
          <div>
            <div style={vb.eyebrow}>In session · {window.fmtTime(elapsed)}</div>
            <h2 style={vb.title}>
              <em>Listening for</em>
              <br/>{isTeacher ? 'Alex' : 'Eleanor'}.
            </h2>
          </div>
          <div style={vb.hp}>
            <HpGlyph/>
            <div>
              <div style={{fontWeight:600, fontSize:13}}>Headphones confirmed</div>
              <div style={{fontSize:11, color:"var(--sb-ink-3)", marginTop:2}}>AEC off · Opus music mode</div>
            </div>
          </div>
        </div>

        {/* Self preview card */}
        <div style={vb.self}>
          <div style={{width:44, height:44, borderRadius:"50%", overflow:"hidden", background:"#000", flexShrink:0}}>
            {isTeacher ? <window.TeacherPortrait level={selfLevel}/> : <window.StudentPortrait level={selfLevel}/>}
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:12, fontWeight:600, color:"var(--sb-ink-2)"}}>You are {role === 'teacher' ? 'teaching' : 'singing'}.</div>
            <SelfLevel level={selfLevel}/>
          </div>
        </div>

        {/* Controls */}
        <div style={vb.controls}>
          <PaperBtn label="Mute"/>
          <PaperBtn label="Video"/>
          <PaperBtn label="Chat"/>
          <PaperBtn label="End lesson" primary/>
        </div>

      </div>
    </div>
  );
};

const HpGlyph = () => (
  <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
    <path d="M6 18a10 10 0 0120 0" stroke="#0F1720" strokeWidth="2" strokeLinecap="round"/>
    <rect x="4" y="18" width="6" height="9" rx="2" fill="#0F1720"/>
    <rect x="22" y="18" width="6" height="9" rx="2" fill="#0F1720"/>
  </svg>
);

// The star of variation B — a live waveform drawn on canvas,
// driven by two synthesised voices. Warm rose = remote, ink = self.
const WaveformScope = ({remoteLevel, selfLevel, showMeter}) => {
  const canvasRef = React.useRef(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf, t0 = performance.now();
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * devicePixelRatio;
      canvas.height = r.height * devicePixelRatio;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now) => {
      const W = canvas.width, H = canvas.height;
      const t = (now - t0) / 1000;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);

      const midY = H / 2;

      // Remote wave (warm rose, thicker)
      ctx.lineWidth = 3 * devicePixelRatio;
      ctx.strokeStyle = 'rgba(225,127,139,0.9)';
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const u = x / W;
        const envelope = Math.sin(u * Math.PI);
        const amp = H * 0.32 * remoteLevel * envelope;
        const y = midY + Math.sin(u * 18 + t * 5) * amp + Math.sin(u * 42 + t * 7) * amp * 0.3;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Self wave (ink, thinner, above)
      ctx.lineWidth = 1.8 * devicePixelRatio;
      ctx.strokeStyle = 'rgba(15,23,32,0.55)';
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const u = x / W;
        const envelope = Math.sin(u * Math.PI);
        const amp = H * 0.22 * selfLevel * envelope;
        const y = midY - H * 0.12 + Math.sin(u * 13 - t * 4) * amp;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Baseline dotted
      ctx.fillStyle = 'rgba(15,23,32,0.18)';
      for (let x = 2; x < W; x += 10 * devicePixelRatio) {
        ctx.beginPath();
        ctx.arc(x, midY + H * 0.36, 1.4 * devicePixelRatio, 0, Math.PI * 2);
        ctx.fill();
      }

      // Numeric meter (top-right) — only if tweaks.showMeter
      if (showMeter) {
        ctx.font = `${11 * devicePixelRatio}px Poppins, sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(15,23,32,0.55)';
        const dB = (lvl) => Math.round(-60 + lvl * 60);
        ctx.fillText(`REMOTE ${dB(remoteLevel)} dB`, W - 10 * devicePixelRatio, 20 * devicePixelRatio);
        ctx.fillText(`SELF   ${dB(selfLevel)} dB`, W - 10 * devicePixelRatio, 36 * devicePixelRatio);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [showMeter]);

  // refs change only on showMeter; feed the hooked levels via refs
  return <canvas ref={canvasRef} style={{width:"100%", height:"100%", display:"block"}}/>;
};

const SelfLevel = ({level}) => (
  <div style={{display:"flex", gap:2, marginTop:6, height:10}}>
    {[...Array(20)].map((_,i)=>{
      const on = i < Math.round(level*20);
      return <div key={i} style={{flex:1, background: on ? 'var(--sb-moss)' : 'rgba(15,23,32,0.08)', borderRadius:1}}/>;
    })}
  </div>
);

const PaperBtn = ({label, primary}) => (
  <button style={{
    padding:"11px 20px",
    fontFamily:"var(--sb-font-ui)",
    fontSize:13, fontWeight:500,
    border:"1px solid " + (primary ? "var(--sb-clay)" : "rgba(15,23,32,0.15)"),
    background: primary ? "var(--sb-clay)" : "#fff",
    color: primary ? "#fff" : "var(--sb-ink)",
    borderRadius:999, cursor:"pointer",
    letterSpacing:".02em"
  }}>{label}</button>
);

const vb = {
  root: { position:"absolute", inset:0, display:"flex", padding:"14px", background:"var(--sb-ink)" },
  paper: { flex:1, background:"var(--sb-paper)", borderRadius:"calc(var(--sb-r-lg) - 4px)", padding:"28px 28px 22px", display:"grid", gridTemplateColumns:"120px 1fr", gridTemplateRows:"auto 1fr auto auto", gap:"18px 22px", position:"relative", overflow:"hidden" },
  heading: { gridColumn:"1 / span 2", gridRow:"1", display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16 },
  eyebrow: { fontSize:10, fontWeight:600, letterSpacing:".2em", textTransform:"uppercase", color:"var(--sb-ink-3)" },
  title: { fontFamily:"var(--sb-font-display)", fontSize:30, fontWeight:500, letterSpacing:"-0.015em", margin:"4px 0 0", lineHeight:1.05 },
  hp: { display:"flex", gap:10, alignItems:"center", background:"var(--sb-paper-2)", padding:"10px 14px", borderRadius:14, border:"1px solid var(--sb-line-soft)" },
  frame: { gridColumn:"1", gridRow:"2", display:"flex", flexDirection:"column", alignItems:"center", gap:10 },
  frameInner: { width:110, height:140, borderRadius:10, overflow:"hidden", background:"#000", border:"3px solid #fff", boxShadow:"0 6px 18px rgba(0,0,0,0.12)" },
  frameLabel: { textAlign:"center" },
  frameName: { fontFamily:"var(--sb-font-display)", fontSize:15, fontWeight:500 },
  frameMeta: { fontSize:11, color:"var(--sb-ink-3)" },
  scope: { gridColumn:"2", gridRow:"2", borderRadius:14, background:"var(--sb-paper-2)", border:"1px solid var(--sb-line-soft)", overflow:"hidden", minHeight:0 },
  self: { gridColumn:"1 / span 2", gridRow:"3", display:"flex", gap:12, alignItems:"center", padding:"12px 14px", background:"var(--sb-paper-2)", borderRadius:12, border:"1px solid var(--sb-line-soft)" },
  controls: { gridColumn:"1 / span 2", gridRow:"4", display:"flex", gap:10, justifyContent:"flex-end", flexWrap:"wrap" },
};

window.VariationB = VariationB;
