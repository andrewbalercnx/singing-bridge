// variation-a.jsx — "The warm room"
// Conventional two-tile layout, reimagined as a warm paper-and-piano
// space. Ambient breath ring around the speaker. Self-preview inset.
// A discreet audio meter runs along the dotted baseline under the video.

const VariationA = ({role, tweaks}) => {
  const isTeacher = role === 'teacher';
  const remoteLevel = window.useAudio(isTeacher ? 'student' : 'teacher', 0.4);
  const selfLevel = window.useAudio(isTeacher ? 'teacher' : 'student', 0.3);
  const elapsed = window.useElapsed();
  const Remote = isTeacher ? window.StudentPortrait : window.TeacherPortrait;
  const remoteName = isTeacher ? 'Alex Price' : 'Ms. Eleanor Hart';
  const remoteRole = isTeacher ? 'Student · Lesson 7' : 'Your teacher';

  const ring = Math.round(remoteLevel * 100);

  return (
    <div style={va.root}>
      {/* Remote video w/ breath ring */}
      <div style={va.remoteWrap}>
        <div style={{...va.breathRing, boxShadow: `inset 0 0 0 ${4 + remoteLevel*10}px rgba(225,127,139,${0.15 + remoteLevel*0.35})`}}/>
        <Remote level={remoteLevel}/>
        {/* name plate */}
        <div style={va.namePlate}>
          <div style={va.nameName}>{remoteName}</div>
          <div style={va.nameRole}>{remoteRole}</div>
        </div>
        {/* headphones check */}
        <div style={va.hpCheck}>
          <span style={va.hpDot}/> Headphones on
        </div>
      </div>

      {/* Dotted baseline with optional meter */}
      <div style={va.baseline}>
        {tweaks.showMeter && (
          <div style={va.meterRow} aria-label="Audio levels">
            <MeterBar label={isTeacher ? 'YOU' : 'YOU'} level={selfLevel} side="left"/>
            <div style={va.meterMid}>{window.fmtTime(elapsed)}</div>
            <MeterBar label={isTeacher ? 'ALEX' : 'ELEANOR'} level={remoteLevel} side="right"/>
          </div>
        )}
        {!tweaks.showMeter && (
          <div style={va.dottedOnly}>
            <span>{window.fmtTime(elapsed)}</span>
          </div>
        )}
      </div>

      {/* Bottom: controls + self preview */}
      <div style={va.bottom}>
        <div style={va.controls}>
          <IconBtn icon="mic"     label="Muted" active={false}/>
          <IconBtn icon="vid"     label="Video" active={true}/>
          <IconBtn icon="note"    label="Note"  active={false}/>
          <IconBtn icon="chat"    label="Say"   active={false}/>
          <IconBtn icon="end"     label="End"   end={true}/>
        </div>
        <div style={va.selfWrap}>
          <div style={{borderRadius:12, overflow:"hidden", width:"100%", height:"100%"}}>
            {isTeacher ? <window.TeacherPortrait level={selfLevel}/> : <window.StudentPortrait level={selfLevel}/>}
          </div>
          <div style={va.selfLabel}>You</div>
        </div>
      </div>
    </div>
  );
};

const MeterBar = ({label, level, side}) => {
  const n = 14;
  const active = Math.round(level * n);
  return (
    <div style={{display:"flex", alignItems:"center", gap:8, flexDirection: side === 'right' ? 'row-reverse' : 'row'}}>
      <span style={{fontSize:10, fontWeight:600, letterSpacing:".14em", color:"rgba(251,246,239,0.7)"}}>{label}</span>
      <div style={{display:"flex", gap:2, flexDirection: side === 'right' ? 'row-reverse' : 'row'}}>
        {[...Array(n)].map((_,i)=>{
          const on = i < active;
          const color = i < n*0.6 ? '#F3ECE0' : i < n*0.85 ? '#E3A950' : '#E17F8B';
          return <span key={i} style={{width:3, height: 6 + i*1.2, background: on ? color : "rgba(251,246,239,0.15)", borderRadius:1, transition:"background .05s"}}/>;
        })}
      </div>
    </div>
  );
};

