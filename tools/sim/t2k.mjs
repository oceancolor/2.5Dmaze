// B14 余量：单人独占可捡件数（门槛 ≤6）在 new / reject 两种撒点下的对比
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2k · B14 余量：单人独占可捡件数（门槛 ≤6）在 new / reject 两种撒点下的对比');
const GAMES = Number(process.argv[2] || 300);
const q=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))];};
const av=a=>a.reduce((x,y)=>x+y,0)/a.length;
for (const mode of ['new','reject']) {
  for (const gpc of [1,2]) {
    const items=[], gems=[], ge5=[];
    for(let s=0;s<GAMES;s++){
      const r=simulateGame(5000+s*131,{nAgents:1,stamina:400,placementMode:mode,thinKeep:0.76,gemColors:5,gemsPerColor:gpc,minSep:30});
      if(r.invalid)continue;
      const a=r.actors[0];
      items.push(a.picked); gems.push(a.picked-a.chestHits); ge5.push(a.picked>=5?1:0);
    }
    const n=items.length;
    console.log(`${mode.padEnd(7)} ${gpc*5}颗 单人: 可捡 mean ${av(items).toFixed(2)} P90 ${q(items,.90)} max ${Math.max(...items)}  人均宝石 ${av(gems).toFixed(2)}  ≥5件 ${(av(ge5)*100).toFixed(1)}%  B14余量 ${(6-av(items)).toFixed(2)}`);
  }
}
