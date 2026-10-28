// 手动输入（SPEC §9.1）：方向键 / WASD / 斜向键 → 网格方向意图；按住 = 按当前倍速节拍连续走（由调度器在每回合末查询 held()）。
// 方向映射（SPEC O7，灰盒 A/B）：等距视图里没有正上方的网格方向，箭头键只能二选一地转 45°：
//   grid  （默认）↑=N 右上  →=E 右下  ↓=S 左下  ←=W 左上
//   screen         ↑=W 左上  →=N 右上  ↓=E 右下  ←=S 左下
// 斜向键与映射无关，永远按屏幕方向：Q / 小键盘7 = 左上(W)  E / 9 = 右上(N)  C / 3 = 右下(E)  Z / 1 = 左下(S)。
// 原地等一回合：空格 / 小键盘5 / 句号。

export const MAPPINGS = Object.freeze({
  grid: Object.freeze({ up: 'N', right: 'E', down: 'S', left: 'W', label: '网格方向（↑ = 右上）' }),
  screen: Object.freeze({ up: 'W', right: 'N', down: 'E', left: 'S', label: '屏幕方向（↑ = 左上）' }),
});

const ARROWS = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowRight: 'right', KeyD: 'right',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
};
const DIAGONAL = {
  KeyQ: 'W', Numpad7: 'W',
  KeyE: 'N', Numpad9: 'N',
  KeyC: 'E', Numpad3: 'E',
  KeyZ: 'S', Numpad1: 'S',
};
const WAIT = new Set(['Space', 'Numpad5', 'Period', 'NumpadDecimal']);

/** 键码 → 'N'|'E'|'S'|'W'|'STAY'|null（纯函数，测试用）。 */
export function dirOfCode(code, mapping = 'grid') {
  if (WAIT.has(code)) return 'STAY';
  if (code in DIAGONAL) return DIAGONAL[code];
  const a = ARROWS[code];
  return a ? MAPPINGS[mapping][a] : null;
}

/**
 * @param {EventTarget} target 一般是 window
 * @param {{onDir:(dir:string)=>void, onKey?:(e:KeyboardEvent)=>void, mapping?:string, holdDelayMs?:number}} handlers
 *   onDir：新按下的方向（不含系统连发）；onKey：其余按键交给调用方（倍速 / 缩放等）
 *   holdDelayMs：按下多久才算「按住」——短按只走一步（2× 下一步动画 100 ms，比一次轻点还短，不设门槛会走两步）
 */
export function createInput(target, { onDir, onKey, mapping = 'grid', holdDelayMs = 170 }) {
  let map = MAPPINGS[mapping] ? mapping : 'grid';
  const held = []; // 按下顺序的方向键码（最新在末尾）；松开即移除
  const downAt = new Map(); // 键码 → 按下时刻（event.timeStamp，与 performance.now 同一时基）
  const isTyping = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  const down = (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const d = dirOfCode(e.code, map);
    if (!d) {
      if (onKey) onKey(e);
      return;
    }
    e.preventDefault();
    if (e.repeat) return; // 连发交给 held()，不灌缓冲
    if (d !== 'STAY') {
      const k = held.indexOf(e.code);
      if (k >= 0) held.splice(k, 1);
      held.push(e.code);
      downAt.set(e.code, e.timeStamp);
    }
    onDir(d);
  };
  const up = (e) => {
    const k = held.indexOf(e.code);
    if (k >= 0) held.splice(k, 1);
    downAt.delete(e.code);
  };
  const clear = () => {
    held.length = 0;
    downAt.clear();
  };

  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', clear);

  return {
    /** 当前按住（已过 holdDelayMs）的方向：最后按下且未松开的那个，没有则 null。 */
    held(now) {
      if (!held.length) return null;
      const code = held[held.length - 1];
      if (now !== undefined && now - downAt.get(code) < holdDelayMs) return null;
      return dirOfCode(code, map);
    },
    get mapping() { return map; },
    setMapping(m) {
      if (MAPPINGS[m]) map = m;
    },
    dispose() {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', clear);
    },
  };
}
