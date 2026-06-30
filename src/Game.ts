import * as THREE from 'three';
import { Input } from './Input';
import { Player } from './Player';
import { Enemy } from './Enemy';
import { GameAudio } from './GameAudio';

const WORLD_SIZE = 260; // ground plane extent
const PLAY_LIMIT = 78; // how far the player may roam from centre
const CAMP_HALF = 22; // camp fence half-extent (square camp)
const GATE_HALF = 4; // half-width of the south gate opening
const BULLET_SPEED = 130;
const BULLET_LIFE = 1.6; // seconds before a bullet despawns
const HIP_FOV = 75;
const EYE_HEIGHT = 0.7; // camera offset above the body centre
const MAX_HEALTH = 100;
const COMBO_WINDOW = 3.0; // seconds to chain kills for a multiplier
const DAMAGE_COOLDOWN = 0.5; // min seconds between hits taken
const PICKUP_DROP_CHANCE = 0.3; // chance a guard drops something
const PICKUP_LIFE = 18; // seconds before a pickup despawns
const HEALTH_PICKUP = 25; // health restored
const CAPTURE_RADIUS = 6; // how close to the flag you must stand
const CAPTURE_TIME = 6; // seconds to raise your flag and win

type WeaponType = 'rifle' | 'sniper';

interface WeaponDef {
  name: string;
  damage: number; // body-shot damage
  headshot: number; // head-shot damage
  fireInterval: number; // seconds between shots
  auto: boolean; // hold to keep firing?
  magSize: number;
  startReserve: number;
  spread: number; // hip-fire inaccuracy
  aimSpread: number; // aimed inaccuracy
  aimFov: number; // zoom when aiming
  loudness: number; // radius (m) that a shot alerts guards
  reloadTime: number;
  scoped: boolean; // shows the sniper scope overlay when aiming
}

const WEAPONS: Record<WeaponType, WeaponDef> = {
  // Loud and fast — great for a frontal assault, but wakes the whole camp.
  rifle: {
    name: 'Assault Rifle', damage: 1, headshot: 3, fireInterval: 0.11, auto: true,
    magSize: 30, startReserve: 120, spread: 0.022, aimSpread: 0.006, aimFov: 55,
    loudness: 60, reloadTime: 1.5, scoped: false,
  },
  // Quiet and lethal — one shot drops most guards without raising the alarm.
  sniper: {
    name: 'Sniper Rifle', damage: 6, headshot: 14, fireInterval: 0.95, auto: false,
    magSize: 5, startReserve: 25, spread: 0.004, aimSpread: 0, aimFov: 16,
    loudness: 14, reloadTime: 2.0, scoped: true,
  },
};

type GameState = 'ready' | 'playing' | 'won' | 'lost';

/** Closest point on the segment a→b to point p (used for bullet hits). */
function closestPointOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  let t = lenSq > 1e-8 ? p.clone().sub(a).dot(ab) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return a.clone().addScaledVector(ab, t);
}

/**
 * Owns the renderer, scene, camera and the main loop. Spawns the player,
 * chasing enemies and a glTF mascot, handles shooting and bullet collisions,
 * runs a countdown timer and resolves win/lose conditions.
 */
