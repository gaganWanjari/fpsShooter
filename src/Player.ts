import * as THREE from 'three';
import { Input } from './Input';

const MOVE_SPEED = 6;
const JUMP_VELOCITY = 9;
const GRAVITY = -22;
const GROUND_Y = 0.9; // body centre height when standing on the floor

/**
 * Player-controlled humanoid built from primitives. Walks with swinging arms
 * and legs, turns to face its movement direction, and jumps. Physics act on the
 * body centre (`mesh.position`); the parts are offset so the feet meet the floor.
 */
export class Player {
  readonly mesh: THREE.Group;
  private velocity = new THREE.Vector3();
  private onGround = true;

  private leftLeg: THREE.Group;
  private rightLeg: THREE.Group;
  private leftArm: THREE.Group;
  private rightArm: THREE.Group;
  private walkPhase = 0;
  private facing = 0;

  constructor() {
    this.mesh = new THREE.Group();
    this.mesh.position.set(0, GROUND_Y, 0);

    const skin = new THREE.MeshStandardMaterial({ color: 0xffcc99, roughness: 0.6 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0x4cc9f0, roughness: 0.5, metalness: 0.1 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2a3a6b, roughness: 0.7 });

    // Torso.
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), shirt);
    torso.position.y = 0.25;
    this.mesh.add(torso);

    // Head.
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 24), skin);
    head.position.y = 0.85;
    this.mesh.add(head);

    // Limbs are built as pivot groups so they can swing from the hip/shoulder.
    this.leftLeg = this.makeLimb(0.18, 0.8, pants, -0.13, -0.1);
    this.rightLeg = this.makeLimb(0.18, 0.8, pants, 0.13, -0.1);
    this.leftArm = this.makeLimb(0.15, 0.65, shirt, -0.36, 0.55);
    this.rightArm = this.makeLimb(0.15, 0.65, shirt, 0.36, 0.55);

    // Gun, attached to the body so it always points along the facing (+z).
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x21262e, roughness: 0.45, metalness: 0.6 });
    const gun = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.6), gunMat);
    barrel.position.z = 0.3;
    gun.add(barrel);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.24, 0.12), gunMat);
    grip.position.set(0, -0.15, 0.05);
    gun.add(grip);
    gun.position.set(0.32, 0.28, 0.18);
    this.mesh.add(gun);

    this.mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
  }

  /**
   * A limb that hangs from a pivot point. The mesh is offset downward so the
   * pivot sits at the hip/shoulder, letting `pivot.rotation.x` swing it.
   */
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

  /** Instantly turn to face a horizontal direction (used when shooting). */
  faceDir(x: number, z: number) {
    this.facing = Math.atan2(x, z);
    this.mesh.rotation.y = this.facing;
  }

  update(dt: number, input: Input): boolean {
    // Build a movement vector from the input axis, relative to camera yaw.
    const axis = input.getMoveAxis();
    const forward = new THREE.Vector3(Math.sin(input.yaw), 0, Math.cos(input.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    const move = new THREE.Vector3();
    move.addScaledVector(forward, -axis.y);
    move.addScaledVector(right, axis.x);
    move.multiplyScalar(MOVE_SPEED);

    const planarSpeed = Math.hypot(move.x, move.z);
    this.animate(dt, move, planarSpeed);

    // Jump.
    let jumped = false;
    if (this.onGround && input.consumeJump()) {
      this.velocity.y = JUMP_VELOCITY;
      this.onGround = false;
      jumped = true;
    }

    // Apply gravity + integrate.
    this.velocity.y += GRAVITY * dt;
    this.mesh.position.x += move.x * dt;
    this.mesh.position.z += move.z * dt;
    this.mesh.position.y += this.velocity.y * dt;

    // Floor collision.
    if (this.mesh.position.y <= GROUND_Y) {
      this.mesh.position.y = GROUND_Y;
      this.velocity.y = 0;
      this.onGround = true;
    }

    // Keep the player inside the arena.
    const limit = 24;
    this.mesh.position.x = THREE.MathUtils.clamp(this.mesh.position.x, -limit, limit);
    this.mesh.position.z = THREE.MathUtils.clamp(this.mesh.position.z, -limit, limit);

    return jumped;
  }

  /** Walk cycle, turning to face travel direction, and an airborne pose. */
  private animate(dt: number, move: THREE.Vector3, planarSpeed: number) {
    // Always turn to face the direction of travel while moving.
    if (planarSpeed > 0.1) {
      const targetYaw = Math.atan2(move.x, move.z);
      this.facing = lerpAngle(this.facing, targetYaw, 1 - Math.pow(0.0001, dt));
      this.mesh.rotation.y = this.facing;
    }

    if (!this.onGround) {
      // Tuck the legs and raise the arms a little while in the air.
      this.poseTowards(this.leftLeg, -0.5, dt);
      this.poseTowards(this.rightLeg, -0.5, dt);
      this.poseTowards(this.leftArm, -1.0, dt);
      this.poseTowards(this.rightArm, -1.0, dt);
      return;
    }

    if (planarSpeed > 0.1) {
      this.walkPhase += dt * (planarSpeed * 1.6 + 2);
      const swing = Math.sin(this.walkPhase) * 0.6;
      this.leftLeg.rotation.x = swing;
      this.rightLeg.rotation.x = -swing;
      this.leftArm.rotation.x = -swing;
      this.rightArm.rotation.x = swing;
    } else {
      // Ease all limbs back to a neutral standing pose.
      this.poseTowards(this.leftLeg, 0, dt);
      this.poseTowards(this.rightLeg, 0, dt);
      this.poseTowards(this.leftArm, 0, dt);
      this.poseTowards(this.rightArm, 0, dt);
    }
  }

  private poseTowards(limb: THREE.Group, target: number, dt: number) {
    limb.rotation.x = THREE.MathUtils.lerp(limb.rotation.x, target, 1 - Math.pow(0.001, dt));
  }

  reset() {
    this.mesh.position.set(0, GROUND_Y, 0);
    this.velocity.set(0, 0, 0);
    this.onGround = true;
    this.facing = 0;
    this.mesh.rotation.y = 0;
  }
}

/** Lerp between two angles taking the shortest way around the circle. */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
