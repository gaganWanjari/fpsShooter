import * as THREE from 'three';

const WHITE = new THREE.Color(1, 1, 1);

export type EnemyType = 'guard' | 'patrol' | 'heavy';

interface TypeDef {
  hp: number;
  walkSpeed: number; // unalerted patrol speed
  chaseSpeed: number; // alerted pursuit speed
  size: number; // body scale
  damage: number; // melee contact damage
  shotDamage: number; // ranged shot damage
  fireInterval: number; // seconds between shots when engaging
  range: number; // how far it can shoot
  points: number;
  jacket: number; // torso colour
  pants: number;
}

const TYPES: Record<EnemyType, TypeDef> = {
  // Standard camp rifleman.
  guard: {
    hp: 2, walkSpeed: 1.5, chaseSpeed: 3.6, size: 1, damage: 10, shotDamage: 7,
    fireInterval: 1.6, range: 24, points: 100, jacket: 0x4d5d3a, pants: 0x3a4a2c,
  },
  // Lighter, faster scout that flanks.
  patrol: {
    hp: 1, walkSpeed: 2.3, chaseSpeed: 4.6, size: 0.92, damage: 7, shotDamage: 5,
    fireInterval: 1.3, range: 20, points: 130, jacket: 0x6b6b3a, pants: 0x4a4a28,
  },
  // Tanky heavy gunner that soaks several hits.
  heavy: {
    hp: 5, walkSpeed: 1.0, chaseSpeed: 2.2, size: 1.18, damage: 20, shotDamage: 11,
    fireInterval: 2.1, range: 18, points: 250, jacket: 0x5a3a2a, pants: 0x3a261c,
  },
};

export interface EnemyOptions {
  /** World-space waypoints the guard walks between while unalerted. */
  patrol?: THREE.Vector3[];
  /** Direction (radians) the guard faces while standing still. */
  facing?: number;
  /** A fixed shooter (e.g. a watchtower sentry) that never leaves its post. */
  stationary?: boolean;
}

/**
 * A camp guard soldier built from primitives. While unaware it patrols a route
 * (or stands watch); once alerted it hunts the player, fires tracer shots and
 * closes for a melee hit. Sniper kills are silent — a loud rifle is what raises
 * the alarm across the camp.
 */
export class Enemy {
  readonly mesh: THREE.Group;
  readonly type: EnemyType;
  readonly damage: number;
  readonly points: number;

  private def: TypeDef;
  private hp: number;
  private alerted = false;
  private bobOffset: number;
  private hurtFlash = 0;
  private walkPhase = 0;
  private facing: number;
  private fireCd: number;
  private alertGlow = 0;

  private patrol: THREE.Vector3[];
  private patrolIdx = 0;
  private idleScan: number;
  private baseY: number;
  private stationary: boolean;

  private torsoMat: THREE.MeshStandardMaterial;
  private leftLeg: THREE.Group;
  private rightLeg: THREE.Group;
  private head: THREE.Mesh;
  private alertMark: THREE.Sprite;

