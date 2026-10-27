/* =========================================================================
   EasyRenderer 3D — Application Logic
   A lightweight, browser-native 3D animation & rendering studio.
   Built on Three.js. No build step, no server, no upload of assets.
   ========================================================================= */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createClient } from '@supabase/supabase-js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/* ---------------------------------------------------------------------
   Global App State
--------------------------------------------------------------------- */
const App = {
  scene: null,
  renderer: null,
  activeCamera: null,
  defaultCamera: null,
  orbit: null,
  transform: null,
  grid: null,
  ground: null,

  sceneObjects: [],        // { id, name, type, object3D, isLight, isCamera, visible, locked }
  selected: null,
  idCounter: 1,

  clock: new THREE.Clock(),

  timeline: { duration: 10, currentTime: 0, playing: false, loop: false },
  mixers: [],
  keyframes: {},           // objectId -> [{time, position, rotation, scale, intensity, ease}]

  cameraPath: {
    points: [], curveType: 'catmullrom', line: null, markers: [],
    previewing: false, previewStart: 0, curve: null,
  },

  recorder: { mediaRecorder: null, chunks: [], recording: false, startTime: 0, endAt: 0, failsafe: null, prevLoop: undefined },
  renderSettings: { width: 1280, height: 720, fps: 30, bitrate: 12, format: 'mp4', hideHelpers: true },
  undo: { stack: [], redoStack: [], suppress: false },
  snapping: false,
  tool: 'select',
};

const SUPABASE_URL = 'https://uajfndbvaloapwwmehzv.supabase.co';
// The anon key is a *public* key (safe in client code; Row Level Security protects the data). Paste it once:
// Supabase Dashboard -> Project Settings -> API -> "anon public". NEVER put the service_role key here.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhamZuZGJ2YWxvYXB3d21laHp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MTY3NjgsImV4cCI6MjEwNzE5Mjc2OH0.a3YncNtObT_bqOEzE4pzeBaPGSJVyQWXxDsL7WWeOko';
// Google OAuth Client ID. It is configured in Supabase (Auth -> Providers -> Google); client code never needs the secret.
const GOOGLE_CLIENT_ID = '73767187639-vahi0fdfnht2e7hhm2fpab1ktvglg583.apps.googleusercontent.com';
const dracoLoader = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const Easing = {
  linear: (f) => f,
  smooth: (f) => f * f * (3 - 2 * f),
  easeIn: (f) => f * f,
  easeOut: (f) => 1 - (1 - f) * (1 - f),
};

/* ---------------------------------------------------------------------
   Cinematic Post-FX state (bloom, vignette, grain, fringe, grade, dust)
   Declared up here so every function can safely reference it.
--------------------------------------------------------------------- */
const FX = {
  ready: false,
  composer: null, renderPass: null, bloom: null, output: null, cinema: null,
  w: 0, h: 0, pr: 0, size: new THREE.Vector2(),
  dust: null, panel: null,
  params: {
    enabled: true,
    bloom: 0.35, bloomRadius: 0.5, bloomThreshold: 0.85,
    vignette: 0.35, grain: 0.04, aberration: 0.0015,
    saturation: 1.08, contrast: 1.05, exposure: 1.05,
    dust: false,
  },
};

