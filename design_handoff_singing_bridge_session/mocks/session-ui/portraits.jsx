// portraits.jsx — SVG stand-ins for teacher and student video feeds.
// Warm painted portraits rather than stock-photo realism; suits the
// "private lesson" tone while keeping everything offline.

const TeacherPortrait = ({level = 0.5}) => (
  <svg viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice"
       style={{width:"100%", height:"100%", display:"block"}}>
    <defs>
      <linearGradient id="tp-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#EED6B8"/>
        <stop offset="1" stopColor="#C9A47D"/>
      </linearGradient>
      <radialGradient id="tp-spot" cx="0.7" cy="0.25" r="0.8">
        <stop offset="0" stopColor="#FFE9C8" stopOpacity="0.9"/>
        <stop offset="1" stopColor="#C9A47D" stopOpacity="0"/>
      </radialGradient>
    </defs>
    <rect width="400" height="600" fill="url(#tp-bg)"/>
    <rect width="400" height="600" fill="url(#tp-spot)"/>
    {/* piano in bg */}
    <rect x="-40" y="440" width="500" height="200" fill="#2A1D18" opacity="0.75"/>
    <rect x="-40" y="440" width="500" height="6" fill="#6E4A2E"/>
    {[...Array(14)].map((_,i)=>(
      <rect key={i} x={-40+i*35} y="455" width="32" height="70" fill="#F8EFE1"/>
    ))}
    {[...Array(13)].map((_,i)=>{
      const pattern = [1,1,0,1,1,1,0];
      if(!pattern[i%7]) return null;
      return <rect key={'b'+i} x={-26+i*35} y="455" width="18" height="42" fill="#1A100B"/>
    })}
    {/* body */}
    <path d="M60 600 C 60 470 140 420 200 420 C 260 420 340 470 340 600 Z" fill="#6E8B8A"/>
    <path d="M140 460 C 140 440 260 440 260 460 L 260 600 L 140 600 Z" fill="#8DA9A4"/>
    {/* neck */}
    <rect x="178" y="340" width="44" height="90" fill="#D9A57A"/>
    {/* head */}
    <ellipse cx="200" cy="290" rx="78" ry="92" fill="#E7B98C"/>
    {/* hair — warm auburn updo */}
    <path d="M132 260 C 130 180 180 148 205 150 C 255 152 275 200 272 262 C 268 240 250 220 236 214 C 240 230 238 252 230 258 C 215 240 178 236 162 252 C 148 246 138 252 132 260 Z" fill="#5B2E1B"/>
    <ellipse cx="200" cy="180" rx="30" ry="22" fill="#5B2E1B"/>
    {/* eyes */}
    <ellipse cx="178" cy="294" rx="5" ry="3" fill="#2A1A10"/>
    <ellipse cx="222" cy="294" rx="5" ry="3" fill="#2A1A10"/>
    <path d="M168 282 Q 178 278 188 282" stroke="#3A271A" strokeWidth="1.6" fill="none"/>
    <path d="M212 282 Q 222 278 232 282" stroke="#3A271A" strokeWidth="1.6" fill="none"/>
    {/* nose */}
    <path d="M200 300 Q 196 318 200 326 Q 204 328 208 326" stroke="#B98461" strokeWidth="1.6" fill="none"/>
    {/* mouth — opens with level */}
    <ellipse cx="200" cy={345 + level*4} rx={14 + level*4} ry={3 + level*7} fill="#8E3A3A"/>
    <ellipse cx="200" cy={344 + level*4} rx={12 + level*3} ry={1 + level*3} fill="#5B1E1E"/>
    {/* cheek blush */}
    <ellipse cx="156" cy="318" rx="14" ry="8" fill="#E17F8B" opacity="0.25"/>
    <ellipse cx="244" cy="318" rx="14" ry="8" fill="#E17F8B" opacity="0.25"/>
    {/* earring */}
    <circle cx="128" cy="310" r="4" fill="#E3A950"/>
    <circle cx="272" cy="310" r="4" fill="#E3A950"/>
  </svg>
);

const StudentPortrait = ({level = 0.3}) => (
  <svg viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice"
       style={{width:"100%", height:"100%", display:"block"}}>
    <defs>
      <linearGradient id="sp-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#D6E3E8"/>
        <stop offset="1" stopColor="#A7BDC7"/>
      </linearGradient>
    </defs>
    <rect width="400" height="600" fill="url(#sp-bg)"/>
    {/* bookshelf bg */}
    <rect x="30" y="100" width="340" height="10" fill="#8B6F4E"/>
    <rect x="30" y="250" width="340" height="10" fill="#8B6F4E"/>
    {[0,1,2,3,4,5,6,7,8,9,10,11].map(i=>(
      <rect key={i} x={40+i*27} y="115" width="22" height="130"
            fill={['#7A4B3A','#4A6B7A','#9A7346','#3F5A3D','#7A3A5A'][i%5]}/>
    ))}
    {/* headphones arc — signature "wears headphones" detail */}
    <path d="M110 260 Q 200 180 290 260" fill="none" stroke="#1F2A33" strokeWidth="10" strokeLinecap="round"/>
    <rect x="94" y="258" width="32" height="58" rx="8" fill="#1F2A33"/>
    <rect x="274" y="258" width="32" height="58" rx="8" fill="#1F2A33"/>
    {/* body — jumper */}
    <path d="M60 600 C 60 470 140 430 200 430 C 260 430 340 470 340 600 Z" fill="#9A6C5C"/>
    <ellipse cx="200" cy="452" rx="70" ry="22" fill="#8B5D4E"/>
    {/* neck */}
    <rect x="182" y="360" width="36" height="80" fill="#E9C4A2"/>
    {/* head */}
    <ellipse cx="200" cy="310" rx="70" ry="84" fill="#F2D0AE"/>
    {/* hair — dark bob */}
    <path d="M134 300 C 130 228 175 190 205 190 C 245 190 272 220 270 298 C 262 274 250 268 240 266 C 240 258 230 254 220 256 C 210 248 195 248 185 256 C 175 252 160 258 158 268 C 148 270 138 280 134 300 Z" fill="#2D1B12"/>
    {/* eyes */}
    <ellipse cx="180" cy="310" rx="4" ry="3" fill="#1A100B"/>
    <ellipse cx="220" cy="310" rx="4" ry="3" fill="#1A100B"/>
    {/* nose */}
    <path d="M200 318 Q 197 334 200 342 Q 203 344 207 342" stroke="#C19275" strokeWidth="1.4" fill="none"/>
    {/* mouth */}
    <ellipse cx="200" cy={360 + level*3} rx={11 + level*3} ry={2 + level*5} fill="#8E3A3A"/>
    <ellipse cx="200" cy={359 + level*3} rx={9 + level*2} ry={1 + level*2.5} fill="#5B1E1E"/>
    {/* cheek */}
    <ellipse cx="160" cy="334" rx="11" ry="7" fill="#E17F8B" opacity="0.3"/>
    <ellipse cx="240" cy="334" rx="11" ry="7" fill="#E17F8B" opacity="0.3"/>
  </svg>
);

Object.assign(window, { TeacherPortrait, StudentPortrait });
