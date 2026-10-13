/* Draw-to-search for the sign dictionary (optikol-style bit grids).
   Grid = N×N monochrome, row-major bit i = y*N+x, packed MSB-first into bytes, base64 in JSON.
   Shared by the offline builder (scripts/mockups/build_sign_draw.js) and the page. */
(function(G){
const RES=[8,16,32], W={8:0.2,16:0.35,32:0.45};
function inkBox(ctx,w,h){const d=ctx.getImageData(0,0,w,h).data;let x0=w,y0=h,x1=-1,y1=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(d[(y*w+x)*4+3]>60){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}
  return x1<0?null:[x0,y0,x1-x0+1,y1-y0+1]}
// crop ink to a centered square, area-average into N×N, threshold coverage
function toGrid(src,N,thr){const c=src.getContext("2d");const b=inkBox(c,src.width,src.height);if(!b)return null;
  const [x,y,w,h]=b,S=Math.max(w,h),pad=S*0.04,side=S+2*pad,ox=x+w/2-side/2,oy=y+h/2-side/2;
  const t=document.createElement("canvas");t.width=t.height=N;const tc=t.getContext("2d",{willReadFrequently:true});
  tc.imageSmoothingEnabled=true;tc.imageSmoothingQuality="high";
  // two-step downsample for better area averaging
  const m=document.createElement("canvas");m.width=m.height=N*8;const mc=m.getContext("2d");mc.imageSmoothingQuality="high";
  mc.drawImage(src,ox,oy,side,side,0,0,N*8,N*8);tc.drawImage(m,0,0,N*8,N*8,0,0,N,N);
  const d=tc.getImageData(0,0,N,N).data,bits=new Uint8Array(N*N);for(let i=0;i<N*N;i++)bits[i]=d[i*4+3]>(thr||70)?1:0;return bits}
function pack(bits){const o=new Uint8Array(Math.ceil(bits.length/8));for(let i=0;i<bits.length;i++)if(bits[i])o[i>>3]|=128>>(i&7);
  let s="";for(const v of o)s+=String.fromCharCode(v);return btoa(s)}
function unpack(b64,N){const s=atob(b64),bits=new Uint8Array(N*N);for(let i=0;i<N*N;i++)bits[i]=(s.charCodeAt(i>>3)>>(7-(i&7)))&1;return bits}
function dilate(b,N){const o=new Uint8Array(N*N);for(let y=0;y<N;y++)for(let x=0;x<N;x++){if(!b[y*N+x])continue;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const X=x+dx,Y=y+dy;if(X>=0&&Y>=0&&X<N&&Y<N)o[Y*N+X]=1}}return o}
function bitsToWords(b){const w=new Uint32Array(Math.ceil(b.length/32));for(let i=0;i<b.length;i++)if(b[i])w[i>>5]|=1<<(i&31);return w}
function pc(v){v=v-((v>>>1)&0x55555555);v=(v&0x33333333)+((v>>>2)&0x33333333);return Math.imul((v+(v>>>4))&0x0F0F0F0F,0x01010101)>>>24}
function cnt(a){let s=0;for(const v of a)s+=pc(v);return s}
function andc(a,b){let s=0;for(let i=0;i<a.length;i++)s+=pc(a[i]&b[i]);return s}
// tolerant Dice: precision of q inside dilated t, recall of t inside dilated q
function soft(q,t){const nq=q.c,nt=t.c;if(!nq||!nt)return 0;const p=andc(q.w,t.dw)/nq,r=andc(t.w,q.dw)/nt;return p+r?2*p*r/(p+r):0}
function dice(q,t){const s=q.c+t.c;return s?2*andc(q.w,t.w)/s:0}
const CFG={qthr:55,pre:1000,mix:{8:0.5,16:0.5,32:0.5}}; // share of soft (tolerant) vs exact Dice per resolution
function sc(q,t,N){const m=CFG.mix[N];return m*soft(q,t)+(1-m)*dice(q,t)}
function prep(bits,N){return{w:bitsToWords(bits),dw:bitsToWords(dilate(bits,N)),c:bits.reduce((a,b)=>a+b,0)}}
function prepQuery(canvas){const q={};for(const N of RES){const b=toGrid(canvas,N,CFG.qthr);if(!b)return null;q[N]=prep(b,N)}return q}
function prepTemplates(T){/* T: [{a, g:{8:b64,16:b64,32:b64}}] */return T.map(t=>{const o={a:t.a,k:t.k,r:{}};for(const N of RES)if(t.g[N])o.r[N]=prep(unpack(t.g[N],N),N);return o})}
function rank(q,P,top){ // 8×8 prefilter → top 200 → rerank with 16+32; one score per sign (best template)
  const s8=P.map(t=>[t,sc(q[8],t.r[8],8)]).sort((a,b)=>b[1]-a[1]).slice(0,CFG.pre);
  const best=new Map();
  for(const [t,a] of s8){let s=W[8]*a,wt=W[8];for(const N of [16,32])if(t.r[N]){s+=W[N]*sc(q[N],t.r[N],N);wt+=W[N]}s/=wt;
    if(!best.has(t.a)||best.get(t.a)<s)best.set(t.a,s)}
  return [...best.entries()].sort((a,b)=>b[1]-a[1]).slice(0,top||24)}
G.SignDraw={CFG,W,RES,toGrid,pack,unpack,prepQuery,prepTemplates,rank};
})(window);