export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private input: Input;
  private player: Player;
  private audio: GameAudio;
  private enemies: Enemy[] = [];
  private bullets: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  private pickups: { mesh: THREE.Mesh; kind: 'health' | 'ammo'; life: number; spin: number }[] = [];
  private tracers: { mesh: THREE.Mesh; life: number; dur: number }[] = [];
  private obstacles: { x: number; z: number; radius: number }[] = [];
  private fx: { mesh: THREE.Mesh; life: number; dur: number; grow: number }[] = [];
  private gunVM = new THREE.Group();
  private muzzleLight = new THREE.PointLight(0xffd27f, 0, 8, 2);
  private fireCooldown = 0;
  private state: GameState = 'ready';

  // Mission progression: clear the camp's guards, then raise your flag.
  private score = 0;
  private combo = 0;
  private comboTimer = 0;
  private totalGuards = 0;
  private detected = false; // has the camp been alerted to your presence?
  private capturing = false; // standing in the flag zone with guards cleared
  private captureProgress = 0; // 0..1
  private health = MAX_HEALTH;
  private damageCd = 0;
  private damageFlash = 0;

  // Weapons: each keeps its own magazine + reserve so you can swap freely.
  private weapon: WeaponType = 'sniper';
  private ammo: Record<WeaponType, number> = {
    rifle: WEAPONS.rifle.magSize,
    sniper: WEAPONS.sniper.magSize,
  };
  private reserve: Record<WeaponType, number> = {
    rifle: WEAPONS.rifle.startReserve,
    sniper: WEAPONS.sniper.startReserve,
  };
  private reloading = false;
  private reloadTimer = 0;

  // Capture-point objects.
  private captureRing?: THREE.Mesh;
  private campFlag?: THREE.Mesh;
  private towerPosts: THREE.Vector3[] = [];

  private crosshairEl: HTMLElement | null = null;
  private damageEl: HTMLElement | null = null;
  private comboEl: HTMLElement | null = null;
  private ammoEl: HTMLElement | null = null;
  private weaponEl: HTMLElement | null = null;
  private objectiveEl: HTMLElement | null = null;
  private alertEl: HTMLElement | null = null;
  private captureWrapEl: HTMLElement | null = null;
  private captureBarEl: HTMLElement | null = null;
  private scopeEl: HTMLElement | null = null;

  private scoreEl: HTMLElement;
  private healthValEl: HTMLElement;
  private healthBarEl: HTMLElement;
  private guardsEl: HTMLElement;
  private fpsEl: HTMLElement;
  private fpsLast = performance.now();
  private fpsFrames = 0;
  private endOverlay: HTMLElement;
  private endTitle: HTMLElement;
  private endMessage: HTMLElement;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    // Cap at 1.5 — on HiDPI/4K screens a ratio of 2 quadruples the pixel count
    // and is the most common cause of stutter on integrated GPUs.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic tone mapping gives the scene a richer, less "flat" look.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 40, 95);

    this.camera = new THREE.PerspectiveCamera(HIP_FOV, 1, 0.05, 200);
    this.camera.position.set(0, EYE_HEIGHT, 0);
    this.scene.add(this.camera); // so the gun viewmodel (a child) renders

    this.input = new Input(canvas);
    this.audio = new GameAudio();
    this.player = new Player();
    this.player.mesh.visible = false; // first-person: hide our own body
    this.player.mesh.position.set(0, 0.9, CAMP_HALF + 36); // approach from the south
    this.scene.add(this.player.mesh);
    this.buildViewModel();

    this.scoreEl = document.getElementById('score')!;
    this.healthValEl = document.getElementById('healthVal')!;
    this.healthBarEl = document.getElementById('healthBar')!;
    this.guardsEl = document.getElementById('guards')!;
    this.fpsEl = document.getElementById('fps')!;
    this.crosshairEl = document.getElementById('crosshair');
    this.damageEl = document.getElementById('damage');
    this.comboEl = document.getElementById('combo');
    this.ammoEl = document.getElementById('ammo');
    this.weaponEl = document.getElementById('weapon');
    this.objectiveEl = document.getElementById('objective');
    this.alertEl = document.getElementById('alert');
    this.captureWrapEl = document.getElementById('capture');
    this.captureBarEl = document.getElementById('captureBar');
    this.scopeEl = document.getElementById('scope');
    this.endOverlay = document.getElementById('endOverlay')!;
    this.endTitle = document.getElementById('endTitle')!;
    this.endMessage = document.getElementById('endMessage')!;

    this.buildWorld();
    this.buildCamp();
    this.spawnGuards();
    this.updateHud();

    this.onResize();
    window.addEventListener('resize', this.onResize);
  }

  /** A simple gun held in view, parented to the camera. */
  private buildViewModel() {
    this.gunVM.position.set(0.2, -0.2, -0.3);
    this.camera.add(this.gunVM);

    // Muzzle flash light, flashed on each shot.
    this.muzzleLight.position.set(0, 0, -0.9);
    this.gunVM.add(this.muzzleLight);

    this.rebuildWeaponModel();
  }

  /** Rebuild the held weapon mesh to match the active weapon. */
  private rebuildWeaponModel() {
    for (let i = this.gunVM.children.length - 1; i >= 0; i--) {
      const c = this.gunVM.children[i];
      if (c === this.muzzleLight) continue;
      this.gunVM.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose?.();
      (m.material as THREE.Material)?.dispose?.();
    }

    const metal = new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.4, metalness: 0.7 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.6, metalness: 0.1 });

    if (this.weapon === 'sniper') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.7), metal);
      body.position.z = -0.35;
      this.gunVM.add(body);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8), metal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = -0.85;
      this.gunVM.add(barrel);
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 12), metal);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.09, -0.3);
      this.gunVM.add(scope);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.3), wood);
      stock.position.set(0, -0.04, 0.05);
      this.gunVM.add(stock);
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.5), metal);
      body.position.z = -0.25;
      this.gunVM.add(body);
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.4), metal);
      barrel.position.z = -0.6;
      this.gunVM.add(barrel);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.1), metal);
      mag.position.set(0, -0.18, -0.18);
      this.gunVM.add(mag);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.2, 0.1), metal);
      grip.position.set(0, -0.16, 0.0);
      this.gunVM.add(grip);
    }
  }

  /** Switch the active weapon and refresh the held model + HUD. */
  private setWeapon(w: WeaponType) {
    if (this.weapon === w) return;
    this.weapon = w;
    this.reloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0.1;
    this.rebuildWeaponModel();
    this.audio.swap();
    this.updateHud();
  }

  private buildWorld() {
    // Warmer, hazier sky + long-range fog for an open battlefield feel.
    this.scene.background = new THREE.Color(0x9fb6c9);
    this.scene.fog = new THREE.Fog(0x9fb6c9, 75, 210);

    // --- Rolling, vertex-coloured terrain (flat around the camp) ---
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 120, 120);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors: number[] = [];
    const cGrass = new THREE.Color(0x4f7a34);
    const cGrass2 = new THREE.Color(0x668f42);
    const cDirt = new THREE.Color(0x6e5436);
    const cSand = new THREE.Color(0x8a7048);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.hypot(x, y);
      const rolling = this.terrainHeight(x, y);
      const falloff = THREE.MathUtils.clamp((r - 32) / 40, 0, 1);
      const h = rolling * falloff;
      pos.setZ(i, h);

      const n = Math.sin(x * 0.15) * Math.cos(y * 0.13) * 0.5 + 0.5;
      if (r < 30) tmp.copy(cDirt).lerp(cGrass, THREE.MathUtils.clamp((r - 18) / 12, 0, 1));
      else tmp.copy(cGrass).lerp(cGrass2, n);
      if (h > 0.8) tmp.lerp(cSand, THREE.MathUtils.clamp((h - 0.8) / 1.5, 0, 0.6));
      colors.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // --- Lighting: warm low sun + cool sky fill ---
    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a35, 0.85);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffe6c0, 1.6);
    sun.position.set(45, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 180;
    const d = 60;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    this.scene.add(sun);

    this.buildTerrainDecor();
  }

  /** Smooth pseudo-noise used for the rolling hills (visual only). */
  private terrainHeight(x: number, y: number): number {
    return (
      Math.sin(x * 0.035) * Math.cos(y * 0.03) * 2.2 +
      Math.sin(x * 0.011 + 1.7) * 1.6 +
      Math.cos(y * 0.017 + 0.6) * 1.3
    );
  }

  /** Distant hills, scattered trees, rocks and bushes around the field. */
  private buildTerrainDecor() {
    // Ring of distant hills on the horizon.
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x55683a, roughness: 1, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.15;
      const rad = 100 + Math.random() * 25;
      const hgt = 9 + Math.random() * 16;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(13 + Math.random() * 10, hgt, 7), hillMat);
      hill.position.set(Math.cos(a) * rad, hgt / 2 - 1.5, Math.sin(a) * rad);
      hill.rotation.y = Math.random() * Math.PI;
      this.scene.add(hill);
    }

    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7a7a76, roughness: 1, flatShading: true });
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x3f6a2c, roughness: 0.9, flatShading: true });

    // Scatter foliage outside the camp footprint.
    let placed = 0;
    let guard = 0;
    while (placed < 46 && guard++ < 400) {
      const x = (Math.random() - 0.5) * (PLAY_LIMIT * 1.8);
      const z = (Math.random() - 0.5) * (PLAY_LIMIT * 1.8);
      const r = Math.hypot(x, z);
      // Keep clear of the camp interior + the approach lane to the gate.
      if (Math.abs(x) < CAMP_HALF + 6 && Math.abs(z) < CAMP_HALF + 6) continue;
      if (Math.abs(x) < 6 && z > CAMP_HALF && z < CAMP_HALF + 40) continue;
      if (r > PLAY_LIMIT * 1.25) continue;
      placed++;

      const roll = Math.random();
      if (roll < 0.45) {
        this.makeTree(x, z, 0.8 + Math.random() * 0.7);
      } else if (roll < 0.7) {
        const s = 0.6 + Math.random() * 1.4;
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
        rock.position.set(x, s * 0.5, z);
        rock.rotation.set(Math.random(), Math.random(), Math.random());
        rock.castShadow = true;
        rock.receiveShadow = true;
        this.scene.add(rock);
        this.obstacles.push({ x, z, radius: s * 0.8 });
      } else {
        const s = 0.5 + Math.random() * 0.6;
        const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), bushMat);
        bush.position.set(x, s * 0.6, z);
        bush.castShadow = true;
        this.scene.add(bush);
      }
    }
  }

  /** A low-poly conifer; recorded as an obstacle for cover. */
  private makeTree(x: number, z: number, scale: number) {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 });
    const leafMat = new THREE.MeshStandardMaterial({
      color: Math.random() < 0.5 ? 0x2e6b2e : 0x357a35,
      roughness: 0.85,
      flatShading: true,
    });
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 2.4, 8), trunkMat);
    trunk.position.y = 1.2;
    trunk.castShadow = true;
    tree.add(trunk);
    const heights = [2.6, 3.4, 4.1];
    const radii = [1.6, 1.25, 0.85];
    for (let j = 0; j < 3; j++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radii[j], 1.6, 8), leafMat);
      cone.position.y = heights[j];
      cone.castShadow = true;
      tree.add(cone);
    }
    tree.position.set(x, 0, z);
    tree.scale.setScalar(scale);
    this.scene.add(tree);
    this.obstacles.push({ x, z, radius: 0.7 * scale });
  }

  // ---- Camp construction ------------------------------------------------

  /** Four watchtower footprints, just inside the fence corners. */
  private towerSpots(): { x: number; z: number }[] {
    const c = CAMP_HALF - 3;
    return [
      { x: -c, z: -c },
      { x: c, z: -c },
      { x: -c, z: c },
      { x: c, z: c },
    ];
  }

  /** Build the whole enemy camp: ground, fence, towers, buildings and props. */
  private buildCamp() {
    // Compacted dirt floor under the camp.
    const dirt = new THREE.Mesh(
      new THREE.PlaneGeometry(CAMP_HALF * 2 + 8, CAMP_HALF * 2 + 8),
      new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 1 })
    );
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = 0.02;
    dirt.receiveShadow = true;
    this.scene.add(dirt);

    this.buildFence();
    this.buildTowers();
    this.buildBuildings();
    this.buildProps();
    this.buildCapturePoint();
  }

  /** Corrugated perimeter hoarding with a gap for the south gate. */
  private buildFence() {
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x6f6552, roughness: 0.85, metalness: 0.25 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2f2a20, roughness: 0.9 });
    const H = 3.2;
    const step = 4;

    const place = (x: number, z: number, horizontal: boolean) => {
      // Leave a gateway in the south (+z) wall.
      if (horizontal && z > CAMP_HALF - 0.1 && Math.abs(x) < GATE_HALF + 1) return;
      const w = step - 0.1;
      const geo = horizontal ? new THREE.BoxGeometry(w, H, 0.25) : new THREE.BoxGeometry(0.25, H, w);
      const panel = new THREE.Mesh(geo, panelMat);
      panel.position.set(x, H / 2, z);
      panel.castShadow = true;
      panel.receiveShadow = true;
      this.scene.add(panel);
      this.obstacles.push({ x, z, radius: 2.1 });
    };

    for (let p = -CAMP_HALF; p <= CAMP_HALF + 0.01; p += step) {
      place(p, -CAMP_HALF, true); // north wall
      place(p, CAMP_HALF, true); // south wall (gated)
      place(-CAMP_HALF, p, false); // west wall
      place(CAMP_HALF, p, false); // east wall
    }

    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, H + 0.6, 0.5), postMat);
      post.position.set(sx * CAMP_HALF, (H + 0.6) / 2, sz * CAMP_HALF);
      post.castShadow = true;
      this.scene.add(post);
    }
    for (const gx of [-GATE_HALF - 1, GATE_HALF + 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, H + 1, 0.6), postMat);
      post.position.set(gx, (H + 1) / 2, CAMP_HALF);
      post.castShadow = true;
      this.scene.add(post);
      this.obstacles.push({ x: gx, z: CAMP_HALF, radius: 0.8 });
    }
  }

  /** Wooden watchtowers at the corners; each carries a sentry post position. */
  private buildTowers() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x5b4327, roughness: 0.85 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 });
    const legH = 5;
    this.towerPosts = [];

    for (const { x, z } of this.towerSpots()) {
      const tower = new THREE.Group();
      tower.position.set(x, 0, z);

      for (const [lx, lz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]] as const) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.25, legH, 0.25), wood);
        leg.position.set(lx, legH / 2, lz);
        leg.castShadow = true;
        tower.add(leg);
      }
      const platform = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 3), wood);
      platform.position.y = legH;
      platform.castShadow = true;
      platform.receiveShadow = true;
      tower.add(platform);
      // Railing.
      for (const [rx, rz, rw, rd] of [[0, -1.4, 3, 0.15], [0, 1.4, 3, 0.15], [-1.4, 0, 0.15, 3], [1.4, 0, 0.15, 3]] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(rw, 0.7, rd), wood);
        rail.position.set(rx, legH + 0.45, rz);
        rail.castShadow = true;
        tower.add(rail);
      }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.4, 4), roofMat);
      roof.position.y = legH + 1.6;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      tower.add(roof);

      this.scene.add(tower);
      this.obstacles.push({ x, z, radius: 1.7 });
      this.towerPosts.push(new THREE.Vector3(x, legH + 0.35, z));
    }
  }

  /** A box building with a pitched roof, door and windows. */
  private makeBuilding(x: number, z: number, w: number, d: number, rot: number, wallColor: number) {
    const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.9 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.8 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.3, metalness: 0.4, emissive: 0x0a1018 });

    const b = new THREE.Group();
    b.position.set(x, 0, z);
    b.rotation.y = rot;
    const wallH = 3;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    walls.position.y = wallH / 2;
    walls.castShadow = true;
    walls.receiveShadow = true;
    b.add(walls);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) * 0.6, 1.6, 4), roofMat);
    roof.position.y = wallH + 0.8;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    b.add(roof);

    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.1), trimMat);
    door.position.set(0, 0.9, d / 2 + 0.01);
    b.add(door);
    for (const wx of [-w / 2 + 0.9, w / 2 - 0.9]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.1), glassMat);
      win.position.set(wx, 1.7, d / 2 + 0.01);
      b.add(win);
    }
    this.scene.add(b);
    this.obstacles.push({ x, z, radius: Math.max(w, d) * 0.5 + 0.2 });
  }

  private buildBuildings() {
    this.makeBuilding(-13, -12, 9, 6, 0, 0x6b6253);
    this.makeBuilding(13, -13, 7, 7, 0, 0x5f5a48);
    this.makeBuilding(14, 6, 6, 9, Math.PI / 2, 0x6b6253);

    // A couple of khaki ridge tents.
    this.makeTent(-14, 6, 0);
    this.makeTent(-9, 12, 0.4);
    this.makeTent(8, 13, -0.3);
  }

  /** A triangular ridge tent (a 3-sided prism). */
  private makeTent(x: number, z: number, rot: number) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x7c7144, roughness: 1, flatShading: true });
    const tent = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 4, 3), mat);
    tent.rotation.z = Math.PI / 2; // lay the prism on its side
    tent.rotation.y = rot;
    tent.position.set(x, 0.9, z);
    tent.castShadow = true;
    tent.receiveShadow = true;
    this.scene.add(tent);
    this.obstacles.push({ x, z, radius: 1.7 });
  }

  /** Crates, barrels and sandbag walls scattered around the yard. */
  private buildProps() {
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x7a5a30, roughness: 0.9 });
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x3f5a3a, roughness: 0.7, metalness: 0.3 });
    const sandMat = new THREE.MeshStandardMaterial({ color: 0x8a7748, roughness: 1 });

    const crateStacks: [number, number][] = [[-4, -14], [6, -10], [-16, 2], [10, -2]];
    for (const [cx, cz] of crateStacks) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), crateMat);
        c.position.set(cx + (Math.random() - 0.5) * 0.6, 0.6 + i * 1.2, cz + (Math.random() - 0.5) * 0.6);
        c.rotation.y = Math.random() * 0.5;
        c.castShadow = true;
        c.receiveShadow = true;
        this.scene.add(c);
      }
      this.obstacles.push({ x: cx, z: cz, radius: 1.0 });
    }

    const barrels: [number, number][] = [[3, -13], [-5, -15], [12, -4], [-15, -3]];
    for (const [bx, bz] of barrels) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 12), barrelMat);
      barrel.position.set(bx, 0.6, bz);
      barrel.castShadow = true;
      this.scene.add(barrel);
      this.obstacles.push({ x: bx, z: bz, radius: 0.6 });
    }

    // Sandbag walls (low cover) near the gate and around the flag.
    const walls: [number, number, number, number][] = [
      [-6, 16, 6, 0],
      [6, 16, 6, 0],
      [0, -8, 7, 0],
    ];
    for (const [wx, wz, len, rot] of walls) {
      const wall = new THREE.Group();
      const count = Math.round(len);
      for (let i = 0; i < count; i++) {
        const bag = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.45, 0.6), sandMat);
        bag.position.set((i - count / 2) * 1.0, 0.22 + (i % 2) * 0.1, 0);
        bag.castShadow = true;
        bag.receiveShadow = true;
        wall.add(bag);
      }
      wall.position.set(wx, 0, wz);
      wall.rotation.y = rot;
      this.scene.add(wall);
      this.obstacles.push({ x: wx, z: wz, radius: len * 0.45 });
    }
  }

  /** The central flag you must reach to capture the camp once it's clear. */
  private buildCapturePoint() {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 6, 10),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.5, metalness: 0.6 })
    );
    pole.position.set(0, 3, 0);
    pole.castShadow = true;
    this.scene.add(pole);

    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 1.4),
      new THREE.MeshStandardMaterial({ color: 0xb01818, roughness: 0.8, side: THREE.DoubleSide })
    );
    flag.position.set(1.2, 5.0, 0);
    this.scene.add(flag);
    this.campFlag = flag;

    // Glowing capture ring on the ground (hidden until the camp is cleared).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CAPTURE_RADIUS - 0.4, CAPTURE_RADIUS, 48),
      new THREE.MeshBasicMaterial({ color: 0x35d07f, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    this.scene.add(ring);
    this.captureRing = ring;
  }

  /** Place all camp guards: tower sentries, gate watch, patrols and a heavy. */
  private spawnGuards() {
    const add = (e: Enemy) => {
      this.scene.add(e.mesh);
      this.enemies.push(e);
    };

    // Tower sentries — fixed shooters watching outward.
    for (const p of this.towerPosts) {
      add(new Enemy(p.clone(), 'guard', { stationary: true, facing: Math.atan2(p.x, p.z) }));
    }

    // Gate watch.
    add(new Enemy(new THREE.Vector3(-GATE_HALF - 2, 0, CAMP_HALF - 2), 'guard', { facing: 0 }));
    add(new Enemy(new THREE.Vector3(GATE_HALF + 2, 0, CAMP_HALF - 2), 'guard', { facing: 0 }));

    // Perimeter patrols (opposite directions around the same loop).
    const loop = [
      new THREE.Vector3(-16, 0, -16),
      new THREE.Vector3(16, 0, -16),
      new THREE.Vector3(16, 0, 16),
      new THREE.Vector3(-16, 0, 16),
    ];
    add(new Enemy(loop[0].clone(), 'patrol', { patrol: loop.map((v) => v.clone()) }));
    add(new Enemy(loop[2].clone(), 'patrol', { patrol: loop.slice().reverse().map((v) => v.clone()) }));

    // Inner yard patrol.
    const inner = [
      new THREE.Vector3(-8, 0, 8),
      new THREE.Vector3(8, 0, 8),
      new THREE.Vector3(8, 0, -8),
      new THREE.Vector3(-8, 0, -8),
    ];
    add(new Enemy(inner[0].clone(), 'patrol', { patrol: inner }));

    // Stationed riflemen by the buildings.
    add(new Enemy(new THREE.Vector3(-13, 0, -7), 'guard', { facing: Math.PI / 2 }));
    add(new Enemy(new THREE.Vector3(12, 0, 9), 'guard', { facing: -Math.PI / 2 }));

    // Heavy gunner guarding the flag.
    add(new Enemy(new THREE.Vector3(0, 0, -5), 'heavy', { facing: 0 }));

    this.totalGuards = this.enemies.length;
  }

  private updateHud() {
    this.scoreEl.textContent = this.score.toLocaleString();

    const remaining = this.enemies.length;
    this.guardsEl.textContent = `${remaining} / ${this.totalGuards}`;
    this.guardsEl.classList.toggle('clear', remaining === 0);

    const hp = Math.max(0, Math.round(this.health));
    this.healthValEl.textContent = `${hp}`;
    const pct = (hp / MAX_HEALTH) * 100;
    this.healthBarEl.style.width = `${pct}%`;
    this.healthBarEl.classList.toggle('low', hp <= 30);

    const def = WEAPONS[this.weapon];
    if (this.ammoEl) {
      const mag = this.reloading ? '· ·' : `${this.ammo[this.weapon]}`;
      this.ammoEl.innerHTML = `<b>${mag}</b> / ${this.reserve[this.weapon]}`;
      this.ammoEl.classList.toggle('empty', !this.reloading && this.ammo[this.weapon] === 0);
      this.ammoEl.classList.toggle('reloading', this.reloading);
    }
    if (this.weaponEl) {
      this.weaponEl.innerHTML = `<span class="wkey">${this.weapon === 'sniper' ? '2' : '1'}</span> ${def.name}`;
      this.weaponEl.classList.toggle('stealth', this.weapon === 'sniper');
    }
    if (this.objectiveEl) {
      this.objectiveEl.textContent =
        remaining > 0
          ? `Eliminate the guards — ${remaining} left`
          : 'Camp clear! Reach the flag to raise your colours';
    }
    if (this.alertEl) {
      this.alertEl.textContent = this.detected ? 'DETECTED' : 'HIDDEN';
      this.alertEl.classList.toggle('hot', this.detected);
    }
  }

  /** Show the floating combo multiplier / headshot callout. */
  private showCombo(headshot = false) {
    if (!this.comboEl) return;
    let text = '';
    if (headshot) text = this.combo >= 2 ? `HEADSHOT  x${this.combo}` : 'HEADSHOT';
    else if (this.combo >= 2) text = `x${this.combo}`;
    if (!text) return;
    this.comboEl.textContent = text;
    this.comboEl.classList.toggle('head', headshot);
    this.comboEl.classList.remove('show');
    void this.comboEl.offsetWidth;
    this.comboEl.classList.add('show');
  }

  start() {
    this.audio.resume();
    this.input.requestLock();
    if (this.state === 'playing') return;
    this.state = 'playing';
    if (!this.raf) {
      this.clock.start();
      this.loop();
    }
  }

  restart() {
    this.player.reset();
    this.player.mesh.position.set(0, 0.9, CAMP_HALF + 36);
    this.clearEntities();
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.detected = false;
    this.capturing = false;
    this.captureProgress = 0;
    this.health = MAX_HEALTH;
    this.damageCd = 0;
    this.damageFlash = 0;
    this.weapon = 'sniper';
    this.ammo = { rifle: WEAPONS.rifle.magSize, sniper: WEAPONS.sniper.magSize };
    this.reserve = { rifle: WEAPONS.rifle.startReserve, sniper: WEAPONS.sniper.startReserve };
    this.reloading = false;
    this.reloadTimer = 0;
    this.rebuildWeaponModel();
    this.spawnGuards();

    // Reset the capture point visuals.
    if (this.captureRing) (this.captureRing.material as THREE.MeshBasicMaterial).opacity = 0;
    if (this.campFlag) (this.campFlag.material as THREE.MeshStandardMaterial).color.set(0xb01818);
    if (this.captureWrapEl) this.captureWrapEl.classList.add('hidden');

    this.input.yaw = 0;
    this.input.pitch = 0;
    this.fireCooldown = 0;
    this.updateHud();
    this.endOverlay.classList.add('hidden');
    this.audio.resume();
    this.input.requestLock();
    this.state = 'playing';
  }

  /** Remove all enemies, bullets, pickups and effects from the scene. */
  private clearEntities() {
    for (const e of this.enemies) this.disposeMesh(e.mesh);
    this.enemies = [];
    for (const b of this.bullets) this.disposeMesh(b.mesh);
    this.bullets = [];
    for (const p of this.pickups) this.disposeMesh(p.mesh);
    this.pickups = [];
    for (const f of this.fx) this.disposeMesh(f.mesh);
    this.fx = [];
    for (const t of this.tracers) this.disposeMesh(t.mesh);
    this.tracers = [];
  }

  /** Remove an object (mesh or group) and dispose all of its geometry/materials. */
  private disposeMesh(obj: THREE.Object3D) {
    this.scene.remove(obj);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.updateFps();
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /** Average the frame rate over ~0.5s of real time so the readout is stable. */
  private updateFps() {
    this.fpsFrames++;
    const now = performance.now();
    const elapsed = now - this.fpsLast;
    if (elapsed >= 500) {
      const fps = Math.round((this.fpsFrames * 1000) / elapsed);
      this.fpsEl.textContent = `FPS: ${fps}`;
      this.fpsFrames = 0;
      this.fpsLast = now;
    }
  }

  private update(dt: number) {
    const t = this.clock.elapsedTime;

    this.updateFx(dt);
    this.updateTracers(dt);

    // Muzzle flash light fades fast after each shot.
    if (this.muzzleLight.intensity > 0) {
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 40);
    }
    // Flag flutter in the breeze.
    if (this.campFlag) this.campFlag.rotation.z = Math.sin(t * 2) * 0.08;
    // Capture ring pulses once the camp is clear.
    if (this.captureRing && this.state === 'playing') {
      const mat = this.captureRing.material as THREE.MeshBasicMaterial;
      mat.opacity = this.enemies.length === 0 ? 0.5 + Math.sin(t * 4) * 0.25 : 0;
    }
    // Red "took damage" vignette fades out.
    if (this.damageFlash > 0) {
      this.damageFlash = Math.max(0, this.damageFlash - dt * 2);
      if (this.damageEl) this.damageEl.style.opacity = `${this.damageFlash}`;
    }

    if (this.state === 'playing') {
      // Weapon switching (1 = rifle, 2 = sniper, Q / wheel = toggle).
      const req = this.input.consumeWeaponRequest();
      if (req === 'rifle') this.setWeapon('rifle');
      else if (req === 'sniper') this.setWeapon('sniper');
      else if (req === 'toggle') this.setWeapon(this.weapon === 'rifle' ? 'sniper' : 'rifle');

      // Combo decays if you stop chaining kills.
      if (this.combo > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) this.combo = 0;
      }
      if (this.damageCd > 0) this.damageCd -= dt;

      // Player + jump SFX.
      if (this.player.update(dt, this.input)) this.audio.jump();
      this.resolveObstacles(this.player.position, 0.4);

      // Reloading (manual request + timer progress).
      if (this.input.consumeReload()) this.startReload();
      if (this.reloading) {
        this.reloadTimer -= dt;
        if (this.reloadTimer <= 0) this.finishReload();
      }

      // Shooting: auto weapons hold-to-fire, the sniper is one-shot-per-click.
      this.fireCooldown -= dt;
      const def = WEAPONS[this.weapon];
      const wantFire = def.auto
        ? this.input.consumeFire() || (this.input.isFiring() && this.fireCooldown <= 0)
        : this.input.consumeTriggerEdge() || this.input.consumeFire();
      if (wantFire && this.fireCooldown <= 0) {
        if (this.ammo[this.weapon] > 0 && !this.reloading) {
          this.fire();
          this.fireCooldown = def.fireInterval;
        } else if (!this.reloading) {
          if (this.reserve[this.weapon] > 0) this.startReload();
          else {
            this.audio.empty();
            this.fireCooldown = 0.3; // dry-click pause
          }
        }
      }

      this.updateBullets(dt);
      this.updatePickups(dt);
      this.updateGuards(dt, t);
      this.updateCapture(dt);
    }

    this.updateCamera(dt);
  }

  /** Move guards, run their vision/alert logic, ranged fire and contact. */
  private updateGuards(dt: number, t: number) {
    const eye = this.player.position.clone();
    eye.y += EYE_HEIGHT;

    for (const enemy of this.enemies) {
      enemy.update(dt, this.player.position, t);
      this.resolveObstacles(enemy.position, enemy.radius);

      // Vision: a guard spots you if you're in range, in its forward arc and
      // not hidden behind cover. Loud gunfire is handled separately on firing.
      if (!enemy.isAlerted) {
        const dist = enemy.position.distanceTo(this.player.position);
        if (dist < enemy.sightRange) {
          const to = new THREE.Vector3().subVectors(this.player.position, enemy.position).setY(0);
          const inFront = dist < 6 || to.lengthSq() < 1e-4 || enemy.facingDir.dot(to.clone().normalize()) > 0.3;
          const guardEye = enemy.position.clone();
          guardEye.y += 1.5;
          if (inFront && this.hasLineOfSight(guardEye, eye)) {
            enemy.alert();
            this.onDetected();
          }
        }
      }

      // Ranged fire while engaged (needs a clear line to you).
      if (enemy.isAlerted) {
        const dmg = enemy.tryFire(dt, this.player.position);
        if (dmg > 0) {
          const guardEye = enemy.position.clone();
          guardEye.y += 1.3;
          if (this.hasLineOfSight(guardEye, eye)) {
            this.spawnTracer(guardEye, eye);
            this.audio.enemyShot();
            if (Math.random() < 0.5) this.takeDamage(dmg);
            if (this.state !== 'playing') return;
          }
        }
      }

      // Melee contact when a guard reaches you.
      if (enemy.position.distanceTo(this.player.position) < enemy.radius + 0.7) {
        this.takeDamage(enemy.damage);
        if (this.state !== 'playing') return;
      }
    }
  }

  /** Capture mechanic: once the camp is clear, hold the flag zone to win. */
  private updateCapture(dt: number) {
    if (this.enemies.length > 0) {
      this.capturing = false;
      this.captureProgress = 0;
      if (this.captureWrapEl) this.captureWrapEl.classList.add('hidden');
      return;
    }

    const inZone = Math.hypot(this.player.position.x, this.player.position.z) < CAPTURE_RADIUS;
    if (inZone) {
      if (!this.capturing) {
        this.capturing = true;
        this.audio.wave();
      }
      this.captureProgress = Math.min(1, this.captureProgress + dt / CAPTURE_TIME);
      if (this.captureWrapEl) this.captureWrapEl.classList.remove('hidden');
      if (this.captureBarEl) this.captureBarEl.style.width = `${Math.round(this.captureProgress * 100)}%`;

      if (this.captureProgress >= 1) {
        if (this.campFlag) (this.campFlag.material as THREE.MeshStandardMaterial).color.set(0x2b7fff);
        this.score += 1000;
        this.updateHud();
        this.endGame('won', `Camp captured! Final score: ${this.score.toLocaleString()}`);
      }
    } else {
      this.capturing = false;
      this.captureProgress = Math.max(0, this.captureProgress - dt * 0.5);
      if (this.captureBarEl) this.captureBarEl.style.width = `${Math.round(this.captureProgress * 100)}%`;
    }
  }

  /** Is the straight line between two points clear of solid cover? */
  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    for (const o of this.obstacles) {
      if (o.radius < 1.0) continue; // low props (bushes, sandbags) don't block sight
      const center = new THREE.Vector3(o.x, from.y, o.z);
      const cp = closestPointOnSegment(center, from, to);
      const dx = cp.x - o.x;
      const dz = cp.z - o.z;
      if (dx * dx + dz * dz < o.radius * o.radius) return false;
    }
    return true;
  }

  /** Wake every guard within `radius` of a point (e.g. loud gunfire). */
  private alertGuardsNear(pos: THREE.Vector3, radius: number) {
    let any = false;
    for (const e of this.enemies) {
      if (!e.isAlerted && e.position.distanceTo(pos) <= radius) {
        e.alert();
        any = true;
      }
    }
    if (any) this.onDetected();
  }

  /** First time the camp realises you're here — sound the alarm. */
  private onDetected() {
    if (this.detected) return;
    this.detected = true;
    this.audio.alarm();
    this.updateHud();
  }

  /** A brief glowing line from a shooter to its target. */
  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = Math.max(0.001, dir.length());
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, len, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd27f, transparent: true, opacity: 0.85, depthWrite: false })
    );
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0, dur: 0.12 });
  }

  private updateTracers(dt: number) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life += dt;
      const k = tr.life / tr.dur;
      (tr.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - k));
      if (k >= 1) {
        this.disposeMesh(tr.mesh);
        this.tracers.splice(i, 1);
      }
    }
  }

  /** Apply damage to the player; ends the game if health is depleted. */
  private takeDamage(amount: number) {
    if (this.damageCd > 0) return;
    this.damageCd = DAMAGE_COOLDOWN;
    this.health -= amount;
    this.damageFlash = 1;
    if (this.damageEl) this.damageEl.style.opacity = '1';
    this.combo = 0;
    this.audio.hurt();
    this.updateHud();
    if (this.health <= 0) {
      this.health = 0;
      this.updateHud();
      this.endGame('lost', `You fell storming the camp. Final score: ${this.score.toLocaleString()}`);
    }
  }

  /** The direction the camera/player is looking (includes pitch). */
  private lookDir(): THREE.Vector3 {
    const { yaw, pitch } = this.input;
    const cp = Math.cos(pitch);
    return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
  }

  /** Fire a bullet from the eye along the look direction. */
  private fire() {
    const def = WEAPONS[this.weapon];
    const dir = this.lookDir();
    // Aiming tightens accuracy; hip-fire spreads (the sniper is precise either way).
    const spread = this.input.isAiming() ? def.aimSpread : def.spread;
    if (spread > 0) {
      dir.x += (Math.random() - 0.5) * spread;
      dir.y += (Math.random() - 0.5) * spread;
      dir.z += (Math.random() - 0.5) * spread;
      dir.normalize();
    }
    this.player.faceDir(dir.x, dir.z);

    const origin = this.camera.position.clone().addScaledVector(dir, 0.6);

    const bullet = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff1a8 })
    );
    bullet.position.copy(origin);
    this.scene.add(bullet);
    this.bullets.push({ mesh: bullet, vel: dir.clone().multiplyScalar(BULLET_SPEED), life: 0 });

    // Recoil kick + muzzle flash on the viewmodel (the sniper kicks harder).
    this.gunVM.position.z += this.weapon === 'sniper' ? 0.12 : 0.06;
    this.muzzleLight.intensity = this.weapon === 'sniper' ? 9 : 6;
    this.ammo[this.weapon]--;
    if (this.weapon === 'sniper') this.audio.sniper();
    else this.audio.shoot();

    // The shot's noise wakes nearby guards — the rifle is far louder.
    this.alertGuardsNear(this.player.position, def.loudness);
    this.updateHud();
  }

  /** Begin a reload if it makes sense (mag not full, spare rounds left). */
  private startReload() {
    const def = WEAPONS[this.weapon];
    if (this.reloading || this.ammo[this.weapon] >= def.magSize || this.reserve[this.weapon] <= 0) return;
    this.reloading = true;
    this.reloadTimer = def.reloadTime;
    this.audio.reload();
    this.updateHud();
  }

  private finishReload() {
    const def = WEAPONS[this.weapon];
    const need = def.magSize - this.ammo[this.weapon];
    const take = Math.min(need, this.reserve[this.weapon]);
    this.ammo[this.weapon] += take;
    this.reserve[this.weapon] -= take;
    this.reloading = false;
    this.updateHud();
  }

  private updateBullets(dt: number) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life += dt;
      const prev = b.mesh.position.clone();
      b.mesh.position.addScaledVector(b.vel, dt);

      // Test the whole travel segment so fast bullets can't tunnel through.
      let hit = false;
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const enemy = this.enemies[j];
        const cp = closestPointOnSegment(enemy.center, prev, b.mesh.position);
        if (cp.distanceTo(enemy.center) < enemy.radius + 0.35) {
          const headshot = cp.y > enemy.headY - 0.35;
          this.onBulletHit(j, headshot);
          hit = true;
          break;
        }
      }

      const p = b.mesh.position;
      const outOfBounds = Math.abs(p.x) > PLAY_LIMIT + 20 || Math.abs(p.z) > PLAY_LIMIT + 20;
      if (hit || b.life > BULLET_LIFE || outOfBounds) {
        this.disposeMesh(b.mesh);
        this.bullets.splice(i, 1);
      }
    }
  }

  /** A bullet struck a guard: damage it, and kill it if its health runs out. */
  private onBulletHit(index: number, headshot: boolean) {
    const enemy = this.enemies[index];
    this.hitMarker(headshot);
    const def = WEAPONS[this.weapon];
    const dmg = headshot ? def.headshot : def.damage;
    if (enemy.hit(dmg)) {
      // A lethal hit is silent — clean sniper kills don't raise the alarm.
      this.killEnemy(index, headshot);
    } else {
      // Wounded but alive — it now knows you're here and shouts a warning.
      if (!enemy.isAlerted) {
        enemy.alert();
        this.alertGuardsNear(enemy.position, 18);
      }
      this.spawnBurst(enemy.center, 0xffd27f, 1.4, 0.22);
    }
  }

  /** Flash the crosshair to confirm a hit landed (gold for a headshot). */
  private hitMarker(headshot: boolean) {
    if (!this.crosshairEl) return;
    this.crosshairEl.classList.remove('hit', 'head');
    void this.crosshairEl.offsetWidth;
    this.crosshairEl.classList.add(headshot ? 'head' : 'hit');
  }

  private killEnemy(index: number, headshot = false) {
    const enemy = this.enemies[index];
    this.spawnBurst(enemy.center, headshot ? 0xffe066 : 0xff6b3d, 4, 0.5);
    this.audio.kill();

    // Combo + score: chained kills multiply the points; headshots add 50%.
    this.combo++;
    this.comboTimer = COMBO_WINDOW;
    let points = enemy.points * this.combo;
    if (headshot) points = Math.round(points * 1.5);
    this.score += points;
    this.showCombo(headshot);

    // Chance to drop a health or ammo pickup.
    if (Math.random() < PICKUP_DROP_CHANCE) {
      this.spawnPickup(enemy.position, Math.random() < 0.5 ? 'health' : 'ammo');
    }

    this.disposeMesh(enemy.mesh);
    this.enemies.splice(index, 1);
    this.updateHud();

    // Camp cleared — the capture point opens up.
    if (this.enemies.length === 0) this.audio.wave();
  }

  private spawnPickup(pos: THREE.Vector3, kind: 'health' | 'ammo') {
    const color = kind === 'health' ? 0x35d07f : 0xffd23f;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.5,
        metalness: 0.3,
        roughness: 0.4,
      })
    );
    mesh.castShadow = true;
    mesh.position.set(pos.x, 0.6, pos.z);
    this.scene.add(mesh);
    this.pickups.push({ mesh, kind, life: 0, spin: Math.random() * Math.PI * 2 });
  }

  private updatePickups(dt: number) {
    const t = this.clock.elapsedTime;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.life += dt;
      p.mesh.rotation.y += dt * 2;
      p.mesh.position.y = 0.6 + Math.sin(t * 3 + p.spin) * 0.12;

      // Collect when the player walks over it.
      const dx = p.mesh.position.x - this.player.position.x;
      const dz = p.mesh.position.z - this.player.position.z;
      if (dx * dx + dz * dz < 1.4 * 1.4) {
        this.collectPickup(p.kind);
        this.disposeMesh(p.mesh);
        this.pickups.splice(i, 1);
        continue;
      }

      if (p.life > PICKUP_LIFE) {
        this.disposeMesh(p.mesh);
        this.pickups.splice(i, 1);
      } else if (p.life > PICKUP_LIFE - 3) {
        p.mesh.visible = Math.floor(p.life * 6) % 2 === 0; // blink before despawn
      }
    }
  }

  private collectPickup(kind: 'health' | 'ammo') {
    if (kind === 'health') {
      this.health = Math.min(MAX_HEALTH, this.health + HEALTH_PICKUP);
    } else {
      // Ammo crate resupplies both weapons.
      this.reserve.rifle += 24;
      this.reserve.sniper += 6;
    }
    this.audio.pickup();
    this.spawnBurst(
      this.player.position.clone().setY(1),
      kind === 'health' ? 0x35d07f : 0xffd23f,
      2,
      0.3
    );
    this.updateHud();
  }

  /** A camera-facing ring that expands and fades (muzzle flashes, kills). */
  private spawnBurst(pos: THREE.Vector3, color: number, grow: number, dur: number) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.55, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.position.copy(pos);
    this.scene.add(ring);
    this.fx.push({ mesh: ring, life: 0, dur, grow });
  }

  private updateFx(dt: number) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life += dt;
      const k = f.life / f.dur;
      f.mesh.scale.setScalar(1 + k * f.grow);
      f.mesh.quaternion.copy(this.camera.quaternion); // billboard toward camera
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) {
        this.disposeMesh(f.mesh);
        this.fx.splice(i, 1);
      }
    }
  }

  /** Push an entity out of any tree it overlaps, on the XZ plane. */
  private resolveObstacles(pos: THREE.Vector3, entityRadius: number) {
    for (const o of this.obstacles) {
      const dx = pos.x - o.x;
      const dz = pos.z - o.z;
      const minDist = o.radius + entityRadius;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDist * minDist && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const push = (minDist - dist) / dist;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
  }

  private endGame(result: 'won' | 'lost', message: string) {
    this.state = result;
    this.endTitle.textContent = result === 'won' ? 'You Win!' : 'Game Over';
    this.endMessage.textContent = message;
    this.endOverlay.classList.remove('hidden');
    if (result === 'won') this.audio.win();
    else this.audio.lose();
  }

  private updateCamera(dt: number) {
    // First-person: sit at eye height, look along yaw/pitch.
    const eye = this.player.position.clone();
    eye.y += EYE_HEIGHT;
    this.camera.position.copy(eye);
    this.camera.lookAt(eye.clone().add(this.lookDir()));

    const aiming = this.input.isAiming();
    const def = WEAPONS[this.weapon];

    // Aim-down-sights: ease the FOV toward this weapon's zoomed value.
    const targetFov = aiming ? def.aimFov : HIP_FOV;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 1 - Math.pow(0.0005, dt));
      this.camera.updateProjectionMatrix();
    }

    // Sniper scope overlay: show only when aiming the scoped weapon.
    const scoped = aiming && def.scoped;
    if (this.scopeEl) this.scopeEl.classList.toggle('on', scoped);
    // Hide the held weapon while looking through the scope.
    this.gunVM.visible = !scoped;

    // Slide the gun toward the centre when aiming, and settle recoil.
    const target = aiming
      ? new THREE.Vector3(0, -0.12, -0.34)
      : new THREE.Vector3(0.2, -0.2, -0.3);
    this.gunVM.position.lerp(target, 1 - Math.pow(0.0001, dt));

    if (this.crosshairEl) this.crosshairEl.classList.toggle('aim', aiming || scoped);
  }

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.renderer.dispose();
  }
}
