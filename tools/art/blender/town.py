"""场外大景（2026-11-09 美术批次）：按用户参考图重做的建筑、人物 / 车辆点缀、巨像遗迹。

参考：
  建筑尺度与风格 1  东方古镇：粗石砌的高望楼 + 上层木构外廊 + 深灰筒瓦四坡顶；白墙灰瓦的民居、集市摊位、红枫
  建筑尺度与风格 2  童话村落：石砌底层 + 木骨架灰泥上层、陡坡彩色屋顶（橙红 / 蓝 / 紫）、紫尖顶城堡
  雕塑尺度 1        半埋在林间空地里的巨大头像（这里换成原创的「守林巨像」机器人头 + 一只巨手，参考天空之城的机器人气质，不照抄）

尺度（屏幕像素，z 为世界高度，上屏 ×0.866）：点缀人物身高 ≈ 21（游戏角色 ≈ 50，场外世界是「远处的小镇」）；
按参考图的比例，民居 ≈ 4–5 个人高、望楼 ≈ 10 个人高、城堡主塔 ≈ 12 个人高、巨像头 ≈ 10 个人高。
朝向沿用管线约定：镜头在 +x、-y 一侧，-y 面迎光、+x 面背光；锚点 = 落地中心。
"""
import math

from mathutils import Matrix, Vector

import common as C
import models as M

U = M.U
V = M.V
ell = M.ell
_log = M._log
_blk = M._blk
_panel = M._panel
_extrude = M._extrude
_lathe = M._lathe
_frame = M._frame

X_AX, Y_AX, Z_AX = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
FRONT_N = Vector((0, -1, 0))  # -y 面（迎光）
SIDE_N = Vector((1, 0, 0))    # +x 面（背光）


# ---------- 材质 ----------

def _mats(key, pal):
    env = pal['env']
    t = env['town']
    return {
        'plaster': C.stone(f'{key}_plaster', t['plaster_e'], speck_amount=0.025, rough=0.85, bump=0.04),
        'plaster_w': C.stone(f'{key}_plaster_w', t['plaster_w'], speck_amount=0.02, rough=0.85, bump=0.03),
        'rubble': C.stone(f'{key}_rubble', t['stone_e'][0], speck_amount=0.07, rough=0.75, bump=0.16),
        'stone': C.stone(f'{key}_stone', t['stone_e'][1], speck_amount=0.05, rough=0.7, bump=0.1),
        'castle': C.stone(f'{key}_castle', t['castle'][0], speck_amount=0.05, rough=0.72, bump=0.1),
        'castle2': C.stone(f'{key}_castle2', t['castle'][1], speck_amount=0.05, rough=0.72, bump=0.1),
        'wood': C.principled(f'{key}_wood', t['wood_e'], rough=0.75, spec=0.25),
        'wood2': C.principled(f'{key}_wood2', t['wood_e2'], rough=0.7, spec=0.3),
        'timber': C.principled(f'{key}_timber', t['timber_w'], rough=0.7, spec=0.3),
        'tile': C.principled(f'{key}_tile', t['tile_e'], rough=0.6, spec=0.35),
        'tiledk': C.principled(f'{key}_tiledk', C.mix_hex(t['tile_e'], '#101418', 0.4), rough=0.65, spec=0.3),
        'tilehi': C.principled(f'{key}_tilehi', t['tile_e_hi'], rough=0.55, spec=0.4),
        'glow': C.principled(f'{key}_glow', env['window'], rough=0.4, emit=1.3, emit_color=env['window']),
        'dark': C.principled(f'{key}_dark', '#231C17', rough=0.9, spec=0.15),
        'glass': C.principled(f'{key}_glass', '#3A4E5C', rough=0.15, spec=0.7, coat=0.4),
        'leaf': C.felt(f'{key}_leaf', *env['canopy']['bush'], 14 * U, z_low=0.0, sheen=0.6, sheen_tint=env['sheen'], bump=0.14),
        'moss': C.felt(f'{key}_moss', *env['town']['moss'], 200 * U, z_low=0.0, sheen=0.5, sheen_tint=env['sheen'], bump=0.12),
        'skin': C.principled(f'{key}_skin', t['skin'], rough=0.6, spec=0.3),
        'hair': C.principled(f'{key}_hair', t['hair'], rough=0.7, spec=0.3),
        'straw': C.principled(f'{key}_straw', t['straw'], rough=0.8, spec=0.2),
        'water': C.principled(f'{key}_water', t['water'], rough=0.08, spec=0.8, coat=0.6, emit=0.25, emit_color=t['water']),
        'flower': C.principled(f'{key}_flower', env['flowers'][1], rough=0.5, spec=0.3),
    }


def _color(key, hexc, rough=0.55):
    return C.vinyl(f'{key}', hexc, rough=rough)


