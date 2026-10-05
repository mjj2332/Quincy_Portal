Drive Chrome only through the `huashu-chrome` MCP tools (`tabs`, `navigate`, `snapshot`, `act`, `click`, `key`, `eval`, `query`, `network`, `screenshot`, `wait`, `read_text`). Use no other browser tool.

# Stage-1 browser pass — __TITLE__ (PASS=__PASS__)

You are the measurer. The local server is ALREADY RUNNING at http://localhost:8787, serving bundle `__BUNDLE__`, and Chrome is already signed in. Do not start, stop or restart any server.

First action in your tab: hard reload (`navigate` action `reload`) and report the loaded `index-*.js` (eval: `[...document.scripts].map(s=>s.src).filter(s=>/index-/.test(s))`) against the served `__BUNDLE__`. If they differ, the pass is void: say so and stop. Repeat the check in the narrow window.

huashu's `act` stops at submit/delete-looking controls; where this brief explicitly tells you to press such a control (local dev only), pass `allowSensitive: true` for that one step.

Contrast helper (paste into `eval` when a row asks for contrast; replace EL with the text element's expression; if a computed colour is not an `rgb()`/`rgba()` string, report the raw strings and say so):
`(()=>{const p=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});const L=s=>{const[r,g,b]=p(s);return 0.2126*r+0.7152*g+0.0722*b};const bg=e=>{for(;e;e=e.parentElement){const c=getComputedStyle(e).backgroundColor;if(c&&!/rgba\(0, 0, 0, 0\)|transparent/.test(c))return c}return 'rgb(255,255,255)'};return {fn:(el)=>{const f=getComputedStyle(el).color,b=bg(el);const a=L(f),c=L(b);return {fg:f,bg:b,ratio:((Math.max(a,c)+0.05)/(Math.min(a,c)+0.05)).toFixed(2)}}}})().fn(EL)` — report fg, bg and ratio.