/* ---------------------------------------------------------------------
   Splash Screen — ambient animated backdrop (lightweight canvas 2D)
--------------------------------------------------------------------- */
function initSplashBackdrop() {
  const canvas = document.getElementById('splashCanvas');
  const ctx = canvas.getContext('2d');
  let w, h, particles;

  function resize() { w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; }
  function makeParticles() {
    particles = Array.from({ length: 70 }, () => ({
      x: Math.random() * w, y: Math.random() * h, z: Math.random() * 1 + 0.2, s: Math.random() * 1.6 + 0.4,
    }));
  }
  resize(); makeParticles();
  window.addEventListener('resize', () => { resize(); makeParticles(); });

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(232,119,45,0.55)';
    const t = performance.now() * 0.00006;
    for (const p of particles) {
      const x = (p.x + Math.sin(t * 10 + p.y) * 20 * p.z);
      const y = (p.y + Math.cos(t * 10 + p.x) * 20 * p.z);
      ctx.globalAlpha = 0.25 + p.z * 0.4;
      ctx.beginPath();
      ctx.arc(x, y, p.s * p.z * 2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (document.getElementById('splash').style.display !== 'none') requestAnimationFrame(draw);
  }
  draw();
}
initSplashBackdrop();

document.getElementById('openStudioBtn').addEventListener('click', openStudioFlow);

function enterStudio() {
  const splash = document.getElementById('splash');
  document.getElementById('studio').classList.add('visible');
  splash.style.transition = 'opacity .5s ease';
  splash.style.opacity = '0';
  setTimeout(() => { splash.style.display = 'none'; }, 500);
  initApp();
}

// Open Studio -> check session -> (login modal) -> studio -> Recent Projects dashboard
async function openStudioFlow() {
  if (!Cloud.client && !createCloudClient()) return;
  const { data: { session } } = await Cloud.client.auth.getSession();
  if (session) return afterAuth(session);
  openAuthModal();
}

async function afterAuth(session) {
  if (Cloud.entering || Cloud.ready) return; Cloud.entering = true;
  closeAuthModal();
  enterStudio();
  await startCloud(session);
  openDashboard(true);
  Cloud.entering = false;
}

/* ---------------------------------------------------------------------
   Three.js Core Init
--------------------------------------------------------------------- */
let initialized = false;

function initApp() {
  if (initialized) { onResize(); return; }
  initialized = true;

  const container = document.getElementById('viewportContainer');
  const canvas = document.getElementById('viewport');

  App.scene = new THREE.Scene();

  App.defaultCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
  App.defaultCamera.position.set(6, 5, 9);
  App.activeCamera = App.defaultCamera;

  App.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  App.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  App.renderer.shadowMap.enabled = true;
  App.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  App.renderer.outputColorSpace = THREE.SRGBColorSpace;
  App.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  App.renderer.toneMappingExposure = 1.05;
  App.envTex = new THREE.PMREMGenerator(App.renderer).fromScene(new RoomEnvironment(), 0.04).texture;

  App.grid = new THREE.GridHelper(30, 30, 0x3a3a3a, 0x232323);
  App.scene.add(App.grid);
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.35 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.__helper = true;
  App.scene.add(ground);
  App.ground = ground;

  // Default studio lighting rig (not undo-tracked — this is the starting state)
  App.undo.suppress = true;
  addLight('ambient', { name: 'Ambient Fill', intensity: 0.5, silent: true });
  addLight('directional', { name: 'Key Light', intensity: 1.4, position: [6, 9, 4], silent: true });
  App.undo.suppress = false;

  App.orbit = new OrbitControls(App.defaultCamera, App.renderer.domElement);
  App.orbit.enableDamping = true;
  App.orbit.dampingFactor = 0.08;
  App.orbit.target.set(0, 1, 0);

  App.transform = new TransformControls(App.defaultCamera, App.renderer.domElement);
  App.transform.addEventListener('dragging-changed', onTransformDraggingChanged);
  App.transform.addEventListener('objectChange', () => { if (App.selected) syncTransformUIFromObject(App.selected); });
  App.scene.add(App.transform);
  App.transform.visible = false;

  onResize();
  window.addEventListener('resize', onResize);
  // Re-fit whenever the viewport box changes for ANY reason (panels, menus, devtools), not only window resize
  new ResizeObserver(() => { if (!App.recorder.recording) onResize(); }).observe(container);

  setupUIBindings();
  setupDragDrop();
  applyEnvironmentSettings();
  refreshHierarchy();
  updateUndoRedoButtons();
  bindCloudUI();

  App.renderer.setAnimationLoop(renderLoop);

  // Cinematic post-processing loads in the background; the studio works without it if it fails to load
  initPostFX();
}

function onResize() {
  const container = document.getElementById('viewportContainer');
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  App.renderer.setSize(w, h, false); // false: CSS size is owned by the stylesheet (canvas fills its container)
  for (const cam of [App.defaultCamera, ...App.sceneObjects.filter(o => o.isCamera).map(o => o.object3D)]) {
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
}

/* ---------------------------------------------------------------------
   Render Loop
--------------------------------------------------------------------- */
let lastFpsUpdate = 0, frameCount = 0;

function renderLoop() {
  const delta = App.clock.getDelta();

  if (App.timeline.playing) {
    App.timeline.currentTime += delta;
    if (App.timeline.currentTime >= App.timeline.duration) {
      if (App.timeline.loop && !App.recorder.recording) {
        App.timeline.currentTime = 0;
      } else {
        App.timeline.currentTime = App.timeline.duration;
        setPlaying(false);
        // Timeline finished while exporting: keep rendering a short tail so the last frame is captured, then stop
        if (App.recorder.recording && !App.recorder.endAt) App.recorder.endAt = performance.now() + 350;
      }
    }
    applyKeyframesAtTime(App.timeline.currentTime);
    updateTimelineUI();
  }

  if (App.cameraPath.previewing) stepCameraPathPreview();
  if (App.orbit.enabled !== false) App.orbit.update();

  renderFrame();

  // Auto-stop the export once the timeline has reached its end (and the tail has been rendered)
  if (App.recorder.recording && App.recorder.endAt && performance.now() >= App.recorder.endAt) stopRecording();

  frameCount++;
  const now = performance.now();
  if (now - lastFpsUpdate > 500) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    document.getElementById('fpsCounter').textContent = fps + ' FPS';
    frameCount = 0;
    lastFpsUpdate = now;
    updateStats();
  }
}

/* ---------------------------------------------------------------------
   Undo / Redo Manager
--------------------------------------------------------------------- */
function pushUndo(undoFn, redoFn) {
  if (App.undo.suppress) return;
  App.undo.stack.push({ undo: undoFn, redo: redoFn });
  if (App.undo.stack.length > 100) App.undo.stack.shift();
  App.undo.redoStack = [];
  updateUndoRedoButtons();
}
function performUndo() {
  const cmd = App.undo.stack.pop();
  if (!cmd) return;
  App.undo.suppress = true;
  cmd.undo();
  App.undo.suppress = false;
  App.undo.redoStack.push(cmd);
  updateUndoRedoButtons();
}
function performRedo() {
  const cmd = App.undo.redoStack.pop();
  if (!cmd) return;
  App.undo.suppress = true;
  cmd.redo();
  App.undo.suppress = false;
  App.undo.stack.push(cmd);
  updateUndoRedoButtons();
}
function updateUndoRedoButtons() {
  document.getElementById('undoBtn').disabled = App.undo.stack.length === 0;
  document.getElementById('redoBtn').disabled = App.undo.redoStack.length === 0;
}

function snapshotTRS(o) {
  return {
    position: o.position.toArray(),
    rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
    scale: o.scale.toArray(),
  };
}
function applyTRS(o, s) {
  o.position.fromArray(s.position);
  o.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
  o.scale.fromArray(s.scale);
  updateLightHelper(o);
  if (o.userData.__helper && o.userData.__helper.update) o.userData.__helper.update();
}
function trsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

let dragSnapshot = null;
function onTransformDraggingChanged(e) {
  App.orbit.enabled = !e.value;
  if (e.value) {
    dragSnapshot = App.selected ? snapshotTRS(App.selected.object3D) : null;
  } else if (App.selected && dragSnapshot) {
    const entry = App.selected;
    const before = dragSnapshot;
    const after = snapshotTRS(entry.object3D);
    if (!trsEqual(before, after)) {
      pushUndo(
        () => { applyTRS(entry.object3D, before); if (App.selected === entry) syncTransformUIFromObject(entry); },
        () => { applyTRS(entry.object3D, after); if (App.selected === entry) syncTransformUIFromObject(entry); }
      );
    }
    dragSnapshot = null;
  }
}

/* Generic helpers to wire numeric/slider inputs into undo history on commit */
function removeFromSceneKeepData(entry) {
  App.scene.remove(entry.object3D);
  if (entry.object3D.userData.__helper) App.scene.remove(entry.object3D.userData.__helper);
  App.sceneObjects = App.sceneObjects.filter((o) => o.id !== entry.id);
  if (App.selected && App.selected.id === entry.id) selectEntry(null);
  refreshHierarchy();
  refreshKeyTrack();
}
function addBackToScene(entry, index) {
  App.scene.add(entry.object3D);
  if (entry.object3D.userData.__helper) App.scene.add(entry.object3D.userData.__helper);
  if (index !== undefined && index >= 0 && index <= App.sceneObjects.length) App.sceneObjects.splice(index, 0, entry);
  else App.sceneObjects.push(entry);
  refreshHierarchy();
  refreshKeyTrack();
}

/* ---------------------------------------------------------------------
   Scene Object Registry / Hierarchy
--------------------------------------------------------------------- */
function registerObject({ name, object3D, isLight = false, isCamera = false, type = 'mesh' }) {
  const entry = { id: App.idCounter++, name, object3D, isLight, isCamera, type, visible: true, locked: false };
  App.sceneObjects.push(entry);
  object3D.userData.__entryId = entry.id;
  refreshHierarchy();
  return entry;
}

function removeObjectEntry(entry) {
  if (!entry || entry.locked) return;
  const index = App.sceneObjects.findIndex((o) => o.id === entry.id);
  removeFromSceneKeepData(entry);
  pushUndo(
    () => addBackToScene(entry, index),
    () => removeFromSceneKeepData(entry)
  );
}

function refreshHierarchy() {
  const list = document.getElementById('hierarchyList');
  list.innerHTML = '';
  for (const entry of App.sceneObjects) {
    const div = document.createElement('div');
    div.className = 'hierarchy-item' + (App.selected && App.selected.id === entry.id ? ' selected' : '') + (entry.locked ? ' locked' : '');
    const icon = entry.isCamera ? 'fa-video' : entry.isLight ? 'fa-lightbulb' : 'fa-cube';

    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid ${icon}`;
    iconEl.style.cssText = 'width:13px; font-size:11px; flex-shrink:0;';

    const nameEl = document.createElement('span');
    nameEl.className = 'h-name';
    nameEl.textContent = entry.name;
    nameEl.title = 'Double-click to rename';
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(entry, nameEl); });

    const eyeBtn = document.createElement('span');
    eyeBtn.className = 'h-icon-btn';
    eyeBtn.innerHTML = `<i class="fa-solid ${entry.visible !== false ? 'fa-eye' : 'fa-eye-slash'}"></i>`;
    eyeBtn.title = 'Toggle visibility';
    eyeBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleVisibility(entry); });

    const lockBtn = document.createElement('span');
    lockBtn.className = 'h-icon-btn';
    lockBtn.innerHTML = `<i class="fa-solid ${entry.locked ? 'fa-lock' : 'fa-lock-open'}"></i>`;
    lockBtn.title = 'Toggle lock';
    lockBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLock(entry); });

    div.append(iconEl, nameEl, eyeBtn, lockBtn);
    div.addEventListener('click', () => { if (!entry.locked) selectEntry(entry); });
    list.appendChild(div);
  }
  if (App.sceneObjects.length === 0) {
    list.innerHTML = '<div style="padding:10px 12px; font-size:11px; color:var(--text-2);">Empty scene. Import a model, add a primitive, or add a light.</div>';
  }
}

function startRename(entry, nameEl) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = entry.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const oldName = entry.name;
    const newName = input.value.trim() || oldName;
    entry.name = newName;
    if (newName !== oldName) {
      pushUndo(
        () => { entry.name = oldName; refreshHierarchy(); syncTransformPanel(); },
        () => { entry.name = newName; refreshHierarchy(); syncTransformPanel(); }
      );
    }
    refreshHierarchy();
    syncTransformPanel();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { committed = true; refreshHierarchy(); }
  });
}

function toggleVisibility(entry) {
  entry.visible = entry.visible === false ? true : false;
  entry.object3D.visible = entry.visible;
  if (entry.object3D.userData.__helper) entry.object3D.userData.__helper.visible = entry.visible;
  refreshHierarchy();
  if (App.selected && App.selected.id === entry.id) syncTransformPanel();
}
function toggleLock(entry) {
  entry.locked = !entry.locked;
  if (entry.locked && App.selected && App.selected.id === entry.id) selectEntry(null);
  refreshHierarchy();
}

/* ---------------------------------------------------------------------
   Selection
--------------------------------------------------------------------- */
function selectEntry(entry) {
  App.selected = entry;
  if (entry) {
    App.transform.attach(entry.object3D);
    App.transform.visible = App.tool !== 'select';
    document.getElementById('selInfo').textContent = entry.name;
  } else {
    App.transform.detach();
    App.transform.visible = false;
    document.getElementById('selInfo').textContent = 'No selection';
  }
  refreshHierarchy();
  syncAllInspectorPanels();
  refreshKeyTrack();
}

function frameSelected() {
  if (!App.selected) return;
  const box = new THREE.Box3().setFromObject(App.selected.object3D);
  const center = box.getCenter(new THREE.Vector3());
  App.orbit.target.copy(center);
}

/* ---------------------------------------------------------------------
   Model Import
--------------------------------------------------------------------- */
function loadModelAsync(url, ext) {
  return new Promise((res, rej) => {
    if (ext === 'gltf' || ext === 'glb') {
      const l = new GLTFLoader(); l.setDRACOLoader(dracoLoader); l.setMeshoptDecoder(MeshoptDecoder);
      l.load(url, (g) => res({ object3D: g.scene, gltf: g }), undefined, rej);
    } else if (ext === 'obj') new OBJLoader().load(url, (o) => res({ object3D: o }), undefined, rej);
    else if (ext === 'fbx') new FBXLoader().load(url, (o) => res({ object3D: o, gltf: { animations: o.animations || [] } }), undefined, rej);
    else rej(new Error('Unsupported type .' + ext));
  });
}

async function importModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);
  try {
    const loaded = await loadModelAsync(url, ext);
    const entry = addImportedModel(loaded, file.name.replace(/\.[^/.]+$/, ''), ext);
    entry.file = file;
    selectEntry(entry);
    pushUndo(() => removeFromSceneKeepData(entry), () => addBackToScene(entry));
  } catch (err) {
    console.error('Import failed:', err);
    alert('Could not import "' + file.name + '". Supported: .gltf (self-contained), .glb, .obj, .fbx');
  } finally { URL.revokeObjectURL(url); }
}

/* Full-package import: meshes + PBR materials + embedded lights + cameras + animation clips */
function addImportedModel({ object3D, gltf }, name, ext, opts = {}) {
  if (!opts.raw) prepareImportedObject(object3D);
  App.scene.add(object3D);
  const entry = registerObject({ name, object3D, type: ext });
  entry.modelExt = ext;
  let nl = 0, nc = 0, na = 0;
  const lights = [], cams = [];
  object3D.traverse((c) => { if (c.isLight) lights.push(c); else if (c.isCamera) cams.push(c); });
  for (const l of lights) {
    const type = l.isDirectionalLight ? 'directional' : l.isSpotLight ? 'spot' : l.isPointLight ? 'point' : 'ambient';
    if (l.intensity > 20) l.intensity = type === 'directional' ? 2 : 3; // glTF physical units -> viewport range
    if (l.shadow) { l.castShadow = true; l.shadow.mapSize.set(1024, 1024); }
    let helper = null;
    if (type === 'directional') helper = new THREE.DirectionalLightHelper(l, 1, 0xffaa55);
    else if (type === 'point') helper = new THREE.PointLightHelper(l, 0.25, 0xffaa55);
    else if (type === 'spot') helper = new THREE.SpotLightHelper(l, 0xffaa55);
    if (helper) App.scene.add(helper);
    l.userData.__helper = helper; l.userData.__lightType = type;
    registerObject({ name: l.name || type + ' light', object3D: l, isLight: true, type }).fromModel = true; nl++;
  }
  for (const c of cams) {
    const helper = new THREE.CameraHelper(c); App.scene.add(helper); c.userData.__helper = helper;
    registerObject({ name: c.name || 'Imported Camera', object3D: c, isCamera: true, type: 'camera' }).fromModel = true; nc++;
  }
  const clips = (gltf && gltf.animations) || [];
  if (clips.length) {
    const mixer = new THREE.AnimationMixer(object3D);
    clips.forEach((c) => mixer.clipAction(c).play());
    mixer.setTime(0); App.mixers.push(mixer); na = clips.length;
    const longest = Math.ceil(Math.max(...clips.map((c) => c.duration)));
    if (longest > App.timeline.duration) { App.timeline.duration = Math.min(longest, 120); document.getElementById('durationInput').value = App.timeline.duration; }
  }
  if (!opts.raw && (nl || nc || na)) toast(`Imported ${name}: ${nl} light(s), ${nc} camera(s), ${na} animation clip(s)`);
  refreshHierarchy();
  return entry;
}

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.classList.add('out'), 3800); setTimeout(() => t.remove(), 4300);
}

function prepareImportedObject(object3D) {
  object3D.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  const box = new THREE.Box3().setFromObject(object3D);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const targetSize = 4;
  object3D.scale.setScalar(targetSize / maxDim);

  const box2 = new THREE.Box3().setFromObject(object3D);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);
  object3D.position.x -= center2.x;
  object3D.position.z -= center2.z;
  object3D.position.y -= box2.min.y;
}

/* ---------------------------------------------------------------------
   Primitives
--------------------------------------------------------------------- */
function addPrimitive(type) {
  let geo, restY = 0.5;
  switch (type) {
    case 'cube': geo = new THREE.BoxGeometry(1, 1, 1); restY = 0.5; break;
    case 'sphere': geo = new THREE.SphereGeometry(0.6, 32, 24); restY = 0.6; break;
    case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 32); restY = 0.6; break;
    case 'cone': geo = new THREE.ConeGeometry(0.6, 1.2, 32); restY = 0.6; break;
    case 'torus': geo = new THREE.TorusGeometry(0.5, 0.18, 20, 40); restY = 0.68; break;
    case 'plane': geo = new THREE.PlaneGeometry(2, 2); restY = 0; break;
    default: geo = new THREE.BoxGeometry(1, 1, 1);
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c9c9, roughness: 0.6, metalness: 0.1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (type === 'plane') mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = restY;

  App.scene.add(mesh);
  const entry = registerObject({ name: type[0].toUpperCase() + type.slice(1), object3D: mesh, type });
  entry.primitive = type;
  selectEntry(entry);
  pushUndo(() => removeFromSceneKeepData(entry), () => addBackToScene(entry));
  return entry;
}

/* ---------------------------------------------------------------------
   Lights
--------------------------------------------------------------------- */
function addLight(type, opts = {}) {
  let light, helper = null;
  const color = opts.color !== undefined ? opts.color : 0xffffff;
  const intensity = opts.intensity !== undefined ? opts.intensity : 1;

  if (type === 'ambient') {
    light = new THREE.AmbientLight(color, intensity);
  } else if (type === 'directional') {
    light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...(opts.position || [5, 8, 5]));
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.left = -12; light.shadow.camera.right = 12;
    light.shadow.camera.top = 12; light.shadow.camera.bottom = -12;
    helper = new THREE.DirectionalLightHelper(light, 1, 0xffaa55);
  } else if (type === 'point') {
    light = new THREE.PointLight(color, intensity, opts.distance || 0);
    light.position.set(...(opts.position || [3, 4, 3]));
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    helper = new THREE.PointLightHelper(light, 0.25, 0xffaa55);
  } else if (type === 'spot') {
    light = new THREE.SpotLight(color, intensity, opts.distance || 20, THREE.MathUtils.degToRad(opts.angle || 35));
    light.position.set(...(opts.position || [4, 6, 4]));
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    helper = new THREE.SpotLightHelper(light, 0xffaa55);
  }

  App.scene.add(light);
  if (helper) App.scene.add(helper);
  light.userData.__helper = helper;
  light.userData.__lightType = type;

  const entry = registerObject({ name: opts.name || (type[0].toUpperCase() + type.slice(1) + ' Light'), object3D: light, isLight: true, type });
  if (!opts.silent) selectEntry(entry);
  if (!App.undo.suppress) {
    pushUndo(() => removeFromSceneKeepData(entry), () => addBackToScene(entry));
  }
  return entry;
}

function addThreePointRig() {
  const key = addLight('directional', { name: 'Key Light', intensity: 1.6, position: [5, 7, 5] });
  const fill = addLight('directional', { name: 'Fill Light', intensity: 0.6, position: [-6, 4, 3] });
  fill.object3D.castShadow = false;
  const rim = addLight('directional', { name: 'Rim Light', intensity: 0.9, position: [0, 5, -7] });
  rim.object3D.castShadow = false;
  selectEntry(key);
}

function updateLightHelper(light) {
  const helper = light.userData.__helper;
  if (helper && helper.update) helper.update();
}

/* ---------------------------------------------------------------------
   Cameras
--------------------------------------------------------------------- */
function addExtraCamera() {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2000);
  cam.position.copy(App.defaultCamera.position);
  cam.quaternion.copy(App.defaultCamera.quaternion);
  const helper = new THREE.CameraHelper(cam);
  App.scene.add(cam);
  App.scene.add(helper);
  cam.userData.__helper = helper;
  const entry = registerObject({ name: 'Camera ' + App.idCounter, object3D: cam, isCamera: true, type: 'camera' });
  selectEntry(entry);
  onResize();
  if (!App.undo.suppress) {
    pushUndo(() => removeFromSceneKeepData(entry), () => addBackToScene(entry));
  }
  return entry;
}

function setActiveCamera(cam) {
  App.activeCamera = cam;
  App.orbit.enabled = (cam === App.defaultCamera);
}

/* ---------------------------------------------------------------------
   Duplicate
--------------------------------------------------------------------- */
function duplicateEntry(entry) {
  if (!entry || entry.locked) return null;
  const clone = entry.object3D.clone(true);
  clone.traverse((c) => { if (c.isMesh && c.material) c.material = c.material.clone(); });
  clone.position.x += 0.5;
  clone.position.z += 0.5;
  App.scene.add(clone);

  let newEntry;
  if (entry.isLight) {
    let helper = null;
    if (clone.isDirectionalLight) helper = new THREE.DirectionalLightHelper(clone, 1, 0xffaa55);
    else if (clone.isPointLight) helper = new THREE.PointLightHelper(clone, 0.25, 0xffaa55);
    else if (clone.isSpotLight) helper = new THREE.SpotLightHelper(clone, 0xffaa55);
    if (helper) { App.scene.add(helper); clone.userData.__helper = helper; }
    clone.userData.__lightType = entry.object3D.userData.__lightType;
    newEntry = registerObject({ name: entry.name + ' Copy', object3D: clone, isLight: true, type: entry.type });
  } else if (entry.isCamera) {
    const helper = new THREE.CameraHelper(clone);
    App.scene.add(helper);
    clone.userData.__helper = helper;
    newEntry = registerObject({ name: entry.name + ' Copy', object3D: clone, isCamera: true, type: 'camera' });
  } else {
    newEntry = registerObject({ name: entry.name + ' Copy', object3D: clone, type: entry.type });
  }

  if (App.keyframes[entry.id]) {
    App.keyframes[newEntry.id] = JSON.parse(JSON.stringify(App.keyframes[entry.id]));
  }
  selectEntry(newEntry);
  pushUndo(() => removeFromSceneKeepData(newEntry), () => addBackToScene(newEntry));
  return newEntry;
}

/* ---------------------------------------------------------------------
   UI Bindings
--------------------------------------------------------------------- */
function setupUIBindings() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.getElementById('toolDelete').addEventListener('click', () => { if (App.selected) removeObjectEntry(App.selected); });
  document.getElementById('toolFrame').addEventListener('click', frameSelected);
  document.getElementById('toolDuplicate').addEventListener('click', () => { if (App.selected) duplicateEntry(App.selected); });
  document.getElementById('toolAddCamera').addEventListener('click', addExtraCamera);

  const lightMenuBtn = document.getElementById('toolAddLight');
  const lightMenu = document.getElementById('lightMenu');
  lightMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(lightMenu); lightMenu.classList.toggle('open'); });
  lightMenu.querySelectorAll('button[data-light]').forEach((btn) => {
    btn.addEventListener('click', () => { addLight(btn.dataset.light); lightMenu.classList.remove('open'); });
  });
  document.getElementById('menuThreePoint').addEventListener('click', () => { addThreePointRig(); lightMenu.classList.remove('open'); });

  const primMenuBtn = document.getElementById('toolAddPrimitive');
  const primMenu = document.getElementById('primitiveMenu');
  primMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(primMenu); primMenu.classList.toggle('open'); });
  primMenu.querySelectorAll('button[data-primitive]').forEach((btn) => {
    btn.addEventListener('click', () => { addPrimitive(btn.dataset.primitive); primMenu.classList.remove('open'); });
  });

  const fileMenuBtn = document.getElementById('fileMenuBtn');
  const fileMenu = document.getElementById('fileMenu');
  fileMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(fileMenu); fileMenu.classList.toggle('open'); });
  document.addEventListener('click', () => closeAllDropdowns());

  function closeAllDropdowns(except) {
    [fileMenu, lightMenu, primMenu].forEach((m) => { if (m !== except) m.classList.remove('open'); });
  }

  document.getElementById('menuImport').addEventListener('click', () => document.getElementById('modelFileInput').click());
  document.getElementById('menuAddCamera').addEventListener('click', addExtraCamera);
  document.getElementById('menuSave').addEventListener('click', saveProject);
  document.getElementById('menuLoad').addEventListener('click', () => document.getElementById('projectFileInput').click());
  document.getElementById('menuExportGltf').addEventListener('click', exportSceneGltf);
  document.getElementById('menuReset').addEventListener('click', () => resetWorkspace());

  document.getElementById('modelFileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importModelFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('projectFileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) loadProject(e.target.files[0]);
    e.target.value = '';
  });

  // Top bar utility buttons
  document.getElementById('undoBtn').addEventListener('click', performUndo);
  document.getElementById('redoBtn').addEventListener('click', performRedo);
  document.getElementById('snapBtn').addEventListener('click', toggleSnap);
  document.getElementById('statsBtn').addEventListener('click', toggleStats);
  document.getElementById('helpBtn').addEventListener('click', () => openModal('helpModal'));
  document.getElementById('renderSettingsBtn').addEventListener('click', () => openModal('renderModal'));

  // Modals
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  document.getElementById('modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });
  document.getElementById('resPreset').addEventListener('change', (e) => {
    document.getElementById('customResWrap').classList.toggle('hidden', e.target.value !== 'custom');
  });
  document.getElementById('bitrateRange').addEventListener('input', (e) => {
    document.getElementById('bitrateVal').textContent = e.target.value + ' Mbps';
  });
  document.getElementById('bitrateVal').textContent = document.getElementById('bitrateRange').value + ' Mbps';
  document.getElementById('applyRenderSettings').addEventListener('click', applyRenderSettings);


  // Right panel tabs
  document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.remove('hidden');
    });
  });

  // Transform inputs (live update + undo commit)
  ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ', 'scaleX', 'scaleY', 'scaleZ'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('input', onTransformInputChange);
    el.addEventListener('focus', onTransformFieldFocus);
    el.addEventListener('change', onTransformFieldCommit);
  });
  document.getElementById('objName').addEventListener('change', onObjectNameChange);
  document.getElementById('objVisible').addEventListener('change', onObjectVisibleChange);
  document.getElementById('setActiveCamBtn').addEventListener('click', () => {
    if (App.selected && App.selected.isCamera) setActiveCamera(App.selected.object3D);
  });
  ['camFov', 'camNear', 'camFar'].forEach((id) => document.getElementById(id).addEventListener('input', onCameraFieldChange));

  // Material tab
  ['matColor', 'matRough', 'matMetal', 'matOpacity', 'matEmissive', 'matEmissiveIntensity'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('input', onMaterialChange);
    bindMaterialControlUndo(el);
  });
  document.getElementById('matShadow').addEventListener('change', onMaterialChange);
  bindMaterialControlUndo(document.getElementById('matShadow'));
  bindMapUpload('mapColor', 'map', THREE.SRGBColorSpace);
  bindMapUpload('mapNormal', 'normalMap', null);
  bindMapUpload('mapRough', 'roughnessMap', null);
  bindMapUpload('mapMetal', 'metalnessMap', null);
  document.getElementById('clearTexBtn').addEventListener('click', clearTexture);

  // Lighting tab
  ['lightColor', 'lightIntensity', 'lightDistance', 'lightAngle', 'lightSoft'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('input', onLightingChange);
    bindLightControlUndo(el);
  });
  document.getElementById('lightShadow').addEventListener('change', onLightingChange);
  bindLightControlUndo(document.getElementById('lightShadow'));

  // Environment tab
  ['envBgColor', 'envGrid', 'envFogEnabled', 'envFogColor', 'envFogNear', 'envFogFar', 'envGroundOpacity', 'envIBL'].forEach((id) => {
    document.getElementById(id).addEventListener('input', applyEnvironmentSettings);
    document.getElementById(id).addEventListener('change', applyEnvironmentSettings);
  });

  // Timeline
  document.getElementById('playBtn').addEventListener('click', togglePlay);
  document.getElementById('stopBtn').addEventListener('click', stopTimeline);
  document.getElementById('loopBtn').addEventListener('click', toggleLoop);
  document.getElementById('durationInput').addEventListener('change', (e) => {
    App.timeline.duration = Math.max(1, parseFloat(e.target.value) || 10);
    refreshKeyTrack();
  });
  document.getElementById('scrubber').addEventListener('input', (e) => {
    const t = (parseInt(e.target.value) / 1000) * App.timeline.duration;
    App.timeline.currentTime = t;
    applyKeyframesAtTime(t);
    updateTimelineUI();
  });
  document.getElementById('addKeyBtn').addEventListener('click', addKeyframeAtCurrentTime);
  document.getElementById('clearKeyBtn').addEventListener('click', clearKeyframesForSelected);

  // Camera path
  document.getElementById('addPathPointBtn').addEventListener('click', addCameraPathPoint);
  document.getElementById('previewPathBtn').addEventListener('click', togglePathPreview);
  document.getElementById('clearPathBtn').addEventListener('click', clearCameraPath);
  document.getElementById('curveType').addEventListener('change', (e) => {
    App.cameraPath.curveType = e.target.value;
    rebuildCameraPathCurve();
  });

  // Export
  document.getElementById('exportBtn').addEventListener('click', exportVideo);

  // Keyboard shortcuts
  window.addEventListener('keydown', onGlobalKeydown);
}

function onGlobalKeydown(e) {
  const tag = document.activeElement && document.activeElement.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) performRedo(); else performUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); performRedo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); if (App.selected) duplicateEntry(App.selected); return; }

  if (e.key === 'w') setTool('translate');
  if (e.key === 'e') setTool('rotate');
  if (e.key === 'r') setTool('scale');
  if (e.key === 'q') setTool('select');
  if (e.key === 'f') frameSelected();
  if (e.key === 'Delete' || e.key === 'Backspace') { if (App.selected) removeObjectEntry(App.selected); }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === '?') openModal('helpModal');
  if (e.key === 'Escape') closeModal();
}

function setTool(tool) {
  App.tool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (tool === 'select') {
    App.transform.visible = false;
  } else {
    App.transform.setMode(tool);
    App.transform.visible = !!App.selected;
  }
}

function toggleSnap() {
  App.snapping = !App.snapping;
  document.getElementById('snapBtn').classList.toggle('active', App.snapping);
  App.transform.setTranslationSnap(App.snapping ? 0.5 : null);
  App.transform.setRotationSnap(App.snapping ? THREE.MathUtils.degToRad(15) : null);
  App.transform.setScaleSnap(App.snapping ? 0.1 : null);
}

/* ---------------------------------------------------------------------
   Modals
--------------------------------------------------------------------- */
function openModal(id) {
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.querySelectorAll('.modal-card').forEach((m) => m.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function closeModal() { document.getElementById('modalOverlay').classList.add('hidden'); }

function applyRenderSettings() {
  const preset = document.getElementById('resPreset').value;
  let w, h;
  if (preset === 'custom') {
    w = parseInt(document.getElementById('customResW').value) || 1280;
    h = parseInt(document.getElementById('customResH').value) || 720;
  } else {
    [w, h] = preset.split('x').map(Number);
  }
  App.renderSettings.width = w;
  App.renderSettings.height = h;
  App.renderSettings.fps = parseInt(document.getElementById('fpsSelect').value);
  App.renderSettings.bitrate = parseInt(document.getElementById('bitrateRange').value);
  closeModal();
}

/* ---------------------------------------------------------------------
   Stats Panel
--------------------------------------------------------------------- */
function toggleStats() {
  const panel = document.getElementById('statsPanel');
  panel.classList.toggle('hidden');
  document.getElementById('statsBtn').classList.toggle('active', !panel.classList.contains('hidden'));
}
function updateStats() {
  const panel = document.getElementById('statsPanel');
  if (panel.classList.contains('hidden')) return;
  let tris = 0, verts = 0, objs = 0;
  App.scene.traverse((o) => {
    if (o.isMesh && o.geometry) {
      objs++;
      const geo = o.geometry;
      if (geo.index) tris += geo.index.count / 3;
      else if (geo.attributes.position) tris += geo.attributes.position.count / 3;
      if (geo.attributes.position) verts += geo.attributes.position.count;
    }
  });
  document.getElementById('statObjects').textContent = objs;
  document.getElementById('statTris').textContent = Math.round(tris).toLocaleString();
  document.getElementById('statVerts').textContent = Math.round(verts).toLocaleString();
  document.getElementById('statCalls').textContent = App.renderer.info.render.calls;
}

/* ---------------------------------------------------------------------
   Drag & Drop Import
--------------------------------------------------------------------- */
function setupDragDrop() {
  const container = document.getElementById('viewportContainer');
  const overlay = document.getElementById('dropOverlay');
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  ['dragenter', 'dragover'].forEach((evt) => container.addEventListener(evt, (e) => { if (!hasFiles(e)) return; e.preventDefault(); overlay.classList.add('show'); }));
  container.addEventListener('dragleave', (e) => { if (!container.contains(e.relatedTarget)) overlay.classList.remove('show'); });
  container.addEventListener('drop', () => overlay.classList.remove('show'));
  container.addEventListener('drop', (e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) importModelFile(file); });
}

/* ---------------------------------------------------------------------
   Inspector Sync — Transform Tab
--------------------------------------------------------------------- */
function syncAllInspectorPanels() {
  syncTransformPanel();
  syncMaterialPanel();
  syncLightingPanel();
}

function syncTransformPanel() {
  const fields = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ', 'scaleX', 'scaleY', 'scaleZ'];
  const entry = App.selected;
  const camWrap = document.getElementById('cameraFieldsWrap');
  const objVisible = document.getElementById('objVisible');
  const objName = document.getElementById('objName');

  if (!entry) {
    fields.forEach((id) => { const el = document.getElementById(id); el.value = ''; el.disabled = true; });
    objName.value = ''; objName.disabled = true;
    objVisible.checked = true; objVisible.disabled = true;
    camWrap.classList.add('hidden');
    return;
  }
  fields.forEach((id) => (document.getElementById(id).disabled = false));
  objName.disabled = false;
  objName.value = entry.name;
  objVisible.disabled = false;
  objVisible.checked = entry.visible !== false;
  syncTransformUIFromObject(entry);

  if (entry.isCamera) {
    camWrap.classList.remove('hidden');
    document.getElementById('camFov').value = round(entry.object3D.fov);
    document.getElementById('camNear').value = entry.object3D.near;
    document.getElementById('camFar').value = entry.object3D.far;
  } else {
    camWrap.classList.add('hidden');
  }
}

function syncTransformUIFromObject(entry) {
  const o = entry.object3D;
  document.getElementById('posX').value = round(o.position.x);
  document.getElementById('posY').value = round(o.position.y);
  document.getElementById('posZ').value = round(o.position.z);
  document.getElementById('rotX').value = round(THREE.MathUtils.radToDeg(o.rotation.x));
  document.getElementById('rotY').value = round(THREE.MathUtils.radToDeg(o.rotation.y));
  document.getElementById('rotZ').value = round(THREE.MathUtils.radToDeg(o.rotation.z));
  document.getElementById('scaleX').value = round(o.scale.x);
  document.getElementById('scaleY').value = round(o.scale.y);
  document.getElementById('scaleZ').value = round(o.scale.z);
}

function onTransformInputChange(e) {
  if (!App.selected) return;
  const o = App.selected.object3D;
  const prop = e.target.dataset.prop, axis = e.target.dataset.axis;
  const val = parseFloat(e.target.value) || 0;
  if (prop === 'position') o.position[axis] = val;
  if (prop === 'scale') o.scale[axis] = val;
  if (prop === 'rotation') o.rotation[axis] = THREE.MathUtils.degToRad(val);
  updateLightHelper(o);
  if (o.userData.__helper && o.userData.__helper.update) o.userData.__helper.update();
}

let transformFieldSnapshot = null;
function onTransformFieldFocus() { if (App.selected) transformFieldSnapshot = snapshotTRS(App.selected.object3D); }
function onTransformFieldCommit() {
  if (!App.selected || !transformFieldSnapshot) return;
  const entry = App.selected;
  const before = transformFieldSnapshot;
  const after = snapshotTRS(entry.object3D);
  if (!trsEqual(before, after)) {
    pushUndo(
      () => { applyTRS(entry.object3D, before); if (App.selected === entry) syncTransformUIFromObject(entry); },
      () => { applyTRS(entry.object3D, after); if (App.selected === entry) syncTransformUIFromObject(entry); }
    );
  }
  transformFieldSnapshot = null;
}

function onObjectNameChange(e) {
  if (!App.selected) return;
  const entry = App.selected;
  const oldName = entry.name;
  const newName = e.target.value.trim() || oldName;
  entry.name = newName;
  if (newName !== oldName) {
    pushUndo(
      () => { entry.name = oldName; refreshHierarchy(); syncTransformPanel(); },
      () => { entry.name = newName; refreshHierarchy(); syncTransformPanel(); }
    );
  }
  refreshHierarchy();
}

function onObjectVisibleChange(e) {
  if (!App.selected) return;
  toggleVisibility(App.selected);
  e.target.checked = App.selected.visible !== false;
}

function onCameraFieldChange() {
  if (!App.selected || !App.selected.isCamera) return;
  const cam = App.selected.object3D;
  cam.fov = parseFloat(document.getElementById('camFov').value) || cam.fov;
  cam.near = parseFloat(document.getElementById('camNear').value) || cam.near;
  cam.far = parseFloat(document.getElementById('camFar').value) || cam.far;
  cam.updateProjectionMatrix();
  if (cam.userData.__helper) cam.userData.__helper.update();
}

function round(n) { return Math.round(n * 1000) / 1000; }

/* ---------------------------------------------------------------------
   Inspector Sync — Material Tab
--------------------------------------------------------------------- */
function getSelectedMesh() {
  if (!App.selected || App.selected.isLight || App.selected.isCamera) return null;
  let mesh = null;
  App.selected.object3D.traverse((c) => { if (!mesh && c.isMesh) mesh = c; });
  return mesh;
}

function syncMaterialPanel() {
  const mesh = getSelectedMesh();
  document.getElementById('materialEmpty').classList.toggle('hidden', !!mesh);
  document.getElementById('materialFields').classList.toggle('hidden', !mesh);
  if (!mesh) return;
  const mat = mesh.material;
  document.getElementById('matColor').value = '#' + (mat.color ? mat.color.getHexString() : 'c9c9c9');
  document.getElementById('matRough').value = mat.roughness !== undefined ? mat.roughness : 0.6;
  document.getElementById('matMetal').value = mat.metalness !== undefined ? mat.metalness : 0.1;
  document.getElementById('matOpacity').value = mat.opacity !== undefined ? mat.opacity : 1;
  document.getElementById('matEmissive').value = '#' + (mat.emissive ? mat.emissive.getHexString() : '000000');
  document.getElementById('matEmissiveIntensity').value = mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1;
  document.getElementById('roughVal').textContent = (mat.roughness ?? 0.6).toFixed(2);
  document.getElementById('metalVal').textContent = (mat.metalness ?? 0.1).toFixed(2);
  document.getElementById('opacityVal').textContent = (mat.opacity ?? 1).toFixed(2);
  document.getElementById('emissiveVal').textContent = (mat.emissiveIntensity ?? 1).toFixed(2);
  document.getElementById('matShadow').checked = mesh.castShadow;
  const hasMap = mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap;
  document.getElementById('clearTexBtn').style.display = hasMap ? 'block' : 'none';
}

function onMaterialChange() {
  const mesh = getSelectedMesh();
  if (!mesh) return;
  const mat = mesh.material;
  if (mat.color) mat.color.set(document.getElementById('matColor').value);
  if (mat.roughness !== undefined) mat.roughness = parseFloat(document.getElementById('matRough').value);
  if (mat.metalness !== undefined) mat.metalness = parseFloat(document.getElementById('matMetal').value);
  const opacity = parseFloat(document.getElementById('matOpacity').value);
  mat.opacity = opacity;
  mat.transparent = opacity < 1;
  if (mat.emissive) mat.emissive.set(document.getElementById('matEmissive').value);
  if (mat.emissiveIntensity !== undefined) mat.emissiveIntensity = parseFloat(document.getElementById('matEmissiveIntensity').value);
  mesh.castShadow = document.getElementById('matShadow').checked;

  document.getElementById('roughVal').textContent = parseFloat(document.getElementById('matRough').value).toFixed(2);
  document.getElementById('metalVal').textContent = parseFloat(document.getElementById('matMetal').value).toFixed(2);
  document.getElementById('opacityVal').textContent = opacity.toFixed(2);
  document.getElementById('emissiveVal').textContent = parseFloat(document.getElementById('matEmissiveIntensity').value).toFixed(2);
  mat.needsUpdate = true;
}

function materialSnapshot(mesh) {
  const m = mesh.material;
  return {
    color: m.color ? m.color.getHex() : null,
    roughness: m.roughness, metalness: m.metalness, opacity: m.opacity, transparent: m.transparent,
    emissive: m.emissive ? m.emissive.getHex() : null, emissiveIntensity: m.emissiveIntensity,
    castShadow: mesh.castShadow,
  };
}
function applyMaterialSnapshot(mesh, snap) {
  const m = mesh.material;
  if (snap.color != null && m.color) m.color.setHex(snap.color);
  if (m.roughness !== undefined) m.roughness = snap.roughness;
  if (m.metalness !== undefined) m.metalness = snap.metalness;
  if (m.opacity !== undefined) m.opacity = snap.opacity;
  m.transparent = snap.transparent;
  if (snap.emissive != null && m.emissive) m.emissive.setHex(snap.emissive);
  if (m.emissiveIntensity !== undefined) m.emissiveIntensity = snap.emissiveIntensity;
  mesh.castShadow = snap.castShadow;
  m.needsUpdate = true;
  syncMaterialPanel();
}
let matBefore = null;
function bindMaterialControlUndo(el) {
  const capture = () => { const mesh = getSelectedMesh(); if (mesh) matBefore = materialSnapshot(mesh); };
  el.addEventListener('focus', capture);
  el.addEventListener('pointerdown', capture);
  el.addEventListener('change', () => {
    const mesh = getSelectedMesh();
    if (!mesh || !matBefore) return;
    const before = matBefore;
    const after = materialSnapshot(mesh);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      pushUndo(() => applyMaterialSnapshot(mesh, before), () => applyMaterialSnapshot(mesh, after));
    }
    matBefore = null;
  });
}

function bindMapUpload(inputId, propName, colorSpace) {
  document.getElementById(inputId).addEventListener('change', (e) => {
    const file = e.target.files[0];
    const mesh = getSelectedMesh();
    if (!file || !mesh) return;
    const url = URL.createObjectURL(file);
    new THREE.TextureLoader().load(url, (tex) => {
      if (colorSpace) tex.colorSpace = colorSpace;
      const before = { prop: propName, tex: mesh.material[propName] || null };
      mesh.material[propName] = tex;
      mesh.material.needsUpdate = true;
      document.getElementById('clearTexBtn').style.display = 'block';
      URL.revokeObjectURL(url);
      pushUndo(
        () => { mesh.material[propName] = before.tex; mesh.material.needsUpdate = true; syncMaterialPanel(); },
        () => { mesh.material[propName] = tex; mesh.material.needsUpdate = true; syncMaterialPanel(); }
      );
    });
  });
}

function clearTexture() {
  const mesh = getSelectedMesh();
  if (!mesh) return;
  ['map', 'normalMap', 'roughnessMap', 'metalnessMap'].forEach((p) => {
    if (mesh.material[p]) { mesh.material[p].dispose(); mesh.material[p] = null; }
  });
  mesh.material.needsUpdate = true;
  document.getElementById('clearTexBtn').style.display = 'none';
}

/* ---------------------------------------------------------------------
   Inspector Sync — Lighting Tab
--------------------------------------------------------------------- */
function syncLightingPanel() {
  const entry = App.selected;
  const isLight = entry && entry.isLight;
  document.getElementById('lightingEmpty').classList.toggle('hidden', !!isLight);
  document.getElementById('lightingFields').classList.toggle('hidden', !isLight);
  if (!isLight) return;
  const light = entry.object3D;
  const type = light.userData.__lightType;

  document.getElementById('lightTypeLabel').textContent = type.toUpperCase();
  document.getElementById('lightColor').value = '#' + light.color.getHexString();
  document.getElementById('lightIntensity').value = light.intensity;
  document.getElementById('lightIntVal').textContent = light.intensity.toFixed(2);

  const showDist = (type === 'point' || type === 'spot');
  const showAngle = (type === 'spot');
  const showShadow = (type !== 'ambient');
  document.getElementById('lightDistWrap').style.display = showDist ? 'block' : 'none';
  document.getElementById('lightAngleWrap').style.display = showAngle ? 'block' : 'none';
  document.getElementById('lightShadowWrap').style.display = showShadow ? 'flex' : 'none';
  document.getElementById('lightSoftWrap').style.display = showShadow ? 'block' : 'none';

  if (showDist) { document.getElementById('lightDistance').value = light.distance || 0; document.getElementById('lightDistVal').textContent = (light.distance || 0).toFixed(1); }
  if (showAngle) { const deg = THREE.MathUtils.radToDeg(light.angle); document.getElementById('lightAngle').value = deg; document.getElementById('lightAngleVal').textContent = deg.toFixed(0) + '°'; }
  if (showShadow) {
    document.getElementById('lightShadow').checked = light.castShadow;
    document.getElementById('lightSoft').value = light.shadow ? light.shadow.radius : 1;
    document.getElementById('lightSoftVal').textContent = (light.shadow ? light.shadow.radius : 1).toFixed(1);
  }
}

function onLightingChange() {
  const entry = App.selected;
  if (!entry || !entry.isLight) return;
  const light = entry.object3D;
  light.color.set(document.getElementById('lightColor').value);
  light.intensity = parseFloat(document.getElementById('lightIntensity').value);
  document.getElementById('lightIntVal').textContent = light.intensity.toFixed(2);

  if (light.distance !== undefined) {
    light.distance = parseFloat(document.getElementById('lightDistance').value);
    document.getElementById('lightDistVal').textContent = light.distance.toFixed(1);
  }
  if (light.angle !== undefined) {
    const deg = parseFloat(document.getElementById('lightAngle').value);
    light.angle = THREE.MathUtils.degToRad(deg);
    document.getElementById('lightAngleVal').textContent = deg.toFixed(0) + '°';
  }
  if (light.castShadow !== undefined && document.getElementById('lightShadowWrap').style.display !== 'none') {
    light.castShadow = document.getElementById('lightShadow').checked;
  }
  if (light.shadow) {
    light.shadow.radius = parseFloat(document.getElementById('lightSoft').value);
    document.getElementById('lightSoftVal').textContent = light.shadow.radius.toFixed(1);
  }
  updateLightHelper(light);
}

function lightSnapshot(light) {
  return {
    color: light.color.getHex(), intensity: light.intensity,
    distance: light.distance, angle: light.angle, castShadow: light.castShadow,
    radius: light.shadow ? light.shadow.radius : undefined,
  };
}
function applyLightSnapshot(light, snap) {
  light.color.setHex(snap.color);
  light.intensity = snap.intensity;
  if (snap.distance !== undefined && light.distance !== undefined) light.distance = snap.distance;
  if (snap.angle !== undefined && light.angle !== undefined) light.angle = snap.angle;
  if (light.castShadow !== undefined) light.castShadow = snap.castShadow;
  if (light.shadow && snap.radius !== undefined) light.shadow.radius = snap.radius;
  updateLightHelper(light);
  syncLightingPanel();
}
let lightBefore = null;
function bindLightControlUndo(el) {
  const capture = () => { if (App.selected && App.selected.isLight) lightBefore = lightSnapshot(App.selected.object3D); };
  el.addEventListener('focus', capture);
  el.addEventListener('pointerdown', capture);
  el.addEventListener('change', () => {
    if (!App.selected || !App.selected.isLight || !lightBefore) return;
    const light = App.selected.object3D;
    const before = lightBefore;
    const after = lightSnapshot(light);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      pushUndo(() => applyLightSnapshot(light, before), () => applyLightSnapshot(light, after));
    }
    lightBefore = null;
  });
}

/* ---------------------------------------------------------------------
   Environment Tab
--------------------------------------------------------------------- */
function applyEnvironmentSettings() {
  const bg = document.getElementById('envBgColor').value;
  App.scene.background = new THREE.Color(bg);
  App.grid.visible = document.getElementById('envGrid').checked;
  App.scene.environment = document.getElementById('envIBL').checked ? App.envTex : null;

  const fogOn = document.getElementById('envFogEnabled').checked;
  const fogColor = document.getElementById('envFogColor').value;
  const fogNear = parseFloat(document.getElementById('envFogNear').value);
  const fogFar = parseFloat(document.getElementById('envFogFar').value);
  App.scene.fog = fogOn ? new THREE.Fog(new THREE.Color(fogColor).getHex(), fogNear, fogFar) : null;
  document.getElementById('fogNearVal').textContent = fogNear;
  document.getElementById('fogFarVal').textContent = fogFar;

  const groundOp = parseFloat(document.getElementById('envGroundOpacity').value);
  if (App.ground) App.ground.material.opacity = groundOp;
  document.getElementById('groundOpVal').textContent = groundOp.toFixed(2);
}

/* ---------------------------------------------------------------------
   Keyframe Animation Engine
--------------------------------------------------------------------- */
function addKeyframeAtCurrentTime() {
  const entry = App.selected;
  if (!entry) { alert('Select an object first.'); return; }
  const o = entry.object3D;
  if (!App.keyframes[entry.id]) App.keyframes[entry.id] = [];
  const list = App.keyframes[entry.id];
  const t = round(App.timeline.currentTime);
  const ease = document.getElementById('defaultEase').value;

  const kf = {
    time: t,
    position: [o.position.x, o.position.y, o.position.z],
    rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
    scale: [o.scale.x, o.scale.y, o.scale.z],
    intensity: entry.isLight ? o.intensity : undefined,
    ease,
  };

  const existingIdx = list.findIndex((k) => Math.abs(k.time - t) < 0.001);
  const previous = existingIdx >= 0 ? list[existingIdx] : null;
  if (existingIdx >= 0) list[existingIdx] = kf; else list.push(kf);
  list.sort((a, b) => a.time - b.time);
  refreshKeyTrack();

  pushUndo(
    () => {
      const idx = list.findIndex((k) => Math.abs(k.time - t) < 0.001);
      if (previous) { if (idx >= 0) list[idx] = previous; } else if (idx >= 0) list.splice(idx, 1);
      refreshKeyTrack();
    },
    () => {
      const idx = list.findIndex((k) => Math.abs(k.time - t) < 0.001);
      if (idx >= 0) list[idx] = kf; else { list.push(kf); list.sort((a, b) => a.time - b.time); }
      refreshKeyTrack();
    }
  );
}

function clearKeyframesForSelected() {
  if (!App.selected) return;
  const entry = App.selected;
  const backup = App.keyframes[entry.id] ? [...App.keyframes[entry.id]] : null;
  if (!backup) return;
  delete App.keyframes[entry.id];
  refreshKeyTrack();
  pushUndo(
    () => { App.keyframes[entry.id] = backup; refreshKeyTrack(); },
    () => { delete App.keyframes[entry.id]; refreshKeyTrack(); }
  );
}

function applyKeyframesAtTime(t) {
  for (const m of App.mixers) m.setTime(t);
  for (const entry of App.sceneObjects) {
    const list = App.keyframes[entry.id];
    if (!list || list.length === 0) continue;
    const o = entry.object3D;

    if (list.length === 1) { applyKF(o, list[0]); continue; }
    if (t <= list[0].time) { applyKF(o, list[0]); continue; }
    if (t >= list[list.length - 1].time) { applyKF(o, list[list.length - 1]); continue; }

    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (t >= a.time && t <= b.time) {
        const span = (b.time - a.time) || 0.0001;
        let f = (t - a.time) / span;
        const ease = Easing[a.ease] || Easing.smooth;
        f = ease(f);
        o.position.set(...lerp3(a.position, b.position, f));
        o.rotation.set(...lerp3(a.rotation, b.rotation, f));
        o.scale.set(...lerp3(a.scale, b.scale, f));
        if (a.intensity !== undefined && b.intensity !== undefined) o.intensity = THREE.MathUtils.lerp(a.intensity, b.intensity, f);
        break;
      }
    }
    updateLightHelper(o);
  }
}
function applyKF(o, kf) {
  o.position.set(...kf.position);
  o.rotation.set(...kf.rotation);
  o.scale.set(...kf.scale);
  if (kf.intensity !== undefined) o.intensity = kf.intensity;
  updateLightHelper(o);
}
function lerp3(a, b, f) {
  return [THREE.MathUtils.lerp(a[0], b[0], f), THREE.MathUtils.lerp(a[1], b[1], f), THREE.MathUtils.lerp(a[2], b[2], f)];
}

function refreshKeyTrack() {
  const track = document.getElementById('keyTrack');
  track.innerHTML = '';
  if (!App.selected) {
    track.innerHTML = '<div style="padding:8px 10px; font-size:11px; color:var(--text-2);">Select an object to view its keyframe track.</div>';
    return;
  }
  const list = App.keyframes[App.selected.id] || [];
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute; top:4px; left:8px; font-size:10px; color:var(--text-2);';
  label.textContent = App.selected.name + ' — ' + list.length + ' keyframe(s)';
  track.appendChild(label);

  for (const kf of list) {
    const pct = (kf.time / App.timeline.duration) * 100;
    const dia = document.createElement('div');
    dia.className = 'keyframe-diamond' + (kf.ease && kf.ease !== 'smooth' ? ' ease-' + kf.ease : '');
    dia.style.left = pct + '%';
    dia.title = 't=' + kf.time.toFixed(2) + 's · ease=' + (kf.ease || 'smooth') + ' (double-click to remove)';
    dia.addEventListener('dblclick', () => {
      const entry = App.selected;
      const idx = App.keyframes[entry.id].indexOf(kf);
      App.keyframes[entry.id] = App.keyframes[entry.id].filter((k) => k !== kf);
      refreshKeyTrack();
      pushUndo(
        () => { App.keyframes[entry.id].splice(idx, 0, kf); refreshKeyTrack(); },
        () => { App.keyframes[entry.id] = App.keyframes[entry.id].filter((k) => k !== kf); refreshKeyTrack(); }
      );
    });
    dia.addEventListener('click', (e) => {
      e.stopPropagation();
      App.timeline.currentTime = kf.time;
      applyKeyframesAtTime(kf.time);
      updateTimelineUI();
    });
    track.appendChild(dia);
  }
}

/* ---------------------------------------------------------------------
   Timeline Transport
--------------------------------------------------------------------- */
function togglePlay() {
  // While exporting, the timeline is driven by the export; pause/resume would stall the recording
  if (App.recorder.recording) { toast('Export in progress — press Stop to finish early.'); return; }
  setPlaying(!App.timeline.playing);
}
function setPlaying(playing) {
  App.timeline.playing = playing;
  document.getElementById('playBtn').innerHTML = playing ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
  if (playing) App.clock.getDelta();
}
function stopTimeline() {
  // Pressing Stop during an export ends it now and saves what has been recorded so far
  if (App.recorder.recording) stopRecording();
  setPlaying(false);
  App.timeline.currentTime = 0;
  applyKeyframesAtTime(0);
  updateTimelineUI();
}
function toggleLoop() {
  App.timeline.loop = !App.timeline.loop;
  document.getElementById('loopBtn').classList.toggle('active', App.timeline.loop);
}
function updateTimelineUI() {
  const t = App.timeline.currentTime;
  const pct = Math.min(1, t / App.timeline.duration);
  document.getElementById('scrubber').value = Math.round(pct * 1000);
  document.getElementById('timecode').textContent = formatTimecode(t);
}
function formatTimecode(t) {
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = Math.floor(t % 60).toString().padStart(2, '0');
  const ff = Math.floor((t % 1) * 60).toString().padStart(2, '0');
  return `${mm}:${ss}:${ff}`;
}

/* ---------------------------------------------------------------------
   Camera Path
--------------------------------------------------------------------- */
function addCameraPathPoint() {
  const p = App.activeCamera.position.clone();
  App.cameraPath.points.push(p);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), new THREE.MeshBasicMaterial({ color: 0x4fa3d1 }));
  marker.position.copy(p);
  marker.userData.__helper = true;
  App.scene.add(marker);
  App.cameraPath.markers.push(marker);
  rebuildCameraPathCurve();
}

function rebuildCameraPathCurve() {
  if (App.cameraPath.line) {
    App.scene.remove(App.cameraPath.line);
    App.cameraPath.line.geometry.dispose();
    App.cameraPath.line.material.dispose();
    App.cameraPath.line = null;
  }
  const pts = App.cameraPath.points;
  if (pts.length < 2) return;

  let curvePoints;
  if (App.cameraPath.curveType === 'catmullrom') {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    curvePoints = curve.getPoints(Math.max(50, pts.length * 20));
    App.cameraPath.curve = curve;
  } else {
    curvePoints = pts;
    App.cameraPath.curve = new THREE.CatmullRomCurve3(pts);
  }

  const geo = new THREE.BufferGeometry().setFromPoints(curvePoints);
  const mat = new THREE.LineBasicMaterial({ color: 0x4fa3d1 });
  const line = new THREE.Line(geo, mat);
  line.userData.__helper = true;
  App.scene.add(line);
  App.cameraPath.line = line;
}

function clearCameraPath() {
  App.cameraPath.points = [];
  App.cameraPath.markers.forEach((m) => { App.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
  App.cameraPath.markers = [];
  if (App.cameraPath.line) { App.scene.remove(App.cameraPath.line); App.cameraPath.line = null; }
  App.cameraPath.previewing = false;
}

function togglePathPreview() {
  if (App.cameraPath.points.length < 2) { alert('Add at least 2 camera path points first.'); return; }
  App.cameraPath.previewing = !App.cameraPath.previewing;
  if (App.cameraPath.previewing) {
    App.cameraPath.previewStart = performance.now();
    App.orbit.enabled = false;
  } else {
    App.orbit.enabled = (App.activeCamera === App.defaultCamera);
  }
  document.getElementById('previewPathBtn').classList.toggle('active', App.cameraPath.previewing);
}

function stepCameraPathPreview() {
  const elapsed = (performance.now() - App.cameraPath.previewStart) / 1000;
  const duration = App.timeline.duration;
  const t = (elapsed % duration) / duration;
  const curve = App.cameraPath.curve;
  if (!curve) return;
  const point = curve.getPointAt(Math.min(0.999, t));
  const lookAhead = curve.getPointAt(Math.min(0.999, t + 0.01));
  App.activeCamera.position.copy(point);
  App.activeCamera.lookAt(lookAhead);
}

/* ---------------------------------------------------------------------
   Project Save / Load / Autosave
--------------------------------------------------------------------- */

function saveProject() {
  const data = collectLightweightState();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (data.title || 'easyrenderer-project').replace(/\s+/g, '_') + '.json';
  a.click();
}


function loadProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      restoreFromState(data);
      alert('Project loaded. Note: 3D meshes are not stored in project files — re-import models or re-add primitives to restore geometry.');
    } catch (err) {
      console.error(err);
      alert('Could not parse this project file.');
    }
  };
  reader.readAsText(file);
}



function resetWorkspace(skipConfirm = false) {
  if (skipConfirm !== true && !confirm('Reset the entire workspace? This cannot be undone.')) return;
  App.undo.suppress = true;
  for (const entry of [...App.sceneObjects]) removeFromSceneKeepData(entry);
  clearCameraPath();
  App.keyframes = {};
  App.mixers = [];
  App.timeline = { duration: 10, currentTime: 0, playing: false, loop: false };
  document.getElementById('durationInput').value = 10;
  document.getElementById('projectTitle').value = 'Untitled Project';
  document.getElementById('envBgColor').value = '#0c0c0c';
  document.getElementById('envGrid').checked = true;
  document.getElementById('envFogEnabled').checked = true;
  document.getElementById('envFogColor').value = '#0c0c0c';
  document.getElementById('envFogNear').value = 30;
  document.getElementById('envFogFar').value = 90;
  document.getElementById('envGroundOpacity').value = 0.35;
  applyEnvironmentSettings();
  addLight('ambient', { name: 'Ambient Fill', intensity: 0.5, silent: true });
  addLight('directional', { name: 'Key Light', intensity: 1.4, position: [6, 9, 4], silent: true });
  App.undo.stack = [];
  App.undo.redoStack = [];
  App.undo.suppress = false;
  updateUndoRedoButtons();
  updateTimelineUI();
  refreshKeyTrack();
}

/* ---------------------------------------------------------------------
   glTF Scene Export (full geometry + materials)
--------------------------------------------------------------------- */
function exportSceneGltf() {
  const exportGroup = new THREE.Group();
  App.sceneObjects.forEach((entry) => {
    if (!entry.isLight && !entry.isCamera && entry.visible !== false) exportGroup.add(entry.object3D.clone(true));
  });
  if (exportGroup.children.length === 0) { alert('No visible mesh objects to export. Import a model or add a primitive first.'); return; }

  const exporter = new GLTFExporter();
  exporter.parse(
    exportGroup,
    (result) => {
      let blob, ext;
      if (result instanceof ArrayBuffer) { blob = new Blob([result], { type: 'application/octet-stream' }); ext = 'glb'; }
      else { blob = new Blob([JSON.stringify(result)], { type: 'application/json' }); ext = 'gltf'; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const title = (document.getElementById('projectTitle').value || 'scene').replace(/\s+/g, '_');
      a.download = title + '.' + ext;
      a.click();
    },
    (err) => { console.error(err); alert('glTF export failed — one of the objects in the scene may use an unsupported feature.'); },
    { binary: true }
  );
}

/* ---------------------------------------------------------------------
   Direct Browser Video Recording & Export
--------------------------------------------------------------------- */
function pickSupportedMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

function exportVideo() {
  if (App.recorder.recording) return;
  App.timeline.currentTime = 0;
  applyKeyframesAtTime(0);
  updateTimelineUI();

  const { width, height } = App.renderSettings;
  App._exportPrevAspect = App.activeCamera.aspect;
  App._exportPrevPixelRatio = App.renderer.getPixelRatio();
  App.renderer.setPixelRatio(1);
  App.renderer.setSize(width, height, false);
  App.activeCamera.aspect = width / height;
  App.activeCamera.updateProjectionMatrix();

  startRecording();
  setPlaying(true);
}

function startRecording() {
  const stream = App.renderer.domElement.captureStream(App.renderSettings.fps);
  const mimeType = pickSupportedMimeType();
  const options = mimeType ? { mimeType, videoBitsPerSecond: App.renderSettings.bitrate * 1_000_000 } : {};

  try {
    App.recorder.mediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    alert('Video recording is not supported in this browser.');
    console.error(err);
    restoreViewportSize();
    return;
  }
  App.recorder.chunks = [];
  App.recorder.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) App.recorder.chunks.push(e.data); };
  App.recorder.mediaRecorder.onstop = onRecordingStop;
  App.recorder.mediaRecorder.start(200);
  App.recorder.recording = true;
  App.recorder.startTime = performance.now();

  document.getElementById('recIndicator').classList.add('show');
  document.getElementById('exportBtn').disabled = true;
  tickRecTimer();
}

function tickRecTimer() {
  if (!App.recorder.recording) return;
  const secs = Math.floor((performance.now() - App.recorder.startTime) / 1000);
  const mm = Math.floor(secs / 60).toString().padStart(2, '0');
  const ss = (secs % 60).toString().padStart(2, '0');
  document.getElementById('recTime').textContent = `${mm}:${ss}`;
  requestAnimationFrame(tickRecTimer);
}

function stopRecording() {
  if (!App.recorder.recording || !App.recorder.mediaRecorder) return;
  App.recorder.mediaRecorder.stop();
  App.recorder.recording = false;
  document.getElementById('recIndicator').classList.remove('show');
  document.getElementById('exportBtn').disabled = false;
}

function restoreViewportSize() {
  const container = document.getElementById('viewportContainer');
  App.renderer.setPixelRatio(App._exportPrevPixelRatio || Math.min(window.devicePixelRatio, 2));
  App.renderer.setSize(container.clientWidth, container.clientHeight, false);
  if (App._exportPrevAspect) { App.activeCamera.aspect = App._exportPrevAspect; App.activeCamera.updateProjectionMatrix(); }
  onResize();
}

function onRecordingStop() {
  restoreViewportSize();
  const mimeType = App.recorder.mediaRecorder.mimeType || 'video/webm';
  const blob = new Blob(App.recorder.chunks, { type: mimeType });
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const title = (document.getElementById('projectTitle').value || 'easyrenderer-export').replace(/\s+/g, '_');
  a.download = `${title}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------------------------------------------------------------
   Project state (lights, cameras, primitives, models, keys, path, env, view)
--------------------------------------------------------------------- */
const R3 = (a) => a.map((n) => Math.round(n * 1000) / 1000);
function collectLightweightState() {
  const objects = [];
  for (const e of App.sceneObjects) {
    if (e.fromModel) continue;
    const o = e.object3D;
    const base = { id: e.id, name: e.name, type: e.type, visible: e.visible,
      position: R3(o.position.toArray()), rotation: R3([o.rotation.x, o.rotation.y, o.rotation.z]), scale: R3(o.scale.toArray()) };
    if (e.isLight) {
      base.isLight = true;
      base.light = { color: '#' + o.color.getHexString(), intensity: round(o.intensity), distance: o.distance, angle: o.angle ? Math.round(THREE.MathUtils.radToDeg(o.angle)) : undefined };
    } else if (e.isCamera) {
      base.isCamera = true; base.camera = { fov: o.fov, near: o.near, far: o.far };
    } else if (e.primitive) {
      const m = o.material; base.primitive = e.primitive;
      base.material = { color: '#' + m.color.getHexString(), roughness: m.roughness, metalness: m.metalness, opacity: m.opacity, emissive: '#' + m.emissive.getHexString(), emissiveIntensity: m.emissiveIntensity };
    } else if (e.storagePath) {
      base.model = { path: e.storagePath, ext: e.modelExt };
    } else continue;
    objects.push(base);
  }
  const activeEntry = App.sceneObjects.find((e) => e.object3D === App.activeCamera);
  return {
    v: 2, duration: App.timeline.duration, loop: App.timeline.loop, renderSettings: App.renderSettings,
    objects, keyframes: App.keyframes, activeCameraId: activeEntry ? activeEntry.id : null,
    view: { position: R3(App.defaultCamera.position.toArray()), target: R3(App.orbit.target.toArray()) },
    cameraPath: App.cameraPath.points.map((p) => R3(p.toArray())), curveType: App.cameraPath.curveType,
    env: {
      bg: '#' + App.scene.background.getHexString(), grid: App.grid.visible, ibl: !!App.scene.environment,
      fogEnabled: !!App.scene.fog, fogColor: App.scene.fog ? '#' + App.scene.fog.color.getHexString() : '#0c0c0c',
      fogNear: App.scene.fog ? App.scene.fog.near : 30, fogFar: App.scene.fog ? App.scene.fog.far : 90,
      groundOpacity: App.ground ? App.ground.material.opacity : 0.35,
    },
    title: document.getElementById('projectTitle').value,
  };
}

async function restoreFromState(data) {
  App.undo.suppress = true;
  selectEntry(null);
  [...App.sceneObjects].forEach(removeFromSceneKeepData);
  clearCameraPath(); App.keyframes = {}; App.mixers = [];
  document.getElementById('projectTitle').value = data.title || 'Untitled Project';
  App.timeline.duration = data.duration || 10; App.timeline.loop = !!data.loop;
  document.getElementById('durationInput').value = App.timeline.duration;
  if (data.renderSettings) Object.assign(App.renderSettings, data.renderSettings);

  const idMap = {};
  for (const od of data.objects || []) {
    let entry = null;
    try {
      if (od.isLight) entry = addLight(od.type, { name: od.name, silent: true, color: new THREE.Color(od.light.color).getHex(), intensity: od.light.intensity, distance: od.light.distance, angle: od.light.angle, position: od.position });
      else if (od.isCamera) { entry = addExtraCamera(); Object.assign(entry.object3D, od.camera); entry.object3D.updateProjectionMatrix(); }
      else if (od.primitive) {
        entry = addPrimitive(od.primitive); const m = entry.object3D.material, s = od.material;
        m.color.set(s.color); m.roughness = s.roughness; m.metalness = s.metalness; m.opacity = s.opacity; m.transparent = s.opacity < 1;
        m.emissive.set(s.emissive); m.emissiveIntensity = s.emissiveIntensity;
      } else if (od.model && Cloud.client) {
        const { data: blob, error } = await Cloud.client.storage.from('models').download(od.model.path);
        if (error) throw error;
        const url = URL.createObjectURL(blob);
        try { entry = addImportedModel(await loadModelAsync(url, od.model.ext), od.name, od.model.ext, { raw: true }); entry.storagePath = od.model.path; }
        finally { URL.revokeObjectURL(url); }
      }
    } catch (err) { console.error('Restore failed for', od.name, err); toast('Could not restore "' + od.name + '"'); }
    if (!entry) continue;
    const o = entry.object3D; entry.name = od.name; idMap[od.id] = entry.id;
    o.position.fromArray(od.position); o.rotation.fromArray(od.rotation); o.scale.fromArray(od.scale);
    entry.visible = od.visible !== false; o.visible = entry.visible; updateLightHelper(o);
  }
  for (const [oldId, list] of Object.entries(data.keyframes || {})) if (idMap[oldId]) App.keyframes[idMap[oldId]] = list;
  if (data.cameraPath && data.cameraPath.length) {
    App.cameraPath.curveType = data.curveType || 'catmullrom';
    data.cameraPath.forEach((arr) => {
      const p = new THREE.Vector3(...arr); App.cameraPath.points.push(p);
      const mk = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), new THREE.MeshBasicMaterial({ color: 0x4fa3d1 }));
      mk.position.copy(p); mk.userData.__helper = true; App.scene.add(mk); App.cameraPath.markers.push(mk);
    });
    rebuildCameraPathCurve();
  }
  if (data.env) {
    const E = data.env, $ = (id) => document.getElementById(id);
    $('envBgColor').value = E.bg; $('envGrid').checked = E.grid; $('envIBL').checked = E.ibl !== false;
    $('envFogEnabled').checked = E.fogEnabled; $('envFogColor').value = E.fogColor; $('envFogNear').value = E.fogNear;
    $('envFogFar').value = E.fogFar; $('envGroundOpacity').value = E.groundOpacity ?? 0.35;
    applyEnvironmentSettings();
  }
  if (data.view) { App.defaultCamera.position.fromArray(data.view.position); App.orbit.target.fromArray(data.view.target); App.orbit.update(); }
  const ae = App.sceneObjects.find((e) => e.id === idMap[data.activeCameraId]);
  setActiveCamera(ae ? ae.object3D : App.defaultCamera);
  App.undo.stack = []; App.undo.redoStack = []; App.undo.suppress = false;
  selectEntry(null); refreshHierarchy(); refreshKeyTrack(); updateUndoRedoButtons(); updateTimelineUI(); applyKeyframesAtTime(0);
}

/* ---------------------------------------------------------------------
   Supabase: Auth (Google OAuth + Email/Password), RLS-protected projects, background autosave
--------------------------------------------------------------------- */
const Cloud = { client: null, user: null, projectId: null, lastHash: '', busy: false, ready: false, timer: null, entering: false, uiBound: false };
const ACTIVE_KEY = 'er_active_project';
const $id = (id) => document.getElementById(id);

function setCloudStatus(state, text) {
  const el = $id('cloudStatus'); el.dataset.state = state; el.querySelector('span').textContent = text;
}
const timeAgo = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };

