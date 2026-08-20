# 批量烘焙 MMD 模型默认姿势：把 腕/ひじ 摆成「大臂 3° 贴身下垂、直臂、
# 手自然垂在身侧」，烘焙进网格顶点（PMX 不存骨骼旋转，默认姿势在顶点里）。
#
# 用法（一次一个模型，单进程避免跨模型状态污染）：
#   /Applications/Blender.app/Contents/MacOS/Blender --background \
#     --python scripts/bake-default-pose.py -- <模型id> <输入pmx> <输出pmx>
#
# 流程：mmd_tools 导入 → 摆臂（pb.matrix 直接赋值，绕骨骼头旋转）→ 烘焙
# （评估网格的顶点坐标与自定义法线写回原网格，形态键原位重建）→ 骨骼复位
# → mmd_tools 导出。导出时 mmd_tools 用 evaluated mesh（含修改器、静止姿势），
# 顶点/法线/形态键按当前数据原样写出；骨骼名经 mmd_bone.name_j 还原为原名。
#
# 形态键处理（Blender 不允许对带键网格 apply 修改器，改走「数据拷贝」路线，
# 无需剥离键，键名/值/相对关系全部保留）：
#   - 相对键（表情/口型）：偏移向量随顶点主骨骼的姿态增量旋转（3x3）。
#   - SDEF 键（mmd_sdef_c/r0/r1，绝对参考点坐标）：随主骨骼刚性变换（4x4，
#     绕骨骼头旋转，与 MMD 运行时骨骼姿态增量语义一致）。
# 主骨骼 = 顶点权重最大的顶点组对应骨骼；姿态增量 = pose.matrix @ rest⁻¹
# （骨架对象空间），再按网格对象矩阵共轭到网格空间。
import bpy
import math
import os
import sys
import traceback

from mathutils import Matrix, Vector

ARM_SPREAD_DEG = 3.0

# MMD 模型坐标经 mmd_tools xzy 转换后是 Blender Z 轴向上；
# 左臂在 Blender +X、右臂在 −X（pmx 左腕 x=+1.2 等，xzy 转换保留 x 符号）；
# 3° 外展 = 左臂向 +X、右臂向 −X；下 = Blender −Z。
TARGET_LEFT = Vector((math.sin(math.radians(ARM_SPREAD_DEG)), 0.0, -math.cos(math.radians(ARM_SPREAD_DEG)))).normalized()
TARGET_RIGHT = Vector((-math.sin(math.radians(ARM_SPREAD_DEG)), 0.0, -math.cos(math.radians(ARM_SPREAD_DEG)))).normalized()

# mmd_tools 导入后骨骼名带 .L/.R 后缀（左腕→腕.L），导出时还原为原名
ARMS = [
    ('腕.L', 'ひじ.L', '手首.L', TARGET_LEFT),
    ('腕.R', 'ひじ.R', '手首.R', TARGET_RIGHT),
]


def log(msg):
    sys.stdout.write(f'[bake-pose] {msg}\n')
    sys.stdout.flush()


def find_armature():
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            return obj
    return None


def pose_arm(arm):
    """把左右臂摆成 3° 贴身下垂（直臂）。返回被修改的骨骼名列表。"""
    bones = arm.data.bones
    touched = []
    for upper, lower, wrist, target in ARMS:
        if any(n not in bones for n in (upper, lower, wrist)):
            log(f'  骨骼链缺失 {(upper, lower, wrist)}，跳过该臂')
            continue
        # 上臂：绕骨骼头把 rest 的 腕→ひじ 方向转到 target
        head = bones[upper].matrix_local.translation
        rest_dir = (bones[lower].matrix_local.translation - head).normalized()
        r_new = rest_dir.rotation_difference(target).to_matrix() @ bones[upper].matrix_local.to_3x3()
        arm.pose.bones[upper].matrix = Matrix.Translation(head) @ r_new.to_4x4()
        bpy.context.view_layer.update()
        # 前臂：直臂——ひじ→手首 也指向 target。肘的位置显式计算为「上臂
        # 姿态施加于 rest 肘」——腕捩等中间骨骼不继承父链旋转时肘也不会掉队
        upper_rest = bones[upper].matrix_local
        elbow_in_upper = upper_rest.inverted() @ bones[lower].matrix_local.translation
        elbow_world = arm.pose.bones[upper].matrix @ elbow_in_upper
        rest_dir_l = (bones[wrist].matrix_local.translation - bones[lower].matrix_local.translation).normalized()
        r_new_l = rest_dir_l.rotation_difference(target).to_matrix() @ bones[lower].matrix_local.to_3x3()
        arm.pose.bones[lower].matrix = Matrix.Translation(elbow_world) @ r_new_l.to_4x4()
        bpy.context.view_layer.update()
        touched.extend([upper, lower])
    return touched


