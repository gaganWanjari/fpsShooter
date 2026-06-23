import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Input } from './Input';
import { Player } from './Player';
import { Enemy, EnemyType } from './Enemy';
import { GameAudio } from './GameAudio';

const ARENA_SIZE = 50;
const BULLET_SPEED = 60;
const BULLET_LIFE = 1.2; // seconds before a bullet despawns
const BULLET_DAMAGE = 1;
const HIP_FOV = 75;
const AIM_FOV = 45;
const FIRE_INTERVAL = 0.14; // seconds between auto-fire shots
const EYE_HEIGHT = 0.7; // camera offset above the body centre
const MAX_HEALTH = 100;
const MAX_WAVE = 8; // clear this many waves to win
const COMBO_WINDOW = 2.5; // seconds to chain kills for a multiplier
const DAMAGE_COOLDOWN = 0.7; // min seconds between hits taken
const WAVE_BREAK = 3.5; // breather between waves
const MAG_SIZE = 12; // rounds per magazine
const START_RESERVE = 48; // spare rounds at the start
const RELOAD_TIME = 1.1; // seconds to reload
const HEADSHOT_DAMAGE = 3; // enough to drop a brute in one shot
const PICKUP_DROP_CHANCE = 0.35; // chance an enemy drops something
const PICKUP_LIFE = 12; // seconds before a pickup despawns
const HEALTH_PICKUP = 25; // health restored
const AMMO_PICKUP = 24; // reserve rounds gained