function createCloudClient() {
  if (Cloud.client) return true;
  if (!SUPABASE_ANON_KEY) {
    toast('Setup needed: paste your Supabase anon (public) key into SUPABASE_ANON_KEY at the top of app.js');
    console.error('SUPABASE_ANON_KEY is empty. Dashboard -> Project Settings -> API -> anon public.');
    return false;
  }
  Cloud.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  // Handles the OAuth redirect return, token refresh, and sign-out from other tabs
  Cloud.client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session && !Cloud.ready) setTimeout(() => afterAuth(session), 0);
    if (event === 'SIGNED_OUT' && Cloud.ready) onSignedOut();
  });
  return true;
}

/* ---- Auth modal ---- */
let authMode = 'signin';
function openAuthModal() { setAuthMsg(''); openModal('authModal'); }
function closeAuthModal() { const m = $id('authModal'); if (m && !m.classList.contains('hidden')) closeModal(); }
function setAuthMsg(msg, kind) { const m = $id('authMsg'); m.textContent = msg; m.dataset.kind = kind || ''; }
function setAuthMode(mode) {
  authMode = mode;
  $id('authSubmit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  $id('authToggle').textContent = mode === 'signin' ? 'No account? Create one' : 'Have an account? Sign in';
  $id('authPassword').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  setAuthMsg('');
}

function bindAuthUI() {
  $id('googleBtn').addEventListener('click', async () => {
    if (!createCloudClient()) return;
    const { error } = await Cloud.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if (error) setAuthMsg(error.message, 'err');
  });
  $id('authToggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  $id('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!createCloudClient()) return;
    const email = $id('authEmail').value.trim(), password = $id('authPassword').value;
    if (!email || password.length < 6) return setAuthMsg('Enter an email and a password of at least 6 characters.', 'err');
    $id('authSubmit').disabled = true; setAuthMsg('Please wait…');
    try {
      if (authMode === 'signin') {
        const { data, error } = await Cloud.client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.session) afterAuth(data.session);
      } else {
        const { data, error } = await Cloud.client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (data.session) afterAuth(data.session);
        else setAuthMsg('Check your inbox to confirm your email, then sign in.', 'ok');
      }
    } catch (err) { setAuthMsg(err.message || 'Authentication failed', 'err'); }
    finally { $id('authSubmit').disabled = false; }
  });
}

