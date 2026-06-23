import * as THREE from 'three';

const ARENA_LIMIT = 24;
const WHITE = new THREE.Color(1, 1, 1);

export type EnemyType = 'grunt' | 'runner' | 'brute';

interface TypeDef {
  hp: number;
  speed: number;
  size: number;
  color: number;
  emissive: number;
  damage: number;
  points: number;
}

const TYPES: Record<EnemyType, TypeDef> = {
  // Standard foe.
  grunt: { hp: 1, speed: 2.4, size: 0.7, color: 0xb5179e, emissive: 0x7a0033, damage: 12, points: 100 },
  // Small and fast — rushes you down.
  runner: { hp: 1, speed: 4.0, size: 0.5, color: 0xffd23f, emissive: 0x7a5a00, damage: 8, points: 150 },
  // Big tank that soaks several hits and hits hard.
  brute: { hp: 3, speed: 1.5, size: 1.05, color: 0xd00000, emissive: 0x4a0000, damage: 24, points: 250 },
};

/**
 * A roaming enemy that homes in on the player. Comes in three flavours
 * (grunt / runner / brute) with different speed, size, health and damage.
 */
export class Enemy {
  readonly mesh: THREE.Mesh;
  readonly type: EnemyType;
  readonly damage: number;
  readonly points: number;
  private speed: number;
  private hp: number;
  private bobOffset: number;
  private hurtFlash = 0;
  private mat: THREE.MeshStandardMaterial;

  constructor(position: THREE.Vector3, type: EnemyType, speedBoost = 0) {
    const def = TYPES[type];
    this.type = type;
    this.damage = def.damage;
    this.points = def.points;
    this.speed = def.speed + speedBoost;
    this.hp = def.hp;

    const geometry = new THREE.OctahedronGeometry(def.size, 0);
    this.mat = new THREE.MeshStandardMaterial({
      color: def.color,
      emissive: def.emissive,
      emissiveIntensity: 0.7,
      metalness: 0.4,
      roughness: 0.3,
      flatShading: true,
    });
    this.mesh = new THREE.Mesh(geometry, this.mat);
    this.mesh.castShadow = true;
    this.mesh.position.copy(position);
    this.bobOffset = Math.random() * Math.PI * 2;
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  /** Collision radius used for bullet hits and player contact. */
  get radius(): number {
    return TYPES[this.type].size + 0.2;
  }

  /** Apply damage; returns true if this killed the enemy. */
  hit(amount: number): boolean {
    this.hp -= amount;
    this.hurtFlash = 1;
    return this.hp <= 0;
  }

  update(dt: number, target: THREE.Vector3, time: number) {
    const dir = new THREE.Vector3(
      target.x - this.mesh.position.x,
      0,
      target.z - this.mesh.position.z
    );
    if (dir.lengthSq() > 0.0001) {
      dir.normalize().multiplyScalar(this.speed * dt);
      this.mesh.position.x += dir.x;
      this.mesh.position.z += dir.z;
    }

    // Hover + spin so it reads as alive and threatening.
    const base = TYPES[this.type].size + 0.2;
    this.mesh.position.y = base + Math.sin(time * 2 + this.bobOffset) * 0.15;
    this.mesh.rotation.y += dt * 1.5;
    this.mesh.rotation.x += dt * 0.8;

    this.mesh.position.x = THREE.MathUtils.clamp(this.mesh.position.x, -ARENA_LIMIT, ARENA_LIMIT);
    this.mesh.position.z = THREE.MathUtils.clamp(this.mesh.position.z, -ARENA_LIMIT, ARENA_LIMIT);

    // Flash white briefly when hit.
    if (this.hurtFlash > 0) {
      this.hurtFlash = Math.max(0, this.hurtFlash - dt * 5);
      this.mat.emissive.set(TYPES[this.type].emissive).lerp(WHITE, this.hurtFlash);
    }
  }
}