// A free, CORS-friendly glTF model served from a CDN. Falls back gracefully
// to a procedural shape if it can't be fetched (e.g. offline).
const MODEL_URL =
  'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/Duck/glTF-Binary/Duck.glb';

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
  private mascot?: THREE.Object3D;
  private obstacles: { x: number; z: number; radius: number }[] = [];
  private fx: { mesh: THREE.Mesh; life: number; dur: number; grow: number }[] = [];
  private gunVM = new THREE.Group();
  private muzzleLight = new THREE.PointLight(0xffd27f, 0, 8, 2);
  private fireCooldown = 0;
  private state: GameState = 'ready';

  // Wave-survival progression.
  private wave = 1;
  private score = 0;
  private combo = 0;
  private comboTimer = 0;
  private waveBreak = 0;
  private health = MAX_HEALTH;
  private damageCd = 0;
  private damageFlash = 0;

  // Ammunition.
  private ammo = MAG_SIZE;
  private reserve = START_RESERVE;
  private reloading = false;
  private reloadTimer = 0;

  private crosshairEl: HTMLElement | null = null;
  private damageEl: HTMLElement | null = null;
  private comboEl: HTMLElement | null = null;
  private ammoEl: HTMLElement | null = null;

  private scoreEl: HTMLElement;
  private healthValEl: HTMLElement;
  private healthBarEl: HTMLElement;
  private waveEl: HTMLElement;
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
    this.scene.add(this.player.mesh);
    this.buildViewModel();

    this.scoreEl = document.getElementById('score')!;
    this.healthValEl = document.getElementById('healthVal')!;
    this.healthBarEl = document.getElementById('healthBar')!;
    this.waveEl = document.getElementById('wave')!;
    this.fpsEl = document.getElementById('fps')!;
    this.crosshairEl = document.getElementById('crosshair');
    this.damageEl = document.getElementById('damage');
    this.comboEl = document.getElementById('combo');
    this.ammoEl = document.getElementById('ammo');
    this.endOverlay = document.getElementById('endOverlay')!;
    this.endTitle = document.getElementById('endTitle')!;
    this.endMessage = document.getElementById('endMessage')!;

    this.buildWorld();
    this.spawnWave();
    this.loadModel();
    this.updateHud();

    this.onResize();
    window.addEventListener('resize', this.onResize);
  }

  /** A simple gun held in view, parented to the camera. */
  private buildViewModel() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x21262e, roughness: 0.45, metalness: 0.6 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.5), mat);
    body.position.z = -0.25;
    this.gunVM.add(body);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.35), mat);
    barrel.position.z = -0.55;
    this.gunVM.add(barrel);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.12), mat);
    grip.position.set(0, -0.16, -0.08);
    this.gunVM.add(grip);

    this.gunVM.position.set(0.2, -0.2, -0.3);
    this.camera.add(this.gunVM);

    // Muzzle flash light, flashed on each shot.
    this.muzzleLight.position.set(0, 0, -0.7);
    this.gunVM.add(this.muzzleLight);
  }

  private buildWorld() {
    // Grassy playground field.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE),
      new THREE.MeshStandardMaterial({ color: 0x5bbf4a, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Lighting tuned for a bright outdoor scene (sky blue + grass bounce).
    const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a7a3a, 0.9);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
    sun.position.set(12, 20, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    this.scene.add(sun);

    this.spawnTrees();
  }

  private spawnTrees() {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 });
    const leafMats = [
      new THREE.MeshStandardMaterial({ color: 0x2e8b2e, roughness: 0.8, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x3aa83a, roughness: 0.8, flatShading: true }),
    ];

    // A ring of trees plus a few scattered ones, all recorded as obstacles.
    const spots: THREE.Vector2[] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      spots.push(new THREE.Vector2(Math.cos(angle) * 19, Math.sin(angle) * 19));
    }
    spots.push(new THREE.Vector2(8, -6), new THREE.Vector2(-10, 7), new THREE.Vector2(5, 12));

    for (const spot of spots) {
      const tree = new THREE.Group();
      const scale = 0.85 + Math.random() * 0.5;

      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 2.4, 8), trunkMat);
      trunk.position.y = 1.2;
      trunk.castShadow = true;
      tree.add(trunk);

      const leafMat = leafMats[Math.floor(Math.random() * leafMats.length)];
      const heights = [2.6, 3.4, 4.1];
      const radii = [1.6, 1.25, 0.85];
      for (let j = 0; j < 3; j++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(radii[j], 1.6, 8), leafMat);
        cone.position.y = heights[j];
        cone.castShadow = true;
        tree.add(cone);
      }

      tree.position.set(spot.x, 0, spot.y);
      tree.scale.setScalar(scale);
      this.scene.add(tree);

      this.obstacles.push({ x: spot.x, z: spot.y, radius: 0.7 * scale });
    }
  }

  /** Build the enemy roster for the current wave: more, faster, tougher. */
  private spawnWave() {
    const count = 3 + this.wave; // grows each wave
    const speedBoost = (this.wave - 1) * 0.2;

    for (let i = 0; i < count; i++) {
      let type: EnemyType = 'grunt';
      const roll = Math.random();
      if (this.wave >= 3 && roll < 0.18) type = 'brute';
      else if (this.wave >= 2 && roll < 0.5) type = 'runner';

      const enemy = new Enemy(this.randomEdgePosition(), type, speedBoost);
      this.scene.add(enemy.mesh);
      this.enemies.push(enemy);
    }
  }

  /** A spot near the arena edge, away from the player's centre spawn. */
  private randomEdgePosition(): THREE.Vector3 {
    const angle = Math.random() * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * 20, 0.9, Math.sin(angle) * 20);
  }

  private loadModel() {
    const loader = new GLTFLoader();
    loader.load(
      MODEL_URL,
      (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(0.02);
        model.position.set(0, 2.5, 0);
        model.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
        });
        this.mascot = model;
        this.scene.add(model);
      },
      undefined,
      () => {
        // Offline / blocked — drop in a procedural stand-in so the centre
        // isn't empty and the game still runs.
        const fallback = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1, 0),
          new THREE.MeshStandardMaterial({ color: 0x4cc9f0, flatShading: true, emissive: 0x113344 })
        );
        fallback.position.set(0, 3, 0);
        fallback.castShadow = true;
        this.mascot = fallback;
        this.scene.add(fallback);
      }
    );
  }

  private updateHud() {
    this.scoreEl.textContent = this.score.toLocaleString();
    this.waveEl.textContent = `${this.wave} / ${MAX_WAVE}`;

    const hp = Math.max(0, Math.round(this.health));
    this.healthValEl.textContent = `${hp}`;
    const pct = (hp / MAX_HEALTH) * 100;
    this.healthBarEl.style.width = `${pct}%`;
    this.healthBarEl.classList.toggle('low', hp <= 30);

    if (this.ammoEl) {
      const mag = this.reloading ? '· ·' : `${this.ammo}`;
      this.ammoEl.innerHTML = `<b>${mag}</b> / ${this.reserve}`;
      this.ammoEl.classList.toggle('empty', !this.reloading && this.ammo === 0);
      this.ammoEl.classList.toggle('reloading', this.reloading);
    }
  }

  /** Briefly bounce the wave pill (used when a new wave starts). */
  private popStat() {
    const stat = this.waveEl.closest('.stat') as HTMLElement | null;
    if (!stat) return;
    stat.classList.remove('pop');
    void stat.offsetWidth; // force reflow so the animation restarts
    stat.classList.add('pop');
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
    this.clearEntities();
    this.wave = 1;
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.waveBreak = 0;
    this.health = MAX_HEALTH;
    this.damageCd = 0;
    this.damageFlash = 0;
    this.ammo = MAG_SIZE;
    this.reserve = START_RESERVE;
    this.reloading = false;
    this.reloadTimer = 0;
    this.spawnWave();
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
  }

  private disposeMesh(mesh: THREE.Mesh) {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
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

    // Decorative motion runs regardless of state.
    if (this.mascot) {
      this.mascot.rotation.y += dt * 0.8;
      this.mascot.position.y = 2.8 + Math.sin(t * 1.5) * 0.3;
    }

    this.updateFx(dt);

    // Muzzle flash light fades fast after each shot.
    if (this.muzzleLight.intensity > 0) {
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 40);
    }
    // Red "took damage" vignette fades out.
    if (this.damageFlash > 0) {
      this.damageFlash = Math.max(0, this.damageFlash - dt * 2);
      if (this.damageEl) this.damageEl.style.opacity = `${this.damageFlash}`;
    }

    if (this.state === 'playing') {
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

      // Shooting: tap-to-fire (touch) or hold-to-fire (mouse) on a cadence.
      this.fireCooldown -= dt;
      const wantFire = this.input.consumeFire() || (this.input.isFiring() && this.fireCooldown <= 0);
      if (wantFire && this.fireCooldown <= 0) {
        if (this.ammo > 0 && !this.reloading) {
          this.fire();
          this.fireCooldown = FIRE_INTERVAL;
        } else if (!this.reloading) {
          if (this.reserve > 0) this.startReload();
          else {
            this.audio.empty();
            this.fireCooldown = 0.3; // dry-click pause
          }
        }
      }
      this.updateBullets(dt);
      this.updatePickups(dt);

      // Enemies chase; contact hurts the player on a short cooldown.
      for (const enemy of this.enemies) {
        enemy.update(dt, this.player.position, t);
        this.resolveObstacles(enemy.position, enemy.radius);
        if (enemy.position.distanceTo(this.player.position) < enemy.radius + 0.6) {
          this.takeDamage(enemy.damage);
          if (this.state !== 'playing') return;
        }
      }

      // Wave cleared — take a breather, then send in the next one.
      if (this.enemies.length === 0) {
        this.waveBreak -= dt;
        if (this.waveBreak <= 0) this.nextWave();
      }
    }

    this.updateCamera(dt);
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
      this.endGame('lost', `Overrun on wave ${this.wave}. Final score: ${this.score.toLocaleString()}`);
    }
  }

  /** Advance to the next wave, or win if the final wave is cleared. */
  private nextWave() {
    if (this.wave >= MAX_WAVE) {
      this.endGame('won', `You survived all ${MAX_WAVE} waves! Final score: ${this.score.toLocaleString()}`);
      return;
    }
    this.wave++;
    this.health = Math.min(MAX_HEALTH, this.health + 25); // heal a little between waves
    this.reserve += MAG_SIZE; // resupply a magazine each wave
    this.spawnWave();
    this.popStat();
    this.audio.wave();
    this.updateHud();
  }

  /** The direction the camera/player is looking (includes pitch). */
  private lookDir(): THREE.Vector3 {
    const { yaw, pitch } = this.input;
    const cp = Math.cos(pitch);
    return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
  }

  /** Fire a bullet from the eye along the look direction. */
  private fire() {
    const dir = this.lookDir();
    // Some spread from the hip, pinpoint accuracy when aiming down sights.
    if (!this.input.isAiming()) {
      const spread = 0.014;
      dir.x += (Math.random() - 0.5) * spread;
      dir.y += (Math.random() - 0.5) * spread;
      dir.z += (Math.random() - 0.5) * spread;
      dir.normalize();
    }
    this.player.faceDir(dir.x, dir.z);

    const origin = this.camera.position.clone().addScaledVector(dir, 0.6);

    const bullet = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff1a8 })
    );
    bullet.position.copy(origin);
    this.scene.add(bullet);
    this.bullets.push({ mesh: bullet, vel: dir.multiplyScalar(BULLET_SPEED), life: 0 });

    // Recoil kick + muzzle flash on the viewmodel.
    this.gunVM.position.z += 0.06;
    this.muzzleLight.intensity = 6;
    this.ammo--;
    this.audio.shoot();
    this.updateHud();
  }

  /** Begin a reload if it makes sense (mag not full, spare rounds left). */
  private startReload() {
    if (this.reloading || this.ammo >= MAG_SIZE || this.reserve <= 0) return;
    this.reloading = true;
    this.reloadTimer = RELOAD_TIME;
    this.audio.reload();
    this.updateHud();
  }

  private finishReload() {
    const need = MAG_SIZE - this.ammo;
    const take = Math.min(need, this.reserve);
    this.ammo += take;
    this.reserve -= take;
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
        const cp = closestPointOnSegment(enemy.position, prev, b.mesh.position);
        if (cp.distanceTo(enemy.position) < enemy.radius) {
          const headshot = cp.y > enemy.position.y + enemy.radius * 0.4;
          this.onBulletHit(j, headshot);
          hit = true;
          break;
        }
      }

      const p = b.mesh.position;
      const outOfBounds = Math.abs(p.x) > 26 || Math.abs(p.z) > 26;
      if (hit || b.life > BULLET_LIFE || outOfBounds) {
        this.disposeMesh(b.mesh);
        this.bullets.splice(i, 1);
      }
    }
  }

  /** A bullet struck an enemy: damage it, and kill it if its health runs out. */
  private onBulletHit(index: number, headshot: boolean) {
    const enemy = this.enemies[index];
    this.hitMarker(headshot);
    const dmg = headshot ? HEADSHOT_DAMAGE : BULLET_DAMAGE;
    if (enemy.hit(dmg)) {
      this.killEnemy(index, headshot);
    } else {
      // Wounded but alive — small spark of feedback.
      this.spawnBurst(enemy.position, 0xffd27f, 1.4, 0.22);
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
    this.spawnBurst(enemy.position, headshot ? 0xffe066 : 0xff6b3d, 4, 0.5);
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

    if (this.enemies.length === 0) {
      this.waveBreak = WAVE_BREAK;
    }
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
      this.reserve += AMMO_PICKUP;
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

    // Aim-down-sights: ease the FOV toward the zoomed value.
    const targetFov = aiming ? AIM_FOV : HIP_FOV;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 1 - Math.pow(0.0005, dt));
      this.camera.updateProjectionMatrix();
    }

    // Slide the gun toward the centre when aiming, and settle recoil.
    const target = aiming
      ? new THREE.Vector3(0, -0.12, -0.34)
      : new THREE.Vector3(0.2, -0.2, -0.3);
    this.gunVM.position.lerp(target, 1 - Math.pow(0.0001, dt));

    if (this.crosshairEl) this.crosshairEl.classList.toggle('aim', aiming);
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