// Page load: bind login UI; if returning from Google OAuth (or a session exists) go straight into the studio
(async function bootAuth() {
  bindAuthUI();
  if (!createCloudClient()) return;
  const { data: { session } } = await Cloud.client.auth.getSession();
  if (session && /[?#&](code|access_token)=/.test(location.href)) {
    history.replaceState(null, '', location.pathname);
    afterAuth(session);
  }
})();

/* ---- Session lifecycle ---- */
async function startCloud(session) {
  Cloud.user = session.user; Cloud.ready = true; Cloud.projectId = null;
  Cloud.lastHash = JSON.stringify(collectLightweightState()); // pristine scene: don't create an empty project
  $id('userEmail').textContent = session.user.email || 'Account';
  $id('userChip').style.display = 'flex';
  setCloudStatus('ok', 'Synced');
  if (!Cloud.timer) {
    Cloud.timer = setInterval(syncTick, 2000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) syncTick(); });
  }
}

async function signOut() {
  await syncTick();
  await Cloud.client.auth.signOut();
  onSignedOut();
}
function onSignedOut() {
  Cloud.ready = false;
  try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
  location.reload(); // clean slate: no previous user's scene stays in memory
}

function bindCloudUI() {
  if (Cloud.uiBound) return; Cloud.uiBound = true;
  $id('cloudStatus').addEventListener('click', () => openDashboard(false));
  $id('menuProjects').addEventListener('click', () => openDashboard(false));
  $id('menuNewProject').addEventListener('click', () => newCloudProject());
  $id('signOutBtn').addEventListener('click', signOut);
  $id('dashNewBtn').addEventListener('click', () => { closeModal(); newCloudProject(true); });
}

