import { buildPlan, CLIFF } from '../../src/render/env.js';
import { HALF_W, HALF_H, worldToTile } from '../../src/render/iso.js';

export const CATEGORIES = ['植物', '建筑', '人物', '杂物与车辆', '遗迹装饰', '地形', '程序绘制'];
export const SCENES = Object.freeze({
  east: '左上 · 东方古镇', west: '右上 · 童话村落', giant: '顶角 · 巨像遗迹',
  forestBack: '后方林带', forestFront: '前方林带 / 崖脚', cliff: '台地前沿土崖', whole: '整圈场外',
});
export const LAYERS = Object.freeze({ back: '后层（地图之前）', front: '前层（地图之后）', cliffs: '土崖层', ground: '地面底层', overlay: '场外叠加层' });
const LABELS = Object.freeze({
  TREE01: ['圆冠大树 · 深绿', '植物'], TREE02: ['圆冠树 · 青绿', '植物'],
  TREE03: ['圆冠小树', '植物'], TREE04: ['圆冠大树 · 林绿', '植物'], PINE01: ['层叠塔松', '植物'],
  BUSH01: ['无花灌木', '植物'], BUSH02: ['开花灌木', '植物'], ROCK01: ['苔藓石块', '遗迹装饰'],
  MAPLE01: ['红枫', '植物'], MAPLE02: ['橙枫', '植物'],
  TOWERE: ['东方望楼 · 有檐方塔', '建筑'], HOUSEE1: ['东方双层民居', '建筑'], HOUSEE2: ['东方铺面 · 条纹布篷', '建筑'],
  CASTLE: ['紫尖顶城堡', '建筑'], HOUSEW1: ['童话民居 · 橙顶', '建筑'], HOUSEW2: ['童话民居 · 蓝顶', '建筑'], HOUSEW3: ['童话民居 · 紫顶', '建筑'],
  STALL01: ['集市摊位 · 红篷', '建筑'], STALL02: ['集市摊位 · 青篷', '建筑'], STALL03: ['集市摊位 · 黄篷', '建筑'],
  FOLK01: ['村民 · 红袍草笠 / 挎篮', '人物'], FOLK02: ['村民 · 蓝袍布帽', '人物'], FOLK03: ['村民 · 黄袍发髻', '人物'],
  FOLK04: ['村民 · 绿袍草笠 / 扁担', '人物'], FOLK05: ['村民 · 紫袍头巾 / 挎篮', '人物'], FOLK06: ['村民 · 白袍布帽', '人物'],
  CART01: ['木制手推车', '杂物与车辆'], VAN01: ['废弃面包车', '杂物与车辆'], CAR01: ['废弃小轿车', '杂物与车辆'],
  GIANTHEAD: ['守林巨像 · 头部遗迹', '遗迹装饰'], GIANTHAND: ['守林巨像 · 巨手遗迹', '遗迹装饰'],
});

export function describe(name) {
  const key = name.replace(/^ENV_/, '').replace(/_na_00$/, '');
  const cliff = /^CLIFF_(SW|SE)(\d+)$/.exec(key);
  if (cliff) return { key, label: `${cliff[1] === 'SW' ? '左前沿' : '右前沿'}土崖 · 变体 ${Number(cliff[2])}`, category: '地形' };
  if (key === 'CLIFF_S') return { key, label: '南角土崖', category: '地形' };
  const [label, category] = LABELS[key] || [key, '遗迹装饰'];
  return { key, label, category };
}