  constructor(position: THREE.Vector3, type: EnemyType, opts: EnemyOptions = {}) {
    const def = TYPES[type];
    this.def = def;
    this.type = type;
    this.damage = def.damage;
    this.points = def.points;
    this.hp = def.hp;
    this.facing = opts.facing ?? Math.random() * Math.PI * 2;
    this.patrol = opts.patrol ?? [];
    this.fireCd = def.fireInterval * (0.5 + Math.random());
    this.bobOffset = Math.random() * Math.PI * 2;
    this.idleScan = Math.random() * Math.PI * 2;
    this.baseY = position.y;
    this.stationary = opts.stationary ?? false;

    this.mesh = new THREE.Group();
    this.mesh.position.copy(position);
    this.mesh.rotation.y = this.facing;

    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a679, roughness: 0.7 });
    this.torsoMat = new THREE.MeshStandardMaterial({ color: def.jacket, roughness: 0.85 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: def.pants, roughness: 0.9 });
    const gearMat = new THREE.MeshStandardMaterial({ color: 0x222018, roughness: 0.6, metalness: 0.3 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0x3b4a2e, roughness: 0.7, metalness: 0.2 });

    const s = def.size;

    // Torso + chest webbing.
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52 * s, 0.72 * s, 0.32 * s), this.torsoMat);
    torso.position.y = 0.95 * s;
    this.mesh.add(torso);
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.5 * s, 0.4 * s, 0.34 * s), gearMat);
    vest.position.y = 1.0 * s;
    this.mesh.add(vest);

    // Head + helmet.
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.21 * s, 18, 18), skin);
    this.head.position.y = 1.5 * s;
    this.mesh.add(this.head);
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.24 * s, 18, 12, 0, Math.PI * 2, 0, Math.PI / 1.7),
      helmetMat
    );
    helmet.position.y = 1.54 * s;
    this.mesh.add(helmet);

    // Legs (swing while walking).
    this.leftLeg = this.makeLimb(0.18 * s, 0.7 * s, pantsMat, -0.14 * s, 0.6 * s);
    this.rightLeg = this.makeLimb(0.18 * s, 0.7 * s, pantsMat, 0.14 * s, 0.6 * s);

    // Static arms + a slung rifle pointing forward (+z).
    const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.15 * s, 0.6 * s, 0.15 * s), this.torsoMat);
    lArm.position.set(-0.36 * s, 0.95 * s, 0.06 * s);
    lArm.rotation.x = -0.5;
    this.mesh.add(lArm);
    const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.15 * s, 0.6 * s, 0.15 * s), this.torsoMat);
    rArm.position.set(0.36 * s, 0.95 * s, 0.06 * s);
    rArm.rotation.x = -0.5;
    this.mesh.add(rArm);

    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.07 * s, 0.07 * s, 0.7 * s), gearMat);
    rifle.position.set(0.3 * s, 0.92 * s, 0.32 * s);
    this.mesh.add(rifle);

    // A "!" alert sprite that pops above the head when the guard spots you.
    this.alertMark = makeAlertSprite();
    this.alertMark.position.y = 1.95 * s;
    this.alertMark.scale.setScalar(0);
    this.mesh.add(this.alertMark);

    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
  }

  private makeLimb(width: number, length: number, mat: THREE.Material, x: number, y: number): THREE.Group {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, width), mat);
    mesh.position.y = -length / 2;
    pivot.add(mesh);
    this.mesh.add(pivot);
    return pivot;
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  get radius(): number {
    return this.def.size * 0.45 + 0.2;
  }

  /** Centre of mass (used so bullets aim at the body, not the feet). */
  get center(): THREE.Vector3 {
    return this.mesh.position.clone().setY(this.mesh.position.y + this.def.size * 0.95);
  }

  /** Head height for headshot tests. */
  get headY(): number {
    return this.mesh.position.y + this.def.size * 1.5;
  }

  get isAlerted(): boolean {
    return this.alerted;
  }

  get sightRange(): number {
    return this.def.range;
  }

  /** Which way the guard is currently looking (for vision cone tests). */
  get facingDir(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  /** Raise the alarm — the guard now hunts the player. */
  alert() {
    if (this.alerted) return;
    this.alerted = true;
    this.alertGlow = 1;
  }

  /** Apply damage; returns true if this killed the guard. */
  hit(amount: number): boolean {
    this.hp -= amount;
    this.hurtFlash = 1;
    return this.hp <= 0;
  }

  /**
   * Ask whether the guard fires this frame. Returns the shot damage if it does
   * (only when alerted, on cooldown and in range), else 0.
   */
  tryFire(dt: number, playerPos: THREE.Vector3): number {
    if (!this.alerted) return 0;
    this.fireCd -= dt;
    const dist = this.position.distanceTo(playerPos);
    if (this.fireCd <= 0 && dist < this.def.range) {
      this.fireCd = this.def.fireInterval;
      return this.def.shotDamage;
    }
    return 0;
  }

  update(dt: number, playerPos: THREE.Vector3, time: number) {
    let moveLen = 0;

    if (this.alerted) {
      // Hunt: face the player; close the distance unless we're a fixed sentry.
      const dir = new THREE.Vector3(playerPos.x - this.position.x, 0, playerPos.z - this.position.z);
      const dist = dir.length();
      this.facing = Math.atan2(dir.x, dir.z);
      if (!this.stationary && dist > 6) {
        dir.normalize().multiplyScalar(this.def.chaseSpeed * dt);
        this.mesh.position.x += dir.x;
        this.mesh.position.z += dir.z;
        moveLen = this.def.chaseSpeed;
      }
    } else if (!this.stationary && this.patrol.length > 0) {
      // Patrol: walk toward the current waypoint, then advance to the next.
      const target = this.patrol[this.patrolIdx];
      const dir = new THREE.Vector3(target.x - this.position.x, 0, target.z - this.position.z);
      const dist = dir.length();
      if (dist < 0.6) {
        this.patrolIdx = (this.patrolIdx + 1) % this.patrol.length;
      } else {
        this.facing = Math.atan2(dir.x, dir.z);
        dir.normalize().multiplyScalar(this.def.walkSpeed * dt);
        this.mesh.position.x += dir.x;
        this.mesh.position.z += dir.z;
        moveLen = this.def.walkSpeed;
      }
    } else {
      // Sentry: slowly sweep the gaze back and forth.
      this.idleScan += dt * 0.6;
      this.facing += Math.sin(this.idleScan) * dt * 0.5;
    }

    this.mesh.rotation.y = this.facing;

    // Walk cycle for the legs.
    if (moveLen > 0.05) {
      this.walkPhase += dt * (moveLen * 1.8 + 3);
      const swing = Math.sin(this.walkPhase) * 0.6;
      this.leftLeg.rotation.x = swing;
      this.rightLeg.rotation.x = -swing;
    } else {
      this.leftLeg.rotation.x = THREE.MathUtils.lerp(this.leftLeg.rotation.x, 0, 1 - Math.pow(0.001, dt));
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, 0, 1 - Math.pow(0.001, dt));
    }

    // Subtle breathing bob around the post height (towers sit elevated).
    this.mesh.position.y = this.baseY + Math.sin(time * 2 + this.bobOffset) * 0.02;

    // Alert "!" sprite grows then settles while engaged.
    if (this.alerted) {
      const target = 0.6;
      const pop = this.alertGlow > 0 ? 1 + this.alertGlow * 0.6 : 1;
      this.alertMark.scale.setScalar(THREE.MathUtils.lerp(this.alertMark.scale.x, target * pop, 1 - Math.pow(0.001, dt)));
      if (this.alertGlow > 0) this.alertGlow = Math.max(0, this.alertGlow - dt * 2);
    }

    // Flash white when shot.
    if (this.hurtFlash > 0) {
      this.hurtFlash = Math.max(0, this.hurtFlash - dt * 5);
      this.torsoMat.color.set(this.def.jacket);
      this.torsoMat.color.lerp(WHITE, this.hurtFlash);
    }
  }
}

/** A small floating red "!" so you can see which guards are aware of you. */
function makeAlertSprite(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ff3b3b';
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;
  ctx.fillText('!', 32, 34);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(0.6);
  return sprite;
}
