"""Blender 端渲染入口：读 Node 生成的任务清单，建模、摆姿势、逐张渲染 4× 原图到 raw 目录。

用法（由 tools/art/build.mjs 调用）：
  blender -b --factory-startup --python tools/art/blender/render.py -- <job.json>
"""
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

import common as C  # noqa: E402
import models as M  # noqa: E402

job = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8'))
SS = job['ss']
OUT = job['out']
ONLY = job.get('only') or []
os.makedirs(OUT, exist_ok=True)
P = job['palette']


def log(*a):
    print('ART', *a, flush=True)


sc = C.setup_scene(job.get('samples', 64))
cam = C.make_camera(sc)
C.make_world(sc, P['sky'], P['sky_strength'])
C.add_sun(sc, 'Key', P['sun_dir'], P['sun_energy'], P['sun_angle'], P['sun_color'])
ground = M.bounce_ground(P['ground_bounce'])
catcher = M.shadow_catcher()

actors = P['actors']
player = M.build_player({'cap': actors[0], 'body': C.mix_hex(actors[0], '#FFFFFF', 0.22), 'face': P['player_face']})
ai = M.build_ai(actors[1], C.mix_hex(actors[1], '#FFFFFF', 0.55))
k, width, ext = M.fit_rig(player, job['actor_top'])
ai.fit.scale = (k, k, k)
ai.pose('IDLE', 0, 's')
ai_top, ai_l, ai_r = M.projected_bounds(ai)
fit = {'scale': round(k, 4), 'playerWidth': round(width, 1), 'playerExtents': ext,
       'aiTop': round(ai_top, 1), 'aiWidth': round(ai_r - ai_l, 1)}
log('FIT', json.dumps(fit))

floors = [M.build_floor(i, P) for i in range(len(M.FLOOR_LAYOUTS))]
walls = [M.build_wall(i, P) for i in range(len(M.WALL_SPECS))]
for i, wl in enumerate(walls):
    t, l, r = M.tile_bounds(wl)
    log('TILE', f'WALL{i + 1:02d}', json.dumps({'top': t, 'left': l, 'right': r, 'px': M.WALL_SPECS[i]['px'],
                                               'fits': t <= 32 and l >= -32 and r <= 32}))
gems = M.build_gems(P['gems'])
for g in gems:
    log('FIT', f'GEM_{g.key}', json.dumps(g.fit()))
chest = M.Chest(P['chest'])
log('FIT', 'CHEST', json.dumps(chest.fit()))
exitpad = M.ExitPad()
decos = [M.build_deco(i, P) for i in range(3)]
for i, dc in enumerate(decos):
    t, l, r = M.tile_bounds(dc)
    log('TILE', f'DECO{i + 1:02d}', json.dumps({'top': t, 'left': l, 'right': r}))
hold_exit = M.holdout_plane('HoldExit', hole=M._squircle(M.EXIT_R[0]))
hold_flat = M.holdout_plane('HoldFlat')
envs = [(f'ENV_{s["key"]}_na_00', M.build_env(s, P)) for s in M.ENV_SPECS]
cliffs = [(f'ENV_CLIFF_{k}{v + 1:02d}_na_00', M.build_cliff(k, v, P)) for k in M.CLIFF_KINDS for v in range(M.CLIFF_VARIANTS)]
cliffs.append(('ENV_CLIFF_S_na_00', M.build_cliff('S', 0, P)))
log('FIT', 'CLIFF', json.dumps({'px': M.CLIFF_PX, 'z': round(M.CLIFF_Z, 4)}))

ROOTS = [player.fit, ai.fit, *floors, *walls, *(g.root for g in gems), chest.root, exitpad.root, *decos,
         *(r for _, r in envs), *(r for _, r in cliffs), hold_exit, hold_flat, ground, catcher]


def solo(*roots, camera=True, use_ground=True, use_catcher=False, catcher_size=30.0):
    for r in ROOTS:
        on = r in roots
        for o in C.descendants(r):
            o.hide_render = not on
            if o.type in ('MESH', 'CURVE') and r not in (hold_exit, hold_flat):
                o.visible_camera = camera
    for o in C.descendants(ground):
        o.hide_render = not use_ground
        o.visible_camera = False
    catcher.hide_render = not use_catcher
    catcher.visible_camera = True
    catcher.scale = (catcher_size / 30.0,) * 3
    # 眨眼帧隐藏的高光需要由 pose 恢复，这里不动


