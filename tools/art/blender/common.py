"""渲染公共件（Blender 4.2 / Cycles CPU）：单位、等距相机、灯光、材质、网格工具。

坐标约定（与 src/render/iso.js 一致）：
  1 格 = 1 m；网格 (gx, gy) → Blender (gx, -gy, z)，Z 向上。
  相机正交，俯角 30°、绕 Z 转 45° → 2:1 等距；菱形对角线 64px ⇒ 1 屏幕像素 = √2/64 m。
  竖直高度 h 在屏幕上占 h·cos30° → 墙侧棱 16px ⇔ 0.408 m。
"""
import math

import bmesh
import bpy
from mathutils import Euler, Vector

PX = math.sqrt(2) / 64
CAM_EULER = Euler((math.radians(60), 0.0, math.radians(45)), 'XYZ')
_ROT = CAM_EULER.to_matrix()
VIEW = _ROT @ Vector((0, 0, -1))
RIGHT = _ROT @ Vector((1, 0, 0))
UP = _ROT @ Vector((0, 1, 0))
COS30 = math.cos(math.radians(30))
# 角色正面朝 -Y（网格 s）；n/e/s/w 对应网格 -y/+x/+y/-x
DIR_YAW = {'s': 0.0, 'e': math.pi / 2, 'n': math.pi, 'w': -math.pi / 2}


def project_px(p):
    """世界点 → 屏幕像素偏移 (右, 上)，相对世界原点。"""
    return p.dot(RIGHT) / PX, p.dot(UP) / PX


# ---------- 颜色 ----------

