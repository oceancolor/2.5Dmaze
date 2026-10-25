// X29 · per-agent 常态调用数 M 的分位数（含 G23 归属后的事件额度）+ 双池余量 + STRAT-A 门禁数
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2n · X29 · per-agent 常态调用数 M 的分位数（含 G23 归属后的事件额度）+ 双池余量 + STRAT-A 门禁数');
const GAMES = Number(process.argv[2] || 400);
const EVCAP = 10;                      // X23 事件上限；G23 规定记入常态池
const q=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))];};
const av=a=>a.reduce((x,y)=>x+y,0)/a.length;
const BASE={nAgents:4,stamina:400,placementMode:'reject',thinKeep:0.76,gemColors:5,gemsPerColor:2,minSep:30,intervalEnd:6};

function boot(perGame,B=2000){const n=perGame.length,o=[];for(let b=0;b<B;b++){let s=0;for(let i=0;i<n;i++)s+=perGame[(Math.random()*n)|0];o.push(s/n);}o.sort((x,y)=>x-y);return{lo:o[(B*.025)|0],hi:o[(B*.975)|0]};}

const perAgentMid=[], perAgentEnd=[], gameMid=[], gameEnd=[];
const failRate=[], arriveRate=[];
let nA=0, fail=0;
for(let s=0;s<GAMES;s++){
  const r=simulateGame(5000+s*131,BASE);
  if(r.invalid)continue;
  let m=0,e=0,f=0;
  for(const a of r.agents||r.actors){}
  for(const a of r.actors){
    nA++; perAgentMid.push(a.midCalls+EVCAP); perAgentEnd.push(a.endCalls);
    m+=a.midCalls; e+=a.endCalls;
    if(a.status==='failed'){fail++;f++;}
  }
  gameMid.push(m); gameEnd.push(e);
  failRate.push(f/r.actors.length); arriveRate.push(1-f/r.actors.length);
}
const G=gameMid.length;
console.log(`样本：${G} 局 / ${nA} actor-局（4 理性贪心 @体力400 同质对局 = STRAT-A 口径）`);
console.log(`\n===== X29 · M = per-agent 常态调用（midCalls + 事件 ${EVCAP}，G23 归属）=====`);
console.log(`  mean ${av(perAgentMid).toFixed(2)}   P50 ${q(perAgentMid,.50)}   P90 ${q(perAgentMid,.90)}   P95 ${q(perAgentMid,.95)}   P99 ${q(perAgentMid,.99)}   max ${Math.max(...perAgentMid)}`);
console.log(`  （不含事件的裸 midCalls：mean ${(av(perAgentMid)-EVCAP).toFixed(2)}  P95 ${q(perAgentMid,.95)-EVCAP}  P99 ${q(perAgentMid,.99)-EVCAP}  max ${Math.max(...perAgentMid)-EVCAP}）`);
const Mp95=q(perAgentMid,.95), Mp99=q(perAgentMid,.99), Mmax=Math.max(...perAgentMid);
console.log(`\n===== 常态池 / 终盘池 总量分位（G23 已归属：事件 40 进常态池）=====`);
const gm=gameMid.map(x=>x+40);
console.log(`  常态池(含事件40): mean ${av(gm).toFixed(1)}  P95 ${q(gm,.95)}  P99 ${q(gm,.99)}  max ${Math.max(...gm)}`);
console.log(`  终盘池          : mean ${av(gameEnd).toFixed(1)}  P95 ${q(gameEnd,.95)}  P99 ${q(gameEnd,.99)}  max ${Math.max(...gameEnd)}`);
console.log(`  总量            : max ${Math.max(...gm.map((x,i)=>x+gameEnd[i]))}  vs 360`);

console.log(`\n===== 按 team-lead 规则算最终值 =====`);
for (const [lab,M] of [['P95',Mp95],['P99',Mp99],['max',Mmax]]) {
  let su = Math.ceil(M*1.15/5)*5;
  let note='';
  if (4*su > 300) { su = 75; note='  ⚠ 触第5条：常态软上限被总量压缩（M 未全额满足）'; }
  console.log(`  M=${lab}=${M}: 软上限=ceil(${M}×1.15/5)*5 = ${su} → 常态池 ${4*su} / 终盘池 ${360-4*su} ${360-4*su>=60?'✅ 终盘池≥60':'❌ <60'}${note}`);
}

console.log(`\n===== STRAT-A · F01a / F05（4 理性 @400 同质对局）=====`);
const p=fail/nA, cbF=boot(failRate), cbA=boot(arriveRate);
console.log(`  F01a 失败率 点估计 ${(p*100).toFixed(1)}%  聚类CI [${(cbF.lo*100).toFixed(1)}, ${(cbF.hi*100).toFixed(1)}]   门槛 ≤15% 且 CI上限 ≤20% → ${p<=.15&&cbF.hi<=.20?'✅ 过':'❌'}`);
console.log(`  F05  到达率 点估计 ${((1-p)*100).toFixed(1)}%  聚类CI [${(cbA.lo*100).toFixed(1)}, ${(cbA.hi*100).toFixed(1)}]   门槛 ≥85% 且 CI下限 ≥80% → ${(1-p)>=.85&&cbA.lo>=.80?'✅ 过':'❌'}`);