def bone_deltas(arm):
    """全部骨骼的姿态增量 {名: 4x4}（骨架对象空间：pose.matrix @ rest⁻¹）。

    未直接摆臂的骨骼（如 手首）增量非单位阵——继承摆臂父链的旋转，
    其顶点（手部形态键/SDEF 参考点）需要同样跟随。
    """
    deltas = {}
    for pb in arm.pose.bones:
        deltas[pb.name] = pb.matrix @ pb.bone.matrix_local.inverted()
    return deltas


def vertex_dominant_bone(mesh):
    """每个顶点的主骨骼：权重最大的顶点组名（无组顶点为 None）。"""
    if not mesh.vertex_groups:
        return {}
    result = {}
    groups = mesh.vertex_groups
    for vi, v in enumerate(mesh.data.vertices):
        best = (-1.0, None)
        for g in v.groups:
            w = g.weight
            if w > best[0]:
                best = (w, groups[g.group].name)
        result[vi] = best[1]
    return result


def bake_meshes(arm, touched):
    """把当前姿态烘焙进网格：评估网格坐标/法线写回，形态键原位重建。"""
    deltas_arm = bone_deltas(arm)
    arm_mat = arm.matrix_world
    arm_mat_inv = arm_mat.inverted()
    targets = [obj for obj in bpy.data.objects
               if obj.type == 'MESH' and any(m.type == 'ARMATURE' and m.object == arm for m in obj.modifiers)]
    log(f'待烘焙网格 {len(targets)} 个')

    for obj in targets:
        me = obj.data
        if me.users > 1:
            me = me.copy()
            obj.data = me
        # 网格空间 4x4 增量：T = (M⁻¹·W)·D·(W⁻¹·M)
        q = arm_mat_inv @ obj.matrix_world
        q_inv = obj.matrix_world.inverted() @ arm_mat
        t_map = {name: q_inv @ d @ q for name, d in deltas_arm.items()}

        keys = me.shape_keys.key_blocks if me.shape_keys is not None else None
        basis_data = keys[0].data if keys else None
        # Blender 5.0：带 shape key 的网格，me.vertices 与 keys[0].data（Basis）
        # 是两个独立数组，评估/导出读的是 keys[0].data。必须先快照原始 Basis
        # 坐标（列表拷贝，后续覆盖 keys[0] 后仍可用），相对偏移也以它为基准。
        basis_orig = [basis_data[i].co.copy() for i in range(len(basis_data))] if basis_data else None
        saved = {}        # {键名: (value, 相对偏移列表)}  —— 非 sdef 键
        saved_sdef = {}   # {键名: 绝对坐标列表}               —— mmd_sdef_* 键
        vertex_bone = {}
        if keys:
            for k in keys[1:]:
                if k.name.startswith('mmd_sdef_'):
                    saved_sdef[k.name] = [k.data[i].co.copy() for i in range(len(basis_orig))]
                else:
                    saved[k.name] = (k.value, [k.data[i].co - basis_orig[i] for i in range(len(basis_orig))])
            if saved_sdef or saved:
                vertex_bone = vertex_dominant_bone(obj)

        # 评估网格（含摆臂修改器效果）
        deps = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(deps)
        mev = ev.to_mesh(depsgraph=deps, preserve_all_data_layers=True)

        # 顶点坐标写回。带 shape key 的网格（全部 MMD 网格）：评估网格的顶点
        # 来自 Basis 键数据（keys[0].data），与 me.vertices 是两个独立数组，
        # 只写 me.vertices 导出仍是原始坐标（diag-keys 实证）——两个都写。
        coords = [c for v in mev.vertices for c in v.co]
        me.vertices.foreach_set('co', coords)
        if basis_data is not None:
            basis_data.foreach_set('co', coords)
        # 自定义法线写回（评估网格的法线已被修改器随姿势变换）
        me.normals_split_custom_set([n.vector for n in mev.corner_normals])
        me.update()
        ev.to_mesh_clear()
        # foreach_set 不改网格版本号，导出时 evaluated_get 会命中陈旧缓存
        # （导出前评估的仍是原始顶点）；必须 update_tag 标记脏
        me.update_tag()
        obj.update_tag()
        bpy.context.view_layer.update()

        # 形态键原位重建：相对键偏移随主骨骼旋转；sdef 参考点随主骨骼刚性变换
        if keys:
            for name, (value, offsets) in saved.items():
                k = keys[name]
                k.value = value
                for i, off in enumerate(offsets):
                    t = t_map.get(vertex_bone.get(i))
                    if t is not None:
                        off = t.to_3x3() @ off
                    k.data[i].co = basis_data[i].co + off
            for name, coords in saved_sdef.items():
                k = keys[name]
                for vi, coord in enumerate(coords):
                    t = t_map.get(vertex_bone.get(vi))
                    if t is not None:
                        coord = t @ coord
                    k.data[vi].co = coord
            me.shape_keys.update_tag()


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    if len(argv) < 3:
        log(f'参数不足: {argv}')
        sys.exit(2)
    model_id, in_path, out_path = argv[0], argv[1], argv[2]
    log(f'处理 {model_id}: {in_path} -> {out_path}')
    if not os.path.exists(in_path):
        log(f'输入不存在: {in_path}')
        sys.exit(2)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    import addon_utils
    addon_utils.enable('mmd_tools')
    bpy.ops.mmd_tools.import_model(
        filepath=in_path,
        types={'MESH', 'ARMATURE', 'PHYSICS', 'DISPLAY', 'MORPHS'},
        scale=0.08,
        clean_model=True,
        remove_doubles=False,
        fix_bone_order=True,
    )
    arm = find_armature()
    if arm is None:
        log('未找到骨架，中止')
        sys.exit(3)
    log(f'骨架 {arm.name}，骨骼 {len(arm.data.bones)}，网格 {sum(1 for o in bpy.data.objects if o.type == "MESH")}')

    sdef_meshes = 0
    for obj in bpy.data.objects:
        if obj.type == 'MESH' and obj.data.shape_keys is not None and 'mmd_sdef_c' in obj.data.shape_keys.key_blocks:
            sdef_meshes += 1
    log(f'含 SDEF 的网格: {sdef_meshes}')

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    touched = pose_arm(arm)
    bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode='OBJECT')
    log(f'已摆臂: {touched}')

    # 摆臂后手/肘世界位置自检
    bones = arm.data.bones
    for side, upper, lower, wrist in (('L', *ARMS[0][:3]), ('R', *ARMS[1][:3])):
        if upper not in bones:
            continue
        ph = lambda n: tuple(round(x, 3) for x in arm.pose.bones[n].matrix.translation)
        log(f'  姿势自检 {side}: 肩{ph(upper)} 肘{ph(lower)} 腕{ph(wrist)}')

    bake_meshes(arm, touched)

    # 骨骼复位：被修改的骨骼完整恢复 rest 矩阵（pose 必须精确为身份，
    # 否则导出时的 evaluated mesh 会被残留姿势再次变形）
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    for name in touched:
        pb = arm.pose.bones.get(name)
        if pb is not None:
            pb.matrix = pb.bone.matrix_local
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()

    # 导出前选中骨架并激活（export_pmx 的 poll 要求 active ∈ selected 且属于 MMD 模型）
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.mmd_tools.export_pmx(
        filepath=out_path,
        scale=12.5,
        copy_textures_mode='NONE',
        sort_materials=False,
        disable_specular=False,
        visible_meshes_only=False,
        export_vertex_colors_as_adduv2=False,
        fix_bone_order=True,
        overwrite_bone_morphs_from_action_pose=False,
        translate_in_presets=False,
        normal_handling='PRESERVE_ALL_NORMALS',
    )
    log(f'导出完成: {out_path} ({os.path.getsize(out_path)} 字节)')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
