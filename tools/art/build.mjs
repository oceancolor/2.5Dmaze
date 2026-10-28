// 美术管线入口：生成任务清单 → 无头 Blender 渲染 4× 原图 → 打包图集。
// 用法：node tools/art/build.mjs [--only 前缀1,前缀2] [--samples 64] [--no-render] [--no-pack]
// Blender 路径：环境变量 BLENDER，默认 D:\Blender\blender-4.2.0-windows-x64\blender.exe
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTOR_COLORS, GEM_COLORS_BASE, CHEST_PALETTES } from '../../src/render/palette.js';
import { packAll, RAW } from './pack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLENDER = process.env.BLENDER || 'D:\\Blender\\blender-4.2.0-windows-x64\\blender.exe';
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(k);

/** 美术参数（座位色 / 宝石色取自 src/render/palette.js，保证与运行时同一常量表）。 */
export const ART = {
  actors: [...ACTOR_COLORS],
  gems: [...GEM_COLORS_BASE],
  player_face: '#FFF1E6',
  // 地面：同一种奶油石（每块在 slab ↔ slab_alt 间取一点点色差），细缝暖灰，嵌石略深一档
  slab: '#F7F3EE', slab_alt: '#F2EDE5',
  grout: '#D3C6B2',
  pebble: '#E8DED0',
  // 绿篱（植绒软陶：脚下 → 顶面竖直渐变 + Sheen 绒光 + Voronoi 叶团起伏）。
  // 深浅三档 = 开心果 / 嫩芽 / 叶绿，修剪球用薄荷绿。
  // ⚠ 各档顶面亮端都压在 V ≤ 196（0xC4）：地面 V≈240，需求 #7 要 ΔV ≥ 40。「马卡龙」靠干净色相 + 绒光，不靠提亮。
  hedge: {
    light: ['#72B65C', '#9ACE7A'],
    mid: ['#62AE5A', '#86C46E'],
    deep: ['#3E9052', '#76BE70'],
    cool: ['#7ACA9E', '#B2E8C8'],
  },
  hedge_sheen: '#F1FFE9',
  flower_pink: '#FFC6D6', flower_heart: '#FFD45A',
  hydrangea: ['#FFC3D5', '#FFDCE6', '#F9AFC8', '#FFF1F4'],
  clover: ['#86C860', '#B4E07E'],
  // 宝箱（03 未定配色，取样张页默认 K1 胡桃木 + 哑金；线脚用场景哑金，避开光环金 #FFD84D）
  chest: {
    wood: CHEST_PALETTES[0].top, lid: '#9A6440', trim: CHEST_PALETTES[0].trim, lock: CHEST_PALETTES[0].lock,
    inner: '#5E574C', coin: '#F2C85A', glow: '#FFE7A0',
  },
  // 出口外圈材质色逐通道（线性）补偿：渲染后顶面 ≈ ACTOR_COLORS 常量（按 .cache/art/measure_assets.mjs 实测回填）。
  // 暖色天光 / 太阳让蓝通道系统性偏低约 13%，四座位一致
  exit_rim_k: [[1, 1.03, 1.13], [1, 1.03, 1.14], [1, 1.05, 1.14], [1, 1.05, 1.14]],
  // 地面装饰：草 / 苔藓比绿篱浅一大档、偏黄（不能读成一截矮墙），花瓣粉白，卵石比石板深一档
  deco_grass: ['#8CC56C', '#C4E49E'],
  deco_petals: ['#FFD3DF', '#FFFFFF', '#FFC0D2'],
  deco_moss: ['#A6CD74', '#D5EBAA'],
  deco_pebbles: ['#D4C8B8', '#BFB2A1'],
  // 场外布景（菱形之外）：比绿篱暗一大档、偏冷（远处的林子读作背景，把地图托出来）；土崖暖棕三层，顶上一道深一点的草皮卷边
  env: {
    canopy: {
      a: ['#26502E', '#4E8847'],
      b: ['#214B3E', '#427E62'],
      c: ['#1F432B', '#3E743E'],
      pine: ['#1B3F33', '#336A50'],
      bush: ['#2F5E35', '#5A9449'],
    },
    sheen: '#B9D4B2',
    trunk: '#6A4A36',
    flowers: ['#F4F0E6', '#F3C2CF'],
    rock: ['#5F5C55', '#6E6960'],
    floor: '#2E4A2C',
    cliff: {
      bands: ['#B27C52', '#8E5B3B', '#6A412C'],
      lip: ['#3C7240', '#5E984E'],
      stone: ['#9C907E', '#857A6A'],
      sheen: '#F2D9C2',
    },
    // 地标（左上 / 右上场外的小屋 / 圆木塔 / 石堆 / 发光玉石；造型参照用户给的童话村落 + 低多边形小景参考图）：
    // 奶油灰泥墙 + 粗木构件 + 鱼鳞瓦（红 / 橙 / 灰蓝三色错开），石色比林子里的石块浅一档；
    // 场外只留三种亮点：窗光（暖）+ 玉石（冷薄荷，偏青，与绿宝石 #3FBF6A 错开）+ 小屋的奶油墙
    plaster: '#CDBE9C',
    wood: { timber: '#7A5236', honey: '#B58450', dark: '#3A281D', door: '#6A4530', frame: '#C8AA82' },
    roof: { a: '#B4523F', b: '#C27A3E', c: '#7C9DB0' },
    window: '#FFC978',
    stone: ['#A0968A', '#887E71', '#6E665B'],
    jade: { body: '#4CC7A0', deep: '#1E8E6C', glow: '#A4F5D8', emit: 1.0 },
  },
  // 光（tools/art 标定：天空 1 → 顶面 1.0；太阳 1 → 顶面 0.28）。
  // 天空 0.69 + 太阳 1.09 + 地面反照 ≈0.8 ⇒ 顶 / 左 / 右 ≈ 1.00 / 0.86 / 0.70，与 03 §1.6 的三档系数一致。
  sky: '#FFFBF4', sky_strength: 0.69,
  sun_dir: [-0.405, -0.253, 0.878], sun_energy: 1.09, sun_angle: 18, sun_color: '#FFF6E8',
  ground_bounce: '#EBE4D9',
};

const job = {
  ss: 4,
  samples: Number(arg('--samples', 64)),
  out: RAW,
  only: (arg('--only', '') || '').split(',').filter(Boolean),
  actor_top: 53,
  actor_canvas: [64, 64, 32, 56],
  frames: {
    player: { IDLE: 4, MOVE: 4, PICK: 3, BLOCK: 2, DEAD: 2 },
    ai: { IDLE: 2, MOVE: 4, PICK: 2, BLOCK: 1, DEAD: 1 },
  },
  palette: ART,
};

function runBlender() {
  if (!existsSync(BLENDER)) throw new Error(`找不到 Blender：${BLENDER}（可设环境变量 BLENDER）`);
  mkdirSync(RAW, { recursive: true });
  const jobPath = join(ROOT, '.cache', 'art', 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 1));
  const script = join(ROOT, 'tools', 'art', 'blender', 'render.py');
  return new Promise((resolve, reject) => {
    const p = spawn(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', jobPath], { cwd: ROOT });
    let tail = '';
    const onData = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-6000);
      for (const ln of s.split(/\r?\n/)) {
        if (ln.startsWith('ART ') || /Error|Traceback/.test(ln)) console.log(ln);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Blender 退出码 ${code}\n${tail}`))));
  });
}

if (!has('--no-render')) {
  const t = Date.now();
  await runBlender();
  console.log(`渲染完成 ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
if (!has('--no-pack')) console.log(JSON.stringify(packAll(), null, 1));