export function createCatalog(atlas, size) {
  const plan = buildPlan(size, atlas.box);
  const position = (it, layer, index) => {
    const [wx, wy] = it.at || [it.wx, it.wy];
    const [gx, gy] = worldToTile(wx, wy);
    const scene = it.scene || (layer === 'cliffs' ? 'cliff' : layer === 'front' ? 'forestFront' : 'forestBack');
    return { name: it.name, index, wx, wy, gx, gy, scene, layer, depth: it.depth };
  };
  const placements = ['back', 'front', 'cliffs'].flatMap((layer) => plan[layer].map((it, i) => position(it, layer, i)));
  const assets = atlas.names().filter((name) => name.startsWith('ENV_')).map((name) => {
    const instances = placements.filter((it) => it.name === name);
    return { name, ...describe(name), kind: 'sprite', frame: atlas.frame(name), box: atlas.box(name), instances };
  });
  const procedure = (name, label, instances, description) => ({ name, key: name, label, category: '程序绘制', kind: 'procedure', instances, description });
  const at = (wx, wy, scene, layer, extra = {}) => ({ wx, wy, ...extra, scene, layer, gx: worldToTile(wx, wy)[0], gy: worldToTile(wx, wy)[1] });
  for (const [tone, label] of [['plaza', '古镇广场地色'], ['path', '村落土路地色'], ['meadow', '遗迹草甸地色']]) {
    assets.push(procedure(`GROUND_${tone}`, label, plan.clearings.filter((c) => c[4] === tone).map(([wx, wy, rx, ry]) => at(wx, wy, tone === 'plaza' ? 'east' : tone === 'path' ? 'west' : 'giant', 'ground', { rx, ry })), '柔边椭圆程序铺色，不是独立 PNG；坐标为椭圆中心，半径见位置表。'));
  }
  assets.push(procedure('CONTACT_SHADOW', '布景落地点柔影', placements.filter((p) => p.layer !== 'cliffs').map((p) => ({ ...p, host: p.name })), '每件后层 / 前层布景绘制一块柔影；不是新增物体，位置与宿主锚点一致。'));
  assets.push(procedure('EDGE_BAND', '后沿暗晕 / 崖脚暗带', [at(0, size * HALF_H / 2 - 2, 'whole', 'back', { band: 'back' }), at(0, size * HALF_H * 1.5 + CLIFF + 3, 'whole', 'front', { band: 'front' })], '沿两条后沿与两条前沿各画一道折线暗带；坐标是折线组的参考中心，不是精灵锚点。'));
  assets.push(procedure('GIANT_GLOW', '巨像琥珀眼辉光', plan.glows.map((p) => at(p.wx, p.wy, 'giant', 'overlay', { host: p.name })), '每个巨像发光点绘制上方辉光与地面反光，位置为巨像落地点；screen 叠加只影响地图之外。'));
  assets.push(procedure('VIGNETTE', '场外暗角', [], '一个随视口绘制的遮罩，不是世界物体，没有固定坐标；菱形地图内部被排除。'));
  for (const asset of assets) {
    asset.count = asset.name === 'VIGNETTE' ? 1 : asset.instances.length;
    asset.scenes = Object.entries(asset.instances.reduce((acc, p) => { acc[p.scene] = (acc[p.scene] || 0) + 1; return acc; }, {}));
  }
  let x0 = -size * HALF_W, y0 = -50, x1 = size * HALF_W, y1 = size * 2 * HALF_H + CLIFF;
  for (const p of placements) {
    const b = atlas.box(p.name);
    x0 = Math.min(x0, p.wx + b.l); x1 = Math.max(x1, p.wx + b.r);
    y0 = Math.min(y0, p.wy - b.t); y1 = Math.max(y1, p.wy + b.b);
  }
  return { size, plan, assets, placements, bounds: { x0, y0, x1, y1 } };
}

export function catalogCsv(catalog) {
  const rows = [['地图边长', '资产ID', '资产名称', '分类', '该种总数', '实例', '场景', '图层', '世界X(px)', '世界Y(px)', '投影格X', '投影格Y', '半径X', '半径Y', '宿主', '备注']];
  for (const a of catalog.assets) {
    for (const [i, p] of (a.instances.length ? a.instances : [null]).entries()) {
      rows.push([catalog.size, a.name, a.label, a.category, a.count, p ? i + 1 : '', p ? SCENES[p.scene] : '', p ? LAYERS[p.layer] : '', p?.wx ?? '', p?.wy ?? '', p?.gx ?? '', p?.gy ?? '', p?.rx ?? '', p?.ry ?? '', p?.host ?? '', a.description || '坐标为精灵落地点锚点；图内构件不另计数']);
    }
  }
  return '\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
