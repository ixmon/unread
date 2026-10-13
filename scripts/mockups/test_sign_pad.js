const {chromium}=require('/tmp/mshot/node_modules/playwright-core');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1400,height:1100}});p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto('http://localhost:8791/mockups/g-signs.html?draw=1');await p.waitForFunction(()=>window.__drawReady,null,{timeout:60000});
const r=await p.evaluate(()=>{const P=window.__pad;
  const L=(a,b,w)=>({t:'line',p:[a,b],w}),W=(a,b)=>({t:'wedge',p:[a,b],w:8});
  const star=w=>[0,45,90,135].map(d=>{const t=d*Math.PI/180;return L([160-110*Math.cos(t),160-110*Math.sin(t)],[160+110*Math.cos(t),160+110*Math.sin(t)],w)});
  const she=(w,wedge)=>{const o=[];for(const y of [95,225])for(const x of [60,100,140,180]){const f=wedge?W:(a,b)=>L(a,b,w);o.push(f([x+36,y-40],[x,y]),f([x+36,y+40],[x,y]))}
    for(const y of [95,225])o.push(wedge?W([228,y-50],[228,y+50]):L([228,y-50],[228,y+50],w));return o};
  const gud=w=>[L([40,120],[200,120],w),L([40,200],[200,200],w),L([200,90],[200,230],w),L([200,90],[290,160],w),L([200,230],[290,160],w)];
  const cases={'AN star w4':[star(4),'AN'],'AN star w14':[star(14),'AN'],'ŠE strokes w4':[she(4),'SZE'],'ŠE strokes w8':[she(8),'SZE'],'ŠE strokes w14':[she(14),'SZE'],'ŠE wedges':[she(0,1),'SZE'],
     'GUD strokes w4':[gud(4),'GUD'],'GUD strokes w14':[gud(14),'GUD']};
  const out={};for(const ms of [0,0.03,0.05,0.07]){SignDraw.CFG.minStroke=ms;for(const [k,[its,want]] of Object.entries(cases)){P.items.length=0;its.forEach(i=>P.items.push(i));
    const q=SignDraw.prepQuery(P.matchCanvas());const rk=SignDraw.rank(q,DRAWP,500);const i=rk.findIndex(([a])=>a===want);(out[k]=out[k]||{})['min'+ms]=i<0?'>500':i+1}}
  let seed=1;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647-.5};
  const jit=its=>its.map(i=>({...i,p:i.p.map(([x,y])=>[x+24*rnd(),y+24*rnd()])}));
  for(const ms of [0,0.05])for(const [k,mk] of [['ŠE jittered strokes w5 (top1/top5/top24 of 30)',()=>she(5)],['ŠE jittered wedges',()=>she(0,1)],['AN jittered w5',()=>star(5)]]){
    SignDraw.CFG.minStroke=ms;seed=7;const rs=[];const want=k.startsWith('AN')?'AN':'SZE';
    for(let n=0;n<30;n++){P.items.length=0;jit(mk()).forEach(i=>P.items.push(i));const rk=SignDraw.rank(SignDraw.prepQuery(P.matchCanvas()),DRAWP,500);const i=rk.findIndex(([a])=>a===want);rs.push(i<0?999:i+1)}
    (out[k]=out[k]||{})['min'+ms]=[1,5,24].map(t=>rs.filter(r=>r<=t).length).join('/')}
  SignDraw.CFG.minStroke=0.05;return out});
console.table(r);await b.close()})();