index_path = os.path.join(OUT, 'index.json')
index = {}
if ONLY and os.path.exists(index_path):
    index = {e['name']: e for e in json.load(open(index_path, encoding='utf-8'))['sprites']}


def want(name):
    return not ONLY or any(name.startswith(p) for p in ONLY)


def want_group(prefix):
    return not ONLY or any(p.startswith(prefix) or prefix.startswith(p) for p in ONLY)


def render(name, w, h, ax, ay, group, **extra):
    C.frame_camera(sc, cam, w, h, ax, ay, SS)
    sc.render.filepath = os.path.join(OUT, name + '.png')
    t = time.time()
    bpy.ops.render.render(write_still=True)
    ms = round((time.time() - t) * 1000)
    index[name] = {'name': name, 'w': w, 'h': h, 'ax': ax, 'ay': ay, 'group': group, 'ms': ms, **extra}
    log('R', name, ms)


T0 = time.time()
AW, AH, AAX, AAY = job['actor_canvas']

# ---- 地形 ----
for i, fl in enumerate(floors):
    n = f'TIL_FLOOR{i + 1:02d}_na_00'
    if want(n):
        solo(fl)
        render(n, 64, 64, 32, 32, 'tile')
for i, wl in enumerate(walls):
    n = f'TIL_WALL{i + 1:02d}_na_00'
    if want(n):
        solo(wl)
        render(n, 64, 64, 32, 32, 'tile')
# 墙投影按变体各一张（高度 / 顶上植物不同，影子长短与轮廓也不同）
for i, wl in enumerate(walls):
    n = f'SHD_WALL{i + 1:02d}_na_00'
    if want(n):
        solo(wl, camera=False, use_ground=False, use_catcher=True)
        render(n, 96, 64, 32, 32, 'shadow')
index.pop('SHD_WALL_na_00', None)

# 出口：4 座位色同一模型，只换材质色；挖空地面把地下侧壁抠掉，叠在任意地面变体上
EXIT_KEYS = ('P', 'A', 'B', 'C')
for i, key in enumerate(EXIT_KEYS):
    n = f'TIL_EXIT_{key}_na_00'
    if want(n):
        exitpad.color(actors[i], P.get('exit_rim_k', [[1, 1, 1]] * 4)[i])
        solo(exitpad.root, hold_exit)
        render(n, 64, 64, 32, 32, 'tile')
# 地面装饰：本体（埋进地下的部分被挖空地面抠掉）+ 接触阴影（打包时垫在下面合成一张）
for i, dc in enumerate(decos):
    n = f'TIL_DECO{i + 1:02d}_na_00'
    s = f'SHD_DECO{i + 1:02d}_na_00'
    if want(n):
        solo(dc, hold_flat)
        render(n, 64, 64, 32, 32, 'tile', under=s)
    if want(n) or want(s):
        solo(dc, camera=False, use_ground=False, use_catcher=True, catcher_size=1.0)
        render(s, 64, 64, 32, 32, 'shadow', merge=True)

# ---- 场外布景（单独打成 env 图集，非首屏）：画布按屏幕包围盒自动定，锚点 = 落地点 / 格心 ----
# 场外地面是深绿林地：反照地面换成深绿（树冠底面不再泛奶油色）；土崖低到 -CLIFF_Z，反照地面要压到它下面（见 bounce_ground 的 ⚠）
def fit_canvas(root, pad=2):
    l, r, b, t = M.bounds2d(C.descendants(root))
    ax, ay = math.ceil(-l) + pad, math.ceil(t) + pad
    return ax + math.ceil(r) + pad, ay + math.ceil(-b) + pad, ax, ay