const IconBtn = ({icon, label, active, end}) => (
  <button style={{
    ...va.btn,
    ...(end ? va.btnEnd : active ? va.btnActive : {}),
  }}>
    <IconGlyph name={icon}/>
    <span style={{fontSize:11, fontWeight:500, letterSpacing:".04em"}}>{label}</span>
  </button>
);

const IconGlyph = ({name}) => {
  const c = "currentColor";
  switch (name) {
    case 'mic':  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0"/><path d="M12 18v3"/></svg>;
    case 'vid':  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>;
    case 'note': return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>;
    case 'chat': return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6"><path d="M4 5h16v11H8l-4 4z"/></svg>;
    case 'end':  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6"><path d="M3 13a13 13 0 0118 0l-2 3-4-1-1-3a10 10 0 00-4 0l-1 3-4 1z"/></svg>;
    default: return null;
  }
};

const va = {
  root: { position:"absolute", inset:0, display:"flex", flexDirection:"column", background:"#0F1720", color:"#FBF6EF", padding:"16px 16px 14px" },
  remoteWrap: { position:"relative", flex:"1 1 auto", borderRadius:20, overflow:"hidden", background:"#000", minHeight:0 },
  breathRing: { position:"absolute", inset:0, zIndex:2, pointerEvents:"none", borderRadius:20, transition:"box-shadow .08s ease-out" },
  namePlate: { position:"absolute", left:16, top:16, background:"rgba(15,23,32,0.55)", backdropFilter:"blur(6px)", padding:"8px 14px", borderRadius:12, zIndex:3 },
  nameName: { fontFamily:"var(--sb-font-display)", fontSize:17, fontWeight:500, letterSpacing:"-0.01em" },
  nameRole: { fontSize:11, opacity:0.75, letterSpacing:".08em", textTransform:"uppercase", marginTop:2 },
  hpCheck: { position:"absolute", right:16, top:16, background:"rgba(111,154,122,0.9)", color:"#fff", padding:"6px 12px", borderRadius:999, fontSize:11, fontWeight:500, display:"flex", alignItems:"center", gap:6, zIndex:3 },
  hpDot: { width:6, height:6, borderRadius:"50%", background:"#fff" },
  baseline: { padding:"12px 4px 10px" },
  meterRow: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:14 },
  meterMid: { fontFamily:"var(--sb-font-display)", fontStyle:"italic", fontSize:15, color:"rgba(251,246,239,0.85)" },
  dottedOnly: {
    height: 22, display:"flex", alignItems:"center", justifyContent:"center",
    backgroundImage:"radial-gradient(circle, rgba(251,246,239,0.35) 1.2px, transparent 1.4px)",
    backgroundSize:"12px 6px", backgroundRepeat:"repeat-x", backgroundPosition:"left center",
    fontFamily:"var(--sb-font-display)", fontStyle:"italic", fontSize:14, color:"rgba(251,246,239,0.7)"
  },
  bottom: { display:"flex", justifyContent:"space-between", alignItems:"flex-end", gap:12 },
  controls: { display:"flex", gap:8 },
  btn: { display:"flex", flexDirection:"column", alignItems:"center", gap:4, width:56, height:56, borderRadius:16, border:"1px solid rgba(251,246,239,0.12)", background:"rgba(251,246,239,0.06)", color:"#FBF6EF", cursor:"pointer", transition:"background .15s" },
  btnActive: { background:"#FBF6EF", color:"#0F1720", borderColor:"#FBF6EF" },
  btnEnd: { background:"#C8684F", color:"#fff", borderColor:"#C8684F" },
  selfWrap: { width:110, height:130, borderRadius:14, background:"#000", position:"relative", overflow:"hidden", boxShadow:"0 6px 20px rgba(0,0,0,0.4)", border:"1px solid rgba(251,246,239,0.12)" },
  selfLabel: { position:"absolute", left:8, bottom:8, fontSize:10, fontWeight:600, letterSpacing:".1em", color:"#FBF6EF", background:"rgba(15,23,32,0.65)", padding:"3px 8px", borderRadius:999 }
};

window.VariationA = VariationA;