def _patina(name, c_a, c_b, rust, scale=5.0):
    """铜绿：两档青绿 + 锈斑（物体坐标噪声），带一点金属感与凹凸。"""
    m = C.principled(name, c_a, rough=0.5, spec=0.5, metallic=0.2)
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.36
    ramp.color_ramp.elements[0].color = C.rgb(c_a)
    ramp.color_ramp.elements[1].position = 0.6
    ramp.color_ramp.elements[1].color = C.rgb(c_b)
    e = ramp.color_ramp.elements.new(0.74)
    e.color = C.rgb(rust)
    nt.links.new(C._noise(nt, tc.outputs['Object'], scale, 4.0, 0.62), ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    bmp = nt.nodes.new('ShaderNodeBump')
    bmp.inputs['Strength'].default_value = 0.12
    bmp.inputs['Distance'].default_value = 0.006
    nt.links.new(C._noise(nt, tc.outputs['Object'], 30.0, 3.0, 0.6), bmp.inputs['Height'])
    nt.links.new(bmp.outputs['Normal'], b.inputs['Normal'])
    return m


def _onto(name, p, n, radii, mat, parent, seg=18, rings=9):
    """贴在表面上的扁椭球（苔藓 / 锈斑 / 铆钉）：薄轴沿法线 n。"""
    u, v, n = _frame(n)
    return ell(name, radii, tuple(p), mat, parent, quat=Matrix((u, v, n)).transposed().to_quaternion(), seg=seg, rings=rings)


def _rwin(key, c, u, n, w, h, m, parent, glow=True, bars=True, shutters=None):
    """方窗：窗框 + 玻璃（暖光或深色）+ 十字窗棂；shutters = 百叶窗材质（两侧各一扇）。"""
    _panel(f'{key}_f', c + n * 0.3, u, n, w + 2.2, h + 2.2, 1.2, m['wood2'], parent, bevel=0.3)
    _panel(f'{key}_g', c + n * 0.9, u, n, w, h, 0.6, m['glow'] if glow else m['dark'], parent, bevel=0)
    if bars:
        _panel(f'{key}_v', c + n * 1.3, u, n, 0.9, h, 0.5, m['wood2'], parent, bevel=0)
        _panel(f'{key}_h', c + n * 1.3, u, n, w, 0.9, 0.5, m['wood2'], parent, bevel=0)
    if shutters is not None:
        for s in (-1, 1):
            _panel(f'{key}_s{s}', c + u * (s * (w / 2 + 2.6)) + n * 0.6, u, n, 3.4, h + 1.5, 0.8, shutters, parent, bevel=0.3)


def _lattice(key, c, u, n, w, h, m, parent):
    """东方格窗：深框 + 浅色窗纸（微亮）+ 竖棂。"""
    _panel(f'{key}_f', c + n * 0.3, u, n, w + 2.0, h + 2.0, 1.1, m['wood'], parent, bevel=0.2)
    _panel(f'{key}_p', c + n * 0.85, u, n, w, h, 0.5, m['glow'], parent, bevel=0)
    k = max(2, int(w / 2.6))
    for i in range(1, k):
        _panel(f'{key}_b{i}', c + u * (-w / 2 + w * i / k) + n * 1.2, u, n, 0.7, h, 0.4, m['wood'], parent, bevel=0)


def _rect_door(key, base, u, n, w, h, m, parent, mat=None):
    """方门：门框 + 门板（两道横带）。base = 墙面上门底中点。"""
    _panel(f'{key}_df', base + n * 0.4 + Vector((0, 0, h / 2 + 0.6)), u, n, w + 2.6, h + 1.3, 1.2, m['wood'], parent, bevel=0.3)
    _panel(f'{key}_dd', base + n * 1.0 + Vector((0, 0, h / 2)), u, n, w, h, 0.8, mat or m['wood2'], parent, bevel=0.2)
    for i, z in enumerate((h * 0.3, h * 0.66)):
        _panel(f'{key}_db{i}', base + n * 1.5 + Vector((0, 0, z)), u, n, w - 1.0, 0.9, 0.4, m['dark'], parent, bevel=0)


def _gable_roof(key, hx, zw, wy, pitch, T, X, eave, slab_mat, rows_mat, parent, rows='tube', front_only=True, row_gap=4.2):
    """沿 x 的双坡顶：两块厚底板 + 迎光坡（-y）上铺瓦。rows = 'tube'（东方筒瓦，沿坡向）或 'shingle'（西式鱼鳞 / 木瓦，沿屋脊方向一排排）。
    返回 (屋顶底面在屋脊处的点 apex, 坡长 L, 坡角 th, 屋脊高 zu)。"""
    th = math.radians(pitch)
    tn = math.tan(th)
    zu = zw + wy * tn
    L = (wy + eave) / math.cos(th)
    apex = Vector((0, 0, zu))
    for s in (-1, 1):
        down = Vector((0, s * math.cos(th), -math.sin(th)))
        nv = Vector((0, s * math.sin(th), math.cos(th)))
        _blk(f'{key}_roof{s}', (2 * X, L + 2.0, T), tuple(apex + down * (L / 2 - 1.0) + nv * (T / 2)), slab_mat, parent, bevel=1.0,
             euler=(math.degrees(-s * th), 0, 0))
        if s > 0 and front_only:
            continue
        if rows == 'tube':
            k = int(2 * X / row_gap)
            for i in range(k + 1):
                x = -X + 1.2 + (2 * X - 2.4) * i / k
                a = apex + down * (L - 0.4) + X_AX * x + nv * (T + 0.9)
                b = apex + down * 1.2 + X_AX * x + nv * (T + 0.9)
                _log(f'{key}_tr{s}_{i}', a, b, 1.25, rows_mat, parent, seg=8, bev=0)
        else:
            t = L - 1.0
            i = 0
            while t > 2.5:
                _blk(f'{key}_sh{s}_{i}', (2 * X - 0.6, 3.6, 1.1), tuple(apex + down * t + nv * (T + 0.55 + i * 0.12)), rows_mat, parent, bevel=0.45,
                     euler=(math.degrees(-s * th), 0, 0))
                t -= 3.2
                i += 1
    return apex, L, th, zu


def _moss_on_slope(key, apex, L, th, X, T, m, parent, rnd, n=3, s=-1):
    down = Vector((0, s * math.cos(th), -math.sin(th)))
    nv = Vector((0, s * math.sin(th), math.cos(th)))
    for i in range(n):
        p = apex + down * (L * rnd.uniform(0.25, 0.85)) + X_AX * rnd.uniform(-X * 0.8, X * 0.8) + nv * (T + 1.6)
        _onto(f'{key}_moss{i}', p, nv, (rnd.uniform(4, 7), rnd.uniform(3, 5), 1.6), m['moss'], parent)


# ---------- 东方古镇（参考图 1） ----------

def _tower_e(spec, pal, root, rnd):
    """望楼：粗石砌方塔身（略收分）+ 腰部挑出的木阳台（小坡顶）+ 顶层木构外廊 + 深灰筒瓦四坡顶（檐角起翘）+ 苔藓。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    A, H = spec['hx'], spec['h']
    _blk(f'{key}_plinth', (2 * A + 10, 2 * A + 10, 5), (0, 0, 2.5), m['stone'], root, bevel=1.2)
    C.rbox(f'{key}_body', A * U, A * U, 4.5 * U, H * U, 2.0 * U, 0.0, m['rubble'], root, n=8, nz=6, k=3)
    # 门洞 + 小拱窗
    base = Vector((A * 0.15, -A, 5))
    _panel(f'{key}_door', base + FRONT_N * 0.6 + Vector((0, 0, 8)), X_AX, FRONT_N, 10, 16, 1.0, m['dark'], root, bevel=0)
    _log(f'{key}_doora', base + FRONT_N * 0.1 + Vector((0, 0, 16)), base + FRONT_N * 1.1 + Vector((0, 0, 16)), 5.0, m['dark'], root, seg=24, bev=0)
    for i, (x, z) in enumerate(((-A * 0.45, H * 0.36), (A * 0.4, H * 0.62), (-A * 0.4, H * 0.8))):
        c = Vector((x, -A, z))
        _panel(f'{key}_wf{i}', c + FRONT_N * 0.5, X_AX, FRONT_N, 4.0, 7.0, 1.0, m['dark'], root, bevel=0)
        _log(f'{key}_wfa{i}', c + FRONT_N * 0.1 + Vector((0, 0, 3.5)), c + FRONT_N * 1.0 + Vector((0, 0, 3.5)), 2.0, m['dark'], root, seg=16, bev=0)
    for i, (y, z) in enumerate(((-A * 0.3, H * 0.5), (A * 0.35, H * 0.72), (0.0, H * 0.25))):
        c = Vector((A, y, z))
        _panel(f'{key}_ws{i}', c + SIDE_N * 0.5, Y_AX, SIDE_N, 4.0, 7.0, 1.0, m['dark'], root, bevel=0)
        _log(f'{key}_wsa{i}', c + SIDE_N * 0.1 + Vector((0, 0, 3.5)), c + SIDE_N * 1.0 + Vector((0, 0, 3.5)), 2.0, m['dark'], root, seg=16, bev=0)
    # 腰部木阳台（右前面）
    zb = H * 0.42
    _blk(f'{key}_bp', (12, 2 * A * 0.7, 2.2), (A + 6, 0, zb), m['wood'], root, bevel=0.5)
    _blk(f'{key}_broom', (8, 2 * A * 0.6, 13), (A + 4, 0, zb + 7.5), m['wood2'], root, bevel=0.6)
    _lattice(f'{key}_bwin', Vector((A + 8.1, 0, zb + 8)), Y_AX, SIDE_N, 2 * A * 0.4, 6, m, root)
    for j in range(5):
        y = -A * 0.62 + j * A * 0.31
        _blk(f'{key}_brp{j}', (1.4, 1.4, 6), (A + 11.5, y, zb + 4), m['wood'], root, bevel=0.3)
    _blk(f'{key}_brr', (1.6, 2 * A * 0.66, 1.4), (A + 11.5, 0, zb + 7.2), m['wood'], root, bevel=0.3)
    _blk(f'{key}_broof', (16, 2 * A * 0.8, 2.2), (A + 7, 0, zb + 16.5), m['tiledk'], root, bevel=0.6, euler=(0, -20, 0))
    for j in range(7):
        y = -A * 0.72 + j * A * 0.24
        _log(f'{key}_brt{j}', (A + 14.5, y, zb + 14.2), (A + 1.5, y, zb + 19.0), 1.0, m['tile'], root, seg=8, bev=0)
    # 顶层木构：外廊平台 + 一圈栏杆 + 收进去的木屋（竖棂窗带）
    zt = H
    B = A + 6
    _blk(f'{key}_gal', (2 * B + 4, 2 * B + 4, 2.4), (0, 0, zt + 1.2), m['wood'], root, bevel=0.6)
    for i in range(9):
        t = -B + i * (2 * B) / 8
        _blk(f'{key}_gpf{i}', (1.5, 1.5, 7), (t, -B - 1.2, zt + 5.6), m['wood'], root, bevel=0.3)
        _blk(f'{key}_gps{i}', (1.5, 1.5, 7), (B + 1.2, t, zt + 5.6), m['wood'], root, bevel=0.3)
    _blk(f'{key}_grf', (2 * B + 3, 1.6, 1.5), (0, -B - 1.2, zt + 9.0), m['wood'], root, bevel=0.3)
    _blk(f'{key}_grs', (1.6, 2 * B + 3, 1.5), (B + 1.2, 0, zt + 9.0), m['wood'], root, bevel=0.3)
    up = spec['upper']
    C.rbox(f'{key}_room', (A + 2) * U, (A + 2) * U, (zt + 2) * U, (zt + up) * U, 1.2 * U, 0.0, m['wood2'], root, n=6, nz=3, k=2)
    _lattice(f'{key}_rwf', Vector((0, -A - 2, zt + up * 0.55)), X_AX, FRONT_N, 2 * A * 0.7, up * 0.45, m, root)
    _lattice(f'{key}_rws', Vector((A + 2, 0, zt + up * 0.55)), Y_AX, SIDE_N, 2 * A * 0.7, up * 0.45, m, root)
    # 四坡顶（方形旋转体 → 转 45° 让四条边沿坐标轴）：檐口外挑大、起翘
    ze = zt + up - 1.5
    E = A + 16  # 檐口半边长
    cap = spec['cap']
    prof = [(1.0, 0.0), (0.82, 0.16), (0.62, 0.4), (0.38, 0.68), (0.0, 1.0)]
    outer = [(E * math.sqrt(2) * r, ze + cap * z) for r, z in prof]
    roof = _lathe(f'{key}_roof', [(0.0, ze - 1.0), (E * math.sqrt(2) - 2.0, ze - 2.4)] + outer, m['tiledk'], root, seg=4)
    roof.rotation_euler = (0, 0, math.radians(45))
    # 迎光两坡的筒瓦：沿截面折线铺管
    for face, (na, ua) in enumerate(((FRONT_N, X_AX), (SIDE_N, Y_AX))):
        k = 14
        for i in range(1, k):
            f = -1 + 2 * i / k
            pts = []
            for r, z in prof[:-1]:
                h = E * r
                pts.append(V(*(na * (h + 0.9) + ua * (f * h) + Vector((0, 0, ze + cap * z + 0.9)))))
            pts.append(V(0, 0, ze + cap * 0.97))
            C.tube(f'{key}_tr{face}_{i}', pts, 1.15 * U, m['tile'], root)
    # 四条垂脊 + 檐角起翘 + 宝顶
    for i, a in enumerate((45, 135, 225, 315)):
        d = Vector((math.cos(math.radians(a)), math.sin(math.radians(a)), 0))
        pts = [V(*(d * (E * math.sqrt(2) * r + 0.6) + Vector((0, 0, ze + cap * z + 1.6)))) for r, z in prof]
        C.tube(f'{key}_hip{i}', pts, 1.9 * U, m['tilehi'], root)
        tip = d * (E * math.sqrt(2) + 2.0) + Vector((0, 0, ze + 3.2))
        ell(f'{key}_horn{i}', (3.0, 1.6, 1.6), tuple(tip), m['tilehi'], root, euler=(0, -35, a), seg=14, rings=7)
    _log(f'{key}_fin', (0, 0, ze + cap - 1), (0, 0, ze + cap + 7), 1.6, m['tilehi'], root, seg=12, bev=0.4)
    ell(f'{key}_finb', (2.6, 2.6, 2.6), (0, 0, ze + cap + 7.5), m['tilehi'], root, seg=16, rings=8)
    for i in range(4):
        a = math.radians(rnd.uniform(-80, 20))
        r = E * rnd.uniform(0.35, 0.8)
        p = Vector((math.cos(a) * r, math.sin(a) * r, 0))
        p.z = ze + cap * (1 - r / E) * 0.9 + 2.5
        _onto(f'{key}_moss{i}', p, Vector((p.x, p.y, E)).normalized(), (rnd.uniform(5, 8), rnd.uniform(4, 6), 2.0), m['moss'], root)
    # 塔脚：几团灌木 + 两个木桶
    for i, (x, y, r) in enumerate(((-A - 6, -A + 4, 5.5), (A + 4, -A - 8, 4.2), (-A + 2, -A - 9, 3.8))):
        M._shrub(f'{key}_s{i}', x, y, r, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=1 if i == 0 else 0)
    for i, (x, y) in enumerate(((A * 0.75, -A - 6), (A * 0.75 + 5, -A - 4))):
        _log(f'{key}_barrel{i}', (x, y, 0), (x, y, 7), 2.8, m['wood2'], root, seg=16, bev=0.6)


def _house_e(spec, pal, root, rnd):
    """白墙灰瓦民居：石台基 + 白灰墙（深色木柱 / 腰梁）+ 灰筒瓦双坡顶（正脊两端起翘）；
    shop = 门前挑出布篷 + 货箱；storeys = 2 时二层挑木外廊。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    hx, hy, wall = spec['hx'], spec['hy'], spec['wall']
    z0 = 4.0
    zw = z0 + wall
    C.slab(f'{key}_base', (hx + 2.5) * U, (hy + 2.5) * U, 0.0, z0 * U, 3.0 * U, 1.2 * U, m['stone'], root)
    C.rbox(f'{key}_wall', hx * U, hy * U, (z0 - 0.5) * U, zw * U, 2.0 * U, 0.0, m['plaster'], root, n=8, nz=3, k=3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            _blk(f'{key}_post{sx}{sy}', (3.0, 3.0, zw - z0), (sx * (hx - 1.0), sy * (hy - 1.0), (z0 + zw) / 2), m['wood'], root, bevel=0.6)
    _blk(f'{key}_bf', (2 * hx + 0.6, 2.2, 2.4), (0, -hy - 0.1, zw - 1.2), m['wood'], root, bevel=0.5)
    _blk(f'{key}_bs', (2.2, 2 * hy + 0.6, 2.4), (hx + 0.1, 0, zw - 1.2), m['wood'], root, bevel=0.5)
    storeys = spec.get('storeys', 1)
    zf = z0 + wall * 0.5
    if storeys > 1:
        _blk(f'{key}_mf', (2 * hx + 0.6, 2.0, 2.0), (0, -hy - 0.1, zf), m['wood'], root, bevel=0.4)
        _blk(f'{key}_ms', (2.0, 2 * hy + 0.6, 2.0), (hx + 0.1, 0, zf), m['wood'], root, bevel=0.4)
    # 门窗
    dx = -hx * 0.35
    _rect_door(f'{key}_door', Vector((dx, -hy, z0)), X_AX, FRONT_N, 9.0, 13.0, m, root)
    rows = [z0 + 8.0] if storeys == 1 else [z0 + 8.0, zf + 8.0]
    for j, z in enumerate(rows):
        for i, x in enumerate((hx * 0.25, hx * 0.68) if j == 0 else (-hx * 0.5, hx * 0.1, hx * 0.6)):
            _lattice(f'{key}_wf{j}{i}', Vector((x, -hy, z)), X_AX, FRONT_N, 8.0, 6.0, m, root)
        _lattice(f'{key}_ws{j}', Vector((hx, hy * 0.1, z)), Y_AX, SIDE_N, 8.0, 6.0, m, root)
    if storeys > 1:  # 二层木外廊
        _blk(f'{key}_gal', (2 * hx * 0.7, 7, 1.8), (hx * 0.1, -hy - 3.4, zf + 1.0), m['wood'], root, bevel=0.4)
        for i in range(7):
            x = hx * 0.1 - hx * 0.66 + i * hx * 0.22
            _blk(f'{key}_gp{i}', (1.2, 1.2, 5.5), (x, -hy - 6.4, zf + 4.4), m['wood'], root, bevel=0.2)
        _blk(f'{key}_gr', (2 * hx * 0.7, 1.4, 1.3), (hx * 0.1, -hy - 6.4, zf + 7.0), m['wood'], root, bevel=0.2)
    # 屋顶
    wy = hy + 0.5
    X = hx + 5
    apex, L, th, zu = _gable_roof(key, hx, zw, wy, spec.get('pitch', 32), 2.6, X, 6.5, m['tiledk'], m['tile'], root, rows='tube')
    _extrude(f'{key}_gable', [(-wy, zw - 1.0), (wy, zw - 1.0), (0, zu - 0.5)], -(hx - 0.5), hx - 0.5, m['plaster'], root)
    _blk(f'{key}_gbeam', (2.2, 2 * wy, 2.0), (hx - 0.2, 0, zw + 1.0), m['wood'], root, bevel=0.4)
    zr = zu + 2.6 + 1.2
    _log(f'{key}_ridge', (-X - 1, 0, zr), (X + 1, 0, zr), 2.4, m['tilehi'], root, seg=14, bev=0.6)
    for s in (-1, 1):
        ell(f'{key}_rh{s}', (3.2, 2.0, 2.4), (s * (X + 2.4), 0, zr + 2.0), m['tilehi'], root, euler=(0, s * 35, 0), seg=14, rings=7)
        down = Vector((0, -math.cos(th), -math.sin(th)))
        p = apex + down * L + X_AX * (s * X)
        ell(f'{key}_eh{s}', (3.0, 2.0, 1.4), tuple(p + Vector((s * 1.5, -1.0, 2.2))), m['tilehi'], root, euler=(25, -s * 25, 0), seg=14, rings=7)
    _moss_on_slope(key, apex, L, th, X, 2.6, m, root, rnd, n=spec.get('moss', 3))
    if spec.get('shop'):
        cloth = _color(f'{key}_cloth', t['cloth'][spec.get('cloth', 0)])
        cloth2 = _color(f'{key}_cloth2', '#F1E8D6')
        for i in range(5):
            _blk(f'{key}_aw{i}', (2 * hx * 0.9 / 5, 12, 1.0), (-hx * 0.9 + (2 * i + 1) * hx * 0.9 / 5, -hy - 6, z0 + 15.5), cloth if i % 2 == 0 else cloth2, root,
                 bevel=0.3, euler=(22, 0, 0))
        for s in (-1, 1):
            _log(f'{key}_awp{s}', (s * hx * 0.85, -hy - 11, 0), (s * hx * 0.85, -hy - 11, z0 + 13.5), 0.8, m['wood'], root, seg=8, bev=0)
        _stall_goods(key, Vector((hx * 0.3, -hy - 8, 0)), m, t, root, rnd)
    for i in range(spec.get('shrubs', 2)):
        M._shrub(f'{key}_s{i}', -hx - 4 + i * (2 * hx + 6), -hy - 3 + i * 3, 4.0 - i * 0.6, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=1)


def _stall_goods(key, at, m, t, parent, rnd, w=16, d=8):
    """货摊台面：木台 + 一筐筐果蔬（小彩球）+ 地上两只木箱。"""
    _blk(f'{key}_tb', (w, d, 2.0), tuple(at + Vector((0, 0, 8.0))), m['wood2'], parent, bevel=0.4)
    for sx in (-1, 1):
        for sy in (-1, 1):
            _log(f'{key}_tl{sx}{sy}', at + Vector((sx * (w / 2 - 1.2), sy * (d / 2 - 1.2), 0)), at + Vector((sx * (w / 2 - 1.2), sy * (d / 2 - 1.2), 7.5)), 0.7,
                 m['wood'], parent, seg=6, bev=0)
    prod = [C.principled(f'{key}_pr{i}', c, rough=0.45, spec=0.4) for i, c in enumerate(t['produce'])]
    k = 0
    for i in range(3):
        x = -w / 2 + 3 + i * (w - 6) / 2
        _lathe(f'{key}_bk{i}', [(0.0, 9.0), (3.0, 9.0), (3.6, 11.5), (0.0, 11.5)], m['straw'], parent, seg=16).location = V(*(at + Vector((x, 0, 0))))
        for j in range(4):
            a = j * 1.6 + i
            ell(f'{key}_fr{k}', (1.3, 1.3, 1.2), tuple(at + Vector((x + math.cos(a) * 1.4, math.sin(a) * 1.4, 12.2 + (j == 3) * 1.2))), prod[(i + j) % len(prod)],
                parent, seg=10, rings=5)
            k += 1
    for i, (x, y) in enumerate(((w / 2 + 3, 2), (w / 2 + 2.5, -4))):
        _blk(f'{key}_crate{i}', (5, 5, 4.5 if i == 0 else 3.5), tuple(at + Vector((x, y, 2.3 if i == 0 else 1.8))), m['wood2'], parent, bevel=0.4)


def _stall(spec, pal, root, rnd):
    """集市摊位（参考图 1 广场）：货摊台面 + 四根细竿撑一张前低后高的布篷（两色条纹）。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    _stall_goods(key, Vector((0, 0, 0)), m, t, root, rnd, w=18, d=10)
    c1 = _color(f'{key}_c1', t['cloth'][spec['cloth']])
    c2 = _color(f'{key}_c2', '#F1E8D6')
    for i in range(4):
        _blk(f'{key}_cn{i}', (24 / 4, 17, 1.0), (-9 + (2 * i + 1) * 3 - 3, 0.5, 22.0), c1 if i % 2 == 0 else c2, root, bevel=0.3, euler=(14, 0, 0))
    for sx in (-1, 1):
        for sy, h in ((-1, 19.8), (1, 24.2)):
            _log(f'{key}_pole{sx}{sy}', (sx * 11, sy * 7.5, 0), (sx * 11, sy * 7.5, h), 0.75, m['wood'], root, seg=6, bev=0)


# ---------- 童话村落（参考图 2） ----------

def _house_w(spec, pal, root, rnd):
    """木骨架房：石砌底层 + 微挑出的灰泥上层（深色木骨架：横梁 + 竖柱 + 斜撑）+ 陡坡彩色屋顶（木瓦一排排）+ 老虎窗 + 烟囱。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    roofc = t['roof_w'][spec['roof']]
    rmat = _color(f'{key}_rf', roofc)
    rdk = _color(f'{key}_rfd', C.mix_hex(roofc, '#20140F', 0.4))
    shutter = _color(f'{key}_sht', t['shutter'][spec.get('shutter', 0)])
    hx, hy = spec['hx'], spec['hy']
    z1 = spec['ground']
    zw = z1 + spec['upper']
    C.rbox(f'{key}_gf', hx * U, hy * U, 0.0, z1 * U, 2.0 * U, 0.0, m['castle'], root, n=8, nz=3, k=3)
    o = 1.6
    C.rbox(f'{key}_uf', (hx + o) * U, (hy + o) * U, (z1 - 0.2) * U, zw * U, 1.6 * U, 0.0, m['plaster_w'], root, n=8, nz=3, k=3)
    # 木骨架（迎光面 + 背光面）
    for face, (n, u, half, w0) in enumerate(((FRONT_N, X_AX, hx + o, hy + o), (SIDE_N, Y_AX, hy + o, hx + o))):
        c0 = n * (w0 + 0.3)
        for zz in (z1 + 1.0, zw - 1.0):
            _panel(f'{key}_tb{face}{zz:.0f}', c0 + Vector((0, 0, zz)), u, n, 2 * half + 0.6, 2.0, 1.2, m['timber'], root, bevel=0.3)
        k = max(3, int(2 * half / 12))
        xs = [-half + 1.0 + (2 * half - 2.0) * i / k for i in range(k + 1)]
        for i, x in enumerate(xs):
            _panel(f'{key}_tv{face}{i}', c0 + u * x + Vector((0, 0, (z1 + zw) / 2)), u, n, 1.8, zw - z1, 1.1, m['timber'], root, bevel=0.2)
        for i in range(k):
            if i % 2:
                continue
            a = c0 + u * xs[i] + Vector((0, 0, z1 + 1.5)) + n * 0.4
            b = c0 + u * xs[i + 1] + Vector((0, 0, zw - 1.5)) + n * 0.4
            _log(f'{key}_td{face}{i}', a, b, 0.8, m['timber'], root, seg=6, bev=0)
    # 门 + 窗
    M._door(key, Vector((-hx * 0.3, -hy, 0.5)), X_AX, FRONT_N, 8.0, 12.0,
            {'frame': m['wood2'], 'door': _color(f'{key}_door', t['door_w']), 'dark': m['dark']}, root)
    _rwin(f'{key}_gw', Vector((hx * 0.45, -hy, 8.0)), X_AX, FRONT_N, 5.5, 6.0, m, root, glow=True)
    for i, x in enumerate((-hx * 0.42, hx * 0.4)):
        _rwin(f'{key}_uw{i}', Vector((x, -hy - o, (z1 + zw) / 2 + 0.5)), X_AX, FRONT_N, 5.0, 6.5, m, root, shutters=shutter)
    _rwin(f'{key}_sw', Vector((hx + o, -hy * 0.1, (z1 + zw) / 2 + 0.5)), Y_AX, SIDE_N, 5.0, 6.5, m, root, shutters=shutter)
    # 花箱
    fb = Vector((hx * 0.45, -hy - 1.6, 3.8))
    _panel(f'{key}_fbox', fb, X_AX, FRONT_N, 8.0, 2.2, 2.4, m['wood2'], root, bevel=0.4)
    for i, d in enumerate((-2.5, 0.0, 2.5)):
        ell(f'{key}_fl{i}', (1.5, 1.4, 1.3), tuple(fb + Vector((d, -0.4, 1.8))), m['leaf'] if i == 1 else m['flower'], root, seg=12, rings=6)
    # 屋顶
    wy = hy + o + 0.5
    X = hx + o + 3.5
    apex, L, th, zu = _gable_roof(key, hx, zw, wy, spec.get('pitch', 52), 2.6, X, 4.0, rdk, rmat, root, rows='shingle')
    _extrude(f'{key}_gable', [(-wy, zw - 1.0), (wy, zw - 1.0), (0, zu - 0.5)], -(hx + o - 0.4), hx + o - 0.4, m['plaster_w'], root)
    gx = hx + o - 0.2
    for i, (a, b) in enumerate((((gx, -wy * 0.7, zw), (gx, 0, zu - 2)), ((gx, wy * 0.7, zw), (gx, 0, zu - 2)), ((gx, 0, zw), (gx, 0, zu - 2)))):
        _log(f'{key}_gt{i}', a, b, 0.9, m['timber'], root, seg=6, bev=0)
    M._window(f'{key}_gw2', Vector((gx + 0.2, 0, zw + (zu - zw) * 0.38)), Y_AX, SIDE_N, 2.4,
              {'frame': m['wood2'], 'glow': m['glow']}, root)
    _log(f'{key}_ridge', (-X - 0.6, 0, zu + 3.2), (X + 0.6, 0, zu + 3.2), 2.0, rdk, root, seg=12, bev=0.5)
    if spec.get('dormer'):
        down = Vector((0, -math.cos(th), -math.sin(th)))
        p = apex + down * (L * 0.52) + X_AX * (-hx * 0.25)
        _blk(f'{key}_dm', (10, 9, 9), tuple(p + Vector((0, -2, 3))), m['plaster_w'], root, bevel=0.6)
        _rwin(f'{key}_dmw', p + Vector((0, -6.6, 3)), X_AX, FRONT_N, 4.5, 4.5, m, root)
        for s in (-1, 1):
            _blk(f'{key}_dmr{s}', (8, 12, 1.6), tuple(p + Vector((s * 3.0, -2.5, 9.6))), rdk, root, bevel=0.4, euler=(0, s * 40, 0))
    cx, cy = hx * 0.45, hy * 0.35
    _log(f'{key}_chim', (cx, cy, zw), (cx, cy, zu + 9), 3.0, m['castle2'], root, seg=8, bev=0.6)
    _log(f'{key}_chimc', (cx, cy, zu + 8.6), (cx, cy, zu + 10.4), 3.9, m['dark'], root, seg=8, bev=0.4)
    M._shrub(f'{key}_s0', -hx - 4, -hy + 2, 4.5, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=2)
    M._shrub(f'{key}_s1', hx + 4, -hy - 2, 3.4, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd)


def _round_tower(key, x, y, r, h, cap, spire, stone, m, parent, flag=None, windows=2):
    """圆塔 + 外撇尖顶（城堡用）。"""
    _lathe(f'{key}_body', [(0.0, 0.0), (r, 0.0), (r - 0.6, h), (0.0, h)], stone, parent, seg=40).location = V(x, y, 0)
    _log(f'{key}_band', (x, y, h - 3.0), (x, y, h + 0.6), r + 1.2, stone, parent, seg=40, bev=0.6)
    Rr = r * 1.3
    outer = [(Rr + 0.3, h + 1.0)] + [(Rr * (1 - tt) ** 1.35, h + 1.0 + (cap - 1.0) * tt) for tt in (0.08, 0.2, 0.36, 0.55, 0.75, 0.92)] + [(0.0, h + cap)]
    _lathe(f'{key}_cap', [(0.0, h + 2.0), (Rr - 0.6, h)] + outer, spire, parent, seg=40).location = V(x, y, 0)
    for i in range(windows):
        z = h * (0.4 + 0.3 * i)
        az = math.radians(-60 + 40 * i)
        n = Vector((math.cos(az), math.sin(az), 0))
        u = Vector((-math.sin(az), math.cos(az), 0))
        c = Vector((x, y, z)) + n * (r - 0.3)
        _panel(f'{key}_w{i}', c + n * 0.4, u, n, 3.4, 6.5, 1.0, m['dark'], parent, bevel=0)
        _log(f'{key}_wa{i}', c + Vector((0, 0, 3.2)), c + n * 1.0 + Vector((0, 0, 3.2)), 1.7, m['dark'], parent, seg=12, bev=0)
    if flag is not None:
        tip = h + cap
        _log(f'{key}_pole', (x, y, tip - 1), (x, y, tip + 10), 0.55, m['dark'], parent, seg=6, bev=0)
        _extrude(f'{key}_flag', [(0.0, 0.0), (0.0, 4.5), (7.5, 2.2)], -0.35, 0.35, flag, parent, loc=(x, y + 0.3, tip + 4.6))


def _castle(spec, pal, root, rnd):
    """城堡（参考图 2 远景的紫尖顶城堡）：雉堞方形主楼 + 大门拱 + 后方高圆塔与左右两座小圆塔，紫色尖顶 + 小旗。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    spire = _color(f'{key}_spire', t['spire'])
    flag = _color(f'{key}_flag', t['roof_w']['a'])
    hx, hy, hk = spec['hx'], spec['hy'], spec['keep']
    _blk(f'{key}_plinth', (2 * hx + 8, 2 * hy + 8, 4), (0, 0, 2), m['castle2'], root, bevel=1.0)
    _round_tower(f'{key}_tm', -hx * 0.25, hy * 0.55, 15, spec['main'], 46, spire, m['castle'], m, root, flag=flag, windows=3)
    C.rbox(f'{key}_keep', hx * U, hy * U, 3.5 * U, hk * U, 2.0 * U, 0.0, m['castle'], root, n=8, nz=4, k=3)
    # 雉堞（迎光面 + 背光面顶沿）
    for i in range(int(2 * hx / 8) + 1):
        x = -hx + 2.5 + i * 8
        if x > hx - 2:
            break
        _blk(f'{key}_mf{i}', (4.6, 4.0, 5.0), (x, -hy + 1.6, hk + 2.4), m['castle'], root, bevel=0.6)
    for i in range(int(2 * hy / 8) + 1):
        y = -hy + 2.5 + i * 8
        if y > hy - 2:
            break
        _blk(f'{key}_ms{i}', (4.0, 4.6, 5.0), (hx - 1.6, y, hk + 2.4), m['castle'], root, bevel=0.6)
    _blk(f'{key}_cor', (2 * hx + 1.2, 2.4, 2.0), (0, -hy - 0.2, hk - 1.0), m['castle2'], root, bevel=0.5)
    _blk(f'{key}_cos', (2.4, 2 * hy + 1.2, 2.0), (hx + 0.2, 0, hk - 1.0), m['castle2'], root, bevel=0.5)
    # 大门拱 + 窗
    g = Vector((hx * 0.1, -hy, 3.5))
    _panel(f'{key}_gate', g + FRONT_N * 0.6 + Vector((0, 0, 9)), X_AX, FRONT_N, 14, 18, 1.0, m['dark'], root, bevel=0)
    _log(f'{key}_gatea', g + FRONT_N * 0.1 + Vector((0, 0, 18)), g + FRONT_N * 1.1 + Vector((0, 0, 18)), 7.0, m['dark'], root, seg=28, bev=0)
    _log(f'{key}_gatef', g + FRONT_N * -0.2 + Vector((0, 0, 18)), g + FRONT_N * 1.6 + Vector((0, 0, 18)), 8.6, m['castle2'], root, seg=28, bev=0.5)
    for i, x in enumerate((-hx * 0.6, hx * 0.62)):
        _rwin(f'{key}_fw{i}', Vector((x, -hy, hk * 0.62)), X_AX, FRONT_N, 4.5, 8.0, m, root)
    for i, y in enumerate((-hy * 0.45, hy * 0.4)):
        _rwin(f'{key}_sw{i}', Vector((hx, y, hk * 0.62)), Y_AX, SIDE_N, 4.5, 8.0, m, root)
    # 两座小圆塔：左前角、右后角
    _round_tower(f'{key}_tl', -hx, -hy, 10, hk + 16, 30, spire, m['castle'], m, root, flag=None)
    _round_tower(f'{key}_tr', hx, hy * 0.6, 10, hk + 24, 32, spire, m['castle'], m, root, flag=flag)
    for i in range(3):
        M._shrub(f'{key}_s{i}', -hx * 0.7 + i * hx * 0.75, -hy - 7 - (i % 2) * 2, 4.5 - i * 0.5, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=1)


# ---------- 人物 / 车辆 ----------

def _folk(spec, pal, root, rnd):
    """点缀小人（身高 ≈ 21）：两腿 + 长袍身子 + 头 + 帽子（草笠 / 布帽 / 头巾 / 发髻）+ 手里一样东西（篮子 / 扁担 / 无）。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    robe = _color(f'{key}_robe', t['folk'][spec['robe']])
    trim = _color(f'{key}_trim', t['folk'][spec.get('trim', (spec['robe'] + 3) % len(t['folk']))])
    for s in (-1, 1):
        _log(f'{key}_leg{s}', (s * 1.3, 0.3 * s, 0), (s * 1.1, 0, 6.0), 1.05, m['dark'], root, seg=8, bev=0.3)
    _lathe(f'{key}_body', [(0.0, 4.5), (3.6, 5.0), (3.3, 9.0), (2.6, 13.5), (2.2, 15.2), (0.0, 15.4)], robe, root, seg=20)
    _log(f'{key}_belt', (0, 0, 9.4), (0, 0, 10.6), 3.25, trim, root, seg=20, bev=0)
    for s in (-1, 1):
        sh = Vector((s * 2.6, 0, 14.0))
        hand = Vector((s * 3.6, -1.6, 9.5)) if spec.get('item') != 'pole' else Vector((s * 3.0, -2.2, 14.0))
        _log(f'{key}_arm{s}', sh, hand, 0.95, robe, root, seg=8, bev=0.3)
        ell(f'{key}_hand{s}', (0.9, 0.9, 0.9), tuple(hand), m['skin'], root, seg=8, rings=4)
    ell(f'{key}_head', (2.4, 2.3, 2.6), (0, 0, 17.6), m['skin'], root, seg=16, rings=8)
    hat = spec.get('hat', 'none')
    if hat == 'straw':
        _lathe(f'{key}_hat', [(0.0, 19.0), (5.4, 19.2), (5.0, 19.7), (1.0, 22.6), (0.0, 22.8)], m['straw'], root, seg=24)
    elif hat == 'cap':
        ell(f'{key}_hat', (2.6, 2.6, 1.6), (0, 0.2, 19.4), trim, root, seg=14, rings=7)
    elif hat == 'scarf':
        ell(f'{key}_hat', (2.7, 2.6, 2.0), (0, 0.5, 18.6), trim, root, seg=14, rings=7)
    else:
        ell(f'{key}_hat', (2.5, 2.4, 1.9), (0, 0.6, 18.9), m['hair'], root, seg=14, rings=7)
        ell(f'{key}_bun', (1.3, 1.3, 1.3), (0, 1.6, 20.4), m['hair'], root, seg=10, rings=5)
    item = spec.get('item')
    if item == 'basket':
        _lathe(f'{key}_bk', [(0.0, 7.0), (2.0, 7.0), (2.6, 10.0), (0.0, 10.0)], m['straw'], root, seg=14).location = V(4.2, -1.8, 0)
        prod = C.principled(f'{key}_pr', t['produce'][spec['robe'] % len(t['produce'])], rough=0.45)
        ell(f'{key}_bkf', (2.0, 2.0, 1.2), (4.2, -1.8, 10.2), prod, root, seg=10, rings=5)
    elif item == 'pole':
        _log(f'{key}_pole', (-9, -2.2, 14.6), (9, -2.2, 14.6), 0.6, m['wood'], root, seg=6, bev=0)
        for s in (-1, 1):
            _log(f'{key}_rope{s}', (s * 8, -2.2, 14.6), (s * 8, -2.2, 7.6), 0.25, m['straw'], root, seg=4, bev=0)
            _lathe(f'{key}_load{s}', [(0.0, 4.5), (2.6, 4.5), (3.0, 7.6), (0.0, 7.6)], m['straw'], root, seg=14).location = V(s * 8, -2.2, 0)


def _cart(spec, pal, root, rnd):
    """手推车：木车斗 + 两个大轮 + 车把，斗里堆着货（果蔬 / 木箱）。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    _blk(f'{key}_bed', (26, 15, 1.6), (0, 0, 9), m['wood2'], root, bevel=0.4)
    for s in (-1, 1):
        _blk(f'{key}_sd{s}', (26, 1.4, 4.5), (0, s * 7.2, 12), m['wood'], root, bevel=0.3)
        _blk(f'{key}_ed{s}', (1.4, 15, 4.5), (s * 12.6, 0, 12), m['wood'], root, bevel=0.3)
        _log(f'{key}_wh{s}', (2, s * 8.6, 7), (2, s * 10.4, 7), 7.0, m['wood'], root, seg=24, bev=0.5)
        _log(f'{key}_hub{s}', (2, s * 10.2, 7), (2, s * 11.2, 7), 1.6, m['dark'], root, seg=12, bev=0)
        _log(f'{key}_hd{s}', (-13, s * 5.5, 10), (-24, s * 5.5, 5), 0.9, m['wood'], root, seg=6, bev=0)
    prod = [C.principled(f'{key}_pr{i}', c, rough=0.45, spec=0.4) for i, c in enumerate(t['produce'])]
    for i in range(14):
        x = rnd.uniform(-10, 10)
        y = rnd.uniform(-5, 5)
        ell(f'{key}_ld{i}', (2.2, 2.2, 2.0), (x, y, 12 + rnd.uniform(0, 3)), prod[i % len(prod)], root, seg=10, rings=5)
    _blk(f'{key}_box', (8, 7, 6), (6, -1, 15), m['wood2'], root, bevel=0.5)


def _auto(spec, pal, root, rnd):
    """废弃车辆（参考图 3 的面包车 / 小轿车）：圆角车身 + 车窗 + 半陷进土里的轮子，车顶长满苔藓、锈斑点点。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    body = C.vinyl(f'{key}_body', t[spec['color']], rough=0.5)
    rust = C.principled(f'{key}_rust', t['rust'], rough=0.8, spec=0.2)
    L, W = spec['l'], spec['w']
    van = spec['type'] == 'van'
    yaw = math.radians(spec.get('yaw', 18))
    car = C.empty(f'{key}_car', parent=root)
    car.rotation_euler = (math.radians(spec.get('tilt', 4)), 0, yaw)
    for sx in (-1, 1):
        for sy in (-1, 1):
            _log(f'{key}_wh{sx}{sy}', (sx * L * 0.62, sy * (W + 0.2), 3.4), (sx * L * 0.62, sy * (W - 2.6), 3.4), 4.6, m['dark'], car, seg=20, bev=0.6)
    if van:
        C.rbox(f'{key}_b', L * U, W * U, 2.5 * U, 26 * U, 4.0 * U, 3.0 * U, body, car, n=8, nz=4, k=3)
        _panel(f'{key}_ws', Vector((L + 0.1, 0, 19)), Y_AX, SIDE_N, 2 * W - 4, 8, 0.6, m['glass'], car, bevel=0.3)
        for i, x in enumerate((-L * 0.55, L * 0.05, L * 0.6)):
            _panel(f'{key}_sw{i}', Vector((x, -W - 0.1, 19)), X_AX, FRONT_N, L * 0.42, 7.5, 0.6, m['glass'], car, bevel=0.3)
        top = 26
    else:
        C.rbox(f'{key}_b', L * U, W * U, 2.5 * U, 11 * U, 4.0 * U, 2.5 * U, body, car, n=8, nz=3, k=3)
        C.rbox(f'{key}_cab', (L * 0.55) * U, (W - 1.2) * U, 10 * U, 18.5 * U, 4.0 * U, 3.0 * U, body, car, loc=V(-L * 0.12, 0, 0), n=8, nz=3, k=3)
        _panel(f'{key}_ws', Vector((L * 0.43 + 0.3, 0, 14.5)), Y_AX, SIDE_N, 2 * W - 6, 5.5, 0.6, m['glass'], car, bevel=0.3)
        for i, x in enumerate((-L * 0.35, L * 0.12)):
            _panel(f'{key}_sw{i}', Vector((x - L * 0.12, -W + 1.1, 14.8)), X_AX, FRONT_N, L * 0.36, 5.0, 0.6, m['glass'], car, bevel=0.3)
        top = 18.5
    for i in range(6):
        p = Vector((rnd.uniform(-L * 0.7, L * 0.7), -W - 0.2, rnd.uniform(5, top - 6)))
        _onto(f'{key}_rs{i}', p, FRONT_N, (rnd.uniform(2, 4), rnd.uniform(1.5, 3), 0.5), rust, car, seg=12, rings=6)
    for i in range(spec.get('moss', 7)):
        p = Vector((rnd.uniform(-L * 0.75, L * 0.75), rnd.uniform(-W * 0.7, W * 0.7), top + 0.8))
        _onto(f'{key}_ms{i}', p, Z_AX, (rnd.uniform(4, 7), rnd.uniform(3, 6), 2.2), m['moss'], car)
    for i in range(3):  # 车边垂下来的藤蔓（苔藓团往下挂）
        p = Vector((rnd.uniform(-L * 0.6, L * 0.6), -W - 0.6, top - rnd.uniform(2, 8)))
        _onto(f'{key}_vn{i}', p, FRONT_N, (2.4, 5.5, 1.4), m['moss'], car)
    M._shrub(f'{key}_s0', -L - 3, -W - 2, 4.0, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd)
    M._shrub(f'{key}_s1', L * 0.5, -W - 5, 3.2, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=1)


# ---------- 巨像遗迹（参考图 3，原创「守林巨像」） ----------

def _giant_head(spec, pal, root, rnd):
    """守林巨像的头：蛋形铜绿穹顶（侧倒、半埋）+ 一圈眼带（一排小圆感应灯 + 两只大六角眼，眼里暖琥珀光）+ 竖向通气口 +
    两侧耳筒 + 天线残桩 + 基部一扇小门；苔藓盖顶，一道细瀑布从裂缝流进脚下小水潭；旁边躺着一截断颈。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    pat = _patina(f'{key}_pat', t['patina'][0], t['patina'][1], t['rust'])
    pat2 = _patina(f'{key}_pat2', t['bronze'], t['patina'][0], t['rust'], scale=8.0)
    eye = C.principled(f'{key}_eye', t['eye'], rough=0.3, emit=3.0, emit_color=t['eye'])
    eye_dim = C.principled(f'{key}_eyed', C.mix_hex(t['eye'], '#3A2A10', 0.45), rough=0.35, emit=0.9, emit_color=t['eye'])
    a, b, c = spec['r']
    zc = c * spec.get('sink', 0.55)
    h = C.empty(f'{key}_h', parent=root)
    h.location = V(0, 0, zc)
    h.rotation_euler = (0, math.radians(-10), math.radians(spec.get('yaw', 22)))
    R = (a, b, c)
    ell(f'{key}_dome', R, (0, 0, 0), pat, h, seg=64, rings=32)
    zb = c * 0.18
    ell(f'{key}_band', (a * 1.04, b * 1.04, c * 0.16), (0, 0, zb), pat2, h, seg=64, rings=20)
    ell(f'{key}_brow', (a * 1.02, b * 1.02, c * 0.05), (0, 0, zb + c * 0.17), pat2, h, seg=64, rings=12)
    # 眼带：一排小感应灯（隔几个亮一个）+ 两只大六角眼
    big = (-a * 0.42, a * 0.42)
    k = 0
    for x in [a * f for f in (-0.86, -0.74, -0.2, -0.08, 0.04, 0.16, 0.28, 0.74, 0.86)]:
        p, n = M.on_surface((a * 1.04, b * 1.04, c * 0.16 * 3.2), x, 0)
        p = p + Vector((0, 0, zb))
        _log(f'{key}_led{k}', p - n * 1.0, p + n * 2.4, 3.4, pat2, h, seg=16, bev=0.4)
        _log(f'{key}_ledg{k}', p + n * 2.3, p + n * 2.8, 2.3, eye_dim if k % 3 else m['dark'], h, seg=16, bev=0)
        k += 1
    for i, x in enumerate(big):
        p, n = M.on_surface(R, x, zb)
        _log(f'{key}_eye{i}', p - n * 3.0, p + n * 6.5, 15.5, pat2, h, seg=6, bev=1.2)
        _log(f'{key}_eyei{i}', p + n * 6.0, p + n * 7.0, 11.5, m['dark'], h, seg=6, bev=0)
        _log(f'{key}_eyeg{i}', p + n * 6.8, p + n * 7.6, 8.8, eye, h, seg=24, bev=0)
    # 通气口（竖槽）+ 腮板接缝 + 铆钉
    p, n = M.on_surface(R, a * 0.05, -c * 0.22)
    u, _, _ = _frame(n)
    _panel(f'{key}_ventf', p + n * 1.0, u, n, 12, 24, 3.0, pat2, h, bevel=1.0)
    _panel(f'{key}_vent', p + n * 2.6, u, n, 7, 18, 1.0, m['dark'], h, bevel=0)
    for i in range(18):
        x = -a * 0.9 + i * a * 1.8 / 17
        for j, dz in enumerate((zb + c * 0.13, zb - c * 0.13)):
            p, n = M.on_surface(R, x, dz)
            ell(f'{key}_rv{i}_{j}', (1.4, 1.4, 1.4), tuple(p + n * 0.6), pat2, h, seg=8, rings=4)
    # 耳筒（右侧那只朝镜头）
    for s in (-1, 1):
        e0 = Vector((s * a * 0.88, 0, -c * 0.02))
        e1 = Vector((s * a * 1.16, 0, -c * 0.02))
        _log(f'{key}_ear{s}', e0, e1, 28, pat2, h, seg=40, bev=2.0)
        _log(f'{key}_earr{s}', e1 - Vector((s * 2, 0, 0)), e1 + Vector((s * 1.2, 0, 0)), 30, pat, h, seg=40, bev=1.0)
        _log(f'{key}_earh{s}', e1, e1 + Vector((s * 1.4, 0, 0)), 18, m['dark'], h, seg=32, bev=0)
    # 天线残桩
    top = Vector((a * 0.2, b * 0.1, c * 0.97))
    _log(f'{key}_ant', top, top + Vector((6, -3, 22)), 2.0, pat2, h, seg=10, bev=0.4)
    ell(f'{key}_antb', (3.4, 3.4, 3.4), tuple(top + Vector((6.6, -3.3, 24))), pat2, h, seg=14, rings=7)
    # 基部小门（游客能走进去的那种）
    p, n = M.on_surface(R, a * 0.38, -c * 0.43)
    u, _, _ = _frame(n)
    _panel(f'{key}_doorf', p + n * 1.0, u, n, 16, 24, 2.6, pat2, h, bevel=0.8)
    _panel(f'{key}_door', p + n * 2.4, u, n, 11, 20, 1.0, m['dark'], h, bevel=0)
    # 苔藓盖顶 + 眼带上挂下来的几团
    for i in range(26):  # 苔藓：一簇簇鼓起来的小团（不是贴纸），顶上密、往下稀
        th_ = math.radians(rnd.uniform(0, 360))
        ph = math.radians(rnd.uniform(0, 30) if i < 14 else rnd.uniform(25, 60))
        d = Vector((math.cos(th_) * math.sin(ph), math.sin(th_) * math.sin(ph), math.cos(ph)))
        p = Vector((d.x * a, d.y * b, d.z * c))
        n = Vector((d.x / a, d.y / b, d.z / c)).normalized()
        r = rnd.uniform(5, 10) if i < 14 else rnd.uniform(3.5, 6)
        mo = _onto(f'{key}_moss{i}', p + n * (r * 0.25), n, (r, r * rnd.uniform(0.7, 0.95), r * 0.55), m['moss'], h, seg=20, rings=10)
        C.puff(mo, cell=0.05, strength=0.02, offset=(i * 0.7, 0.3, 0))
    for i in range(6):
        x = rnd.uniform(-a * 0.8, a * 0.8)
        p, n = M.on_surface(R, x, zb + c * 0.22)
        _onto(f'{key}_mh{i}', p + n * 1.2, n, (rnd.uniform(4, 7), 3.0, 2.0), m['moss'], h)
        p2, n2 = M.on_surface(R, x + 2, zb + c * 0.06)
        _onto(f'{key}_vine{i}', p2 + n2 * 2.4, n2, (2.0, 2.0, 6.5), m['moss'], h)
    # 细瀑布：从左眼下方的裂缝落进水潭
    p, n = M.on_surface(R, -a * 0.62, -c * 0.12)
    import bpy  # 世界坐标里竖直下落：父物体旋转后再换算
    bpy.context.view_layer.update()
    pw = (h.matrix_world @ V(*(p + n * 3.0)))
    base = Vector((pw.x / U, pw.y / U, 0.6))
    top_z = pw.z / U
    _panel(f'{key}_fall', Vector((base.x, base.y, (top_z + 0.6) / 2)), Vector((0.7, 0.7, 0)).normalized(), Vector((0.7, -0.7, 0)).normalized(),
           3.4, top_z - 0.6, 0.8, m['water'], root, bevel=0.3)
    ell(f'{key}_pond', (26, 17, 1.0), (base.x - 6, base.y - 12, 0.3), m['water'], root, seg=40, rings=10)
    for i in range(9):
        a_ = i * math.tau / 9
        M._boulder(f'{key}_pb{i}', 3.2, (base.x - 6 + math.cos(a_) * 27, base.y - 12 + math.sin(a_) * 18, -0.6), m['stone'], root, rnd)
    # 断颈：几节圆筒横躺在右后方
    for i in range(3):
        p0 = Vector((a * 0.95 + i * 15, b * 0.55 + i * 9, 18 - i * 2))
        _log(f'{key}_neck{i}', p0, p0 + Vector((13, 8, -1)), 22 - i * 2, pat if i % 2 == 0 else pat2, root, seg=36, bev=1.5)
    M._shrub(f'{key}_s0', -a * 0.7, -b * 0.95, 8.0, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=3)
    M._shrub(f'{key}_s1', a * 0.6, -b * 1.05, 6.0, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=2)
    M._shrub(f'{key}_s2', a * 1.1, -b * 0.3, 7.0, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd)


def _giant_hand(spec, pal, root, rnd):
    """守林巨像的手：掌心朝上半陷在草地里，四根管状长指（三节 + 关节球）微微蜷起 + 拇指；腕部一圈环箍与外露的活塞；掌心积了苔藓。"""
    key = f'env_{spec["key"]}'
    m = _mats(key, pal)
    t = pal['env']['town']
    pat = _patina(f'{key}_pat', t['patina'][0], t['patina'][1], t['rust'])
    pat2 = _patina(f'{key}_pat2', t['bronze'], t['patina'][0], t['rust'], scale=8.0)
    hd = C.empty(f'{key}_hand', parent=root)
    hd.rotation_euler = (0, 0, math.radians(spec.get('yaw', -28)))
    hd.location = V(0, 0, -2.0)
    PX, PY = 30, 25
    C.rbox(f'{key}_palm', PX * U, PY * U, 0.0, 15 * U, 7.0 * U, 4.0 * U, pat, hd, n=8, nz=3, k=3)
    for i in range(7):
        _onto(f'{key}_pm{i}', Vector((rnd.uniform(-PX * 0.6, PX * 0.5), rnd.uniform(-PY * 0.6, PY * 0.6), 15.6)), Z_AX,
              (rnd.uniform(6, 10), rnd.uniform(5, 8), 2.4), m['moss'], hd)
    for f in range(4):
        y = -PY * 0.72 + f * PY * 0.48
        p = Vector((PX - 2, y, 8))
        d = Vector((1, (f - 1.5) * 0.08, 0)).normalized()
        for s, ln in enumerate((22, 17, 13)):
            ell(f'{key}_j{f}_{s}', (7.6, 7.6, 7.6), tuple(p), pat2, hd, seg=20, rings=10)
            q = p + d * ln
            _log(f'{key}_f{f}_{s}', p, q, 6.4 - s * 0.6, pat, hd, seg=24, bev=1.6)
            _log(f'{key}_fr{f}_{s}', p + d * (ln * 0.5 - 1.2), p + d * (ln * 0.5 + 1.2), 7.0 - s * 0.6, pat2, hd, seg=24, bev=0.4)
            p = q
            d = (d + Vector((0, 0, 0.32))).normalized()
        ell(f'{key}_tip{f}', (6.0, 6.0, 6.0), tuple(p), pat, hd, seg=20, rings=10)
    tp = Vector((PX * 0.2, -PY - 2, 8))
    td = Vector((0.55, -1, 0.15)).normalized()
    for s, ln in enumerate((18, 13)):
        ell(f'{key}_tj{s}', (7.8, 7.8, 7.8), tuple(tp), pat2, hd, seg=20, rings=10)
        q = tp + td * ln
        _log(f'{key}_tf{s}', tp, q, 6.6, pat, hd, seg=24, bev=1.6)
        tp = q
        td = (td + Vector((0.3, 0, 0.3))).normalized()
    ell(f'{key}_ttip', (6.2, 6.2, 6.2), tuple(tp), pat, hd, seg=20, rings=10)
    w0 = Vector((-PX + 2, 0, 9))
    w1 = Vector((-PX - 30, 4, 7))
    _log(f'{key}_wrist', w0, w1, 20, pat2, hd, seg=40, bev=1.6)
    for i in range(3):
        c = w0 + (w1 - w0) * (0.18 + i * 0.3)
        _log(f'{key}_wr{i}', c - X_AX * 1.6, c + X_AX * 1.6, 21.5, pat, hd, seg=40, bev=0.6)
    _log(f'{key}_wend', w1 - X_AX * 0.4, w1 + X_AX * 0.6, 17, m['dark'], hd, seg=36, bev=0)
    for i, (dy, dz) in enumerate(((-7, 4), (6, 6), (0, -4))):
        _log(f'{key}_pist{i}', w1 + Vector((0.6, dy, dz)), w1 + Vector((-9, dy * 1.2, dz)), 2.6, pat2, hd, seg=12, bev=0.4)
    for i in range(4):
        _onto(f'{key}_wm{i}', w0 + (w1 - w0) * rnd.uniform(0.1, 0.9) + Vector((0, rnd.uniform(-8, 8), 19)), Z_AX, (rnd.uniform(5, 8), 4.0, 2.0), m['moss'], hd)
    M._shrub(f'{key}_s0', -PX - 6, -PY - 12, 5.0, {'leaf': m['leaf'], 'flower': m['flower']}, root, rnd, flowers=2)


BUILD = {
    'tower_e': _tower_e, 'house_e': _house_e, 'stall': _stall, 'house_w': _house_w, 'castle': _castle,
    'folk': _folk, 'cart': _cart, 'auto': _auto, 'giant_head': _giant_head, 'giant_hand': _giant_hand,
}

SPECS = [
    # 东方古镇
    {'key': 'TOWERE', 'kind': 'tower_e', 'hx': 22, 'h': 150, 'upper': 26, 'cap': 30},
    {'key': 'HOUSEE1', 'kind': 'house_e', 'hx': 40, 'hy': 24, 'wall': 40, 'storeys': 2, 'pitch': 32, 'moss': 4},
    {'key': 'HOUSEE2', 'kind': 'house_e', 'hx': 34, 'hy': 22, 'wall': 26, 'storeys': 1, 'pitch': 30, 'shop': True, 'cloth': 0, 'moss': 2},
    {'key': 'STALL01', 'kind': 'stall', 'cloth': 0},
    {'key': 'STALL02', 'kind': 'stall', 'cloth': 1},
    {'key': 'STALL03', 'kind': 'stall', 'cloth': 2},
    # 童话村落
    {'key': 'CASTLE', 'kind': 'castle', 'hx': 36, 'hy': 28, 'keep': 70, 'main': 140},
    {'key': 'HOUSEW1', 'kind': 'house_w', 'hx': 30, 'hy': 22, 'ground': 18, 'upper': 22, 'pitch': 54, 'roof': 'a', 'dormer': True, 'shutter': 0},
    {'key': 'HOUSEW2', 'kind': 'house_w', 'hx': 26, 'hy': 20, 'ground': 16, 'upper': 20, 'pitch': 55, 'roof': 'b', 'shutter': 1},
    {'key': 'HOUSEW3', 'kind': 'house_w', 'hx': 24, 'hy': 21, 'ground': 17, 'upper': 22, 'pitch': 56, 'roof': 'c', 'dormer': True, 'shutter': 2},
    # 人物 / 车辆
    {'key': 'FOLK01', 'kind': 'folk', 'robe': 0, 'hat': 'straw', 'item': 'basket'},
    {'key': 'FOLK02', 'kind': 'folk', 'robe': 1, 'hat': 'cap'},
    {'key': 'FOLK03', 'kind': 'folk', 'robe': 2, 'hat': 'bun'},
    {'key': 'FOLK04', 'kind': 'folk', 'robe': 3, 'hat': 'straw', 'item': 'pole'},
    {'key': 'FOLK05', 'kind': 'folk', 'robe': 4, 'hat': 'scarf', 'item': 'basket'},
    {'key': 'FOLK06', 'kind': 'folk', 'robe': 5, 'hat': 'cap', 'trim': 0},
    {'key': 'CART01', 'kind': 'cart'},
    {'key': 'VAN01', 'kind': 'auto', 'type': 'van', 'l': 24, 'w': 11, 'color': 'van', 'yaw': 24, 'tilt': 5, 'moss': 8},
    {'key': 'CAR01', 'kind': 'auto', 'type': 'car', 'l': 19, 'w': 9, 'color': 'car', 'yaw': -16, 'tilt': -4, 'moss': 5},
    # 巨像遗迹
    {'key': 'GIANTHEAD', 'kind': 'giant_head', 'r': (86, 76, 98), 'sink': 0.5, 'yaw': 40},
    {'key': 'GIANTHAND', 'kind': 'giant_hand', 'yaw': -28},
]