bounce_mat = ground.data.materials[0]
if want_group('ENV_'):
    C.set_base_color(bounce_mat, P['env']['floor'])
    for n, rt in envs + cliffs:
        if not want(n):
            continue
        ground.location.z = -M.CLIFF_Z - 0.06 if n.startswith('ENV_CLIFF') else -0.16
        w, h, ax, ay = fit_canvas(rt)
        log('TILE', n, json.dumps({'w': w, 'h': h, 'ax': ax, 'ay': ay}))
        solo(rt)
        render(n, w, h, ax, ay, 'env')
    ground.location.z = -0.16
    C.set_base_color(bounce_mat, P['ground_bounce'])

# ---- 角色 ----
SEQ = job['frames']  # {"player": {"IDLE": 4, "MOVE": 4}, "ai": {...}}
DIRS = ('n', 'e', 's', 'w')


TOP_LIMIT = AAY - 1.0  # 画布顶留 1px 给渲染层描边
clamped = {}


def clamp_top(rig, name):
    """拉伸帧（起跳 / 万岁 / 一僵）的帽顶可能顶出画布：按超出比例压回根节点的竖向缩放（绕脚下，脚不动）。"""
    top, _, _ = M.projected_bounds(rig)
    if top <= TOP_LIMIT:
        return
    for _ in range(3):
        sx, sy, sz = rig.root.scale
        rig.root.scale = (sx, sy, sz * TOP_LIMIT / top)
        top, _, _ = M.projected_bounds(rig)
        if top <= TOP_LIMIT:
            break
    clamped[name] = round(top, 1)


def actor_set(rig, prefix, kind):
    for state, count in SEQ[kind].items():
        for d in DIRS:
            for f in range(count):
                n = f'ACT_{prefix}_{state}_{d}_{f:02d}'
                if not want(n):
                    continue
                rig.pose(state, f, d)
                clamp_top(rig, n)
                solo(rig.fit)
                render(n, AW, AH, AAX, AAY, 'actor')


actor_set(player, 'PLAYER', 'player')
if want('SHD_PLAYER'):
    player.pose('IDLE', 0, 's')
    solo(player.fit, camera=False, use_ground=False, use_catcher=True)
    render('SHD_PLAYER_na_00', 96, AH, AAX, AAY, 'shadow')

for seat, key in ((1, 'AIA'), (2, 'AIB'), (3, 'AIC')):
    if not want_group(f'ACT_{key}') and not (seat == 1 and want('SHD_AI')):
        continue
    C.set_base_color(ai.mats['body'], actors[seat])
    C.set_base_color(ai.mats['belly'], C.mix_hex(actors[seat], '#FFFFFF', 0.55))
    actor_set(ai, key, 'ai')
    if seat == 1 and want('SHD_AI'):
        ai.pose('IDLE', 0, 's')
        solo(ai.fit, camera=False, use_ground=False, use_catcher=True)
        render('SHD_AI_na_00', 96, AH, AAX, AAY, 'shadow')

# ---- 宝石（4 帧：悬浮 0/1/2/1 px + 小幅转动带出高光移动） ----
for g in gems:
    for f in range(4):
        n = f'PRP_GEM_{g.key}_na_{f:02d}'
        if not want(n):
            continue
        g.pose(f)
        solo(g.root)
        render(n, 64, 64, 32, 56, 'prop')
    n = f'SHD_GEM_{g.key}_na_00'
    if want(n):
        g.pose(0)
        solo(g.root, camera=False, use_ground=False, use_catcher=True)
        render(n, 64, 64, 32, 56, 'shadow')
index.pop('SHD_GEM_na_00', None)

# ---- 宝箱（8 帧） ----
for f in range(8):
    n = f'PRP_CHEST_na_{f:02d}'
    if not want(n):
        continue
    chest.pose(f)
    solo(chest.root)
    render(n, 64, 64, 32, 56, 'prop')
if want('SHD_CHEST'):
    chest.pose(0)
    solo(chest.root, camera=False, use_ground=False, use_catcher=True)
    render('SHD_CHEST_na_00', 64, 64, 32, 56, 'shadow')

if clamped:
    log('CLAMP', json.dumps(clamped))
meta = {'ss': SS, 'samples': job.get('samples', 64), 'fit': fit, 'blender': bpy.app.version_string,
        'totalSec': round(time.time() - T0, 1)}
json.dump({'meta': meta, 'sprites': sorted(index.values(), key=lambda e: e['name'])},
          open(index_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
log('DONE', json.dumps(meta))