/* ---- Recent Projects dashboard ---- */
async function openDashboard(isStartup) {
  openModal('projectsModal');
  $id('dashSub').textContent = isStartup ? 'Welcome back. Pick up where you left off or start fresh.' : 'Your saved scenes';
  await renderProjectList();
}

async function renderProjectList() {
  const box = $id('projectsList');
  if (!Cloud.ready) { box.textContent = 'Sign in to see your projects.'; return; }
  box.textContent = 'Loading…';
  const { data, error } = await Cloud.client.from('projects').select('id,title,updated_at').order('updated_at', { ascending: false });
  if (error) { box.textContent = 'Could not load projects: ' + error.message; return; }
  if (!data.length) { box.textContent = 'No saved projects yet. Start a new one; your work saves automatically.'; return; }
  box.innerHTML = '';
  data.forEach((p) => {
    const row = document.createElement('div'); row.className = 'project-row';
    row.innerHTML = '<div style="min-width:0"><div class="pr-title"></div><div class="pr-sub"></div></div><div class="pr-actions"><button class="btn-ghost">Open</button><button class="btn-ghost danger">Delete</button></div>';
    row.querySelector('.pr-title').textContent = p.title || 'Untitled Project';
    row.querySelector('.pr-sub').textContent = timeAgo(p.updated_at) + (p.id === Cloud.projectId ? ' · open' : '');
    const [open, del] = row.querySelectorAll('button');
    open.onclick = async () => { closeModal(); await openCloudProject(p.id); };
    del.onclick = async () => {
      if (!confirm('Permanently delete “' + (p.title || 'Untitled') + '” and its uploaded models?')) return;
      const { data: files } = await Cloud.client.storage.from('models').list(`${Cloud.user.id}/${p.id}`);
      if (files && files.length) await Cloud.client.storage.from('models').remove(files.map((f) => `${Cloud.user.id}/${p.id}/${f.name}`));
      await Cloud.client.from('projects').delete().eq('id', p.id);
      if (p.id === Cloud.projectId) { Cloud.projectId = null; try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {} }
      row.remove();
    };
    box.appendChild(row);
  });
}

