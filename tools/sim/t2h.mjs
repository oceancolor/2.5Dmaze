// 调用数对 interval 的敏感性：中盘 interval = 8 / 10 两档（终盘恒 8，事件 +6）
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2h · 调用数对 interval 的敏感性：中盘 interval = 8 / 10 两档（终盘恒 8，事件 +6）');
const GAMES = 400;
const q=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))];};
const av=a=>a.reduce((x,y)=>x+y,0)/a.length;
function calls(T, mi){ const e=Math.min(T,60), m=Math.max(0,T-e); return Math.ceil(m/mi)+Math.ceil(e/8)+6; }
for (const mi of [8,10]) {
  for (const st of [400,450]) {
    const pg=[];
    for(let s=0;s<GAMES;s++){
      const r=simulateGame(5000+s*131,{nAgents:4,stamina:st,placementMode:'reject',thinKeep:0.76,gemColors:5,gemsPerColor:2,minSep:30});
      if(r.invalid)continue;
      let g=0; for(const a of r.actors) g+=calls(a.endTurn>0?a.endTurn:r.turns, mi);
      pg.push(g);
    }
    console.log(`中盘interval=${mi} 体力${st}: 单局调用 mean ${av(pg).toFixed(1)} P95 ${q(pg,.95)} max ${Math.max(...pg)}  超240 ${(pg.filter(x=>x>240).length/pg.length*100).toFixed(1)}%  超360 ${(pg.filter(x=>x>360).length/pg.length*100).toFixed(1)}%`);
  }
}
