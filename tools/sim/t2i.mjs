// v1.9 物理隔离双池：常态池 328 / 终盘池 32 的实测占用与余量
// 终盘间隔 = 8（v1.9 终裁，不是 6）；中盘 = 10；终盘触发线 stamina<=60
import { simulateGame, cfgSummary } from './lib.mjs';
cfgSummary('t2i · v1.9 物理隔离双池：常态池 328 / 终盘池 32 的实测占用与余量 / 终盘间隔 = 8（v1.9 终裁，不是 6）；中盘 = 10');

const GAMES = Number(process.argv[2] || 400);
const POOL_MID = 328, POOL_END = 32, CAP_TOTAL = 360;
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const av = a => a.reduce((x, y) => x + y, 0) / a.length;

function run(label, o) {
  const mid = [], end = [], tot = [], ent = [], perEnd = [], turns = [];
  let overMid = 0, overEnd = 0, overTot = 0, n = 0;
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, Object.assign({
      nAgents: 4, stamina: 400, placementMode: 'reject', thinKeep: 0.76,
      gemColors: 5, gemsPerColor: 2, minSep: 30, intervalEnd: 8, // 钉 8：本脚本为 X22 前的历史口径，勿随内核默认值漂移
    }, o));
    if (r.invalid) continue;
    n++; turns.push(r.turns);
    let m = 0, e = 0;
    for (const a of r.actors) { m += a.midCalls; e += a.endCalls; perEnd.push(a.endCalls); ent.push(a.endgameEntries); }
    mid.push(m); end.push(e); tot.push(m + e);
    if (m > POOL_MID) overMid++;
    if (e > POOL_END) overEnd++;
    if (m + e > CAP_TOTAL) overTot++;
  }
  const r1 = x => (x / n * 100).toFixed(1) + '%';
  console.log(`\n===== ${label}（${n} 局）=====`);
  console.log(`回合 P50 ${q(turns, .5)} / P95 ${q(turns, .95)} / max ${Math.max(...turns)}`);
  console.log(`【常态池 328】  mean ${av(mid).toFixed(1)}  P95 ${q(mid, .95)}  max ${Math.max(...mid)}   余量 ${(POOL_MID - Math.max(...mid))}  破池 ${r1(overMid)}`);
  console.log(`【终盘池 32 】  mean ${av(end).toFixed(1)}  P95 ${q(end, .95)}  max ${Math.max(...end)}   余量 ${(POOL_END - Math.max(...end))}  破池 ${r1(overEnd)}`);
  console.log(`【总量 360  】  mean ${av(tot).toFixed(1)}  P95 ${q(tot, .95)}  max ${Math.max(...tot)}   破顶 ${r1(overTot)}`);
  console.log(`单人终盘调用   mean ${av(perEnd).toFixed(2)}  P95 ${q(perEnd, .95)}  max ${Math.max(...perEnd)}  （理论值 ceil(60/8)=8）`);
  console.log(`终盘进入次数   mean ${av(ent).toFixed(2)}  max ${Math.max(...ent)}  （>1 = 宝箱体力奖励把人顶出终盘后又掉回来）`);
  return { mid, end, tot, perEnd, ent };
}

console.log('########## v1.9 双池实测（中盘 interval=10 / 终盘 interval=8 / 触发线 stamina<=60）##########');
console.log('注：以下只算「间隔驱动的重规划」，不含事件额度 6×4=24（事件归属哪个池 v1.9 未定，见结论）');
run('体力 400 · 四人 · 10 颗 · reject+minSep30', {});
run('体力 450 · 四人 · 10 颗 · reject+minSep30', { stamina: 450 });
run('体力 400 · 四人 · 5 颗 · reject+minSep30', { gemsPerColor: 1 });

// 事件额度归属两可：分别看加上之后破不破
console.log('\n########## 事件额度 6×4=24 归属的两种极端 ##########');
for (const st of [400, 450]) {
  const totMid = [], totEnd = [];
  for (let s = 0; s < GAMES; s++) {
    const r = simulateGame(5000 + s * 131, { nAgents: 4, stamina: st, placementMode: 'reject', thinKeep: 0.76, gemColors: 5, gemsPerColor: 2, minSep: 30, intervalEnd: 8 }); // 钉 8：历史口径
    if (r.invalid) continue;
    let m = 0, e = 0;
    for (const a of r.actors) { m += a.midCalls; e += a.endCalls; }
    totMid.push(m + 24); totEnd.push(e + 24);
  }
  console.log(`体力 ${st}: 事件全记常态池 → max ${Math.max(...totMid)} vs 328 ${Math.max(...totMid) > 328 ? '❌破' : '✅'} ; 事件全记终盘池 → max ${Math.max(...totEnd)} vs 32 ${Math.max(...totEnd) > 32 ? '❌破' : '✅'}`);
}