async function openCloudProject(id) {
  await syncTick(); // flush pending edits of the current project first
  setCloudStatus('sync', 'Loading…');
  const { data, error } = await Cloud.client.from('projects').select('*').eq('id', id).single();
  if (error) { setCloudStatus('err', 'Load failed'); return toast('Could not load project'); }
  Cloud.projectId = id; try { localStorage.setItem(ACTIVE_KEY, id); } catch (e) {}
  await restoreFromState(data.state || {});
  Cloud.lastHash = JSON.stringify(collectLightweightState());
  setCloudStatus('ok', 'Synced');
}

async function newCloudProject(skipConfirm) {
  await syncTick();
  Cloud.projectId = null; try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
  resetWorkspace(skipConfirm === true); Cloud.lastHash = JSON.stringify(collectLightweightState());
}

/* ---- Background autosave: cheap poll, writes only when the scene changed, never blocks the UI ---- */
async function syncTick() {
  if (!Cloud.ready || Cloud.busy || App.recorder.recording) return;
  if (JSON.stringify(collectLightweightState()) === Cloud.lastHash) return;
  Cloud.busy = true; setCloudStatus('sync', 'Saving…');
  try {
    const title = $id('projectTitle').value || 'Untitled Project';
    if (!Cloud.projectId) {
      const { data, error } = await Cloud.client.from('projects').insert({ title, state: {}, user_id: Cloud.user.id }).select('id').single();
      if (error) throw error; Cloud.projectId = data.id; try { localStorage.setItem(ACTIVE_KEY, data.id); } catch (e) {}
    }
    for (const e of App.sceneObjects) { // upload newly imported model files first
      if (e.file && !e.storagePath) {
        const path = `${Cloud.user.id}/${Cloud.projectId}/${Date.now()}_${e.file.name.replace(/[^\w.\-]/g, '_')}`;
        const { error } = await Cloud.client.storage.from('models').upload(path, e.file, { contentType: e.file.type || 'application/octet-stream' });
        if (error) throw error; e.storagePath = path;
      }
    }
    const state = collectLightweightState();
    const { error } = await Cloud.client.from('projects').update({ title, state, updated_at: new Date().toISOString() }).eq('id', Cloud.projectId);
    if (error) throw error;
    Cloud.lastHash = JSON.stringify(state); setCloudStatus('ok', 'Synced');
  } catch (e) { console.error(e); setCloudStatus('err', 'Sync failed — retrying'); }
  finally { Cloud.busy = false; }
}

/* =========================================================================
   EasyRenderer 3D — FIX PATCH
   Fixes: foreground tabs, viewport sizing, video export and local download.
   NEW: export now ALWAYS stops by itself when the timeline finishes
        (loop is forced off while exporting, a tail is rendered so the last
        frame is captured, and a failsafe timer guarantees it ends).
   ========================================================================= */

