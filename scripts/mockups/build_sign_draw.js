// Offline: render every sign with Unicode (Noto Sans Cuneiform 8/16/32, composed no-Unicode signs from Unread Cuneiform; Esagil 8/16 where it has the glyph) into
// bit grids via web/mockups/sign-draw.js, write web/mockups/data/signs_draw.json, then self-test retrieval.
// Run from /tmp/mshot (playwright-core): node build_sign_draw.js  (needs the mockup server on :8791)
const {chromium}=require('/tmp/mshot/node_modules/playwright-core');const fs=require('fs');
const OUT='/home/darkstar/cursor/unread-ui-mockups/web/mockups/data/signs_draw.json';
(async()=>{const b=await chromium.launch();const p=await b.newPage();p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto('http://localhost:8791/mockups/g-signs.html');await p.waitForFunction(()=>window.__ready&&window.SignDraw);
const res=await p.evaluate(async()=>{
  await document.fonts.load('100px NotoCun','𒀭');await document.fonts.load('100px Esagil','𒀭');await document.fonts.load('100px Santakku','𒀭');await document.fonts.load('100px UnreadCun','\u{F0000}');await document.fonts.ready;
  const D=SignDraw;const cv=document.createElement('canvas');cv.width=cv.height=320;const c=cv.getContext('2d',{willReadFrequently:true});
  function render(ch,font,px,lw){c.clearRect(0,0,320,320);c.font=`${px}px ${font}`;c.textAlign='center';c.textBaseline='middle';
    c.fillStyle=c.strokeStyle='#000';c.lineJoin='round';const w=c.measureText(ch).width;const sc=w>300?300/w:1;
    c.save();c.translate(160,160);c.scale(sc,sc);c.fillText(ch,0,0);if(lw){c.lineWidth=lw/sc;c.strokeText(ch,0,0)}c.restore();return cv}
  const T=[];let skipE=0;
  for(const s of IDX){if(!s.u)continue;
    const g={};for(const N of [8,16,32]){const bits=D.toGrid(render(s.u,s.uc?'UnreadCun':'NotoCun',200,0),N);if(bits)g[N]=D.pack(bits)}
    if(g[8])T.push({a:s.a,k:'n',g});
    const fb=D.toGrid(render(s.u,'monospace',200,0),16),e16=D.toGrid(render(s.u,'Esagil',200,0),16);
    if(!s.uc&&e16&&(!fb||D.pack(e16)!==D.pack(fb))){T.push({a:s.a,k:'e',g:{8:D.pack(D.toGrid(cv,8)),16:D.pack(e16)}})}else skipE++}
  const P=D.prepTemplates(T);
  // self-test: re-render at a different size and stroke thickness, rank among all signs
  const tests={'Noto 110px, +8px stroke':['NotoCun',110,8],'Noto 260px, +3px stroke':['NotoCun',260,3],'Santakku 160px (font not in templates)':['Santakku',160,2]};
  const out={};for(const pre of [200,1000,1e9])for(const [nm0,[f,px,lw]] of Object.entries(tests)){D.CFG.pre=pre;const nm=nm0+' | prefilter '+(pre>1e6?'off':pre);const rk=[];
    for(const s of IDX){if(!s.u)continue;if(f==='Santakku'){const fb=D.toGrid(render(s.u,'monospace',160,2),16),x=D.toGrid(render(s.u,f,px,lw),16);if(!x||(fb&&D.pack(x)===D.pack(fb)))continue}
      if(s.uc&&f!=='NotoCun')continue;const q=D.prepQuery(render(s.u,s.uc?'UnreadCun':f,px,lw));if(!q)continue;const r=D.rank(q,P,100);const i=r.findIndex(([a])=>a===s.a);rk.push(i<0?9999:i+1)}
    const n=rk.length,at=k=>+(100*rk.filter(r=>r<=k).length/n).toFixed(1);rk.sort((a,b)=>a-b);
    out[nm]={n,top1:at(1),top5:at(5),top24:at(24)}}D.CFG.pre=1000;
  return {T,skipE,out}});
const json=JSON.stringify({res:[8,16,32],packing:'row-major bit i=y*N+x, MSB-first bytes, base64',fonts:{n:'Noto Sans Cuneiform (OFL)',e:'Esagil (8/16 only)'},t:res.T.map(t=>[t.a,t.k,t.g[8],t.g[16],t.g[32]||''])});
fs.writeFileSync(OUT,json);console.log(JSON.stringify({templates:res.T.length,esagil_skipped:res.skipE,bytes:json.length,selftest:res.out},null,1));
await b.close()})();