def _s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb(hex_str, alpha=1.0):
    """'#RRGGBB'（sRGB）→ 线性 RGBA，供材质 socket 使用。"""
    h = hex_str.lstrip('#')
    return tuple(_s2l(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (alpha,)


def mix_hex(a, b, t):
    pa = [int(a.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)]
    pb = [int(b.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)]
    return '#' + ''.join(f'{round(x + (y - x) * t):02X}' for x, y in zip(pa, pb))


# ---------- 场景 ----------

def setup_scene(samples=64):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    r = sc.render
    r.engine = 'CYCLES'
    cy = sc.cycles
    cy.device = 'CPU'
    cy.samples = samples
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.02
    cy.use_denoising = True
    cy.denoiser = 'OPENIMAGEDENOISE'
    cy.max_bounces = 6
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 2
    cy.transmission_bounces = 2
    cy.transparent_max_bounces = 4
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    r.film_transparent = True
    r.use_persistent_data = True
    r.resolution_percentage = 100
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGBA'
    r.image_settings.color_depth = '8'
    r.image_settings.compression = 15
    vs = sc.view_settings
    vs.view_transform = 'Standard'  # AgX 会把座位色压灰，必须用 Standard
    vs.look = 'None'
    vs.exposure = 0.0
    vs.gamma = 1.0
    return sc


def make_camera(sc):
    cam = bpy.data.cameras.new('IsoCam')
    cam.type = 'ORTHO'
    cam.clip_start = 0.1
    cam.clip_end = 200
    ob = bpy.data.objects.new('IsoCam', cam)
    sc.collection.objects.link(ob)
    sc.camera = ob
    ob.rotation_euler = CAM_EULER
    return ob


def frame_camera(sc, cam_ob, w, h, ax, ay, ss):
    """让世界原点精确落在 w×h sprite 的 (ax, ay) 像素坐标上，按 ss 倍超采样渲染。"""
    sc.render.resolution_x = int(w * ss)
    sc.render.resolution_y = int(h * ss)
    cam_ob.data.ortho_scale = max(w, h) * PX
    cam_ob.data.sensor_fit = 'AUTO'
    center = RIGHT * (-(ax - w / 2) * PX) + UP * ((ay - h / 2) * PX)
    cam_ob.location = center - VIEW * 40


def make_world(sc, color='#FFF8EE', strength=0.5, zenith=1.12, horizon=0.86):
    """竖直渐变天空：漫反射积分≈color×strength；高光里能映出上亮下暗的柔和反光带。"""
    w = bpy.data.worlds.new('World')
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes['Background']
    bg.inputs['Strength'].default_value = strength
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    base = rgb(color)
    ramp.color_ramp.elements[0].position = 0.45
    ramp.color_ramp.elements[0].color = tuple(c * horizon for c in base[:3]) + (1,)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = tuple(c * zenith for c in base[:3]) + (1,)
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = -1.0
    mr.inputs['From Max'].default_value = 1.0
    nt.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    sc.world = w
    return w


def add_sun(sc, name, to_light, energy, angle_deg, color='#FFFFFF'):
    ld = bpy.data.lights.new(name, 'SUN')
    ld.energy = energy
    ld.angle = math.radians(angle_deg)
    ld.color = rgb(color)[:3]
    ob = bpy.data.objects.new(name, ld)
    sc.collection.objects.link(ob)
    ob.rotation_euler = Vector(to_light).normalized().to_track_quat('Z', 'Y').to_euler()
    return ob


# ---------- 材质 ----------

def _set(node, values):
    for k, v in values.items():
        s = node.inputs.get(k)
        if s is None:
            raise RuntimeError(f'Principled BSDF 缺少输入：{k}')
        s.default_value = v


def principled(name, color, rough=0.5, coat=0.0, coat_rough=0.2, spec=0.5, emit=0.0, emit_color=None, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    _set(b, {
        'Base Color': rgb(color),
        'Roughness': rough,
        'Metallic': metallic,
        'Coat Weight': coat,
        'Coat Roughness': coat_rough,
        'Specular IOR Level': spec,
        'Emission Color': rgb(emit_color or color),
        'Emission Strength': emit,
    })
    return m


def vinyl(name, color, rough=0.42):
    """软胶玩具质感：中等粗糙度 + 一层薄清漆。"""
    return principled(name, color, rough=rough, coat=0.25, coat_rough=0.3, spec=0.45)


def set_base_color(mat, color):
    mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = rgb(color)


def _noise(nt, vec, scale, detail=2.0, rough=0.5):
    n = nt.nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = detail
    n.inputs['Roughness'].default_value = rough
    nt.links.new(vec, n.inputs['Vector'])
    return n.outputs['Fac']


def _math(nt, op, a, b=None, c=None):
    n = nt.nodes.new('ShaderNodeMath')
    n.operation = op
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def felt(name, c_low, c_high, z_top, z_low=0.0, sheen=1.0, sheen_tint='#F2FFF2', bump=0.18, sss=0.12, mottle=0.12):
    """植绒软陶（绿篱 / 灌木 / 花球）：
    - 底色按世界高度做竖直渐变（脚下 c_low → 顶 c_high），只叠很弱的低频起伏，干净不发花；
    - Sheen 给掠射角一圈柔亮边（绒感），少量次表面让明暗过渡变软；
    - 凹凸 = 细颗粒（绒面）+ 低频团块（蓬松），不再用 Voronoi 叶纹。"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    _set(b, {'Roughness': 0.82, 'Specular IOR Level': 0.3, 'Sheen Weight': sheen, 'Sheen Roughness': 0.38,
             'Sheen Tint': rgb(sheen_tint), 'Subsurface Weight': sss, 'Subsurface Scale': 0.025})
    b.inputs['Subsurface Radius'].default_value = (0.8, 1.0, 0.7)
    L = nt.links.new
    tc = nt.nodes.new('ShaderNodeTexCoord')
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    L(geo.outputs['Position'], sep.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = z_low
    mr.inputs['From Max'].default_value = z_top
    L(sep.outputs['Z'], mr.inputs['Value'])
    wob = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', _noise(nt, tc.outputs['Object'], 4.5, 1.0), 0.5), mottle)
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = rgb(c_low)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = rgb(c_high)
    L(_math(nt, 'ADD', mr.outputs['Result'], wob), ramp.inputs['Fac'])
    L(ramp.outputs['Color'], b.inputs['Base Color'])
    fine = _noise(nt, tc.outputs['Object'], 90.0, 3.0, 0.6)
    lump = _noise(nt, tc.outputs['Object'], 13.0, 2.0, 0.5)
    h = _math(nt, 'MULTIPLY_ADD', fine, 0.35, _math(nt, 'MULTIPLY', lump, 0.65))
    bmp = nt.nodes.new('ShaderNodeBump')
    bmp.inputs['Strength'].default_value = bump
    bmp.inputs['Distance'].default_value = 0.006
    L(h, bmp.inputs['Height'])
    L(bmp.outputs['Normal'], b.inputs['Normal'])
    return m


def stone(name, color, speck_amount=0.035, rough=0.68, bump=0.06):
    """石材：底色上只叠极弱的颗粒深浅（不再是明显麻点）+ 很浅的颗粒凹凸。"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    _set(b, {'Roughness': rough, 'Specular IOR Level': 0.35, 'Coat Weight': 0.08, 'Coat Roughness': 0.4})
    L = nt.links.new
    tc = nt.nodes.new('ShaderNodeTexCoord')
    base = rgb(color)
    dark = tuple(c * (1 - speck_amount * 2.2) for c in base[:3]) + (1,)
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = dark
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = base
    L(_noise(nt, tc.outputs['Object'], 22.0, 4.0, 0.55), ramp.inputs['Fac'])
    L(ramp.outputs['Color'], b.inputs['Base Color'])
    bmp = nt.nodes.new('ShaderNodeBump')
    bmp.inputs['Strength'].default_value = bump
    bmp.inputs['Distance'].default_value = 0.004
    L(_noise(nt, tc.outputs['Object'], 60.0, 3.0, 0.6), bmp.inputs['Height'])
    L(bmp.outputs['Normal'], b.inputs['Normal'])
    return m


# ---------- 网格 ----------

def link(ob, parent=None, loc=(0, 0, 0)):
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.location = loc
    return ob


def empty(name, loc=(0, 0, 0), parent=None):
    return link(bpy.data.objects.new(name, None), parent, loc)


def mesh_from_bm(name, bm, mat=None, smooth=True, parent=None, loc=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', [smooth] * len(me.polygons))
    if mat is not None:
        me.materials.append(mat)
    return link(bpy.data.objects.new(name, me), parent, loc)


def ellipsoid(name, radii, center=(0, 0, 0), mat=None, parent=None, rot=None, seg=40, rings=20):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    bmesh.ops.scale(bm, vec=Vector(radii), verts=bm.verts)
    if rot is not None:
        bmesh.ops.rotate(bm, cent=Vector((0, 0, 0)), matrix=Euler(rot, 'XYZ').to_matrix(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return mesh_from_bm(name, bm, mat, True, parent)


def box(name, size, center=(0, 0, 0), mat=None, parent=None, bevel=0.0, segments=3, smooth=True):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    ob = mesh_from_bm(name, bm, mat, smooth and bevel > 0, parent)
    if bevel > 0:
        md = ob.modifiers.new('Bevel', 'BEVEL')
        md.width = bevel
        md.segments = segments
        md.limit_method = 'ANGLE'
        md.harden_normals = True
    return ob


def _axis(lo, hi, r_lo, r_hi, n, k):
    """一维网格坐标：内段均匀 n 段；有圆角的一端再加 k 个圆角带点（tan 分布 ⇒ 映射到圆角上是等角度）。"""
    a = lo + r_lo
    b = hi - r_hi
    pts = [a + (b - a) * i / n for i in range(n + 1)]
    if r_lo > 0:
        pts = [a - r_lo * math.tan(math.pi / 4 * j / k) for j in range(k, 0, -1)] + pts
    if r_hi > 0:
        pts += [b + r_hi * math.tan(math.pi / 4 * j / k) for j in range(1, k + 1)]
    return pts


def rbox(name, hx, hy, z0, z1, r_xy, r_z, mat=None, parent=None, loc=(0, 0, 0), n=12, nz=4, k=5, dome=0.0, top=True):
    """圆角软块：竖棱按 r_xy、顶棱按 r_z 椭圆倒圆，底面不倒圆且不建（贴地，免得底边掏空露底）。
    dome > 0：顶面中间再鼓起 dome 米（枕头感），侧面自下而上渐入，底边保持在 z0。
    top=False：不建顶面（开口盒，配 Solidify 做箱体）。"""
    xs = _axis(-hx, hx, r_xy, r_xy, n, k)
    ys = _axis(-hy, hy, r_xy, r_xy, n, k)
    zs = _axis(z0, z1, 0.0, r_z, nz, k)
    ix, iy, iz = hx - r_xy, hy - r_xy, z1 - r_z

    def mapped(x, y, z):
        cx = max(-ix, min(ix, x))
        cy = max(-iy, min(iy, y))
        cz = min(iz, z)
        sx = (x - cx) / r_xy if r_xy else 0.0
        sy = (y - cy) / r_xy if r_xy else 0.0
        sz = (z - cz) / r_z if r_z else 0.0
        ln = math.sqrt(sx * sx + sy * sy + sz * sz)
        if ln > 1e-9:
            x, y, z = cx + r_xy * sx / ln, cy + r_xy * sy / ln, cz + r_z * sz / ln
        if dome:
            w = max(0.0, min(1.0, (z - z0) / (z1 - z0))) ** 2
            z += dome * max(0.0, 1 - (x / hx) ** 2) * max(0.0, 1 - (y / hy) ** 2) * w
        return Vector((x, y, z))

    bm = bmesh.new()
    cache = {}

    def vert(x, y, z):
        key = (round(x, 7), round(y, 7), round(z, 7))
        v = cache.get(key)
        if v is None:
            v = cache[key] = bm.verts.new(mapped(x, y, z))
        return v

    def grid(us, vs, f, flip):
        for i in range(len(us) - 1):
            for j in range(len(vs) - 1):
                q = [f(us[i], vs[j]), f(us[i + 1], vs[j]), f(us[i + 1], vs[j + 1]), f(us[i], vs[j + 1])]
                bm.faces.new([vert(*p) for p in (reversed(q) if flip else q)])

    if top:
        grid(xs, ys, lambda x, y: (x, y, z1), False)
    grid(ys, zs, lambda y, z: (hx, y, z), False)
    grid(ys, zs, lambda y, z: (-hx, y, z), True)
    grid(xs, zs, lambda x, z: (x, hy, z), True)
    grid(xs, zs, lambda x, z: (x, -hy, z), False)
    return mesh_from_bm(name, bm, mat, True, parent, loc)


def slab(name, hx, hy, z0, z1, r_plan, bevel, mat=None, parent=None, loc=(0, 0, 0), corner_seg=6, bevel_seg=4):
    """圆角矩形石块：平面四角按 r_plan 倒圆；顶棱用 bevel 宽的四分之一圆倒圆（手工放样，不走 Bevel 修改器）。
    顶面从中心扇形三角化（圆角矩形是凸的，扇形不会翻面）。"""
    r = max(min(r_plan, hx * 0.95, hy * 0.95), bevel * 1.2)

    def ring(d, z):
        rr = r - d
        out = []
        for cx, cy, a0 in ((hx - r, hy - r, 0), (-hx + r, hy - r, 90), (-hx + r, -hy + r, 180), (hx - r, -hy + r, 270)):
            for j in range(corner_seg + 1):
                a = math.radians(a0 + 90 * j / corner_seg)
                out.append((cx + rr * math.cos(a), cy + rr * math.sin(a), z))
        return out

    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in ring(0.0, z0)]]
    for k in range(bevel_seg + 1):
        t = math.pi / 2 * k / bevel_seg
        rings.append([bm.verts.new(p) for p in ring(bevel * (1 - math.cos(t)), z1 - bevel * (1 - math.sin(t)))])
    n = len(rings[0])
    for lo, hi in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    c = bm.verts.new((0, 0, z1))
    top = rings[-1]
    for i in range(n):
        bm.faces.new((top[i], top[(i + 1) % n], c))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = mesh_from_bm(name, bm, mat, True, parent, loc)
    wn = ob.modifiers.new('WN', 'WEIGHTED_NORMAL')
    wn.weight = 100
    return ob


def puff(ob, cell=0.07, strength=0.05, mid=0.15, subdiv=0, offset=(0, 0, 0)):
    """蓬松叶团：Voronoi F1²（细胞中心 0、边缘大）取负向沿法线推 → 细胞中心鼓出、细胞边界凹成折痕，
    表面是一颗颗抛物面软包，剪影也跟着起伏。cell = 叶团直径量级（米）；1 屏幕像素 ≈ 0.022 m，
    取 3–4 px 一团在 64px 下读得出又不碎。offset：纹理坐标偏移，让不同变体的叶团排布不同。"""
    if subdiv:
        sd = ob.modifiers.new('Sub', 'SUBSURF')
        sd.subdivision_type = 'SIMPLE'
        sd.levels = sd.render_levels = subdiv
    tex = bpy.data.textures.new(f'{ob.name}_puff', 'VORONOI')
    tex.noise_scale = cell
    tex.distance_metric = 'DISTANCE_SQUARED'
    tex.color_mode = 'INTENSITY'
    tex.noise_intensity = 1.0
    ref = empty(f'{ob.name}_puffref', Vector(offset))
    d = ob.modifiers.new('Puff', 'DISPLACE')
    d.texture = tex
    d.texture_coords = 'OBJECT'
    d.texture_coords_object = ref
    d.direction = 'NORMAL'
    d.mid_level = mid
    d.strength = -strength
    return ob


def tube(name, pts, radius, mat, parent=None):
    """沿折线的圆管（嘴巴用），两端封口。"""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = radius
    cu.bevel_resolution = 3
    cu.use_fill_caps = True
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for p, co in zip(sp.points, pts):
        p.co = (co[0], co[1], co[2], 1.0)
    cu.materials.append(mat)
    return link(bpy.data.objects.new(name, cu), parent)


def descendants(ob):
    out = [ob]
    for c in ob.children:
        out.extend(descendants(c))
    return out