(function installEasyRendererFixes() {
  // Keep the tabs and viewport visible in the foreground.
  const patchStyle = document.createElement('style');
  patchStyle.id = 'easyRendererForegroundPatch';
  patchStyle.textContent = `
    .tab-btn {
      position: relative;
      z-index: 20;
    }

    .tab-panel {
      position: relative;
      z-index: 10;
    }

    #viewportContainer {
      position: relative;
      min-width: 0;
      min-height: 0;
    }

    #viewport {
      display: block;
      width: 100%;
      height: 100%;
    }

    #hierarchyList,
    .hierarchy-item {
      position: relative;
    }

    #exportBtn:disabled {
      opacity: .65;
      cursor: wait;
    }

    /* Export progress bar (bottom edge of the viewport) */
    #erExportBar {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 3px;
      background: rgba(255,255,255,.08);
      z-index: 40;
      display: none;
      pointer-events: none;
    }
    #erExportBar.show { display: block; }
    #erExportBar > div {
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, #e8772d, #ffb36b);
      box-shadow: 0 0 12px #e8772d;
    }
  `;

  if (!document.getElementById(patchStyle.id)) {
    document.head.appendChild(patchStyle);
  }

  // Restore the viewport after an export finishes.
  function restoreExportViewport() {
    if (!App.renderer) return;

    const container = document.getElementById('viewportContainer');

    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (!width || !height) return;

    App.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, 2)
    );

    App.renderer.setSize(width, height, false);

    if (App.activeCamera) {
      App.activeCamera.aspect = width / height;
      App.activeCamera.updateProjectionMatrix();
    }

    if (App.defaultCamera) {
      App.defaultCamera.aspect = width / height;
      App.defaultCamera.updateProjectionMatrix();
    }

    renderFrame();
  }

  // Select a recording format supported by the current browser.
  function getSupportedExportMimeType() {
    if (!window.MediaRecorder) return '';

    const mp4 = [
      'video/mp4;codecs=avc1.640028',
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1',
      'video/mp4'
    ];
    const webm = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    const wantMp4 = (App.renderSettings.format || 'mp4') === 'mp4';
    const formats = wantMp4 ? mp4.concat(webm) : webm.concat(mp4);

    for (const format of formats) {
      if (MediaRecorder.isTypeSupported(format)) {
        if (wantMp4 && !format.startsWith('video/mp4')) {
          toast('This browser cannot record MP4 directly, so the video will be saved as WebM.');
        }
        return format;
      }
    }

    return '';
  }

  // Hide grid, gizmo, light/camera helpers and camera-path lines so only the scene objects are recorded
  let hiddenForExport = [];
  function hideHelpersForExport() {
    hiddenForExport = [];
    if (App.renderSettings.hideHelpers === false) return;
    const hide = (o) => { if (o && o.visible) { hiddenForExport.push(o); o.visible = false; } };
    hide(App.grid);
    hide(App.transform);
    App.sceneObjects.forEach((e) => {
      const h = e.object3D.userData.__helper;
      if (h && typeof h === 'object') hide(h);
    });
    App.cameraPath.markers.forEach(hide);
    hide(App.cameraPath.line);
  }
  function restoreHelpersAfterExport() {
    hiddenForExport.forEach((o) => { o.visible = true; });
    hiddenForExport = [];
    if (App.transform) App.transform.visible = App.tool !== 'select' && !!App.selected;
    App.sceneObjects.forEach((e) => {
      const h = e.object3D.userData.__helper;
      if (h && typeof h === 'object') h.visible = e.visible !== false;
    });
    const g = document.getElementById('envGrid');
    if (App.grid && g) App.grid.visible = g.checked;
  }

  // Export progress bar helpers
  function ensureExportBar() {
    let bar = document.getElementById('erExportBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'erExportBar';
      bar.appendChild(document.createElement('div'));
      const container = document.getElementById('viewportContainer');
      if (container) container.appendChild(bar);
    }
    return bar;
  }
  function hideExportBar() {
    const bar = document.getElementById('erExportBar');
    if (bar) {
      bar.classList.remove('show');
      if (bar.firstChild) bar.firstChild.style.width = '0%';
    }
  }
  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function tickExportTimer() {
    if (!App.recorder.recording) { hideExportBar(); return; }
    const dur = App.timeline.duration || 1;
    const elapsed = Math.min(dur, (performance.now() - App.recorder.startTime) / 1000);
    const label = document.getElementById('recTime');
    if (label) label.textContent = fmtClock(elapsed) + ' / ' + fmtClock(dur);
    const bar = document.getElementById('erExportBar');
    if (bar && bar.firstChild) {
      bar.firstChild.style.width = Math.min(100, (App.timeline.currentTime / dur) * 100) + '%';
    }
    requestAnimationFrame(tickExportTimer);
  }

  // Start video export.
  exportVideo = function exportVideoFixed() {
    if (App.recorder.recording) return;

    if (!App.renderer || !App.activeCamera) {
      alert('The 3D studio is not ready. Please try again.');
      return;
    }

    if (
      !App.renderer.domElement.captureStream ||
      !window.MediaRecorder
    ) {
      alert(
        'Video export is not supported in this browser. ' +
        'Please use a recent version of Chrome or Edge.'
      );
      return;
    }

    const exportButton = document.getElementById('exportBtn');

    try {
      setPlaying(false);
      App.timeline.currentTime = 0;
      applyKeyframesAtTime(0);
      updateTimelineUI();

      const width = Math.max(
        1,
        Number(App.renderSettings.width) || 1280
      );

      const height = Math.max(
        1,
        Number(App.renderSettings.height) || 720
      );

      App._exportPrevAspect = App.activeCamera.aspect;
      App.renderer.setPixelRatio(1);
      App.renderer.setSize(width, height, false);

      App.activeCamera.aspect = width / height;
      App.activeCamera.updateProjectionMatrix();

      hideHelpersForExport();
      renderFrame();

      const stream = App.renderer.domElement.captureStream(
        Math.max(1, Number(App.renderSettings.fps) || 30)
      );

      const mimeType = getSupportedExportMimeType();

      const options = {
        videoBitsPerSecond:
          Math.max(1, Number(App.renderSettings.bitrate) || 12) *
          1000000
      };

      if (mimeType) options.mimeType = mimeType;

      let recorder;

      try {
        recorder = new MediaRecorder(stream, options);
      } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        throw error;
      }

      App.recorder.mediaRecorder = recorder;
      App.recorder.stream = stream;
      App.recorder.chunks = [];
      App.recorder.recording = true;
      App.recorder.startTime = performance.now();
      App.recorder.endAt = 0;

      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) {
          App.recorder.chunks.push(event.data);
        }
      };

      recorder.onerror = function (event) {
        console.error('Video recording error:', event.error || event);
        toast('Video recording error. Please try again.');
      };

      recorder.onstop = function () {
        finishExportDownload();
      };

      recorder.start(250);

      // An export must end when the timeline ends: loop is switched off for the duration of the export
      App.recorder.prevLoop = App.timeline.loop;
      App.timeline.loop = false;
      const loopBtn = document.getElementById('loopBtn');
      if (loopBtn) loopBtn.classList.remove('active');

      // Failsafe: no matter what happens, the recording is closed shortly after the timeline length
      clearTimeout(App.recorder.failsafe);
      App.recorder.failsafe = setTimeout(function () {
        if (App.recorder.recording) stopRecording();
      }, (App.timeline.duration + 6) * 1000);

      if (exportButton) exportButton.disabled = true;

      document.getElementById('recIndicator')
        ?.classList.add('show');

      ensureExportBar().classList.add('show');
      tickExportTimer();

      setPlaying(true);

      toast(
        'Recording started. It stops automatically at the end of the timeline and downloads.'
      );

    } catch (error) {
      console.error('Could not start video export:', error);

      App.recorder.recording = false;

      if (exportButton) exportButton.disabled = false;

      document.getElementById('recIndicator')
        ?.classList.remove('show');

      hideExportBar();
      restoreHelpersAfterExport();
      restoreExportViewport();

      alert(
        'Video export could not start. ' +
        'Check the browser console for details.'
      );
    }
  };

  // Stop the recorder safely. Its onstop handler downloads the completed file.
  stopRecording = function stopRecordingFixed() {
    const recorder = App.recorder.mediaRecorder;

    if (!recorder || !App.recorder.recording) return;

    App.recorder.recording = false;

    document.getElementById('recIndicator')
      ?.classList.remove('show');

    try {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        finishExportDownload();
      }
    } catch (error) {
      console.error('Could not stop video recording:', error);

      if (App.recorder.stream) {
        App.recorder.stream.getTracks().forEach(track => track.stop());
        App.recorder.stream = null;
      }

      cleanupExportState();
      restoreExportViewport();
    }
  };

  // Put every export-related setting back to normal.
  function cleanupExportState() {
    clearTimeout(App.recorder.failsafe);
    App.recorder.failsafe = null;
    App.recorder.endAt = 0;
    App.recorder.recording = false;

    if (App.recorder.prevLoop !== undefined) {
      App.timeline.loop = App.recorder.prevLoop;
      App.recorder.prevLoop = undefined;
      const loopBtn = document.getElementById('loopBtn');
      if (loopBtn) loopBtn.classList.toggle('active', App.timeline.loop);
    }

    if (App.timeline.playing) setPlaying(false);

    const button = document.getElementById('exportBtn');
    if (button) button.disabled = false;

    document.getElementById('recIndicator')
      ?.classList.remove('show');

    hideExportBar();
    restoreHelpersAfterExport();
  }

  // Save the finished recording to the browser's Downloads folder.
  function finishExportDownload() {
    try {
      const recorder = App.recorder.mediaRecorder;
      const chunks = App.recorder.chunks || [];

      if (!chunks.length) {
        toast('No video data was recorded. Please try again.');
        return;
      }

      const mimeType =
        (recorder && recorder.mimeType) || 'video/webm';

      const blob = new Blob(chunks, { type: mimeType });

      const extension = mimeType.includes('mp4')
        ? 'mp4'
        : 'webm';

      const rawTitle =
        document.getElementById('projectTitle')?.value ||
        'EasyRenderer3D_Export';

      const safeTitle = rawTitle
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_') || 'EasyRenderer3D_Export';

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = `${safeTitle}.${extension}`;
      link.style.display = 'none';

      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 30000);

      toast(
        'Export complete! Check your browser Downloads folder.'
      );

    } catch (error) {
      console.error('Could not download the video:', error);

      alert(
        'The recording finished, but the download could not start.'
      );

    } finally {
      if (App.recorder.stream) {
        App.recorder.stream.getTracks().forEach(track => track.stop());
        App.recorder.stream = null;
      }

      App.recorder.chunks = [];

      cleanupExportState();
      restoreExportViewport();
    }
  }

  // Keep the viewport fitted after tab changes.
  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      requestAnimationFrame(() => {
        if (App.renderer && !App.recorder.recording) {
          onResize();
        }
      });
    });
  });

})();

/* =========================================================================
   EasyRenderer 3D — CINEMATIC POST-FX (high-end look)
   Bloom glow, filmic tone-mapping, vignette, film grain, lens fringing,
   colour grading and optional floating-dust atmosphere.
   Everything renders through the normal viewport, so video export gets it too.
   The studio keeps working with the standard renderer if anything fails to load.
   ========================================================================= */

const FX_PRESETS = {
  cinematic: { enabled: true, bloom: 0.35, bloomRadius: 0.5, bloomThreshold: 0.85, vignette: 0.35, grain: 0.04, aberration: 0.0015, saturation: 1.08, contrast: 1.05, exposure: 1.05, dust: false },
  clean:     { enabled: true, bloom: 0.12, bloomRadius: 0.3, bloomThreshold: 0.95, vignette: 0.12, grain: 0.0,  aberration: 0.0,    saturation: 1.0,  contrast: 1.0,  exposure: 1.0,  dust: false },
  neon:      { enabled: true, bloom: 0.9,  bloomRadius: 0.8, bloomThreshold: 0.55, vignette: 0.5,  grain: 0.05, aberration: 0.003,  saturation: 1.3,  contrast: 1.12, exposure: 1.1,  dust: true  },
  dreamy:    { enabled: true, bloom: 0.65, bloomRadius: 1.0, bloomThreshold: 0.7,  vignette: 0.3,  grain: 0.03, aberration: 0.0008, saturation: 1.15, contrast: 0.95, exposure: 1.15, dust: true  },
  off:       { enabled: false, bloom: 0, bloomRadius: 0, bloomThreshold: 1, vignette: 0, grain: 0, aberration: 0, saturation: 1, contrast: 1, exposure: 1.05, dust: false },
};

const FX_SLIDERS = [
  ['bloom', 'Bloom glow', 0, 2, 0.01],
  ['bloomRadius', 'Bloom spread', 0, 1.5, 0.01],
  ['bloomThreshold', 'Bloom threshold', 0, 1.5, 0.01],
  ['vignette', 'Vignette', 0, 1, 0.01],
  ['grain', 'Film grain', 0, 0.2, 0.005],
  ['aberration', 'Lens fringing', 0, 0.01, 0.0002],
  ['saturation', 'Saturation', 0, 2, 0.01],
  ['contrast', 'Contrast', 0.5, 1.6, 0.01],
  ['exposure', 'Exposure', 0.2, 2.5, 0.01],
];

const CinemaShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    vignette: { value: 0.35 },
    grain: { value: 0.04 },
    aberration: { value: 0.0015 },
    saturation: { value: 1.08 },
    contrast: { value: 1.05 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float vignette;
    uniform float grain;
    uniform float aberration;
    uniform float saturation;
    uniform float contrast;
    varying vec2 vUv;

    float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      vec2 off = c * aberration * d * 6.0;

      vec4 base = texture2D(tDiffuse, vUv);
      float r = texture2D(tDiffuse, vUv + off).r;
      float b = texture2D(tDiffuse, vUv - off).b;
      vec3 col = vec3(r, base.g, b);

      // colour grade
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, saturation);
      col = (col - 0.5) * contrast + 0.5;

      // vignette
      float v = smoothstep(0.25, 0.95, length(c) * 1.35);
      col *= 1.0 - vignette * v;

      // film grain (strongest in the mid tones)
      float n = rnd(vUv * vec2(1920.0, 1080.0) + fract(time) * 97.0) - 0.5;
      col += n * grain * (1.0 - abs(luma - 0.5));

      gl_FragColor = vec4(max(col, 0.0), base.a);
    }`,
};

async function initPostFX() {
  if (FX.ready) return;
  try {
    const [ec, rp, ub, op, sp] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
      import('three/addons/postprocessing/ShaderPass.js'),
    ]);

    loadFXParams();

    const size = App.renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: 4, // multisampled so edges stay smooth with post-processing on
    });

    const composer = new ec.EffectComposer(App.renderer, target);
    const renderPass = new rp.RenderPass(App.scene, App.activeCamera);
    const bloom = new ub.UnrealBloomPass(new THREE.Vector2(size.x, size.y), FX.params.bloom, FX.params.bloomRadius, FX.params.bloomThreshold);
    const output = new op.OutputPass();
    const cinema = new sp.ShaderPass(CinemaShader);

    composer.addPass(renderPass);
    composer.addPass(bloom);
    composer.addPass(output);
    composer.addPass(cinema);

    FX.composer = composer; FX.renderPass = renderPass; FX.bloom = bloom; FX.output = output; FX.cinema = cinema;

    createDust();
    buildFXPanel();
    applyFXParams();
    FX.ready = true;
  } catch (err) {
    console.warn('Post-processing unavailable, using the standard renderer:', err);
  }
}

// One call used by the render loop and the export: composer when FX is on, plain renderer otherwise
function renderFrame() {
  const t = performance.now() * 0.001;

  if (FX.dust && FX.dust.visible) {
    FX.dust.rotation.y = t * 0.012;
    FX.dust.position.y = Math.sin(t * 0.25) * 0.25;
  }

  if (FX.ready && FX.params.enabled) {
    App.renderer.getSize(FX.size);
    const pr = App.renderer.getPixelRatio();
    if (FX.size.x !== FX.w || FX.size.y !== FX.h || pr !== FX.pr) {
      FX.w = FX.size.x; FX.h = FX.size.y; FX.pr = pr;
      if (FX.composer.setPixelRatio) FX.composer.setPixelRatio(pr);
      FX.composer.setSize(FX.w, FX.h);
    }
    FX.renderPass.camera = App.activeCamera;
    FX.cinema.uniforms.time.value = t % 100;
    FX.composer.render();
  } else {
    App.renderer.render(App.scene, App.activeCamera);
  }
}

function createDust() {
  const n = 600;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 30;
    pos[i * 3 + 1] = Math.random() * 10;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 30;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffd9b0, size: 0.05, transparent: true, opacity: 0.55,
    depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.visible = false;
  pts.userData.__fx = true;
  App.scene.add(pts);
  FX.dust = pts;
}

function loadFXParams() {
  try {
    const saved = JSON.parse(localStorage.getItem('er_fx') || 'null');
    if (saved && typeof saved === 'object') Object.assign(FX.params, saved);
  } catch (e) {}
}
function saveFXParams() {
  try { localStorage.setItem('er_fx', JSON.stringify(FX.params)); } catch (e) {}
}

function applyFXParams() {
  const P = FX.params;
  if (FX.bloom) { FX.bloom.strength = P.bloom; FX.bloom.radius = P.bloomRadius; FX.bloom.threshold = P.bloomThreshold; }
  if (FX.cinema) {
    const u = FX.cinema.uniforms;
    u.vignette.value = P.vignette; u.grain.value = P.grain; u.aberration.value = P.aberration;
    u.saturation.value = P.saturation; u.contrast.value = P.contrast;
  }
  if (App.renderer) App.renderer.toneMappingExposure = P.exposure;
  if (FX.dust) FX.dust.visible = !!P.dust;
  syncFXPanel();
  saveFXParams();
}

function buildFXPanel() {
  if (FX.panel) return;
  const host = document.getElementById('viewportContainer');
  if (!host) return;

  const wrap = document.createElement('div');
  wrap.className = 'er-fx';
  wrap.innerHTML = `
    <button class="er-fx-toggle" type="button" title="Cinematic effects"><i class="fa-solid fa-wand-magic-sparkles"></i><span>FX</span></button>
    <div class="er-fx-panel">
      <div class="er-fx-head">
        <strong>Cinematic FX</strong>
        <label class="er-fx-switch"><input type="checkbox" data-fx="enabled"><span></span></label>
      </div>
      <div class="er-fx-presets">
        <button type="button" data-preset="cinematic">Cinematic</button>
        <button type="button" data-preset="clean">Clean</button>
        <button type="button" data-preset="neon">Neon</button>
        <button type="button" data-preset="dreamy">Dreamy</button>
        <button type="button" data-preset="off">Off</button>
      </div>
      <div class="er-fx-sliders"></div>
      <label class="er-fx-check"><input type="checkbox" data-fx="dust"><span>Atmosphere dust</span></label>
    </div>`;

  const sliders = wrap.querySelector('.er-fx-sliders');
  FX_SLIDERS.forEach(([key, label, min, max, step]) => {
    const row = document.createElement('div');
    row.className = 'er-fx-row';
    row.innerHTML = `<span>${label}</span><input type="range" data-fx="${key}" min="${min}" max="${max}" step="${step}"><em></em>`;
    sliders.appendChild(row);
  });

  wrap.querySelector('.er-fx-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  wrap.addEventListener('click', (e) => e.stopPropagation());
  wrap.addEventListener('pointerdown', (e) => e.stopPropagation());

  wrap.querySelectorAll('input[data-fx]').forEach((el) => {
    el.addEventListener('input', () => {
      const key = el.dataset.fx;
      FX.params[key] = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
      applyFXParams();
    });
  });
  wrap.querySelectorAll('button[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Object.assign(FX.params, FX_PRESETS[btn.dataset.preset]);
      applyFXParams();
    });
  });

  host.appendChild(wrap);
  FX.panel = wrap;
}

function syncFXPanel() {
  if (!FX.panel) return;
  FX.panel.querySelectorAll('input[data-fx]').forEach((el) => {
    const v = FX.params[el.dataset.fx];
    if (el.type === 'checkbox') el.checked = !!v;
    else {
      el.value = v;
      const em = el.parentElement.querySelector('em');
      if (em) em.textContent = Number(v).toFixed(el.dataset.fx === 'aberration' ? 4 : 2);
    }
  });
  FX.panel.classList.toggle('fx-off', !FX.params.enabled);
}

/* =========================================================================
   EasyRenderer 3D — VISUAL POLISH
   Glass panels, glow accents, smooth transitions, animated splash,
   refined scrollbars and focus states. Pure CSS: nothing is removed or
   re-wired, so every existing feature behaves exactly as before.
   ========================================================================= */

(function installVisualPolish() {
  if (document.getElementById('erPolishStyle')) return;
  const s = document.createElement('style');
  s.id = 'erPolishStyle';
  s.textContent = `
    :root {
      --er-accent: #e8772d;
      --er-accent-2: #ffb36b;
      --er-glow: rgba(232,119,45,.45);
    }

    /* ---- smooth, tactile controls ---- */
    button, .tool-btn, .tab-btn, .btn-ghost, .hierarchy-item, .h-icon-btn, select, input {
      transition: transform .15s ease, box-shadow .22s ease, background-color .2s ease,
                  border-color .2s ease, color .2s ease, opacity .2s ease, filter .2s ease;
    }
    .tool-btn:hover:not(:disabled), .btn-ghost:hover:not(:disabled) {
      box-shadow: 0 0 0 1px rgba(232,119,45,.35), 0 6px 20px rgba(232,119,45,.16);
      transform: translateY(-1px);
    }
    .tool-btn:active:not(:disabled), .btn-ghost:active:not(:disabled) { transform: translateY(0) scale(.97); }
    .tool-btn.active { box-shadow: 0 0 0 1px rgba(232,119,45,.6), 0 0 18px var(--er-glow); }
    .tab-btn:hover { color: var(--er-accent-2); }
    .tab-btn.active { box-shadow: inset 0 -2px 0 var(--er-accent); text-shadow: 0 0 12px var(--er-glow); }

    /* ---- hierarchy ---- */
    .hierarchy-item:hover { background: rgba(232,119,45,.07); }
    .hierarchy-item.selected {
      box-shadow: inset 3px 0 0 var(--er-accent), 0 0 22px rgba(232,119,45,.10);
    }

    /* ---- inputs ---- */
    input[type="range"] { accent-color: var(--er-accent); }
    input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px rgba(232,119,45,.38);
    }

    /* ---- glass modals ---- */
    #modalOverlay {
      backdrop-filter: blur(10px) saturate(1.25);
      -webkit-backdrop-filter: blur(10px) saturate(1.25);
      animation: erFade .25s ease;
    }
    .modal-card {
      animation: erPop .3s cubic-bezier(.2,.9,.3,1.15);
      box-shadow: 0 30px 90px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.06), 0 0 70px rgba(232,119,45,.08);
    }

    /* ---- toasts ---- */
    .toast {
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-left: 3px solid var(--er-accent);
      box-shadow: 0 14px 40px rgba(0,0,0,.5), 0 0 24px rgba(232,119,45,.12);
    }

    /* ---- keyframes on the timeline glow on hover ---- */
    .keyframe-diamond { filter: drop-shadow(0 0 3px rgba(232,119,45,.55)); }
    .keyframe-diamond:hover { filter: drop-shadow(0 0 8px rgba(255,179,107,.95)); }

    /* ---- recording indicator pulse ---- */
    #recIndicator.show { animation: erRec 1.3s ease-in-out infinite; }

    /* ---- studio entrance ---- */
    #studio.visible { animation: erStudioIn .7s cubic-bezier(.2,.8,.2,1); }

    /* ---- splash: drifting aurora + glowing call-to-action ---- */
    #splash::before {
      content: "";
      position: absolute;
      inset: -25%;
      background:
        radial-gradient(40% 40% at 25% 30%, rgba(232,119,45,.22), transparent 70%),
        radial-gradient(35% 35% at 75% 65%, rgba(79,163,209,.16), transparent 70%),
        radial-gradient(30% 30% at 55% 15%, rgba(255,179,107,.12), transparent 70%);
      filter: blur(50px);
      animation: erAurora 20s ease-in-out infinite alternate;
      pointer-events: none;
      z-index: -1;
    }
    #openStudioBtn { animation: erGlow 2.8s ease-in-out infinite; }
    #openStudioBtn:hover { transform: translateY(-2px) scale(1.02); }

    /* ---- refined scrollbars ---- */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(232,119,45,.55); }

    /* ---- Cinematic FX panel ---- */
    .er-fx { position: absolute; top: 12px; left: 12px; z-index: 35; font-family: inherit; }
    .er-fx-toggle {
      display: flex; align-items: center; gap: 7px;
      padding: 7px 12px; border-radius: 10px;
      color: #f3f3f3; font-size: 12px; font-weight: 600; letter-spacing: .04em; cursor: pointer;
      background: rgba(20,20,22,.62);
      border: 1px solid rgba(255,255,255,.1);
      backdrop-filter: blur(14px) saturate(1.3);
      -webkit-backdrop-filter: blur(14px) saturate(1.3);
      box-shadow: 0 8px 26px rgba(0,0,0,.4);
    }
    .er-fx-toggle i { color: var(--er-accent-2); }
    .er-fx-toggle:hover { border-color: rgba(232,119,45,.6); box-shadow: 0 8px 26px rgba(0,0,0,.4), 0 0 18px var(--er-glow); }
    .er-fx.open .er-fx-toggle { border-color: rgba(232,119,45,.7); }

    .er-fx-panel {
      display: none; margin-top: 8px; width: 270px; padding: 12px 14px 14px;
      color: #e8e8e8; font-size: 11px;
      background: rgba(18,18,20,.72);
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 14px;
      backdrop-filter: blur(20px) saturate(1.4);
      -webkit-backdrop-filter: blur(20px) saturate(1.4);
      box-shadow: 0 24px 70px rgba(0,0,0,.6), 0 0 40px rgba(232,119,45,.07);
      animation: erPop .25s cubic-bezier(.2,.9,.3,1.15);
      max-height: calc(100% - 70px); overflow-y: auto;
    }
    .er-fx.open .er-fx-panel { display: block; }
    .er-fx-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .er-fx-head strong { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }

    .er-fx-presets { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }
    .er-fx-presets button {
      padding: 4px 9px; font-size: 10.5px; color: #ddd; cursor: pointer;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); border-radius: 999px;
    }
    .er-fx-presets button:hover { color: #fff; border-color: rgba(232,119,45,.6); background: rgba(232,119,45,.16); }

    .er-fx-row { display: grid; grid-template-columns: 96px 1fr 38px; align-items: center; gap: 8px; margin-bottom: 7px; }
    .er-fx-row span { color: #b9b9b9; }
    .er-fx-row em { font-style: normal; text-align: right; color: var(--er-accent-2); font-variant-numeric: tabular-nums; }
    .er-fx-row input[type="range"] { width: 100%; }
    .er-fx.fx-off .er-fx-sliders, .er-fx.fx-off .er-fx-check { opacity: .4; pointer-events: none; }

    .er-fx-check { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: #cfcfcf; cursor: pointer; }
    .er-fx-check input { accent-color: var(--er-accent); }

    .er-fx-switch { position: relative; width: 34px; height: 18px; display: inline-block; cursor: pointer; }
    .er-fx-switch input { opacity: 0; width: 0; height: 0; }
    .er-fx-switch span {
      position: absolute; inset: 0; border-radius: 999px; background: rgba(255,255,255,.14); transition: background .2s ease;
    }
    .er-fx-switch span::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
      background: #fff; transition: transform .2s ease; box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .er-fx-switch input:checked + span { background: var(--er-accent); box-shadow: 0 0 12px var(--er-glow); }
    .er-fx-switch input:checked + span::after { transform: translateX(16px); }

    /* ---- keyframes ---- */
    @keyframes erFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes erPop { from { opacity: 0; transform: translateY(10px) scale(.96); } to { opacity: 1; transform: none; } }
    @keyframes erStudioIn { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: none; } }
    @keyframes erAurora {
      0% { transform: translate3d(-3%, -2%, 0) rotate(0deg) scale(1); }
      100% { transform: translate3d(3%, 3%, 0) rotate(8deg) scale(1.12); }
    }
    @keyframes erGlow {
      0%, 100% { box-shadow: 0 0 0 rgba(232,119,45,0), 0 8px 30px rgba(232,119,45,.18); }
      50% { box-shadow: 0 0 34px rgba(232,119,45,.5), 0 8px 40px rgba(232,119,45,.3); }
    }
    @keyframes erRec {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,60,60,.5); }
      50% { box-shadow: 0 0 0 9px rgba(255,60,60,0); }
    }

    @media (prefers-reduced-motion: reduce) {
      #splash::before, #openStudioBtn, #recIndicator.show, #studio.visible { animation: none !important; }
    }
  `;
  document.head.appendChild(s);
})();

/* =========================================================================
   EasyRenderer 3D — Export options (format + hide helpers) in Render Settings
   ========================================================================= */
(function installExportOptions() {
  const applyBtn = document.getElementById('applyRenderSettings');
  if (!applyBtn || !applyBtn.parentElement || document.getElementById('erExportOptions')) return;

  const box = document.createElement('div');
  box.id = 'erExportOptions';
  box.style.cssText = 'display:flex; flex-direction:column; gap:10px; margin:12px 0;';
  box.innerHTML = `
    <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:12px;">
      <span>Video format</span>
      <select id="exportFormat" style="min-width:150px;">
        <option value="mp4">MP4 (recommended)</option>
        <option value="webm">WebM</option>
      </select>
    </label>
    <label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer;">
      <input type="checkbox" id="exportHideHelpers" checked>
      <span>Hide grid, lines &amp; gizmos while recording</span>
    </label>`;
  applyBtn.parentElement.insertBefore(box, applyBtn);

  const fmt = document.getElementById('exportFormat');
  const hide = document.getElementById('exportHideHelpers');
  const sync = () => {
    fmt.value = App.renderSettings.format || 'mp4';
    hide.checked = App.renderSettings.hideHelpers !== false;
  };
  fmt.addEventListener('change', () => { App.renderSettings.format = fmt.value; });
  hide.addEventListener('change', () => { App.renderSettings.hideHelpers = hide.checked; });
  const rsBtn = document.getElementById('renderSettingsBtn');
  if (rsBtn) rsBtn.addEventListener('click', sync);
  sync();
})();
