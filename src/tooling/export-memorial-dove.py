# Подготовка модели Paul Spooner (CC BY 4.0); авторство и запуск: docs/memorial-dove.md.
# Запускайте Blender с --disable-autoexec: исходный blend содержит сторонний Python.
import bpy, os
from mathutils import Vector
bird = bpy.data.objects['Bird']; rig = bpy.data.objects['rig']; scene=bpy.context.scene
for o in list(bpy.data.objects):
    if o not in [bird,rig]: bpy.data.objects.remove(o,do_unlink=True)
for t in list(rig.animation_data.nla_tracks): rig.animation_data.nla_tracks.remove(t)
rig.animation_data.action = bpy.data.actions['Takeoff']
scene.frame_set(1)
bird.data.materials.clear()
def material(name,color,roughness):
    m=bpy.data.materials.new(name); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*color,1); p.inputs['Roughness'].default_value=roughness
    bird.data.materials.append(m)
material('Ivory plumage',(0.91,0.9,0.86),0.88)
material('Eyes',(0.012,0.01,0.007),0.2)
material('Feet',(0.35,0.19,0.16),0.75)
material('Beak',(0.37,0.32,0.27),0.65)
for p in bird.data.polygons:
    weights={}
    for idx in p.vertices:
        for g in bird.data.vertices[idx].groups:
            name=bird.vertex_groups[g.group].name
            weights[name]=weights.get(name,0)+g.weight/len(p.vertices)
    eye=sum(w for n,w in weights.items() if 'eye.' in n)
    beak=sum(w for n,w in weights.items() if 'beak' in n)
    feet=sum(w for n,w in weights.items() if any(s in n for s in ['foot','shin','t_index','t_middle','t_ring','t_thumb']))
    p.material_index=1 if eye>0.5 else 3 if beak>0.5 else 2 if feet>0.5 else 0
    p.use_smooth=True
bpy.context.view_layer.objects.active=bird
bpy.ops.object.select_all(action='DESELECT'); bird.select_set(True)
bpy.ops.object.modifier_apply(modifier='Mirror')
sub=bird.modifiers.new('Smooth plumage','SUBSURF'); sub.levels=1; sub.render_levels=1
print('ATTRS', [(a.name,a.data_type) for a in bird.data.attributes])
for attr in list(bird.data.attributes):
    if 'crease' in attr.name or 'normal' in attr.name or 'sharp' in attr.name: bird.data.attributes.remove(attr)
for p in bird.data.polygons: p.use_smooth=True
rig.select_set(True)
scene.frame_start=1; scene.frame_end=60
params=bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
print('EXPORT_PARAMS', [p for p in params if 'anim' in p or 'bone' in p])
out=os.path.abspath('src/assets/memorial-dove.glb')
# Bake the evaluated 3D surface, including subdivision AFTER armature deformation.
# This preserves the original feathers without shipping hundreds of rig controls.
deps=bpy.context.evaluated_depsgraph_get()
mesh=bpy.data.meshes.new_from_object(bird.evaluated_get(deps),depsgraph=deps)
baked=bpy.data.objects.new('White dove',mesh); scene.collection.objects.link(baked)
baked.matrix_world=bird.matrix_world.copy()
baked.shape_key_add(name='Basis')
frames=list(range(1,60,4))+[60]
for frame in frames:
    scene.frame_set(frame); deps.update()
    ev=bird.evaluated_get(deps); temp=ev.to_mesh()
    key=baked.shape_key_add(name='Pose_%02d'%frame)
    for v in temp.vertices: key.data[v.index].co=v.co
    ev.to_mesh_clear()
    index=frames.index(frame)
    for f,val in [(frames[max(0,index-1)],0),(frame,1),(frames[min(len(frames)-1,index+1)],0)]:
        if f == frame and val == 0: continue
        key.value=val; key.keyframe_insert(data_path='value',frame=f)
for layer in baked.data.shape_keys.animation_data.action.layers:
    for strip in layer.strips:
        for bag in strip.channelbags:
            for curve in bag.fcurves:
                for k in curve.keyframe_points: k.interpolation='LINEAR'
baked.data.shape_keys.animation_data.action.name='Takeoff'
bpy.ops.object.select_all(action='DESELECT'); baked.select_set(True); bpy.context.view_layer.objects.active=baked
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=out,export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='ACTIVE_ACTIONS',export_frame_range=True,export_force_sampling=True,export_morph=True,export_morph_normal=True,export_cameras=False,export_lights=False)
baked.hide_render=True
bpy.context.view_layer.update()
ev=bird.evaluated_get(bpy.context.evaluated_depsgraph_get()); points=[ev.matrix_world@Vector(c) for c in ev.bound_box]; target=sum(points,Vector())/8
print('CENTER', list(target), 'BOUNDS',[(min(p[i] for p in points),max(p[i] for p in points)) for i in range(3)])
scene.render.engine='CYCLES'; scene.cycles.samples=32; scene.render.film_transparent=True
scene.render.resolution_x=384; scene.render.resolution_y=384; scene.render.resolution_percentage=100
scene.world.color=(0.5,0.5,0.5)
bpy.ops.object.camera_add(location=target+Vector((-0.7,-0.4,0.2)))
cam=bpy.context.object; cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.type='ORTHO'; cam.data.ortho_scale=0.75; scene.camera=cam
for loc,power,size in [((-.3,-.5,.7),20,.5),((.4,.2,.5),12,.5)]:
    bpy.ops.object.light_add(type='AREA',location=target+Vector(loc)); l=bpy.context.object
    l.data.energy=power; l.data.shape='DISK'; l.data.size=size; l.rotation_euler=(target-l.location).to_track_quat('-Z','Y').to_euler()
scene.render.image_settings.file_format='PNG'; scene.render.filepath=os.path.abspath('src/assets/memorial-dove-rest.png'); bpy.ops.render.render(write_still=True)
for frame in [15,30,45,60]:
    scene.frame_set(frame)
    scene.render.filepath=os.path.abspath('outputs/dove-3d/frame-%d.png'%frame); bpy.ops.render.render(write_still=True)
