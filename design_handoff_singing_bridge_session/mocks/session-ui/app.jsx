// app.jsx — chrome, variation tabs, tweaks panel, two pane mounts

const App = () => {
  const { tweaks, setTweak, tweaksOpen, setTweaksOpen } = window.useTweakState();
  const Var = tweaks.variation === 'A' ? window.VariationA
           : tweaks.variation === 'B' ? window.VariationB
           : window.VariationC;
  const label = tweaks.variation === 'A' ? 'Warm room'
              : tweaks.variation === 'B' ? 'Listening room'
              : 'The stave';
  const blurb = tweaks.variation === 'A'
    ? 'A conventional two-tile call, re-skinned as a warm paper & piano room. Ambient breath-ring around the speaker. Familiar territory, done thoughtfully.'
    : tweaks.variation === 'B'
    ? 'Audio-first. Video shrinks to a passport frame, and the live waveform becomes the centrepiece — because in a singing lesson, you\'re listening more than looking.'
    : 'Music-teacher-native. The session sits on a live stave with real-time pitch tracking against the target note. Controls become tuning forks, metronomes, fermatas, double-bars.';

  return (
    <>
      <div className="chrome">
        <div className="chrome-inner">
          <div className="brand">
            <span className="mark"/>
            Singing Bridge <span className="brand-amp">by Rich Consultancy</span>
          </div>
          <div className="var-tabs" role="tablist">
            {['A','B','C'].map(v => (
              <button key={v} className="var-tab"
                      aria-pressed={tweaks.variation === v}
                      onClick={() => setTweak('variation', v)}>
                Variation {v}
              </button>
            ))}
          </div>
          <div className="chrome-meta">Session UI · Online singing lessons</div>
        </div>
      </div>

      <div className="stage">
        <div className="stage-head">
          <div className="stage-title">
            <h1><em>Variation {tweaks.variation} —</em> {label}</h1>
            <p>{blurb}</p>
          </div>
          <div style={{fontSize:12, color:"var(--sb-ink-3)", textAlign:"right"}}>
            Both panes live. <br/>Teacher left · Student right.
          </div>
        </div>

        <div className="pair">
          <div>
            <div className="pane-label teacher">Teacher's view</div>
            <div className="v-pane">
              <Var role="teacher" tweaks={tweaks}/>
            </div>
          </div>
          <div>
            <div className="pane-label student">Student's view</div>
            <div className="v-pane">
              <Var role="student" tweaks={tweaks}/>
            </div>
          </div>
        </div>
      </div>

      <div className="captions">
        <div>
          <b>Teacher's view</b> — {tweaks.variation === 'A'
            ? 'sees the student full-bleed with a name plate and a headphones-confirmed badge; self-preview as a small inset; controls laid out horizontally at the foot.'
            : tweaks.variation === 'B'
            ? 'sees Alex in a small framed portrait; the canvas is dominated by a live dual waveform (rose = remote, ink = self) so the teacher can watch phrasing, not faces.'
            : 'sees the student\'s pitch drift around the target note in real time. Green = in tune, rose = sharp/flat. Cents readout visible when the meter is on.'}
        </div>
        <div>
          <b>Student's view</b> — {tweaks.variation === 'A'
            ? 'identical mirror of the teacher\'s layout with roles swapped. Reduces cognitive load — both sides navigate the same chrome.'
            : tweaks.variation === 'B'
            ? 'sees Eleanor in the framed portrait, same giant scope. Deliberately de-emphasises self-consciousness about appearance.'
            : 'sees themselves reflected on the stave too — target note stays the same, their own notehead moves. Signature: "you are singing on the staff, not in front of a camera."'}
        </div>
      </div>

      {/* Tweaks panel */}
      <div className={"tweaks " + (tweaksOpen ? "open" : "")}>
        <div className="tweaks-head">
          <span>Tweaks</span>
          <button onClick={() => setTweaksOpen(false)}
                  style={{background:"none", border:0, color:"inherit", cursor:"pointer", fontSize:16, lineHeight:1}}>×</button>
        </div>
        <div className="tweaks-body">
          <div className="tweak-row">
            <div>
              <div className="tweak-label">Variation</div>
              <span className="tweak-sub">Switch UI approach</span>
            </div>
            <div className="seg" role="group">
              {['A','B','C'].map(v => (
                <button key={v}
                        aria-pressed={tweaks.variation === v}
                        onClick={() => setTweak('variation', v)}>{v}</button>
              ))}
            </div>
          </div>
          <div className="tweak-row">
            <div>
              <div className="tweak-label">Audio meter</div>
              <span className="tweak-sub">Show numeric dB / cents readouts</span>
            </div>
            <button className="switch"
                    aria-checked={tweaks.showMeter}
                    onClick={() => setTweak('showMeter', !tweaks.showMeter)}/>
          </div>
        </div>
      </div>
    </>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
