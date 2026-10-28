"""模型：玩家（蘑菇帽小人）、AI（圆头团子）、地面石板、绿篱墙、红宝石。

尺寸单位 = 屏幕像素（1 px = common.PX 米）。水平半径按屏幕像素理解；z 为世界高度，
上屏后乘 cos30°≈0.866。角色正面朝 -Y（网格 s 向），脚下落点在原点。
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

import common as C

U = C.PX


def V(x, y, z):
    return Vector((x * U, y * U, z * U))


def ell(name, radii, loc, mat, parent, quat=None, euler=None, seg=40, rings=20, smooth=True):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    bmesh.ops.scale(bm, vec=Vector(radii) * U, verts=bm.verts)
    ob = C.mesh_from_bm(name, bm, mat, smooth, parent, V(*loc))
    if quat is not None:
        ob.rotation_mode = 'QUATERNION'
        ob.rotation_quaternion = quat
    elif euler is not None:
        ob.rotation_euler = Euler([math.radians(a) for a in euler], 'XYZ')
    return ob


def on_surface(radii, x, dz):
    """椭球（中心在原点）正面（-Y）上横坐标 x、相对高度 dz 的表面点与法线。"""
    a, b, c = radii
    t = max(0.0, 1 - (x / a) ** 2 - (dz / c) ** 2)
    y = -b * math.sqrt(t)
    p = Vector((x, y, dz))
    n = Vector((x / a ** 2, y / b ** 2, dz / c ** 2)).normalized()
    return p, n


def facing(n):
    """让局部 -Y 轴对齐法线 n（面部贴件的薄轴朝外）。"""
    return Vector((0, -1, 0)).rotation_difference(n)


HIDE = (1e-4, 1e-4, 1e-4)  # 显隐一律用缩放：render.solo() 会重置 hide_render，靠它藏东西会被悄悄覆盖


class Rig:
    """fit（整体缩放）→ root（朝向 + 挤压拉伸，绕脚下原点）→ 各部件（关节空物体 + 网格）。"""

    def __init__(self, name):
        self.name = name
        self.fit = C.empty(f'{name}_fit')
        self.root = C.empty(f'{name}_root', parent=self.fit)
        self.j = {}
        self.base = {}
        self.eyes = []
        self.eye_hi = []
        self.whites = []
        self.xeyes = []

    def joint(self, key, loc, parent=None):
        ob = C.empty(f'{self.name}_{key}', V(*loc), parent or self.root)
        self.j[key] = ob
        return ob

    def snapshot(self):
        for k, ob in self.j.items():
            self.base[k] = (ob.location.copy(), ob.rotation_euler.copy(), ob.scale.copy())

    def meshes(self):
        return [o for o in C.descendants(self.fit) if o.type in ('MESH', 'CURVE')]

    def show(self, on, camera=True):
        for o in C.descendants(self.fit):
            o.hide_render = not on
            if o.type in ('MESH', 'CURVE'):
                o.visible_camera = camera

    def reset(self):
        self.root.scale = (1, 1, 1)
        self.root.location = (0, 0, 0)
        for k, (loc, rot, sc) in self.base.items():
            ob = self.j[k]
            ob.location = loc
            ob.rotation_euler = rot
            ob.scale = sc
        for e in self.eyes + self.whites + self.eye_hi:
            e.scale = (1, 1, 1)
        for x in self.xeyes:
            x.scale = HIDE

    # ---- 姿态 ----
    def _arm(self, side, out_deg, swing_deg=0.0):
        """side -1 = 左臂（-X）。out：向外张开（约 120° 为举过肩的「万岁」）；swing：正 = 向后摆。"""
        ob = self.j['armL' if side < 0 else 'armR']
        r0 = self.base['armL' if side < 0 else 'armR'][1]
        ob.rotation_euler = Euler((r0.x + math.radians(swing_deg), r0.y + math.radians(out_deg) * (1 if side < 0 else -1), r0.z), 'XYZ')

    def _arms(self, out_deg, swing_deg=0.0):
        self._arm(-1, out_deg, swing_deg)
        self._arm(1, out_deg, swing_deg)

    def _leg(self, side, fwd=0.0, lift=0.0):
        k = 'legL' if side < 0 else 'legR'
        loc = self.base[k][0]
        self.j[k].location = loc + V(0, -fwd, lift)

    def _up(self, dz=0.0, tilt=0.0, roll=0.0):
        """上半身（头 + 帽）：dz 抬高（px）；tilt 正 = 前倾（低头）；roll 正 = 向右歪头。"""
        loc, rot, _ = self.base['upper']
        self.j['upper'].location = loc + V(0, 0, dz)
        self.j['upper'].rotation_euler = Euler((rot.x + math.radians(tilt), rot.y + math.radians(roll), rot.z), 'XYZ')

    def _shift(self, back_px):
        """整体沿朝向前后平移（正 = 后退），受阻的「被弹回」用。"""
        self.root.location = self.root.rotation_euler.to_matrix() @ V(0, back_px, 0)

    def _squint(self, k):
        for e in self.eyes + self.whites:
            e.scale = (1.06, 1, k)

    def _xeyes(self):
        for e in self.eyes + self.whites + self.eye_hi:
            e.scale = HIDE
        for x in self.xeyes:
            x.scale = (1, 1, 1)

    def pose(self, state, frame, direction='s'):
        self.reset()
        # 等距取巧：朝向镜头的两向（s / e）再往镜头转 20°，脸更正、更好认
        turn = {'s': 20.0, 'e': -20.0}.get(direction, 0.0)
        self.root.rotation_euler = Euler((0, 0, C.DIR_YAW[direction] + math.radians(turn)), 'XYZ')
        if state == 'IDLE':
            if frame in (1, 2):
                self._up(0.7)
                self.j['body'].scale = (1, 1, 1.03)
                self._arm(-1, 4 if frame == 1 else 7)
                self._arm(1, 4 if frame == 1 else 7)
            elif frame == 3:
                for e in self.eyes:
                    e.scale = (1, 1, 0.16)
                for h in self.eye_hi:
                    h.scale = HIDE
        elif state == 'MOVE':
            if frame == 0:  # 蓄力压缩（同时用作落地压缩）
                self.root.scale = (1.1, 1.1, 0.86)
                self._arm(-1, 34)
                self._arm(1, 34)
            elif frame == 1:  # 起跳拉伸
                self.root.scale = (0.93, 0.93, 1.09)
                self._leg(-1, 1.8, 1.2)
                self._leg(1, -1.2, 0)
                self._arm(-1, 10, 28)
                self._arm(1, 10, -28)
                self._up(0.5, -4)
            elif frame == 2:  # 腾空
                self.root.scale = (0.97, 0.97, 1.04)
                self._leg(-1, 0.6, 1.6)
                self._leg(1, 0.6, 1.6)
                self._arm(-1, 40, -8)
                self._arm(1, 40, -8)
                self._up(0.4, -2)
            elif frame == 3:  # 下落
                self._leg(1, 1.8, 1.2)
                self._leg(-1, -1.2, 0)
                self._arm(-1, 10, -28)
                self._arm(1, 10, 28)
                self._up(0.2, 3)
        elif state == 'PICK':
            if frame == 0:  # 低头蓄力：压扁、手往前探
                self.root.scale = (1.07, 1.07, 0.9)
                self._arms(36, -16)
                self._up(-0.4, 8)
            elif frame == 1:  # 万岁：拉伸、双臂举过肩、仰头（头顶留给 +1 飘字）
                self.root.scale = (0.95, 0.95, 1.07)
                self._arms(124)
                self._up(0.8, -7)
            else:  # 开心回落：笑眯眼
                self.root.scale = (1.0, 1.0, 1.03)
                self._arms(112)
                self._up(0.5, -4)
                self._squint(0.5)
        elif state == 'BLOCK':
            if frame == 0:  # 撞上：被弹回、压扁、后仰、手往前撑、挤眼
                self._shift(1.6)
                self.root.scale = (1.08, 1.08, 0.9)
                self._arms(50, -30)
                self._up(-0.3, -10)
                self._squint(0.32)
            else:  # 回弹：略前冲
                self._shift(-0.8)
                self.root.scale = (0.97, 0.97, 1.04)
                self._arms(14)
                self._up(0.2, 5)
                self._squint(0.55)
        elif state == 'DEAD':
            # 动画层另做：下沉 4px + 去饱和 60% 的 tween（03 §3.2.1），sprite 只给首尾关键帧，不含下沉
            self._xeyes()
            if self.name == 'ai':
                frame = 1  # AI 只有 1 帧：直接用瘫倒的终态
            if frame == 0:  # 一僵：拉直、双臂平伸
                self.root.scale = (0.95, 0.95, 1.06)
                self._arms(78)
                self._up(0.5, -6)
            else:  # 瘫软：压扁、垂手、低头歪头
                self.root.scale = (1.1, 1.1, 0.84)
                self._arms(8, 12)
                self._up(-1.6, 12, 9)


def _face_features(rig, head_parent, radii, eye, eye_dx, eye_dz, highlight, mats):
    for side in (-1, 1):
        p, n = on_surface(radii, side * eye_dx, eye_dz)
        p = p - n * (eye[1] * 0.45)
        e = ell(f'{rig.name}_eye{side}', eye, tuple(p), mats['eye'], head_parent, quat=facing(n), seg=24, rings=12)
        rig.eyes.append(e)
        if highlight:
            h = ell(f'{rig.name}_eyehi{side}', (0.62, 0.4, 0.62), (-0.55, -eye[1] * 0.85, eye[2] * 0.42), mats['hi'], e, seg=12, rings=6)
            rig.eye_hi.append(h)


def _mouth(rig, head_parent, radii, pts2d, r, mat):
    pts = []
    for x, dz in pts2d:
        p, n = on_surface(radii, x, dz)
        pts.append(tuple(p - n * (r * 0.3)))
    C.tube(f'{rig.name}_mouth', [tuple(c * U for c in q) for q in pts], r * U, mat, head_parent)


def _x_eyes(rig, head_parent, radii, eye_dx, eye_dz, s, r, mat):
    """出局用的 × 眼：贴在眼位的两根交叉短管，默认缩到不可见，DEAD 时与原眼睛互换。"""
    for side in (-1, 1):
        p, n = on_surface(radii, side * eye_dx, eye_dz)
        holder = C.empty(f'{rig.name}_x{side}', V(*(p + n * 0.12)), head_parent)
        holder.rotation_mode = 'QUATERNION'
        holder.rotation_quaternion = facing(n)
        for k, (a, b) in enumerate((((-s, -s), (s, s)), ((-s, s), (s, -s)))):
            C.tube(f'{rig.name}_x{side}_{k}', [(a[0] * U, 0, a[1] * U), (b[0] * U, 0, b[1] * U)], r * U, mat, holder)
        holder.scale = HIDE
        rig.xeyes.append(holder)


def _shared_mats(prefix):
    return {
        'eye': C.principled(f'{prefix}_eye', '#2A221E', rough=0.2, coat=0.9, coat_rough=0.05),
        'hi': C.principled(f'{prefix}_hi', '#FFFFFF', rough=0.5, emit=1.2),
        'mouth': C.principled(f'{prefix}_mouth', '#7A3236', rough=0.5),
        'cheek': C.principled(f'{prefix}_cheek', '#FF8FA3', rough=0.7),
        'white': C.vinyl(f'{prefix}_white', '#FFFFFF', rough=0.35),
    }


def build_player(colors):
    """玩家：蘑菇帽（座位色）+ 奶油脸 + 座位色身体；大眼带高光、微笑、腮红。"""
    rig = Rig('player')
    mats = _shared_mats('p')
    m_cap = C.vinyl('p_cap', colors['cap'], rough=0.3)
    m_body = C.vinyl('p_body', colors['body'])
    m_face = C.vinyl('p_face', colors['face'], rough=0.5)
    rig.mats = {'cap': m_cap, 'body': m_body}

    for side, key in ((-1, 'legL'), (1, 'legR')):
        lg = rig.joint(key, (side * 4.3, 0, 0))
        ell(f'player_{key}', (3.9, 4.4, 4.6), (0, -0.4, 4.6), m_body, lg)
    body = rig.joint('body', (0, 0, 5))
    ell('player_body', (9.2, 8.2, 9.6), (0, 0, 9.6), m_body, body)
    for side, key in ((-1, 'armL'), (1, 'armR')):
        arm = rig.joint(key, (side * 8.0, 0, 18.5))
        arm.rotation_euler = Euler((0, math.radians(18) * (1 if side < 0 else -1), 0), 'XYZ')
        ell(f'player_{key}', (3.0, 3.0, 5.4), (0, 0, -4.4), m_body, arm)
    up = rig.joint('upper', (0, 0, 23))
    head_r = (12.0, 11.0, 11.6)
    head_c = (0, 0, 12.2)
    head = C.empty('player_headc', V(*head_c), up)
    ell('player_head', head_r, (0, 0, 0), m_face, head)
    _face_features(rig, head, head_r, (1.9, 1.0, 2.5), 4.7, -1.2, True, mats)
    _x_eyes(rig, head, head_r, 4.7, -1.2, 1.7, 0.5, mats['eye'])
    _mouth(rig, head, head_r, [(-1.7, -5.0), (-0.8, -5.7), (0, -5.95), (0.8, -5.7), (1.7, -5.0)], 0.5, mats['mouth'])
    for side in (-1, 1):
        p, n = on_surface(head_r, side * 7.6, -4.0)
        ell(f'player_cheek{side}', (2.3, 0.5, 1.3), tuple(p - n * 0.2), mats['cheek'], head, quat=facing(n), seg=16, rings=8)

    # 蘑菇帽：椭球按斜平面切开（前高后低露出脸），再加厚
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=1.0)
    bmesh.ops.scale(bm, vec=Vector((14.6, 13.8, 12.2)) * U, verts=bm.verts)
    bmesh.ops.translate(bm, vec=V(0, 0.8, 16.6), verts=bm.verts)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=V(0, 0, 14.6),
                           plane_no=Vector((0, 0.32, 1)).normalized(), clear_inner=True)
    cap = C.mesh_from_bm('player_cap', bm, m_cap, True, up)
    sol = cap.modifiers.new('Solid', 'SOLIDIFY')
    sol.thickness = 1.5 * U
    sol.offset = -1
    sol.use_even_offset = True
    # 帽顶白斑（蘑菇的识别符号，也让帽子在灰度下与 AI 团子拉开）
    m_dot = C.vinyl('p_dot', '#FFF6EE', rough=0.45)
    rnd = random.Random(7)
    for k, (ang, el, s) in enumerate([(-50, 52, 2.4), (20, 60, 2.0), (95, 48, 2.2), (160, 55, 1.8), (-120, 40, 1.7)]):
        a = math.radians(ang + 90)
        e = math.radians(el)
        rr = (14.6, 13.8, 12.2)
        d = Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
        p = Vector((d.x * rr[0], d.y * rr[1] + 0.8, d.z * rr[2] + 16.6))
        n = Vector((d.x / rr[0], d.y / rr[1], d.z / rr[2])).normalized()
        ell(f'player_dot{k}', (s, 0.6, s * 0.8), tuple(p + n * 0.05), m_dot, up,
            quat=Vector((0, -1, 0)).rotation_difference(n), seg=16, rings=8)
        rnd.random()
    rig.snapshot()
    return rig


def build_ai(color, belly):
    """AI：圆头团子，整体座位色 + 浅色肚兜；豆豆眼无高光、一字嘴。"""
    rig = Rig('ai')
    mats = _shared_mats('a')
    m_body = C.vinyl('a_body', color)
    m_belly = C.vinyl('a_belly', belly, rough=0.5)
    rig.mats = {'body': m_body, 'belly': m_belly}
    for side, key in ((-1, 'legL'), (1, 'legR')):
        lg = rig.joint(key, (side * 4.4, 0, 0))
        ell(f'ai_{key}', (3.9, 4.4, 4.6), (0, -0.4, 4.6), m_body, lg)
    body = rig.joint('body', (0, 0, 5))
    ell('ai_body', (9.6, 8.6, 9.0), (0, 0, 9.0), m_body, body)
    ell('ai_belly', (6.2, 3.0, 6.0), (0, -6.0, 8.6), m_belly, body)
    for side, key in ((-1, 'armL'), (1, 'armR')):
        arm = rig.joint(key, (side * 8.4, 0, 16.5))
        arm.rotation_euler = Euler((0, math.radians(20) * (1 if side < 0 else -1), 0), 'XYZ')
        ell(f'ai_{key}', (3.0, 3.0, 5.2), (0, 0, -4.2), m_body, arm)
    up = rig.joint('upper', (0, 0, 20.5))
    head_r = (13.4, 12.4, 12.4)
    head = C.empty('ai_headc', V(0, 0, 12.0), up)
    ell('ai_head', head_r, (0, 0, 0), m_body, head)
    # 眼白 + 深色豆瞳（深色身体上纯黑豆眼读不出来）；无高光 = poker face
    for side in (-1, 1):
        p, n = on_surface(head_r, side * 4.8, -0.4)
        q = facing(n)
        rig.whites.append(ell(f'ai_white{side}', (2.6, 0.7, 3.1), tuple(p - n * 0.25), mats['white'], head, quat=q, seg=20, rings=10))
        p2, n2 = on_surface(head_r, side * 4.8 + 0.25 * side, -0.9)
        rig.eyes.append(ell(f'ai_eye{side}', (1.45, 0.6, 1.8), tuple(p2 + n2 * 0.28), mats['eye'], head, quat=facing(n2), seg=16, rings=8))
    _x_eyes(rig, head, head_r, 4.8, -0.6, 1.9, 0.55, mats['eye'])
    _mouth(rig, head, head_r, [(-2.0, -4.6), (2.0, -4.6)], 0.55, mats['mouth'])
    rig.snapshot()
    return rig


def fit_rig(rig, target_top_px, dirs=('s', 'e', 'n', 'w')):
    """把 IDLE_00 的屏幕最高点缩放到 target_top_px，返回四向最大宽度（px）。"""
    rig.fit.scale = (1, 1, 1)
    rig.pose('IDLE', 0, 's')
    top, _, _ = projected_bounds(rig)
    k = target_top_px / top
    rig.fit.scale = (k, k, k)
    width = 0.0
    ext = []
    for d in dirs:
        rig.pose('IDLE', 0, d)
        t, l, r = projected_bounds(rig)
        width = max(width, r - l)
        ext.append((d, round(t, 1), round(l, 1), round(r, 1)))
    rig.pose('IDLE', 0, 's')
    return k, width, ext


def projected_bounds(rig):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    top = -1e9
    left = 1e9
    right = -1e9
    for ob in rig.meshes():
        eo = ob.evaluated_get(dg)
        me = eo.to_mesh()
        mw = eo.matrix_world
        for v in me.vertices:
            x, y = C.project_px(mw @ v.co)
            top = max(top, y)
            left = min(left, x)
            right = max(right, x)
        eo.to_mesh_clear()
    return top, left, right


# ---------- 地形 ----------

def ball(name, r, loc, mat, parent, squash=(1.0, 1.0, 1.0), seg=24, rings=12, euler=None):
    """米制小球 / 椭球（地形装饰用）。"""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    bmesh.ops.scale(bm, vec=Vector(squash), verts=bm.verts)
    ob = C.mesh_from_bm(name, bm, mat, True, parent, Vector(loc))
    if euler is not None:
        ob.rotation_euler = Euler([math.radians(a) for a in euler], 'XYZ')
    return ob


SEAM = 0.016  # 石缝全宽（米）≈ 0.7 屏幕像素：缩小后是一条细线，不再是沟
GROUT_TOP = -0.012

# 同一种奶油石，4 种拼法（格坐标 [-0.5, 0.5]²，矩形 x0, y0, x1, y1；+y = 网格北）。
# 每块内缩半条缝 → 相邻格拼起来缝宽一致。pebbles = 嵌在缝交汇处的小圆石。
FLOOR_LAYOUTS = [
    {'rects': [(-.5, -.5, .12, .02), (.12, -.5, .5, .02), (-.5, .02, -.18, .5), (-.18, .02, .5, .5)],
     'pebbles': []},
    {'rects': [(-.5, -.5, .2, .22), (.2, -.5, .5, -.1), (.2, -.1, .5, .22), (-.5, .22, -.08, .5), (-.08, .22, .5, .5)],
     'pebbles': [(.2, .22, .046)]},
    {'rects': [(-.5, -.5, -.04, .5), (-.04, -.5, .5, -.14), (-.04, -.14, .26, .5), (.26, -.14, .5, .5)],
     'pebbles': [(-.04, -.14, .04)]},
    {'rects': [(-.5, -.5, .5, -.16), (-.5, -.16, .14, .5), (.14, -.16, .5, .2), (.14, .2, .5, .5)],
     'pebbles': [(.14, -.16, .044), (.14, .2, .034)]},
]


def build_floor(variant, pal):
    """地面：同一种奶油石按不同拼法铺，细缝、圆角、顶面微鼓，偶有小圆石嵌在缝交汇处。
    格心在原点，石面顶 z ≈ 0（角色脚不陷）；缝底略低形成浅槽。"""
    lay = FLOOR_LAYOUTS[variant]
    root = C.empty(f'floor{variant}')
    rnd = random.Random(101 + variant * 17)
    grout = C.principled(f'grout{variant}', pal['grout'], rough=0.9)
    C.box(f'floor{variant}_base', (1.0, 1.0, 0.04), (0, 0, GROUT_TOP - 0.02), grout, root)
    for i, (x0, y0, x1, y1) in enumerate(lay['rects']):
        hx = (x1 - x0) / 2 - SEAM / 2
        hy = (y1 - y0) / 2 - SEAM / 2
        tint = C.mix_hex(pal['slab'], pal['slab_alt'], rnd.random())
        m = C.stone(f'slab{variant}_{i}', tint)
        st = C.slab(f'floor{variant}_s{i}', hx, hy, -0.04, -0.0005 - rnd.random() * 0.0015, rnd.uniform(0.035, 0.055), 0.009, m, root,
                    ((x0 + x1) / 2, (y0 + y1) / 2, 0))
        st.rotation_euler = Euler((math.radians(rnd.uniform(-0.4, 0.4)), math.radians(rnd.uniform(-0.4, 0.4)),
                                   math.radians(rnd.uniform(-0.6, 0.6))), 'XYZ')
    peb = C.stone(f'pebble{variant}', pal['pebble'], rough=0.55)
    for j, (x, y, r) in enumerate(lay['pebbles']):
        C.slab(f'floor{variant}_p{j}', r, r, -0.04, -0.003, r, 0.008, peb, root, (x, y, 0), corner_seg=8)
    return root


def wall_h(px):
    """墙侧棱 px 像素对应的世界高度（米）。"""
    return px / C.COS30 * C.PX


WALL_H = wall_h(16)  # 0.408 m：最高档（画布 64×64、锚点 (32,32) 下顶角正好贴到 y=0）

# 绿篱 5 变体：高度 16 / 14 / 12 三档错落，深浅三档，植物 5 种。
# 平面占满整格（相邻墙拼成连续篱笆，缝里不露底）；顶上植物只长在格内、且不超过画布顶 —— 画布本身就保证了
# 「前排墙最多遮角色 16px」（03 §3.12 的保守界按画布顶算），所以变矮只会遮得更少。
WALL_SPECS = [
    {'key': 'W01', 'px': 16, 'shade': 'mid', 'deco': None},
    {'key': 'W02', 'px': 16, 'shade': 'deep', 'deco': 'flowers'},
    {'key': 'W03', 'px': 12, 'shade': 'mid', 'deco': 'topiary'},
    {'key': 'W04', 'px': 14, 'shade': 'light', 'deco': 'hydrangea'},
    {'key': 'W05', 'px': 14, 'shade': 'deep', 'deco': 'clover'},
]
WALL_DOME = 0.035


def _top_z(h, x, y, hx=0.5, hy=0.5):
    """绿篱顶面（含枕头鼓起）在 (x, y) 处的高度。"""
    return h + WALL_DOME * max(0.0, 1 - (x / hx) ** 2) * max(0.0, 1 - (y / hy) ** 2)


def build_wall(variant, pal):
    """绿篱：植绒软块（大圆角 + 顶面微鼓 + Sheen 绒光）+ 顶上不同植物。"""
    spec = WALL_SPECS[variant]
    h = wall_h(spec['px'])
    lo, hi = pal['hedge'][spec['shade']]
    root = C.empty(f'wall{variant}')
    m = C.felt(f'hedge{variant}', lo, hi, h, sheen_tint=pal['hedge_sheen'])
    blk = C.rbox(f'wall{variant}_block', 0.5, 0.5, 0.0, h, 0.075, 0.085, m, root, n=40, nz=12, k=6, dome=WALL_DOME)
    C.puff(blk, cell=0.1, strength=0.045, offset=(variant * 0.37, variant * 0.61, 0))
    rnd = random.Random(31 + variant * 7)
    deco = spec['deco']
    if deco == 'flowers':
        petal = [C.principled(f'petal{variant}a', '#FFFFFF', rough=0.5, spec=0.3),
                 C.principled(f'petal{variant}b', pal['flower_pink'], rough=0.5, spec=0.3)]
        heart = C.principled(f'heart{variant}', pal['flower_heart'], rough=0.45)
        spots = [(-0.24, -0.16), (0.16, -0.26), (0.04, 0.1), (-0.22, 0.24), (0.27, 0.18), (0.3, -0.04)]
        for k, (x, y) in enumerate(spots):
            z = _top_z(h, x, y) + 0.006
            mp = petal[1] if k % 3 == 1 else petal[0]
            a0 = rnd.random() * math.tau
            for p in range(5):
                a = a0 + p * math.tau / 5
                ball(f'flw{variant}_{k}_{p}', 0.026, (x + math.cos(a) * 0.028, y + math.sin(a) * 0.028, z), mp, root,
                     squash=(1.25, 0.95, 0.42), seg=12, rings=6, euler=(0, 0, math.degrees(a)))
            ball(f'flw{variant}_{k}_h', 0.017, (x, y, z + 0.006), heart, root, squash=(1, 1, 0.75), seg=10, rings=6)
    elif deco == 'topiary':
        lo2, hi2 = pal['hedge']['cool']
        for k, (x, y, r) in enumerate([(-0.17, 0.15, 0.17), (0.17, 0.08, 0.14), (-0.02, -0.19, 0.15)]):
            zc = _top_z(h, x, y) + r * 0.62
            mb = C.felt(f'topiary{variant}_{k}', lo2, hi2, zc + r, z_low=zc - r * 0.8, sheen_tint=pal['hedge_sheen'], sss=0.3)
            tb = ball(f'topiary{variant}_{k}', r, (x, y, zc), mb, root, squash=(1, 1, 0.94), seg=48, rings=24)
            C.puff(tb, cell=0.055, strength=0.03, offset=(k * 0.5, 0.2, 0))
    elif deco == 'hydrangea':
        cols = [C.principled(f'hyd{variant}_{i}', c, rough=0.55, spec=0.3) for i, c in enumerate(pal['hydrangea'])]
        leaf = C.felt(f'hydleaf{variant}', *pal['hedge']['deep'], h + 0.08, z_low=h, sheen_tint=pal['hedge_sheen'])
        for k, (x, y, r) in enumerate([(-0.16, 0.12, 0.085), (0.17, -0.1, 0.075), (0.2, 0.22, 0.06)]):
            zc = _top_z(h, x, y) + r * 0.45
            for j in range(4):
                a = j * math.tau / 4 + 0.4
                ball(f'hydl{variant}_{k}_{j}', r * 0.62, (x + math.cos(a) * r * 0.85, y + math.sin(a) * r * 0.85, _top_z(h, x, y) + 0.004),
                     leaf, root, squash=(1.3, 0.8, 0.3), seg=12, rings=6, euler=(0, 0, math.degrees(a)))
            n = 22
            for j in range(n):
                # 斐波那契上半球：小花球铺成绣球团
                t = (j + 0.5) / n
                el = math.asin(t)
                az = j * 2.39996
                d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
                ball(f'hyd{variant}_{k}_{j}', r * 0.36, Vector((x, y, zc)) + d * r * 0.78, cols[rnd.randrange(len(cols))], root,
                     seg=10, rings=6)
    elif deco == 'clover':
        leafm = C.felt(f'clover{variant}', *pal['clover'], h + 0.06, z_low=h, sheen_tint='#FBFFE8', bump=0.1)
        bloom = C.principled(f'cbloom{variant}', '#FFFFFF', rough=0.55, spec=0.3)
        for k, (x, y) in enumerate([(-0.2, 0.14), (0.18, -0.16), (0.12, 0.24), (-0.12, -0.24)]):
            z = _top_z(h, x, y) + 0.008
            a0 = rnd.random() * math.tau
            for j in range(3 if k % 2 else 4):
                a = a0 + j * math.tau / (3 if k % 2 else 4)
                ball(f'clv{variant}_{k}_{j}', 0.05, (x + math.cos(a) * 0.045, y + math.sin(a) * 0.045, z + 0.012), leafm, root,
                     squash=(1.0, 0.85, 0.28), seg=14, rings=7, euler=(0, -16, math.degrees(a)))
            if k == 0:
                ball(f'clvb{variant}', 0.03, (x, y, z + 0.05), bloom, root, seg=12, rings=8)
    return root


def tile_bounds(root):
    """地形 sprite 的屏幕包围（px，相对锚点；up 为正）：用于确认没有东西长出 64×64 画布。"""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    top, left, right = -1e9, 1e9, -1e9
    for ob in C.descendants(root):
        if ob.type != 'MESH':
            continue
        eo = ob.evaluated_get(dg)
        me = eo.to_mesh()
        for v in me.vertices:
            x, y = C.project_px(eo.matrix_world @ v.co)
            top, left, right = max(top, y), min(left, x), max(right, x)
        eo.to_mesh_clear()
    return round(top, 1), round(left, 1), round(right, 1)


# ---------- 屏幕包围 ----------

def bounds2d(objs):
    """一组网格的屏幕包围（px，相对世界原点；up 为正）→ (left, right, bottom, top)。"""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    l, r, b, t = 1e9, -1e9, 1e9, -1e9
    for ob in objs:
        if ob.type not in ('MESH', 'CURVE'):
            continue
        eo = ob.evaluated_get(dg)
        me = eo.to_mesh()
        for v in me.vertices:
            x, y = C.project_px(eo.matrix_world @ v.co)
            l, r, b, t = min(l, x), max(r, x), min(b, y), max(t, y)
        eo.to_mesh_clear()
    return l, r, b, t


# ---------- 宝石 ----------
# 五颗外形在灰度下两两可分（03 §1.4）：红 竖长双锥 1:1.7 · 黄 六角鼓包星（唯一凹多边形）·
# 绿 切角方阶梯切 · 蓝 水滴（纯曲线）· 紫 扁六边板 1.6:1。
# 统一「硬糖」材质；平板类宝石竖立并略后仰朝向镜头，正面朝 -Y（yaw 45° 时正对相机）。

GEM_KEYS = ('RUBY', 'CITRINE', 'EMERALD', 'SAPPHIRE', 'AMETHYST')


def _plate(name, outline, profile, mat, parent, smooth=False, cap=None):
    """竖立的「板状」宝石：outline 为正面轮廓 (u 横, v 竖)，围绕原点、逆时针；
    profile = [(缩放, 厚度半值), …] 从腰线到台面；正反两面对称。cap = 中心点厚度（默认 = 最后一圈）。
    中心用扇形封口 —— 轮廓只要对原点星形可见（星、凸多边形都满足）就不会翻面。"""
    bm = bmesh.new()
    n = len(outline)

    def ring(s, d):
        return [bm.verts.new(V(u * s, d, v * s)) for u, v in outline]

    front = [ring(s, -d) for s, d in profile]
    back = [ring(s, d) for s, d in profile]

    def bridge(a, b):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))

    bridge(back[0], front[0])
    for k in range(len(profile) - 1):
        bridge(front[k], front[k + 1])
        bridge(back[k + 1], back[k])
    cd = profile[-1][1] if cap is None else cap
    for rings, sgn in ((front, -1), (back, 1)):
        c = bm.verts.new(V(0, sgn * cd, 0))
        last = rings[-1]
        for i in range(n):
            bm.faces.new((last[i], last[(i + 1) % n], c))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return C.mesh_from_bm(name, bm, mat, smooth, parent)


def _ruby_mesh(m, parent):
    """竖长双锥（宽:高≈1:1.7），8 刻面腰线 + 两段冠部，剪影是上下出尖的菱形。
    r 按 yaw 45° 下的屏幕投影定：八边形腰线斜看会变宽，r=5.5 时屏幕宽高比 ≈ 0.6。"""
    bm = bmesh.new()
    h, r, n = 21.0, 5.5, 8
    z0 = -h * 0.5
    zg = 0.0
    top = bm.verts.new(V(0, 0, z0 + h))
    bot = bm.verts.new(V(0, 0, z0))
    angs = [k * 2 * math.pi / n for k in range(n)]
    girdle = [bm.verts.new(V(r * math.cos(a), r * math.sin(a), zg)) for a in angs]
    crown = [bm.verts.new(V(r * 0.52 * math.cos(a + math.pi / n), r * 0.52 * math.sin(a + math.pi / n), zg + h * 0.3)) for a in angs]
    for i in range(n):
        g0, g1 = girdle[i], girdle[(i + 1) % n]
        c0, c1 = crown[i], crown[(i + 1) % n]
        bm.faces.new((g0, g1, c0))
        bm.faces.new((c0, g1, c1))
        bm.faces.new((c0, c1, top))
        bm.faces.new((g1, g0, bot))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return C.mesh_from_bm('gem_RUBY_mesh', bm, m, False, parent)


def _citrine_mesh(m, parent):
    """六角鼓包星：12 角（6 凸 6 凹），边缘圆鼓、正面微拱 —— 像一颗软糖星星。"""
    R, r = 10.6, 5.9
    outline = []
    for k in range(12):
        a = math.radians(90 + k * 30)
        rr = R if k % 2 == 0 else r
        outline.append((rr * math.cos(a), rr * math.sin(a)))
    T = 2.6
    prof = [(1 - 0.2 * (1 - math.cos(t)), T * max(0.08, math.sin(t))) for t in (math.radians(d) for d in (0, 22, 45, 68, 90))]
    prof += [(0.6, T * 1.12), (0.38, T * 1.2), (0.18, T * 1.24)]
    return _plate('gem_CITRINE_mesh', outline, prof, m, parent, smooth=True, cap=T * 1.25)


def _emerald_mesh(m, parent):
    """切角方 · 阶梯切：八边形轮廓，正反各两级台阶刻面 + 平台面。"""
    w, h, c = 8.2, 8.6, 2.7
    outline = [(w - c, h), (-(w - c), h), (-w, h - c), (-w, -(h - c)), (-(w - c), -h), (w - c, -h), (w, -(h - c)), (w, h - c)]
    prof = [(1.0, 0.7), (0.86, 2.1), (0.72, 2.95), (0.6, 3.3)]
    return _plate('gem_EMERALD_mesh', outline, prof, m, parent)


def _amethyst_mesh(m, parent):
    """扁六边板：左右出尖的横长六边形（宽:高 1.6:1），一级刻面 + 平台面。"""
    W, H = 10.9, 6.9
    outline = [(W, 0), (W * 0.56, H), (-W * 0.56, H), (-W, 0), (-W * 0.56, -H), (W * 0.56, -H)]
    prof = [(1.0, 0.6), (0.78, 2.3), (0.62, 2.75)]
    return _plate('gem_AMETHYST_mesh', outline, prof, m, parent)


def _sapphire_mesh(m, parent):
    """水滴：上尖下圆的旋转体，剪影只有曲线。"""
    bm = bmesh.new()
    Hd, Rr, seg, rings = 22.0, 7.6, 40, 28
    prof = []
    for i in range(rings + 1):
        t = math.pi * i / rings
        z = Hd * (math.cos(t) * 0.5)  # t=0 顶（+Hd/2）→ t=π 底（−Hd/2）
        rad = Rr * math.sin(t) * math.sin(t / 2) ** 1.15 / 0.69
        prof.append((rad, z))
    top = bm.verts.new(V(0, 0, prof[0][1]))
    bot = bm.verts.new(V(0, 0, prof[-1][1]))
    loops = []
    for rad, z in prof[1:-1]:
        loops.append([bm.verts.new(V(rad * math.cos(2 * math.pi * k / seg), rad * math.sin(2 * math.pi * k / seg), z)) for k in range(seg)])
    for k in range(seg):
        j = (k + 1) % seg
        bm.faces.new((top, loops[0][k], loops[0][j]))
        bm.faces.new((bot, loops[-1][j], loops[-1][k]))
    for a, b in zip(loops, loops[1:]):
        for k in range(seg):
            j = (k + 1) % seg
            bm.faces.new((a[k], b[k], b[j], a[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return C.mesh_from_bm('gem_SAPPHIRE_mesh', bm, m, True, parent)


_GEM_MESH = {'RUBY': _ruby_mesh, 'CITRINE': _citrine_mesh, 'EMERALD': _emerald_mesh,
             'SAPPHIRE': _sapphire_mesh, 'AMETHYST': _amethyst_mesh}
# 平板类后仰（度）：让正面多朝镜头一点，少被 30° 俯角压扁
_GEM_TILT = {'RUBY': 0.0, 'CITRINE': 14.0, 'EMERALD': 14.0, 'SAPPHIRE': 0.0, 'AMETHYST': 14.0}
GEM_LIFT = [0, 1, 2, 1]     # 悬浮（px）
GEM_YAW = [0, 9, 0, -9]     # 小幅转动：高光随之扫过
GEM_ROLL = [0, 3, 0, -3]    # 水滴是旋转体，单靠 yaw 高光不动，再加一点左右摆


class Gem:
    """root（悬浮高度）→ pivot（朝向 / 后仰 / 摆动 + 缩放，绕宝石中心）→ 网格（以中心为原点建）。"""

    def __init__(self, key, color):
        self.key = key
        self.root = C.empty(f'gem_{key}')
        self.pivot = C.empty(f'gem_{key}_pivot', parent=self.root)
        # 清漆压低：亮天空在清漆里的反射会把宝石整体洗白（实测饱和度掉 0.1–0.2）；保留低粗糙度出锐利小高光
        self.mat = C.principled(f'gem_{key}', color, rough=0.14, coat=0.18, coat_rough=0.04, spec=0.32, emit=0.1)
        self.mesh = _GEM_MESH[key](self.mat, self.pivot)
        self.k = 1.0
        self.base_z = 0.0

    def pose(self, frame=0, lift=True):
        self.pivot.rotation_euler = Euler((math.radians(-_GEM_TILT[self.key]), math.radians(GEM_ROLL[frame]),
                                           math.radians(45 + GEM_YAW[frame])), 'XYZ')
        self.pivot.scale = (self.k, self.k, self.k)
        self.root.location = (0, 0, self.base_z + ((GEM_LIFT[frame] * C.PX / C.COS30) if lift else 0.0))

    def fit(self, max_h=20.0, max_w=18.0, bottom=2.0):
        """frame 0 下缩放到不超过 max_h × max_w（屏幕 px），并把最低点抬到锚点上方 bottom px。"""
        self.k, self.base_z = 1.0, 0.0
        self.pose(0)
        l, r, b, t = bounds2d([self.mesh])
        self.k = min(max_h / (t - b), max_w / (r - l))
        self.pose(0)
        l, r, b, t = bounds2d([self.mesh])
        self.base_z = (bottom - b) * C.PX / C.COS30
        self.pose(0)
        l, r, b, t = bounds2d([self.mesh])
        return {'w': round(r - l, 1), 'h': round(t - b, 1), 'bottom': round(b, 1), 'aspect': round((r - l) / (t - b), 2)}


def build_gems(colors):
    return [Gem(k, c) for k, c in zip(GEM_KEYS, colors)]


# ---------- 宝箱 ----------
# 软胶玩具宝箱：圆角木箱身（开口壳体 + 暗色内底）+ 半圆拱盖（绕后上棱开合）+ 哑金箍条 + 锁扣。
# 8 帧（03 §3.6）：00 闭合 · 01 呼吸压缩 + 锁扣闪 · 02–04 开盖 35/70/100° · 05 迸发（盖过冲 + 宝光最亮）·
# 06 迸发回落 · 07 空箱。星芒由特效层画，图里只给宝光。

CHEST_LID = [0, 0, 35, 70, 100, 110, 100, 100]
CHEST_GLOW = [0, 0, 0.6, 1.2, 2.0, 5.0, 3.0, 0]


def _extrude(name, prof, x0, x1, mat, parent, loc=(0, 0, 0)):
    """把 y-z 平面的闭合轮廓（逆时针，屏幕像素单位）沿 x 从 x0 拉到 x1，两端平盖。"""
    bm = bmesh.new()
    a = [bm.verts.new(V(x0, y, z)) for y, z in prof]
    b = [bm.verts.new(V(x1, y, z)) for y, z in prof]
    n = len(prof)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(list(reversed(a)))
    bm.faces.new(b)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = C.mesh_from_bm(name, bm, mat, True, parent, V(*loc))
    bv = ob.modifiers.new('Bevel', 'BEVEL')
    bv.width = 0.55 * U
    bv.segments = 3
    bv.limit_method = 'ANGLE'
    bv.angle_limit = math.radians(40)
    bv.harden_normals = True
    return ob


def _arch(hy, lip, rise, y0=0.0, n=14):
    """拱盖横截面（y-z）：前沿竖边 lip → 椭圆拱 rise → 后沿竖边，底边闭合。y0 = 截面中心的 y。"""
    pts = [(y0 - hy, 0.0), (y0 - hy, lip)]
    for i in range(1, n):
        t = math.pi * i / n
        pts.append((y0 - hy * math.cos(t), lip + rise * math.sin(t)))
    pts += [(y0 + hy, lip), (y0 + hy, 0.0)]
    return pts


class Chest:
    def __init__(self, pal):
        self.root = C.empty('chest')
        self.fit_ob = C.empty('chest_fit', parent=self.root)
        self.k = 1.0
        wood = C.vinyl('chest_wood', pal['wood'], rough=0.5)
        lidm = C.vinyl('chest_lidwood', pal['lid'], rough=0.45)
        trim = C.principled('chest_trim', pal['trim'], rough=0.32, metallic=0.55, coat=0.35, coat_rough=0.2, spec=0.5)
        inner = C.principled('chest_inner', pal['inner'], rough=0.85)
        lid_in = C.principled('chest_lid_in', C.mix_hex(pal['wood'], '#2A1E16', 0.45), rough=0.8)
        self.lock_m = C.principled('chest_lock', pal['lock'], rough=0.28, metallic=0.4, coat=0.4, emit=0.0, emit_color='#FFF6D8')
        self.glow_m = C.principled('chest_glow', pal['glow'], rough=0.3, metallic=0.3, emit=0.0, emit_color=pal['glow'])
        a, b, H = 10.0, 7.4, 12.5
        self.a, self.b, self.H = a, b, H
        # 箱身：开口圆角壳体，向内加厚 → 有壁厚的箱口
        body = C.rbox('chest_body', a * U, b * U, 0.0, H * U, 2.4 * U, 0.0, wood, self.fit_ob, n=10, nz=4, k=4, top=False)
        so = body.modifiers.new('Solid', 'SOLIDIFY')
        so.thickness = 1.3 * U
        so.offset = -1
        so.use_even_offset = True
        C.box('chest_floor', ((2 * a - 2.4) * U, (2 * b - 2.4) * U, 0.3 * U), (0, 0, H * 0.35 * U), inner, self.fit_ob)
        # 竖箍（前后各两条）+ 箱口沿
        for sx in (-1, 1):
            for sy in (-1, 1):
                C.box(f'chest_band{sx}{sy}', (2.3 * U, 0.7 * U, (H - 0.2) * U), (sx * a * 0.56 * U, sy * (b + 0.2) * U, (H - 0.2) * 0.5 * U),
                      trim, self.fit_ob, bevel=0.25 * U, segments=2)
        # 锁扣（箱身前沿正中）+ 锁孔
        self.lock = C.box('chest_lock', (3.4 * U, 0.9 * U, 4.0 * U), (0, -(b + 0.35) * U, (H - 1.9) * U), self.lock_m, self.fit_ob,
                          bevel=0.5 * U, segments=3)
        ell('chest_keyhole', (0.55, 0.3, 0.9), (0, -(b + 0.8), H - 2.3), inner, self.fit_ob, seg=12, rings=6)
        # 宝物堆：金币 + 一颗宝光球（02–06 可见，07 收起）
        self.pile = C.empty('chest_pile', V(0, 0, H * 0.35), self.fit_ob)
        coin = C.principled('chest_coin', pal['coin'], rough=0.3, metallic=0.6, coat=0.3, emit=0.0)
        self.coin_m = coin
        rnd = random.Random(5)
        for i in range(16):
            x = rnd.uniform(-a + 3.4, a - 3.4)
            y = rnd.uniform(-b + 3.2, b - 3.2)
            z = H * 0.65 - 2.3 + 2.2 * (1 - (x / a) ** 2) * (1 - (y / b) ** 2) + rnd.uniform(-0.4, 0.4)
            ell(f'chest_coin{i}', (1.7, 1.7, 0.5), (x, y, z), coin, self.pile, euler=(rnd.uniform(-25, 25), rnd.uniform(-25, 25), 0), seg=14, rings=6)
        ell('chest_orb', (2.6, 2.6, 2.6), (1.5, 0.5, H * 0.65 - 0.2), self.glow_m, self.pile, seg=24, rings=12)
        # 拱盖：绕后上棱（y=+b, z=H）转
        self.hinge = C.empty('chest_hinge', V(0, b, H), self.fit_ob)
        lb = b + 0.45
        _extrude('chest_lid', _arch(lb, 1.4, 4.6, y0=-b), -(a + 0.45), a + 0.45, lidm, self.hinge)
        # 盖内面（开盖后朝镜头）：暗色薄板贴在盖底下
        C.box('chest_lid_under', ((2 * a + 0.3) * U, (2 * lb - 0.6) * U, 0.25 * U), (0, -b * U, -0.1 * U), lid_in, self.hinge)
        for sx in (-1, 1):
            _extrude(f'chest_lidband{sx}', _arch(lb + 0.35, 1.5, 4.95, y0=-b), sx * a * 0.56 - 1.15, sx * a * 0.56 + 1.15, trim, self.hinge,
                     loc=(0, 0, 0.05))
        _extrude('chest_lidrim', _arch(lb + 0.3, 1.25, 0.0, y0=-b, n=2)[:2] + [(-b - lb + 1.0, 1.25), (-b - lb + 1.0, 0.0)],
                 -(a + 0.6), a + 0.6, trim, self.hinge)

    def meshes(self):
        return [o for o in C.descendants(self.root) if o.type == 'MESH']

    def pose(self, frame):
        self.root.rotation_euler = Euler((0, 0, math.radians(25)), 'XYZ')
        sq = (1.03, 1.03, 0.95) if frame == 1 else (1.0, 1.0, 1.0)
        self.fit_ob.scale = tuple(self.k * s for s in sq)
        self.hinge.rotation_euler = Euler((math.radians(-CHEST_LID[frame]), 0, 0), 'XYZ')
        self.lock_m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 1.6 if frame == 1 else 0.0
        g = CHEST_GLOW[frame]
        for m, k in ((self.glow_m, 1.0), (self.coin_m, 0.25)):
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = g * k
        self.pile.scale = (1, 1, 1) if 2 <= frame <= 6 else HIDE

    def fit(self, top_px=24.0, max_w=30.0):
        self.k = 1.0
        self.pose(0)
        l, r, b, t = bounds2d(self.meshes())
        self.k = min(top_px / t, max_w / (r - l))
        out = {}
        for f in (0, 4, 5):
            self.pose(f)
            l, r, b, t = bounds2d(self.meshes())
            out[f] = {'top': round(t, 1), 'w': round(r - l, 1), 'left': round(l, 1), 'right': round(r, 1)}
        self.pose(0)
        return out


# ---------- 出口 ----------
# 地面传送台：外圈圆角方石（座位色，与地面齐平）→ 白色嵌环 → 两级下沉台阶 → 中心发光圆钮。
# 全部 ≤ 地面高度（03 §3.8「不得有高出地面的造型」）；座位色同一常量（ACTOR_COLORS），只换材质色。

def _band(name, r_out, r_in, z_top, z_bot, mat, parent, n=96):
    """环带：外轮廓 r_out(θ)、内圆 r_in，顶面 z_top，内外壁下到 z_bot（米）。"""
    bm = bmesh.new()
    angs = [2 * math.pi * i / n for i in range(n)]
    ot = [bm.verts.new((r_out(a) * math.cos(a), r_out(a) * math.sin(a), z_top)) for a in angs]
    ob = [bm.verts.new((r_out(a) * math.cos(a), r_out(a) * math.sin(a), z_bot)) for a in angs]
    it = [bm.verts.new((r_in * math.cos(a), r_in * math.sin(a), z_top)) for a in angs]
    ib = [bm.verts.new((r_in * math.cos(a), r_in * math.sin(a), z_bot)) for a in angs]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((it[i], it[j], ot[j], ot[i]))
        bm.faces.new((ot[i], ot[j], ob[j], ob[i]))
        bm.faces.new((ib[i], ib[j], it[j], it[i]))
        bm.faces.new((ob[i], ob[j], ib[j], ib[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = C.mesh_from_bm(name, bm, mat, False, parent)
    wn = me.modifiers.new('WN', 'WEIGHTED_NORMAL')
    wn.weight = 100
    return me


def _squircle(R, p=4.0):
    return lambda a: R / (abs(math.cos(a)) ** p + abs(math.sin(a)) ** p) ** (1 / p)


EXIT_R = [0.455, 0.355, 0.315, 0.235, 0.15]   # 外圈方石 / 白环 / 一级台 / 二级台 / 中心钮
EXIT_Z = [0.0, -0.0015, -0.034, -0.068, -0.1]


class ExitPad:
    def __init__(self):
        self.root = C.empty('exit')
        self.m = {k: C.vinyl(f'exit_{k}', '#FFFFFF', rough=r) for k, r in (('white', 0.4), ('step1', 0.45), ('step2', 0.45))}
        # 外圈 = 「出口色 = 座位色」的承载面：哑光、无清漆无高光（清漆会映出亮天空把座位色洗白，实测 ΔE 达 23）
        self.m['rim'] = C.principled('exit_rim', '#FFFFFF', rough=0.95, spec=0.0)
        self.m['core'] = C.principled('exit_core', '#FFFFFF', rough=0.25, coat=0.6, coat_rough=0.08, emit=0.0)
        zb = -0.14
        _band('exit_rim', _squircle(EXIT_R[0]), EXIT_R[1], EXIT_Z[0], zb, self.m['rim'], self.root)
        _band('exit_white', lambda a: EXIT_R[1] + 0.003, EXIT_R[2], EXIT_Z[1], zb, self.m['white'], self.root)
        _band('exit_step1', lambda a: EXIT_R[2] + 0.003, EXIT_R[3], EXIT_Z[2], zb, self.m['step1'], self.root)
        _band('exit_step2', lambda a: EXIT_R[3] + 0.003, EXIT_R[4], EXIT_Z[3], zb, self.m['step2'], self.root)
        C.slab('exit_floor', EXIT_R[4] + 0.003, EXIT_R[4] + 0.003, zb, EXIT_Z[4], EXIT_R[4], 0.004, self.m['step2'], self.root, corner_seg=12)
        core = ball('exit_core', EXIT_R[4] * 0.72, (0, 0, EXIT_Z[4]), self.m['core'], self.root, squash=(1, 1, 0.42), seg=40, rings=16)
        core.name = 'exit_core'

    def color(self, c, rim_k=(1.0, 1.0, 1.0)):
        """c = 座位色；rim_k = 外圈材质色逐通道（线性）补偿，使渲染后顶面 ≈ 常量（由实测回填）。"""
        def lin(hex_str, k):
            return tuple(min(1.0, x * kk) for x, kk in zip(C.rgb(hex_str)[:3], k)) + (1.0,)
        bs = lambda m: m.node_tree.nodes['Principled BSDF']  # noqa: E731
        bs(self.m['rim']).inputs['Base Color'].default_value = lin(c, rim_k)
        bs(self.m['white']).inputs['Base Color'].default_value = C.rgb('#FFFFFF')
        bs(self.m['step1']).inputs['Base Color'].default_value = C.rgb(C.mix_hex(c, '#FFFFFF', 0.38))
        bs(self.m['step2']).inputs['Base Color'].default_value = C.rgb(c)
        core = bs(self.m['core'])
        core.inputs['Base Color'].default_value = C.rgb(C.mix_hex(c, '#FFFFFF', 0.6))
        core.inputs['Emission Color'].default_value = C.rgb(C.mix_hex(c, '#FFFFFF', 0.45))
        core.inputs['Emission Strength'].default_value = 0.55


# ---------- 地面装饰 ----------
# 3 种，非阻挡、贴地（最高 ≈2.5px），烘进静态层；颜色不碰宝石的饱和色，不长在格心（角色脚下）。
# D1 草簇 + 小雏菊 · D2 落花瓣 · D3 苔藓 + 卵石。接触阴影单独渲一张，打包时垫在下面合成一张 sprite。

def _blade(name, x, y, h, lean, yaw, mat, parent, w=0.022):
    return ball(name, w, (x + math.cos(yaw) * lean * h * 0.5, y + math.sin(yaw) * lean * h * 0.5, h * 0.42), mat, parent,
                squash=(1.0, 0.4, h / w * 0.5), seg=10, rings=8,
                euler=(0, math.degrees(math.atan(lean)), math.degrees(yaw)))


def _daisy(name, x, y, z, s, petal, heart, parent, rnd):
    a0 = rnd.random() * math.tau
    for p in range(7):
        a = a0 + p * math.tau / 7
        ball(f'{name}_p{p}', 0.011 * s, (x + math.cos(a) * 0.012 * s, y + math.sin(a) * 0.012 * s, z), petal, parent,
             squash=(1.5, 0.75, 0.4), seg=10, rings=6, euler=(0, 0, math.degrees(a)))
    ball(f'{name}_h', 0.0075 * s, (x, y, z + 0.003 * s), heart, parent, squash=(1, 1, 0.7), seg=10, rings=6)


def build_deco(variant, pal):
    """尺寸按 1× 可读定：单簇 6–10px，最高 ≈4px；都偏在格子的一侧，格心留给角色脚下。
    坐标是格内米制（+x 屏幕右下、+y 屏幕右上）。"""
    root = C.empty(f'deco{variant}')
    rnd = random.Random(400 + variant * 13)
    if variant == 0:
        grass = C.felt('deco_grass', *pal['deco_grass'], 0.11, z_low=0.0, sheen_tint=pal['hedge_sheen'], bump=0.05)
        petal = C.principled('deco_daisy', '#FFFFFF', rough=0.5, spec=0.3)
        heart = C.principled('deco_heart', pal['flower_heart'], rough=0.45)
        for ci, (cx, cy, nb, hs) in enumerate([(-0.24, 0.2, 10, 1.0), (0.26, -0.16, 7, 0.8)]):
            for j in range(nb):
                yaw = j * math.tau / nb + rnd.uniform(-0.3, 0.3)
                d = rnd.uniform(0.0, 0.045)
                _blade(f'deco0_b{ci}_{j}', cx + math.cos(yaw) * d, cy + math.sin(yaw) * d, rnd.uniform(0.075, 0.11) * hs,
                       rnd.uniform(0.3, 0.55), yaw, grass, root)
        # 雏菊开在草簇顶上（不悬空），另一朵平躺在石面上
        for k, (x, y, z, s) in enumerate([(-0.21, 0.24, 0.085, 2.0), (-0.29, 0.15, 0.06, 1.6), (0.27, -0.13, 0.065, 1.8), (0.0, 0.32, 0.008, 1.7)]):
            _daisy(f'deco0_d{k}', x, y, z, s, petal, heart, root, rnd)
    elif variant == 1:
        mats = [C.principled(f'deco_petal{i}', c, rough=0.5, spec=0.3) for i, c in enumerate(pal['deco_petals'])]
        leaf = C.felt('deco_leaf', *pal['deco_grass'], 0.012, z_low=0.0, sheen_tint=pal['hedge_sheen'], bump=0.04)
        # 一阵风吹落的花瓣：沿一条斜带散开（左上密、右下疏）
        for k in range(12):
            t = k / 11
            x = -0.32 + 0.5 * t + rnd.uniform(-0.06, 0.06)
            y = 0.28 - 0.18 * t + rnd.uniform(-0.09, 0.09)
            ball(f'deco1_p{k}', 0.032, (x, y, 0.006), mats[k % len(mats)], root, squash=(1.4, 0.85, 0.22), seg=14, rings=6,
                 euler=(rnd.uniform(-10, 10), rnd.uniform(-10, 10), rnd.uniform(0, 180)))
        for k, (x, y) in enumerate([(-0.3, 0.06), (0.22, 0.24)]):
            ball(f'deco1_l{k}', 0.045, (x, y, 0.006), leaf, root, squash=(1.5, 0.72, 0.2), seg=14, rings=6, euler=(0, 0, rnd.uniform(0, 180)))
    else:
        moss = C.felt('deco_moss', *pal['deco_moss'], 0.05, z_low=0.0, sheen_tint=pal['hedge_sheen'], bump=0.12, sss=0.2)
        stone = [C.stone('deco_pebble0', pal['deco_pebbles'][0], rough=0.5), C.stone('deco_pebble1', pal['deco_pebbles'][1], rough=0.5)]
        # 苔藓沿左侧角弧形铺开（小而浅：与绿篱同色系，铺大了会读成一截矮墙），卵石三颗聚在右下
        for k in range(8):
            t = k / 7
            x = -0.36 + 0.2 * t + rnd.uniform(-0.025, 0.025)
            y = 0.0 + 0.3 * math.sin(t * 2.4) + rnd.uniform(-0.025, 0.025)
            r = rnd.uniform(0.034, 0.05)
            ball(f'deco2_m{k}', r, (x, y, r * 0.12), moss, root, squash=(1.1, 1.0, 0.4), seg=18, rings=8)
        for k, (x, y, r) in enumerate([(0.2, -0.22, 0.072), (0.33, -0.06, 0.052), (0.08, -0.34, 0.042)]):
            ball(f'deco2_s{k}', r, (x, y, r * 0.35), stone[k % 2], root, squash=(1.15, 0.95, 0.62), seg=24, rings=12,
                 euler=(0, 0, rnd.uniform(0, 180)))
    return root


# ---------- 场外布景（地图菱形之外，只烘进静态层） ----------
# 地图 = 一块抬高的台地：朝镜头的两条边（SW / SE）露出土崖，场外地面比地图低 CLIFF_PX；四周是圆冠密林 + 塔松 + 灌木 + 石块。
# 不进地图格子 → 不占需求 #7 的 12 个 tile 变体名额。尺寸单位 = 世界像素（× U 成米），画布由包围盒自动定。

CLIFF_PX = 28                # 土崖在屏幕上的高度（px）；tools/gallery/pilot.js 的 CLIFF 必须同值
CLIFF_Z = wall_h(CLIFF_PX)   # 世界高度（米）
CLIFF_OV = 0.05              # 每段两端各多出的长度（米）：相邻段叠 ≈1.6px，接缝不露底
CLIFF_BANDS = (0.34, 0.68)   # 地层分界（自顶向下的比例）
CLIFF_LIP = 0.05             # 崖顶草皮卷边半径（米，≈2.3px）
CLIFF_RC = 1 / math.tau      # 细纹理的「沿边坐标 → 圆周」半径：周长 = 1 格，纹理按格周期平铺

ENV_SPECS = [
    {'key': 'TREE01', 'kind': 'tree', 'r': 20, 'zc': 34, 'shade': 'a', 'lobes': 4},
    {'key': 'TREE02', 'kind': 'tree', 'r': 17, 'zc': 28, 'shade': 'b', 'lobes': 3},
    {'key': 'TREE03', 'kind': 'tree', 'r': 13, 'zc': 21, 'shade': 'c', 'lobes': 3},
    {'key': 'TREE04', 'kind': 'tree', 'r': 19, 'zc': 31, 'shade': 'c', 'lobes': 4},
    {'key': 'PINE01', 'kind': 'pine', 'r': 13, 'h': 56, 'shade': 'pine'},
    {'key': 'BUSH01', 'kind': 'bush', 'r': 10, 'shade': 'bush', 'flowers': 0},
    {'key': 'BUSH02', 'kind': 'bush', 'r': 8, 'shade': 'bush', 'flowers': 6},
    {'key': 'ROCK01', 'kind': 'rock', 'r': 8},
    # 地标（只摆在左上 / 右上场外，样张页手工定点）：山墙小屋 / 蘑菇圆屋 / 圆木塔 / 石堆 ×2 / 发光玉石 ×2。
    # 造型参照用户给的三张参考图（童话村落 + 低多边形等距小景），尺寸单位 = 屏幕像素；见下方「地标」段的说明。
    {'key': 'CABIN01', 'kind': 'cottage', 'hx': 21, 'hy': 15, 'wall': 14, 'pitch': 50, 'eave': 5, 'gable_eave': 3, 'roof': 'a'},
    {'key': 'CABIN02', 'kind': 'roundhouse', 'r': 20, 'wall': 19, 'cap': 28, 'flare': 1.45, 'roof': 'b'},
    {'key': 'TOWER01', 'kind': 'tower', 'r': 12, 'h': 48, 'cap': 40},
    {'key': 'STONES01', 'kind': 'stones', 'form': 'pile'},
    {'key': 'STONES02', 'kind': 'stones', 'form': 'cairn'},
    # 玉晶：(半径, 柱高, 尖高, 倾角°, 方位°, 离中心距离)；石座：(x, y, r)；悬浮碎晶：(方位°, 离中心距离, 离地高, 半径)
    {'key': 'JADE01', 'kind': 'jade',
     'crystals': [(11, 40, 15, 4, 120, 0), (7, 22, 10, 18, 100, 9.5), (6, 16, 8, 26, 210, 10), (4.5, 10, 6, 34, 320, 10)],
     'rocks': [(-10, 9, 7.5), (11, 6, 6.2), (4, -12, 5.2), (-9, -7, 4.4)],
     'float': [(40, 17, 34, 2.4), (200, 16, 46, 2.0), (300, 15, 22, 1.7)]},
    {'key': 'JADE02', 'kind': 'jade',
     'crystals': [(12, 32, 15, 9, 300, 0), (5.5, 13, 7, 30, 150, 11), (4.5, 9, 6, 36, 240, 11)],
     'rocks': [(-9, 10, 7.6), (12, 4, 6.0), (-3, -12, 4.8)],
     'float': [(60, 16, 30, 2.2), (220, 15, 40, 1.8)]},
]
CLIFF_KINDS = ('SW', 'SE')
CLIFF_VARIANTS = 3


def _smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def _tree(spec, pal, root, rnd):
    """圆冠树：短树干 + 一大团主冠 + 3–4 个侧团 + 1 个顶团（植绒，蓬松起伏），读作参考图里一簇簇的圆树冠。"""
    key = spec['key']
    env = pal['env']
    r = spec['r'] * U
    zc = spec['zc'] * U
    bark = C.principled(f'env_{key}_bark', env['trunk'], rough=0.8, spec=0.3)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=14, radius1=r * 0.17, radius2=r * 0.11, depth=zc)
    bmesh.ops.translate(bm, vec=Vector((0, 0, zc / 2)), verts=bm.verts)
    C.mesh_from_bm(f'env_{key}_trunk', bm, bark, True, root)
    ball(f'env_{key}_root', r * 0.22, (0, 0, r * 0.03), bark, root, squash=(1.25, 1.25, 0.4), seg=16, rings=8)
    lo, hi = env['canopy'][spec['shade']]
    leaf = C.felt(f'env_{key}_leaf', lo, hi, zc + r * 1.25, z_low=zc - r * 0.9, sheen=0.55, sheen_tint=env['sheen'],
                  bump=0.16, sss=0.15)
    parts = [(0.0, 0.0, 0.0, 1.0)]
    n = spec['lobes']
    a0 = rnd.uniform(0, math.tau)
    for i in range(n):
        a = a0 + i * math.tau / n + rnd.uniform(-0.35, 0.35)
        d = rnd.uniform(0.48, 0.62)
        parts.append((math.cos(a) * d, math.sin(a) * d, rnd.uniform(-0.28, 0.02), rnd.uniform(0.56, 0.7)))
    parts.append((rnd.uniform(-0.18, 0.06), rnd.uniform(-0.06, 0.18), 0.5, rnd.uniform(0.5, 0.6)))
    for i, (dx, dy, dz, s) in enumerate(parts):
        b = ball(f'env_{key}_c{i}', r * s, (dx * r, dy * r, zc + dz * r), leaf, root, squash=(1, 1, 0.9), seg=40, rings=20)
        C.puff(b, cell=0.06, strength=0.024, offset=(rnd.uniform(0, 5), rnd.uniform(0, 5), 0))


def _pine(spec, pal, root, rnd):
    """塔松：4 层由大到小的扁圆绒团叠起来 + 尖顶，冷一档的深绿 —— 给密林一点不同的剪影。"""
    key = spec['key']
    env = pal['env']
    r = spec['r'] * U
    h = spec['h'] * U
    bark = C.principled(f'env_{key}_bark', env['trunk'], rough=0.8, spec=0.3)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=r * 0.16, radius2=r * 0.1, depth=h * 0.4)
    bmesh.ops.translate(bm, vec=Vector((0, 0, h * 0.2)), verts=bm.verts)
    C.mesh_from_bm(f'env_{key}_trunk', bm, bark, True, root)
    lo, hi = env['canopy'][spec['shade']]
    leaf = C.felt(f'env_{key}_leaf', lo, hi, h, z_low=h * 0.15, sheen=0.5, sheen_tint=env['sheen'], bump=0.14, sss=0.12)
    tiers = 4
    for k in range(tiers):
        t = k / (tiers - 1)
        rk = r * (1.0 - 0.6 * t)
        zk = h * (0.26 + 0.5 * t)
        b = ball(f'env_{key}_t{k}', rk, (0, 0, zk), leaf, root, squash=(1, 1, 0.62), seg=40, rings=20,
                 euler=(0, 0, rnd.uniform(0, 90)))
        C.puff(b, cell=0.05, strength=0.02, offset=(k * 0.7, rnd.uniform(0, 3), 0))
    ball(f'env_{key}_tip', r * 0.3, (0, 0, h * 0.9), leaf, root, squash=(1, 1, 1.5), seg=24, rings=12)


def _bush(spec, pal, root, rnd):
    """灌木：3–4 个低矮绒团；BUSH02 上缀几朵小白 / 粉花（小而淡，不跟宝石抢色）。"""
    key = spec['key']
    env = pal['env']
    r = spec['r'] * U
    lo, hi = env['canopy'][spec['shade']]
    leaf = C.felt(f'env_{key}_leaf', lo, hi, r * 1.9, z_low=0.0, sheen=0.6, sheen_tint=env['sheen'], bump=0.16, sss=0.15)
    blobs = [(0.0, 0.0, 1.0)]
    a0 = rnd.uniform(0, math.tau)
    for i in range(3):
        a = a0 + i * math.tau / 3 + rnd.uniform(-0.4, 0.4)
        blobs.append((math.cos(a) * 0.75, math.sin(a) * 0.75, rnd.uniform(0.62, 0.78)))
    tops = []
    for i, (dx, dy, s) in enumerate(blobs):
        rr = r * s
        c = Vector((dx * r, dy * r, rr * 0.72))
        b = ball(f'env_{key}_b{i}', rr, c, leaf, root, squash=(1, 1, 0.86), seg=32, rings=16)
        C.puff(b, cell=0.05, strength=0.018, offset=(rnd.uniform(0, 5), i * 0.6, 0))
        tops.append((c, rr))
    if spec['flowers']:
        mats = [C.principled(f'env_{key}_fl{i}', c, rough=0.5, spec=0.3) for i, c in enumerate(env['flowers'])]
        heart = C.principled(f'env_{key}_heart', pal['flower_heart'], rough=0.45)
        for k in range(spec['flowers']):
            c, rr = tops[k % len(tops)]
            # 朝镜头 / 朝上的半球面上取点（相机在 +x、-y 一侧）
            az = math.radians(-45 + rnd.uniform(-80, 80))
            el = math.radians(rnd.uniform(25, 70))
            d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el) * 0.86))
            p = c + d * rr * 0.98
            _daisy(f'env_{key}_f{k}', p.x, p.y, p.z, 2.3, mats[k % len(mats)], heart, root, rnd)


def _rock(spec, pal, root, rnd):
    """石块：两块圆润的灰石 + 大石顶上一小片苔藓。"""
    key = spec['key']
    env = pal['env']
    r = spec['r'] * U
    st = [C.stone(f'env_{key}_s{i}', c, rough=0.6) for i, c in enumerate(env['rock'])]
    ball(f'env_{key}_a', r, (0, 0, r * 0.42), st[0], root, squash=(1.2, 1.0, 0.72), seg=32, rings=16, euler=(0, 0, 20))
    ball(f'env_{key}_b', r * 0.62, (r * 0.95, -r * 0.55, r * 0.26), st[1], root, squash=(1.1, 1.0, 0.7), seg=28, rings=14,
         euler=(0, 0, -30))
    moss = C.felt(f'env_{key}_moss', *env['canopy']['bush'], r * 1.0, z_low=r * 0.5, sheen_tint=env['sheen'], bump=0.12)
    for k in range(4):
        a = k * 1.5 + 0.4
        ball(f'env_{key}_m{k}', r * 0.34, (math.cos(a) * r * 0.32 - r * 0.2, math.sin(a) * r * 0.26 + r * 0.1, r * 0.86), moss, root,
             squash=(1.2, 1.0, 0.42), seg=16, rings=8)


# ---- 地标：小屋 / 木塔 / 石堆 / 发光玉石（尺寸单位 = 屏幕像素） ----
# 造型参照用户给的三张图：童话村落的蘑菇小屋 / 圆塔（大而圆的鱼鳞瓦顶占立面一半以上、矮胖墙身、圆拱门、圆窗），
# 低多边形等距小景（大块切面石、发光晶柱 + 悬浮碎晶）。落到本管线的软胶玩具：体块大而少、棱角全倒圆、没有细杆细梁，
# 最小的结构件（窗框 / 门框 / 木箍）也 ≥ 2px；体量上小屋 ≈ 一棵大树宽的 1.5 倍，木塔是场外最高的一件。

def _log(name, a, b, r, mat, parent, seg=12, bev=None):
    """两点（px）之间的圆柱（台基 / 墙身 / 烟囱 / 屋脊 / 圆窗都用它）；bev = 端面倒角 px（默认 min(0.45, 0.3r)，0 = 不倒）。"""
    a, b = Vector(a), Vector(b)
    d = b - a
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r * U, radius2=r * U, depth=d.length * U)
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix()
    bmesh.ops.rotate(bm, cent=Vector((0, 0, 0)), matrix=rot, verts=bm.verts)
    ob = C.mesh_from_bm(name, bm, mat, True, parent, (a + b) * (0.5 * U))
    bev = min(0.45, r * 0.3) if bev is None else bev
    if bev > 0:
        bv = ob.modifiers.new('Bevel', 'BEVEL')
        bv.width = bev * U
        bv.segments = 3
        bv.limit_method = 'ANGLE'
        bv.angle_limit = math.radians(40)
        bv.harden_normals = True
    return ob


def _blk(name, size, center, mat, parent, bevel=0.4, euler=None):
    """px 单位的倒角方块，原点在块心（C.box 是米制且绕世界原点建，转不了）。"""
    ob = C.box(name, tuple(s * U for s in size), (0, 0, 0), mat, parent, bevel=bevel * U, segments=2)
    ob.location = V(*center)
    if euler is not None:
        ob.rotation_euler = Euler([math.radians(a) for a in euler], 'XYZ')
    return ob


def _panel(name, c, u, n, w, h, d, mat, parent, bevel=0.3):
    """贴墙的方块：c = 中心（px），u = 墙面水平切向，n = 墙面外法线；w 沿 u、d 沿 n、h 竖直。"""
    ob = _blk(name, (w, d, h), (0, 0, 0), mat, parent, bevel=bevel)
    ob.location = V(*c)
    ob.rotation_euler = (0, 0, math.atan2(u.y, u.x))
    return ob


def _frame(n):
    """法线 n → 右手正交基 (u 水平切向, v 沿面向上, n)。"""
    n = Vector(n).normalized()
    u = Vector((0, 0, 1)).cross(n)
    u = u.normalized() if u.length > 1e-6 else Vector((1, 0, 0))
    return u, n.cross(u), n


def _tile(name, p, n, size, mat, parent):
    """一片鱼鳞瓦：扁椭球，长轴沿水平切向、次轴沿坡、薄轴沿法线；size = (a, b, c) px。"""
    u, v, n = _frame(n)
    return ell(name, size, tuple(p), mat, parent, quat=Matrix((u, v, n)).transposed().to_quaternion(), seg=16, rings=8)


TILE = (3.9, 3.1, 0.9)  # 鱼鳞瓦半径（px）：1× 下一片 ≈ 6–7px，读得出一排排圆弧；薄轴再厚就鼓成一颗颗小球
TILE_DU, TILE_DV = 6.4, 5.0  # 同排间距 / 排距


def _tiles_slope(key, apex, down, nv, along, X, L, T, mat, parent):
    """双坡顶一坡的鱼鳞瓦：从檐口往屋脊一排排铺（最下一排骑在檐口上 → 檐口剪影是一串圆弧），隔排错半片；
    越靠屋脊的排越高一点（上排压下排）。apex = 屋顶底面在屋脊处的点，down / nv = 坡向下 / 坡面法线，
    along = 屋脊方向，X = 沿屋脊半长，L = 坡长，T = 底板厚。"""
    k = 0
    for i in range(int(L / TILE_DV) + 1):
        t = L - i * TILE_DV
        if t < TILE_DV * 0.4:
            break
        x = -X + TILE[0] * 0.7 + (i % 2) * TILE_DU / 2
        while x <= X - TILE[0] * 0.7:
            _tile(f'{key}_t{k}', apex + down * t + along * x + nv * (T + TILE[2] * 0.25 + i * 0.22), nv, TILE, mat, parent)
            k += 1
            x += TILE_DU


def _lathe(name, prof, mat, parent, seg=48):
    """绕 z 轴旋转截面成体：prof = [(r, z), …] px，首尾在轴上（r = 0）。"""
    bm = bmesh.new()
    rings = []
    for r, z in prof:
        if r < 1e-6:
            rings.append([bm.verts.new(V(0, 0, z))])
        else:
            rings.append([bm.verts.new(V(r * math.cos(math.tau * k / seg), r * math.sin(math.tau * k / seg), z)) for k in range(seg)])
    for A, B in zip(rings, rings[1:]):
        if len(A) == 1 and len(B) == 1:
            continue
        for k in range(seg):
            j = (k + 1) % seg
            if len(A) == 1:
                bm.faces.new((A[0], B[k], B[j]))
            elif len(B) == 1:
                bm.faces.new((A[k], A[j], B[0]))
            else:
                bm.faces.new((A[k], A[j], B[j], B[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = C.mesh_from_bm(name, bm, mat, True, parent)
    es = ob.modifiers.new('ES', 'EDGE_SPLIT')  # 截面折角（檐口 / 顶盖）处断开平滑，不出明暗脏斑
    es.split_angle = math.radians(40)
    return ob


def _tiles_lathe(key, outer, mat, parent, top=3.5):
    """旋转体屋顶（伞盖 / 尖帽）的鱼鳞瓦：outer = 外表面截面 [(r, z), …] 从檐口到顶；按弧长每排距一圈，
    每圈按周长每片距一片、隔圈错半片，越往上越高一点；r < top 的顶尖不铺（放顶饰）。
    背对镜头的不铺（省物体；剪影由底壳给）。"""
    seglen = [math.hypot(r2 - r1, z2 - z1) for (r1, z1), (r2, z2) in zip(outer, outer[1:])]
    cam = -C.VIEW
    s, i, k = 0.9, 0, 0
    while s < sum(seglen):
        j, acc = 0, 0.0
        while acc + seglen[j] < s:
            acc += seglen[j]
            j += 1
        (r1, z1), (r2, z2) = outer[j], outer[j + 1]
        f = (s - acc) / seglen[j]
        r, z = r1 + (r2 - r1) * f, z1 + (z2 - z1) * f
        if r < top:
            break
        nr, nz = (z2 - z1) / seglen[j], -(r2 - r1) / seglen[j]  # 截面切向 (dr, dz) 转 -90° = 外法线
        m = max(6, round(math.tau * r / TILE_DU))
        for q in range(m):
            a = math.tau * (q + 0.5 * (i % 2)) / m
            n3 = Vector((nr * math.cos(a), nr * math.sin(a), nz))
            if n3.dot(cam) < -0.25:
                continue
            p = Vector((r * math.cos(a), r * math.sin(a), z)) + n3 * (TILE[2] * 0.25 + i * 0.2)
            _tile(f'{key}_t{k}', p, n3, TILE, mat, parent)
            k += 1
        s += TILE_DV
        i += 1


def _door(key, base, u, n, w, h, m, parent):
    """圆拱门：门框（浅木）+ 门板（深木，两道横带）+ 门把；base = 墙面上门底中点（px）。"""
    for tag, mat, ww, hh, o in (('f', m['frame'], w + 2.6, h + 1.3, 0.0), ('d', m['door'], w, h, 0.6)):
        r = ww / 2
        c = base + n * (o + 0.6)
        _panel(f'{key}_door{tag}', c + Vector((0, 0, (hh - r) / 2)), u, n, ww, hh - r, 1.2, mat, parent)
        a = c + Vector((0, 0, hh - r))
        _log(f'{key}_door{tag}a', a - n * 0.6, a + n * 0.6, r, mat, parent, seg=28, bev=0.3)
    c = base + n * 1.75
    for i, z in enumerate((h * 0.28, h * 0.6)):
        _panel(f'{key}_doorb{i}', c + Vector((0, 0, z)), u, n, w - 1.2, 1.0, 0.5, m['dark'], parent, bevel=0)
    ell(f'{key}_knob', (0.9, 0.9, 0.9), tuple(c + u * (w * 0.27) + Vector((0, 0, h * 0.44)) + n * 0.4), m['frame'], parent,
        seg=12, rings=6)


def _window(key, c, u, n, r, m, parent):
    """圆窗：浅木窗框圆盘 + 暖光玻璃 + 十字窗棂（1px 粗，1× 下读得出）。c = 墙面上的窗心（px）。"""
    _log(f'{key}_wf', c - n * 0.2, c + n * 1.1, r + 1.3, m['frame'], parent, seg=28, bev=0.4)
    _log(f'{key}_wg', c + n * 1.0, c + n * 1.3, r, m['glow'], parent, seg=28, bev=0)
    g = c + n * 1.4
    _panel(f'{key}_wv', g, u, n, 1.0, 2 * r, 0.5, m['frame'], parent, bevel=0)
    _panel(f'{key}_wh', g, u, n, 2 * r, 1.0, 0.5, m['frame'], parent, bevel=0)


def _wall_at(R, az, z, w=0.0):
    """圆墙上方位 az（度）、高 z 处：(墙面点, 水平切向 u, 外法线 n)。w > 0：平板宽 w 时把点往外推一个弓高，板边不陷进圆墙。"""
    a = math.radians(az)
    n = Vector((math.cos(a), math.sin(a), 0))
    sag = R - math.sqrt(max(0.0, R * R - (w / 2) ** 2)) if w else 0.0
    return n * (R + sag) + Vector((0, 0, z)), Vector((-math.sin(a), math.cos(a), 0)), n


def _house_mats(key, env, roof):
    wd = env['wood']
    return {
        'wall': C.stone(f'{key}_wall', env['plaster'], speck_amount=0.02, rough=0.8, bump=0.03),
        'timber': C.principled(f'{key}_timber', wd['timber'], rough=0.7, spec=0.3),
        'dark': C.principled(f'{key}_dark', wd['dark'], rough=0.85, spec=0.2),
        'door': C.principled(f'{key}_door', wd['door'], rough=0.7, spec=0.3),
        'frame': C.principled(f'{key}_frame', wd['frame'], rough=0.6, spec=0.3),
        'glow': C.principled(f'{key}_glow', env['window'], rough=0.4, emit=1.5, emit_color=env['window']),
        'stone': C.stone(f'{key}_stone', env['stone'][1], rough=0.65),
        'stone2': C.stone(f'{key}_stone2', env['stone'][2], rough=0.65),
        'roof': C.vinyl(f'{key}_roof', roof, rough=0.5),
        'roofdk': C.vinyl(f'{key}_roofdk', C.mix_hex(roof, '#2A1A14', 0.35), rough=0.55),
        'leaf': C.felt(f'{key}_leaf', *env['canopy']['bush'], 10 * U, z_low=0.0, sheen=0.6, sheen_tint=env['sheen'], bump=0.14),
        'flower': C.principled(f'{key}_flower', env['flowers'][1], rough=0.5, spec=0.3),
    }


def _boulder(name, r, loc, mat, parent, rnd, squash=(1.15, 1.0, 0.75), jit=0.13):
    """低多边形大石（参考图 3）：一阶细分二十面球 + 顶点随机起伏 → 平面切面；切面之间倒圆（软胶，不扎手）。
    loc = 落点（px），底部埋进地里约 1/4。返回石顶高度（px）。"""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r * U)
    for v in bm.verts:
        k = 1 + rnd.uniform(-jit, jit)
        v.co = Vector((v.co.x * k * squash[0], v.co.y * k * squash[1], v.co.z * k * squash[2]))
    x, y, z = loc
    zc = z + r * squash[2] * 0.55
    ob = C.mesh_from_bm(name, bm, mat, False, parent, V(x, y, zc))
    bv = ob.modifiers.new('Bevel', 'BEVEL')
    bv.width = r * 0.09 * U
    bv.segments = 2
    bv.limit_method = 'ANGLE'
    bv.angle_limit = math.radians(18)
    bv.harden_normals = True
    ob.rotation_euler = (math.radians(rnd.uniform(-6, 6)), math.radians(rnd.uniform(-6, 6)), rnd.uniform(0, math.tau))
    return zc + r * squash[2]


def _shrub(key, x, y, r, m, parent, rnd, flowers=0):
    """门边一团灌木（植绒，与场外灌木同色），可缀几朵小粉花。"""
    b = ell(f'{key}_sh', (r, r, r * 0.82), (x, y, r * 0.62), m['leaf'], parent, seg=28, rings=14)
    C.puff(b, cell=0.05, strength=0.016, offset=(rnd.uniform(0, 5), rnd.uniform(0, 5), 0))
    for i in range(flowers):
        a = math.radians(-45 + rnd.uniform(-70, 70))
        el = math.radians(rnd.uniform(25, 60))
        ell(f'{key}_fl{i}', (0.9, 0.9, 0.7), (x + math.cos(el) * math.cos(a) * r * 0.95, y + math.cos(el) * math.sin(a) * r * 0.95,
                                             r * 0.62 + math.sin(el) * r * 0.8), m['flower'], parent, seg=10, rings=5)


def _cottage(spec, pal, root, rnd):
    """山墙小屋（参考图 1 的红顶小屋）：山墙朝镜头左前（迎光），门开在山墙上、山尖一扇圆窗 ——
    石台基 + 矮胖灰泥墙身（四角粗木柱 + 顶圈木梁）+ 陡坡 50° 的厚双坡顶（屋顶高 ≈ 墙高），朝镜头的一坡满铺鱼鳞瓦、
    粗圆脊，坡上一根粗圆石烟囱；门前石阶，窗下花箱，门边两团灌木。
    ⚠ 等距视线俯角 30°：墙上高于「檐口 − 0.82 × 出挑」的部分会被屋檐挡住 —— 所以门窗开在山墙（出挑只在两侧），
    长边的檐口出挑只给 3.5px。建模在规范朝向里做（屋脊沿 x、门在 +x 山墙），最后整体转 -90°：
    +x 山墙 → 世界 -y（左前，迎光），+y 长边 / 坡 → 世界 +x（右前，背光）。"""
    key = f'env_{spec["key"]}'
    env = pal['env']
    m = _house_mats(key, env, env['roof'][spec['roof']])
    body = C.empty(f'{key}_body', parent=root)
    body.rotation_euler = (0, 0, math.radians(-90))
    hx, hy = spec['hx'], spec['hy']  # hx 沿屋脊（山墙到山墙）、hy 跨屋脊
    z0 = 4.5
    zw = z0 + spec['wall']
    th = math.radians(spec.get('pitch', 50))
    tn = math.tan(th)
    dy, wy_ = -4.0, 6.0  # 门 / 窗在山墙上的横向位置
    C.slab(f'{key}_base', (hx + 3) * U, (hy + 3) * U, 0.0, z0 * U, 4.0 * U, 1.6 * U, m['stone'], body)
    k = 0
    for y in range(-hy + 1, hy + 1, 6):  # 台基脚下一排卵石（门前石阶处空出来）
        if abs(y - dy) > 6:
            _boulder(f'{key}_pb{k}', 2.5, (hx + 3.2, y + rnd.uniform(-1, 1), -0.6), m['stone2'], body, rnd)
            k += 1
    for x in range(-hx + 3, hx - 1, 7):
        _boulder(f'{key}_pb{k}', 2.5, (x + rnd.uniform(-1, 1), hy + 3.2, -0.6), m['stone2'], body, rnd)
        k += 1
    C.rbox(f'{key}_wall', hx * U, hy * U, (z0 - 0.5) * U, zw * U, 3.0 * U, 0.0, m['wall'], body, n=8, nz=3, k=3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            _blk(f'{key}_post{sx}{sy}', (3.6, 3.6, zw - z0), (sx * (hx - 1.2), sy * (hy - 1.2), (z0 + zw) / 2), m['timber'], body,
                 bevel=0.9)
    for s in (-1, 1):
        _blk(f'{key}_bx{s}', (2 * hx + 0.8, 2.8, 2.8), (0, s * (hy + 0.2), zw - 1.0), m['timber'], body, bevel=0.8)
        _blk(f'{key}_by{s}', (2.8, 2 * hy + 0.8, 2.8), (s * (hx + 0.2), 0, zw - 1.0), m['timber'], body, bevel=0.8)
    # 山墙（同灰泥）+ 山尖圆窗
    wy = hy + 0.5
    zu = zw + wy * tn  # 屋顶底面在屋脊处的高度
    _extrude(f'{key}_gable', [(-wy, zw - 1.5), (wy, zw - 1.5), (0, zu)], -(hx - 0.4), hx - 0.4, m['wall'], body)
    u, n = Vector((0, 1, 0)), Vector((1, 0, 0))
    _window(f'{key}_aw', Vector((hx - 0.4, 0, zw + 5.5)), u, n, 2.7, m, body)
    # 屋顶：两块厚底板（深一档的瓦色，瓦缝里透出来）+ 朝镜头一坡的鱼鳞瓦 + 粗圆脊
    T = 3.6
    X = hx + spec.get('gable_eave', 3.0)
    L = (wy + spec.get('eave', 3.5)) / math.cos(th)
    apex = Vector((0, 0, zu))
    for s in (-1, 1):
        down = Vector((0, s * math.cos(th), -math.sin(th)))
        nv = Vector((0, s * math.sin(th), math.cos(th)))
        _blk(f'{key}_roof{s}', (2 * X, L + 2.0, T), tuple(apex + down * (L / 2 - 1.0) + nv * (T / 2)), m['roofdk'], body, bevel=1.4,
             euler=(math.degrees(-s * th), 0, 0))
        if s > 0:
            _tiles_slope(key, apex, down, nv, Vector((1, 0, 0)), X - 0.5, L, T, m['roof'], body)
    _log(f'{key}_ridge', (-X - 0.8, 0, zu + T * 0.9), (X + 0.8, 0, zu + T * 0.9), 3.0, m['roof'], body, seg=20, bev=1.0)
    # 烟囱：立在朝镜头那一坡的后半段
    cx, cy = -hx * 0.4, hy * 0.42
    top = zu + 7.0
    _log(f'{key}_chim', (cx, cy, zw), (cx, cy, top), 3.4, m['stone'], body, seg=20, bev=0.9)
    _log(f'{key}_chimcap', (cx, cy, top - 0.4), (cx, cy, top + 1.6), 4.3, m['roofdk'], body, seg=20, bev=0.6)
    _log(f'{key}_chimhole', (cx, cy, top + 1.4), (cx, cy, top + 1.7), 2.4, m['dark'], body, seg=16, bev=0)
    # 山墙正面：门 + 石阶 + 圆窗 + 花箱 + 两团灌木
    _door(key, Vector((hx, dy, z0)), u, n, 7.2, 10.5, m, body)
    _panel(f'{key}_step', Vector((hx + 4.4, dy, 1.2)), u, n, 9.6, 2.4, 2.8, m['stone'], body, bevel=0.6)
    wc = Vector((hx, wy_, z0 + 7.2))
    _window(f'{key}_w', wc, u, n, 2.8, m, body)
    _panel(f'{key}_fbox', wc + Vector((0, 0, -5.4)) + n * 1.6, u, n, 8.4, 2.4, 2.6, m['frame'], body, bevel=0.5)
    for i, d in enumerate((-2.6, 0.0, 2.6)):
        ell(f'{key}_fb{i}', (1.7, 1.8, 1.4), tuple(wc + Vector((0, d, -3.7)) + n * 1.8), m['leaf'], body, seg=14, rings=7)
    for i, d in enumerate((-1.8, 1.5)):
        ell(f'{key}_ff{i}', (0.9, 0.9, 0.8), tuple(wc + Vector((0, d, -2.6)) + n * 2.6), m['flower'], body, seg=10, rings=5)
    _shrub(f'{key}_s0', hx + 5.5, -hy - 1.0, 4.4, m, body, rnd, flowers=2)
    _shrub(f'{key}_s1', hx + 3.0, hy + 4.5, 3.6, m, body, rnd)


def _roundhouse(spec, pal, root, rnd):
    """圆屋（参考图 1 的蘑菇顶小屋）：圆石台基 + 矮圆墙身（粗木柱 + 顶圈木箍）+ 蘑菇伞盖：檐口外挑 ≈ 墙半径的 0.6，
    卷边压到门顶，伞盖高 ≈ 墙高的 1.4 倍、满铺鱼鳞瓦，顶上一个小圆钮。迎光侧圆拱门、背光侧圆窗，伞盖上探出一截烟囱。"""
    key = f'env_{spec["key"]}'
    env = pal['env']
    m = _house_mats(key, env, env['roof'][spec['roof']])
    R = spec['r']
    z0 = 4.5
    zw = z0 + spec['wall']
    _log(f'{key}_base', (0, 0, 0), (0, 0, z0), R + 3.2, m['stone'], root, seg=48, bev=1.5)
    for i in range(7):
        a = math.radians(-160 + i * 26 + rnd.uniform(-5, 5))
        _boulder(f'{key}_pb{i}', 2.5, ((R + 3.4) * math.cos(a), (R + 3.4) * math.sin(a), -0.6), m['stone2'], root, rnd)
    _log(f'{key}_wall', (0, 0, z0 - 0.5), (0, 0, zw), R, m['wall'], root, seg=48, bev=0.6)
    # 镜头方位 -45°：门偏 25°、窗偏 40°。伞盖出挑 (flare-1)·R，等距俯角 30° 下盖沿以下 ≈ 0.58 × 出挑 / cos(偏角) 被挡住 →
    # 门顶 / 窗顶都压在这条线以下（墙身因此比参考图略高）
    door_az, win_az = -70, -5
    for i, az in enumerate((-150, -45, 20, 70, 125, 175)):
        p, u, n = _wall_at(R, az, (z0 + zw) / 2, 3.2)
        _panel(f'{key}_post{i}', p + n * 0.5, u, n, 3.2, zw - z0, 2.2, m['timber'], root, bevel=0.8)
    _log(f'{key}_band', (0, 0, zw - 3.0), (0, 0, zw), R + 1.0, m['timber'], root, seg=48, bev=0.6)
    # 伞盖：半个扁椭球 + 往里收的卷边；底面平
    Rc, zc, Hc = R * spec.get('flare', 1.45), zw - 2.0, spec['cap']
    outer = [(Rc + 0.3, zc + 1.4)] + [(Rc * math.cos(math.radians(a)), zc + 1.4 + (Hc - 1.4) * math.sin(math.radians(a)))
                                      for a in range(8, 91, 8)] + [(0.0, zc + Hc)]
    _lathe(f'{key}_cap', [(0.0, zc + 2.6), (Rc * 0.8, zc + 0.8), (Rc - 0.8, zc)] + outer, m['roofdk'], root)
    _tiles_lathe(key, outer, m['roof'], root, top=2.2)
    ell(f'{key}_knob', (2.2, 2.2, 2.4), (0, 0, zc + Hc + 1.2), m['roof'], root, seg=20, rings=10)
    p, u, n = _wall_at(R, -20, 0)
    cx, cy = (p.x * 0.85, p.y * 0.85)
    ztop = zc + Hc * 0.86 + 6.0
    _log(f'{key}_chim', (cx, cy, zw), (cx, cy, ztop), 3.2, m['stone'], root, seg=20, bev=0.9)
    _log(f'{key}_chimcap', (cx, cy, ztop - 0.4), (cx, cy, ztop + 1.6), 4.1, m['roofdk'], root, seg=20, bev=0.6)
    _log(f'{key}_chimhole', (cx, cy, ztop + 1.4), (cx, cy, ztop + 1.7), 2.2, m['dark'], root, seg=16, bev=0)
    p, u, n = _wall_at(R, door_az, z0, 7.2 + 2.6)
    _door(key, p, u, n, 7.2, 10.5, m, root)
    _panel(f'{key}_step', p + n * 4.6 + Vector((0, 0, 1.2 - z0)), u, n, 9.6, 2.4, 2.8, m['stone'], root, bevel=0.6)
    p, u, n = _wall_at(R, win_az, z0 + 6.0, 2 * 4.3)
    _window(f'{key}_w', p, u, n, 3.0, m, root)
    p, u, n = _wall_at(R + 6.5, door_az - 32, 0)
    _shrub(f'{key}_s0', p.x, p.y, 4.2, m, root, rnd, flowers=2)
    p, u, n = _wall_at(R + 5.5, win_az + 34, 0)
    _shrub(f'{key}_s1', p.x, p.y, 3.4, m, root, rnd)


def _staves(name, color, line, n=14, frac=0.14):
    """竖向木板墙：按方位角切成 n 块，每块左缘一道深色板缝（物体坐标，圆柱 / 旋转体用）。"""
    mt = C.principled(name, color, rough=0.7, spec=0.3)
    nt = mt.node_tree
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Object'], sep.inputs['Vector'])
    f = C._math(nt, 'FRACT', C._math(nt, 'MULTIPLY', C._math(nt, 'ARCTAN2', sep.outputs['Y'], sep.outputs['X']), n / math.tau))
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].color = C.rgb(line)
    ramp.color_ramp.elements[1].position = frac
    ramp.color_ramp.elements[1].color = C.rgb(color)
    nt.links.new(f, ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])
    return mt


def _tower(spec, pal, root, rnd):
    """木塔（参考图 1 的圆塔）：粗石台基 + 微收分的竖板木塔身（三道深色木箍、圆拱门、上下两扇圆窗）+ 外撇的大尖帽：
    帽檐半径 ≈ 塔身的 1.6 倍、帽高 ≈ 塔身高的 0.85，满铺鱼鳞瓦（灰蓝，与小屋的红 / 橙瓦错开），帽尖小圆钮 + 一面三角小旗。"""
    key = f'env_{spec["key"]}'
    env = pal['env']
    m = _house_mats(key, env, env['roof']['c'])
    R, H = spec['r'], spec['h']
    zb = 8.0
    zt = zb + H
    _log(f'{key}_base', (0, 0, 0), (0, 0, zb), R + 2.8, m['stone'], root, seg=48, bev=1.6)
    for i in range(7):
        a = math.radians(-170 + i * 30 + rnd.uniform(-6, 6))
        _boulder(f'{key}_pb{i}', 2.8, ((R + 3.2) * math.cos(a), (R + 3.2) * math.sin(a), -0.6), m['stone2'], root, rnd)
    rt = R - 1.0  # 收分后的顶半径
    wood = _staves(f'{key}_staves', env['wood']['honey'], C.mix_hex(env['wood']['honey'], env['wood']['dark'], 0.55))
    _lathe(f'{key}_body', [(0.0, zb - 0.5), (R, zb - 0.5), (rt, zt), (0.0, zt)], wood, root)

    def r_at(z):
        return R + (rt - R) * (z - zb) / H

    for i, z in enumerate((zb + 1.2, zb + H * 0.5, zt - 1.6)):
        _log(f'{key}_band{i}', (0, 0, z - 1.3), (0, 0, z + 1.3), r_at(z) + 0.9, m['timber'], root, seg=48, bev=0.6)
    p, u, n = _wall_at(R, -80, zb, 7.4 + 2.6)
    _door(key, p, u, n, 7.4, 11.4, m, root)
    for i in range(2):  # 门前两级石阶：从台基下到地面
        h = zb * (2 - i) / 3
        _panel(f'{key}_step{i}', p + n * (4.3 + 2.6 * i) + Vector((0, 0, h / 2 - zb)), u, n, 9.6, h, 3.0, m['stone'], root, bevel=0.6)
    for i, (az, z) in enumerate(((-20, zb + H * 0.36), (-70, zb + H * 0.72))):
        p, u, n = _wall_at(r_at(z), az, z, 2 * 4.4)
        _window(f'{key}_w{i}', p, u, n, 3.1, m, root)
    # 尖帽：外撇（r = Rr·(1-t)^1.6 → 檐口一段平展、往上收尖）
    Rr, zc, Hc = R * 1.6, zt - 3.0, spec['cap']
    outer = [(Rr + 0.3, zc + 1.0)] + [(Rr * (1 - t) ** 1.6, zc + 1.0 + (Hc - 1.0) * t) for t in (0.05, 0.13, 0.23, 0.35, 0.5, 0.66, 0.82, 0.94)]
    outer.append((0.0, zc + Hc))
    _lathe(f'{key}_cap', [(0.0, zc + 2.4), (Rr * 0.75, zc + 0.6), (Rr - 0.6, zc - 0.4)] + outer, m['roofdk'], root)
    _tiles_lathe(key, outer, m['roof'], root, top=2.6)
    tip = zc + Hc
    _log(f'{key}_pole', (0, 0, tip - 1.0), (0, 0, tip + 6.5), 0.55, m['dark'], root, seg=8, bev=0)
    ell(f'{key}_ball', (1.6, 1.6, 1.6), (0, 0, tip + 0.6), m['frame'], root, seg=16, rings=8)
    flag = C.vinyl(f'{key}_flag', env['roof']['a'], rough=0.5)
    _extrude(f'{key}_flag', [(0.0, 0.0), (0.0, 4.0), (6.0, 2.0)], -0.4, 0.4, flag, root, loc=(0, 0.3, tip + 2.4))


def _stones(spec, pal, root, rnd):
    """石堆（参考图 2 / 3 的大块切面石）：pile = 一块大石 + 两块中石斜靠 + 几块小石，顶上苔藓；
    cairn = 大石底座上叠三块扁切面石 + 一块小顶石。石色比场外的 ROCK01 浅一档（人垒的东西要读得出来）。"""
    key = f'env_{spec["key"]}'
    env = pal['env']
    st = [C.stone(f'{key}_s{i}', c, rough=0.62) for i, c in enumerate(env['stone'])]
    moss = C.felt(f'{key}_moss', *env['canopy']['bush'], 30 * U, z_low=0.0, sheen=0.6, sheen_tint=env['sheen'], bump=0.12)
    tops = []
    if spec['form'] == 'pile':
        tops.append((0, 0, _boulder(f'{key}_b0', 11.0, (0, 0, 0), st[0], root, rnd, squash=(1.2, 1.0, 0.78)), 11.0))
        for i, (x, y, r, sz) in enumerate(((-11, 7, 7.6, 0.85), (10, 6, 6.6, 0.8), (6, -11, 4.2, 0.75), (-8, -9, 3.4, 0.7),
                                           (14, -4, 2.8, 0.7))):
            tops.append((x, y, _boulder(f'{key}_b{i + 1}', r, (x, y, 0), st[(i + 1) % 3], root, rnd, squash=(1.1, 1.0, sz)), r))
        _boulder(f'{key}_top', 4.6, (1.5, 1.5, tops[0][2] - 1.2), st[2], root, rnd, squash=(1.15, 1.0, 0.8))
        mossy = (0, 1)
    else:
        z = _boulder(f'{key}_b0', 9.5, (0, 0, 0), st[1], root, rnd, squash=(1.2, 1.1, 0.62))
        tops.append((0, 0, z, 9.5))
        for i, r in enumerate((7.8, 6.2, 4.6)):  # 叠石：落点抬到上一块顶上方，底面只陷进去 ≈ 0.1r
            x, y = rnd.uniform(-1.2, 1.2), rnd.uniform(-1.2, 1.2)
            z = _boulder(f'{key}_b{i + 1}', r, (x, y, z + r * 0.45 * 0.25), st[i % 3], root, rnd, squash=(1.25, 1.1, 0.45), jit=0.1)
        _boulder(f'{key}_cap', 3.0, (0, 0, z - 0.2), st[2], root, rnd, squash=(1.1, 1.0, 0.8))
        for i, (x, y, r) in enumerate(((-10, 6, 4.0), (9, -7, 3.2))):
            tops.append((x, y, _boulder(f'{key}_l{i}', r, (x, y, 0), st[(i + 2) % 3], root, rnd), r))
        mossy = (0, 1)
    for k, i in enumerate(mossy):
        x, y, zt, r = tops[i]
        ball(f'{key}_m{k}', r * 0.5 * U, (x * U, (y + r * 0.1) * U, (zt - r * 0.2) * U), moss, root, squash=(1.25, 1.0, 0.45),
             seg=20, rings=10)


def _shard(name, r, h, tip, mat, parent, loc, lean=0.0, toward=0.0, spin=0.0, foot=3.0):
    """一根玉晶（px）：略收分的六棱柱 + 上尖；foot ≥ 0 → 平底埋进地里 foot px，foot < 0 → 下端也收成尖（悬浮碎晶）。
    切面之间大倒圆 → 软糖质感。lean / toward / spin 为度。"""
    bm = bmesh.new()
    angs = [math.radians(spin) + k * math.tau / 6 for k in range(6)]
    lo = [bm.verts.new(V(r * math.cos(a), r * math.sin(a), -max(foot, 0.0))) for a in angs]
    hi = [bm.verts.new(V(r * 0.86 * math.cos(a), r * 0.86 * math.sin(a), h)) for a in angs]
    top = bm.verts.new(V(0, 0, h + tip))
    for i in range(6):
        j = (i + 1) % 6
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
        bm.faces.new((hi[i], hi[j], top))
    if foot >= 0:
        bm.faces.new(list(reversed(lo)))
    else:
        bot = bm.verts.new(V(0, 0, foot))
        for i in range(6):
            bm.faces.new((lo[(i + 1) % 6], lo[i], bot))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = C.mesh_from_bm(name, bm, mat, False, parent, V(*loc))
    bv = ob.modifiers.new('Bevel', 'BEVEL')
    bv.width = min(1.4, r * 0.18) * U
    bv.segments = 3
    bv.limit_method = 'ANGLE'
    bv.angle_limit = math.radians(25)
    bv.harden_normals = True
    la, ta = math.radians(lean), math.radians(toward)
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(
        Vector((math.cos(ta) * math.sin(la), math.sin(ta) * math.sin(la), math.cos(la))))
    return ob


def _jade(spec, pal, root, rnd):
    """发光玉石（参考图 3 的发光晶柱 + 悬浮碎晶）：一根粗胖的六棱玉晶 + 一两根小晶从切面石座里拱出，身边悬着两三片小碎晶。
    半透（次表面）+ 自发光，根部深玉 → 晶尖亮薄荷，自发光随高度加强；偏青，与地图里的绿宝石 #3FBF6A 错开色相与体量
    （大 2–3 倍、带石座），读作场景而不是可拾取物。辉光由样张页另画（静态层）。"""
    key = f'env_{spec["key"]}'
    env = pal['env']
    j = env['jade']
    m = C.principled(f'{key}_jade', j['body'], rough=0.18, coat=0.6, coat_rough=0.05, spec=0.5, emit=j['emit'], emit_color=j['glow'])
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Subsurface Weight'].default_value = 0.55
    b.inputs['Subsurface Scale'].default_value = 0.05
    b.inputs['Subsurface Radius'].default_value = (0.4, 1.0, 0.75)
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Position'], sep.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = 0.0
    mr.inputs['From Max'].default_value = max(c[1] + c[2] for c in spec['crystals']) * U
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    for sock, lo, hi in (('Base Color', j['deep'], j['body']), ('Emission Color', j['deep'], j['glow'])):
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color = C.rgb(lo)
        ramp.color_ramp.elements[1].color = C.rgb(hi)
        nt.links.new(mr.outputs['Result'], ramp.inputs['Fac'])
        nt.links.new(ramp.outputs['Color'], b.inputs[sock])
    k = nt.nodes.new('ShaderNodeMath')
    k.operation = 'MULTIPLY_ADD'
    nt.links.new(mr.outputs['Result'], k.inputs[0])
    k.inputs[1].default_value = j['emit'] * 0.9
    k.inputs[2].default_value = j['emit'] * 0.35
    nt.links.new(k.outputs[0], b.inputs['Emission Strength'])
    rock = [C.stone(f'{key}_r{i}', c, rough=0.6) for i, c in enumerate(env['rock'])]
    for i, (r, h, tip, lean, toward, d) in enumerate(spec['crystals']):
        a = math.radians(toward)
        _shard(f'{key}_c{i}', r, h, tip, m, root, (d * math.cos(a), d * math.sin(a), 0), lean, toward, rnd.uniform(0, 60))
    for i, (x, y, r) in enumerate(spec['rocks']):
        _boulder(f'{key}_k{i}', r, (x, y, -1.0), rock[i % len(rock)], root, rnd, squash=(1.2, 1.0, 0.72))
    for i, (az, d, z, r) in enumerate(spec.get('float', [])):
        a = math.radians(az)
        _shard(f'{key}_f{i}', r, r * 0.9, r * 1.5, m, root, (d * math.cos(a), d * math.sin(a), z), rnd.uniform(15, 35), az + 180,
               rnd.uniform(0, 60), foot=-r * 1.3)


def build_env(spec, pal):
    root = C.empty(f'env_{spec["key"]}')
    rnd = random.Random(700 + sum(map(ord, spec['key'])))
    {'tree': _tree, 'pine': _pine, 'bush': _bush, 'rock': _rock, 'cottage': _cottage, 'roundhouse': _roundhouse, 'tower': _tower,
     'stones': _stones, 'jade': _jade}[spec['kind']](spec, pal, root, rnd)
    return root


def _cliff_path(kind):
    """崖面的平面路径（格心在原点，1 格 = 1 m）→ [(点, 外法线, u, 端距)]。
    SW = 网格 +y 侧（Blender -y），SE = 网格 +x 侧（Blender +x），S = 南角那一格（两面 + 圆角）。
    u = 沿边坐标，对 1 取模后与相邻段一致（细纹理按 u 周期平铺）；端距 = 到「需要与邻段拼接的端点」的路径长度。"""
    ov, step = CLIFF_OV, 0.02
    out = []

    def line(p0, p1, n, u0, u1):
        k = max(2, math.ceil((p1 - p0).length / step))
        for i in range(k + 1):
            t = i / k
            out.append((p0.lerp(p1, t), n, u0 + (u1 - u0) * t))

    if kind == 'SW':
        line(Vector((-0.5 - ov, -0.5)), Vector((0.5 + ov, -0.5)), Vector((0, -1)), -0.5 - ov, 0.5 + ov)
    elif kind == 'SE':
        line(Vector((0.5, -0.5 - ov)), Vector((0.5, 0.5 + ov)), Vector((1, 0)), -0.5 - ov, 0.5 + ov)
    else:
        rho = 0.12
        line(Vector((-0.5 - ov, -0.5)), Vector((0.5 - rho, -0.5)), Vector((0, -1)), -0.5 - ov, 0.5 - rho)
        c = Vector((0.5 - rho, -0.5 + rho))
        k = 10
        for i in range(1, k):
            a = -math.pi / 2 + (math.pi / 2) * i / k
            n = Vector((math.cos(a), math.sin(a)))
            # 圆弧上 u 线性拉伸到 2ρ（而不是 ρπ/2）：这样 SE 段 u = y + 1，和 SE 邻段的 u = y 同余
            out.append((c + n * rho, n, 0.5 - rho + 2 * rho * i / k))
        line(Vector((0.5, -0.5 + rho)), Vector((0.5, 0.5 + ov)), Vector((1, 0)), 0.5 + rho, 1.5 + ov)
    # 端距：只有两个外端要和邻段拼接（S 角的两端也是外端）
    acc = [0.0]
    for i in range(1, len(out)):
        acc.append(acc[-1] + (out[i][0] - out[i - 1][0]).length)
    total = acc[-1]
    return [(p, n, u, min(a, total - a)) for (p, n, u), a in zip(out, acc)]


def _cliff_win(e):
    """端部窗：与邻段重叠的那一截（端距 < 2·OV）为 0 —— 两段在重叠区完全一样；往里 0.15 m 渐变到 1。"""
    return _smooth((e - 2 * CLIFF_OV - 0.01) / 0.15)


def _cliff_mat(name, pal):
    """土崖材质：地层色按顶点属性 band 分三档（CONSTANT，分界跟着几何上的台阶走）；
    细颗粒凹凸 + 轻微斑驳用「沿边 u → 圆周」坐标 → 按格周期平铺，接缝处纹理连续；崖脚压暗（接地 AO）。"""
    cl = pal['env']['cliff']
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    C._set(b, {'Roughness': 0.86, 'Specular IOR Level': 0.28, 'Sheen Weight': 0.3, 'Sheen Roughness': 0.5,
               'Sheen Tint': C.rgb(cl['sheen'])})
    L = nt.links.new
    att = nt.nodes.new('ShaderNodeAttribute')
    att.attribute_name = 'band'
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    els = ramp.color_ramp.elements
    els[0].position = 0.0
    els[0].color = C.rgb(cl['bands'][0])
    els[1].position = CLIFF_BANDS[0]
    els[1].color = C.rgb(cl['bands'][1])
    e2 = els.new(CLIFF_BANDS[1])
    e2.color = C.rgb(cl['bands'][2])
    L(att.outputs['Fac'], ramp.inputs['Fac'])
    tc = nt.nodes.new('ShaderNodeTexCoord')
    suv = nt.nodes.new('ShaderNodeSeparateXYZ')
    L(tc.outputs['UV'], suv.inputs['Vector'])
    ang = C._math(nt, 'MULTIPLY', suv.outputs['X'], math.tau)
    comb = nt.nodes.new('ShaderNodeCombineXYZ')
    L(C._math(nt, 'MULTIPLY', C._math(nt, 'COSINE', ang), CLIFF_RC), comb.inputs['X'])
    L(C._math(nt, 'MULTIPLY', C._math(nt, 'SINE', ang), CLIFF_RC), comb.inputs['Y'])
    L(suv.outputs['Y'], comb.inputs['Z'])
    fine = C._noise(nt, comb.outputs['Vector'], 14.0, 3.0, 0.6)
    mott = C._noise(nt, comb.outputs['Vector'], 3.0, 2.0, 0.5)
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sp = nt.nodes.new('ShaderNodeSeparateXYZ')
    L(geo.outputs['Position'], sp.inputs['Vector'])
    ao = nt.nodes.new('ShaderNodeMapRange')
    ao.inputs['From Min'].default_value = -CLIFF_Z
    ao.inputs['From Max'].default_value = -CLIFF_Z + 0.2
    ao.inputs['To Min'].default_value = 0.5
    ao.inputs['To Max'].default_value = 1.0
    L(sp.outputs['Z'], ao.inputs['Value'])
    k = C._math(nt, 'MULTIPLY', ao.outputs['Result'], C._math(nt, 'MULTIPLY_ADD', mott, 0.14, 0.93))
    sc = nt.nodes.new('ShaderNodeVectorMath')
    sc.operation = 'SCALE'
    L(ramp.outputs['Color'], sc.inputs[0])
    L(k, sc.inputs['Scale'])
    L(sc.outputs['Vector'], b.inputs['Base Color'])
    bmp = nt.nodes.new('ShaderNodeBump')
    bmp.inputs['Strength'].default_value = 0.3
    bmp.inputs['Distance'].default_value = 0.004
    L(fine, bmp.inputs['Height'])
    L(bmp.outputs['Normal'], b.inputs['Normal'])
    return m


def _cliff_offset(p, z, win, seed):
    """崖面某点沿外法线的鼓出量（米）+ 该点的地层值 band（0 顶 → 1 底，含中段的起伏）。
    只依赖 z 的部分（地层台阶、崖脚外扩）各段一致；随机起伏乘端部窗，接缝处为 0。"""
    from mathutils import noise
    t = -z / CLIFF_Z
    q = Vector((p.x * 5.0 + seed * 3.1, p.y * 5.0 - seed * 1.7, z * 5.0))
    band = t + win * 0.07 * noise.noise(q)
    o = 0.0
    for bz in CLIFF_BANDS:
        o += 0.012 * (1 - _smooth((band - bz + 0.025) / 0.05))  # 上层比下层略鼓 ≈0.5px：一层层的台阶
    o += win * 0.03 * noise.noise(Vector((p.x * 7.0 - seed, p.y * 7.0 + seed * 2.3, z * 7.0 + seed)))
    o += 0.045 * _smooth((t - 0.8) / 0.2) ** 2  # 崖脚外扩成小土坡
    return o, band


def build_cliff(kind, variant, pal):
    """土崖一段（一格宽，两端各多出 OV 与邻段重叠）：分层土壁 + 崖顶草皮卷边 + 中段的嵌石 / 垂草 / 脚下草团（按变体不同）。
    kind = 'SW' / 'SE' / 'S'（南角）。崖顶 z=0 正好贴着地图菱形的边线，往下 CLIFF_Z。"""
    root = C.empty(f'cliff_{kind}{variant}')
    rnd = random.Random(900 + variant * 31 + ord(kind[-1]))
    seed = variant + (3 if kind == 'SE' else 7 if kind == 'S' else 0)
    path = _cliff_path(kind)
    nz = 30
    verts, uvs, bands, wins = [], [], [], []
    for p, n, u, e in path:
        w = _cliff_win(e)
        for j in range(nz + 1):
            z = -CLIFF_Z * j / nz
            o, band = _cliff_offset(p, z, w, seed)
            q = p + n * o
            verts.append((q.x, q.y, z))
            uvs.append((u, z))
            bands.append(band)
            wins.append(w)
    faces = []
    for i in range(len(path) - 1):
        for j in range(nz):
            a = i * (nz + 1) + j
            b = (i + 1) * (nz + 1) + j
            faces.append((a, a + 1, b + 1, b))  # 法线朝外（-z × 路径前进方向）
    me = bpy.data.meshes.new(f'cliff_{kind}{variant}_face')
    me.from_pydata(verts, [], faces)
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    at = me.attributes.new('band', 'FLOAT', 'POINT')
    at.data.foreach_set('value', bands)
    me.materials.append(_cliff_mat(f'cliff_{kind}{variant}_m', pal))
    C.link(bpy.data.objects.new(f'cliff_{kind}{variant}_face', me), root)

    # 崖顶草皮卷边：沿路径扫一根等粗圆管（不带随机纹理 → 各段一模一样，拼起来是一条连续的边）
    cl = pal['env']['cliff']
    lip = C.felt(f'cliff_{kind}{variant}_lip', *cl['lip'], 0.0, z_low=-CLIFF_LIP * 2.2, sheen=0.7, sheen_tint=pal['env']['sheen'],
                 bump=0.0, mottle=0.0)
    ring = 12
    lv, lf = [], []
    for p, n, u, e in path:
        c = p + n * (CLIFF_LIP * 0.45)
        for k in range(ring):
            a = math.tau * k / ring
            q = c + n * (math.cos(a) * CLIFF_LIP)
            lv.append((q.x, q.y, -CLIFF_LIP + math.sin(a) * CLIFF_LIP))
    for i in range(len(path) - 1):
        for k in range(ring):
            a, b2 = i * ring + k, i * ring + (k + 1) % ring
            lf.append((a, (i + 1) * ring + k, (i + 1) * ring + (k + 1) % ring, b2))
    lm = bpy.data.meshes.new(f'cliff_{kind}{variant}_lip')
    lm.from_pydata(lv, [], lf)
    lm.polygons.foreach_set('use_smooth', [True] * len(lm.polygons))
    lm.materials.append(lip)
    C.link(bpy.data.objects.new(f'cliff_{kind}{variant}_lip', lm), root)

    # 中段细节（端部窗 ≈1 的地方才放，接缝区保持干净）
    inner = [s for s in path if _cliff_win(s[3]) > 0.98]
    stone = [C.stone(f'cliff_{kind}{variant}_st{i}', c, rough=0.6) for i, c in enumerate(cl['stone'])]
    tuft = C.felt(f'cliff_{kind}{variant}_tuft', *cl['lip'], 0.06 - CLIFF_Z, z_low=-CLIFF_Z, sheen=0.6, sheen_tint=pal['env']['sheen'],
                  bump=0.12)
    plan = [(2, 2, 1), (1, 3, 2), (3, 1, 1)][variant % 3]  # 嵌石 / 垂草 / 脚下草团 个数
    m = sum(plan)
    slots = [inner[min(len(inner) - 1, int((i + rnd.uniform(0.2, 0.8)) * len(inner) / m))] for i in range(m)]
    rnd.shuffle(slots)  # 分槽取点：细节沿边散开，不扎堆
    for k, (p, n, u, e) in enumerate(slots):
        if k < plan[0]:
            z = -CLIFF_Z * rnd.uniform(0.25, 0.7)
            o, _ = _cliff_offset(p, z, 1.0, seed)
            rs = rnd.uniform(0.045, 0.07)
            c = p + n * (o + rs * 0.2)
            ball(f'cliff_{kind}{variant}_s{k}', rs, (c.x, c.y, z), stone[k % len(stone)], root, squash=(1.15, 1.0, 0.82), seg=20,
                 rings=10, euler=(0, 0, rnd.uniform(0, 180)))
        elif k < plan[0] + plan[1]:
            c = p + n * (CLIFF_LIP * 1.1)
            for j in range(3):
                rr = CLIFF_LIP * (0.62 - j * 0.14)
                ball(f'cliff_{kind}{variant}_d{k}_{j}', rr, (c.x, c.y, -CLIFF_LIP * (1.5 + j * 0.95)), lip, root,
                     squash=(1.0, 1.0, 1.15), seg=14, rings=8)
        else:
            o, _ = _cliff_offset(p, -CLIFF_Z, 1.0, seed)
            for j in range(3):
                a = rnd.uniform(0, math.tau)
                c = p + n * (o + 0.03) + Vector((math.cos(a), math.sin(a))) * 0.035
                rr = rnd.uniform(0.032, 0.048)
                ball(f'cliff_{kind}{variant}_g{k}_{j}', rr, (c.x, c.y, -CLIFF_Z + rr * 0.55), tuft, root, squash=(1.1, 1.0, 0.8),
                     seg=14, rings=8)
    return root


# ---------- 辅助平面 ----------

def bounce_ground(color):
    """相机不可见的地面：挡住来自下方的环境光，并给角色侧面一点地面反光。
    ⚠ 必须低于场景里一切几何的最低面（石面缝底 -0.05，出口下沉台阶底 -0.14）：它对漫反射光线不透明，
    高过谁就把谁的天空遮掉（石面曾因此出现沿交线切开的暗三角）。无限大平面放多深对受光都一样。"""
    m = C.principled('bounce', color, rough=0.9)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -0.16))
    ob = bpy.context.object
    ob.name = 'BounceGround'
    ob.data.materials.append(m)
    ob.visible_camera = False
    ob.visible_shadow = False
    return ob


def holdout_plane(name, hole=None, z=-0.0008, size=0.8, n=96):
    """只对相机生效的「挖空」地面（Holdout → alpha 0）：盖在 z≈0，把埋进地下的部分从 sprite 里抠掉，
    这样出口 / 装饰叠在任意地面变体上都不会露出地下的侧壁。hole = 中间留洞的轮廓 r(θ)（米）。"""
    m = bpy.data.materials.new(f'{name}_m')
    m.use_nodes = True
    nt = m.node_tree
    ho = nt.nodes.new('ShaderNodeHoldout')
    nt.links.new(ho.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
    bm = bmesh.new()
    if hole is None:
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size)
        for v in bm.verts:
            v.co.z = z
    else:
        angs = [2 * math.pi * i / n for i in range(n)]
        sq = lambda a: size / max(abs(math.cos(a)), abs(math.sin(a)))  # noqa: E731
        o = [bm.verts.new((sq(a) * math.cos(a), sq(a) * math.sin(a), z)) for a in angs]
        h = [bm.verts.new((hole(a) * math.cos(a), hole(a) * math.sin(a), z)) for a in angs]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((h[i], h[j], o[j], o[i]))
    ob = C.mesh_from_bm(name, bm, m, False)
    for k in ('visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_volume_scatter', 'visible_shadow'):
        setattr(ob, k, False)
    return ob


def shadow_catcher():
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    ob = bpy.context.object
    ob.name = 'ShadowCatcher'
    ob.is_shadow_catcher = True
    ob.hide_render = True
    return ob
