// 音效（2026-11-09）：全部用 WebAudio 现场合成，不带任何音频文件（不占体积预算、CSP 下 default-src 'self' 也不受影响）。
//   gem 宝石叮（五色各一个音高，五声音阶）· set 凑齐一套的上行琶音 · chestScore 开箱吱呀 + 金币叮当 · chestStamina 开箱 + 暖和弦上扬
//   escape 到达出口的小号角 · fail 体力耗尽的下行两音 · bump 撞墙闷响
// 浏览器要求用户手势后才能出声：首次按键 / 点击时 resume。开关与音量记在本机（maze.sfx.v1）。
// 别人的事件音量减半；按镜头左右做一点立体声定位。

const KEY = 'maze.sfx.v1';
const PENTA = [1046.5, 1174.7, 1318.5, 1568.0, 1760.0]; // C6 D6 E6 G6 A6：红黄绿蓝紫

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p && typeof p.on === 'boolean') return { on: p.on, vol: Number.isFinite(p.vol) ? Math.min(1, Math.max(0, p.vol)) : 0.7 };
  } catch { /* 隐私模式 */ }
  return { on: true, vol: 0.7 };
}

export function createSfx({ now = () => performance.now() } = {}) {
  const prefs = loadPrefs();
  let ac = null;
  let master = null;
  let noiseBuf = null;

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch { /* 隐私模式 */ }
  };

  function ensure() {
    if (ac) return ac;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = prefs.vol;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp);
    comp.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let x = 2463534242;
    for (let i = 0; i < d.length; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      d[i] = ((x >>> 0) / 4294967296) * 2 - 1;
    }
    return ac;
  }

  // ---------- 合成积木 ----------

  /** 一个音：振荡器 + 包络（attack / decay），可滑音。 */
  function tone(out, t, { f, f2 = null, type = 'sine', a = 0.004, d = 0.3, vol = 0.3, detune = 0 }) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    o.detune.value = detune;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + a + d + 0.05);
  }

  /** 一段滤波噪声（吱呀 / 尘土 / 闪光的嘶声）。 */
  function noise(out, t, { dur = 0.2, f = 2000, f2 = null, q = 1, type = 'bandpass', vol = 0.2, a = 0.01 }) {
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    const fl = ac.createBiquadFilter();
    fl.type = type;
    fl.frequency.setValueAtTime(f, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    fl.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl);
    fl.connect(g);
    g.connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  const SOUNDS = {
    gem(out, t, c = 0) {
      const f = PENTA[c % PENTA.length];
      tone(out, t, { f, type: 'triangle', d: 0.32, vol: 0.32 });
      tone(out, t + 0.07, { f: f * 1.5, type: 'sine', d: 0.38, vol: 0.2 });
      tone(out, t, { f: f * 4, type: 'sine', d: 0.12, vol: 0.05 });
      noise(out, t, { dur: 0.16, f: 9000, q: 0.8, type: 'highpass', vol: 0.05 });
    },
    set(out, t, c = 0) {
      SOUNDS.gem(out, t, c);
      [523.3, 659.3, 784.0, 1046.5, 1318.5].forEach((f, i) => tone(out, t + 0.1 + i * 0.075, { f, type: 'triangle', d: 0.4, vol: 0.2 }));
      tone(out, t + 0.5, { f: 2093, type: 'sine', d: 0.6, vol: 0.08 });
      noise(out, t + 0.1, { dur: 0.6, f: 7000, q: 0.6, type: 'highpass', vol: 0.05 });
    },
    creak(out, t) {
      noise(out, t, { dur: 0.22, f: 420, f2: 900, q: 9, vol: 0.18 });
      tone(out, t, { f: 180, f2: 240, type: 'sawtooth', d: 0.18, vol: 0.03 });
    },
    chestScore(out, t) {
      SOUNDS.creak(out, t);
      [1568, 2093, 1760, 2349, 2637].forEach((f, i) => {
        tone(out, t + 0.16 + i * 0.06, { f, type: 'square', d: 0.09, vol: 0.05 });
        tone(out, t + 0.16 + i * 0.06, { f: f * 2.01, type: 'sine', d: 0.18, vol: 0.06 });
      });
    },
    chestStamina(out, t) {
      SOUNDS.creak(out, t);
      [392, 494, 587].forEach((f, i) => tone(out, t + 0.15, { f, f2: f * 1.5, type: 'sine', d: 0.55, vol: 0.12, detune: i * 4 }));
      noise(out, t + 0.15, { dur: 0.5, f: 600, f2: 3000, q: 0.7, vol: 0.06 });
    },
    escape(out, t) {
      [523.3, 659.3, 784.0, 1046.5].forEach((f, i) => {
        tone(out, t + i * 0.11, { f, type: 'sawtooth', d: i === 3 ? 0.55 : 0.14, vol: 0.07 });
        tone(out, t + i * 0.11, { f, type: 'triangle', d: i === 3 ? 0.6 : 0.16, vol: 0.16 });
      });
    },
    fail(out, t) {
      tone(out, t, { f: 392, f2: 370, type: 'triangle', d: 0.28, vol: 0.18 });
      tone(out, t + 0.26, { f: 294, f2: 220, type: 'triangle', d: 0.5, vol: 0.18 });
      noise(out, t + 0.1, { dur: 0.5, f: 500, f2: 200, q: 0.8, type: 'lowpass', vol: 0.08 });
    },
    bump(out, t) {
      tone(out, t, { f: 120, f2: 60, type: 'sine', d: 0.12, vol: 0.28 });
      noise(out, t, { dur: 0.07, f: 1400, q: 1.2, vol: 0.08 });
    },
  };

  return {
    get on() { return prefs.on; },
    get volume() { return prefs.vol; },
    /** 用户手势里调用：解锁 AudioContext。 */
    unlock() {
      if (!prefs.on) return;
      const a = ensure();
      if (a && a.state === 'suspended') a.resume();
    },
    toggle() {
      prefs.on = !prefs.on;
      save();
      if (prefs.on) this.unlock();
      else if (ac && ac.state === 'running') ac.suspend();
      return prefs.on;
    },
    setVolume(v) {
      prefs.vol = Math.min(1, Math.max(0, v));
      if (master) master.gain.value = prefs.vol;
      save();
    },
    /**
     * 播一个音效。at = 与 performance.now() 同一时基的毫秒（特效那一刻）；pan ∈ [-1, 1]；gain 相对音量。
     */
    play(name, { at = null, pan = 0, gain = 1, c = 0 } = {}) {
      if (!prefs.on || !SOUNDS[name]) return false;
      const a = ensure();
      if (!a || a.state !== 'running') return false;
      const delay = at === null ? 0 : Math.max(0, (at - now()) / 1000);
      if (delay > 3) return false;
      const t = a.currentTime + delay + 0.01;
      const g = a.createGain();
      g.gain.value = gain;
      const p = a.createStereoPanner ? a.createStereoPanner() : null;
      if (p) {
        p.pan.value = Math.max(-1, Math.min(1, pan));
        g.connect(p);
        p.connect(master);
      } else g.connect(master);
      SOUNDS[name](g, t, c);
      return true;
    },
  };
}
