/**
 * First-person input: keyboard movement, pointer-lock mouse look, click to
 * shoot, right-click to aim — plus on-screen joystick / buttons for touch.
 */
export class Input {
  private keys = new Set<string>();

  /** Horizontal look angle (radians). */
  public yaw = 0;
  /** Vertical look angle (radians); 0 = level, clamped to avoid flipping. */
  public pitch = 0;

  // Pointer lock (desktop FPS look).
  private locked = false;
  private firing = false; // left button held
  private aiming = false; // right button held

  // Touch look-drag state (used only when not pointer-locked).
  private dragging = false;
  private dragId = -1;
  private lastX = 0;
  private lastY = 0;

  // Tap-to-fire (touch): a short, near-stationary press.
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  private fireQueued = false;
  private touchAim = false;

  // Virtual joystick state.
  private joyId = -1;
  private joyVec = { x: 0, y: 0 };
  private joyRadius = 55;
  private joystick?: HTMLElement;
  private stick?: HTMLElement;

  // Touch jump latch.
  private touchJump = false;
  private touchReload = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    // Pointer lock + mouse look.
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch / non-locked drag look.
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);

    this.setupTouchControls();
  }

  /** Engage pointer lock for free mouse look (no-op on touch devices). */
  requestLock() {
    this.canvas.requestPointerLock?.();
  }

  private setupTouchControls() {
    this.joystick = document.getElementById('joystick') ?? undefined;
    this.stick = document.getElementById('stick') ?? undefined;
    const jumpBtn = document.getElementById('jumpBtn');
    const aimBtn = document.getElementById('aimBtn');
    const reloadBtn = document.getElementById('reloadBtn');

    if (this.joystick) {
      this.joystick.addEventListener('pointerdown', this.onJoyStart);
      window.addEventListener('pointermove', this.onJoyMove);
      window.addEventListener('pointerup', this.onJoyEnd);
    }

    if (jumpBtn) {
      jumpBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchJump = true;
      });
    }

    if (aimBtn) {
      aimBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchAim = true;
      });
      aimBtn.addEventListener('pointerup', () => (this.touchAim = false));
      aimBtn.addEventListener('pointercancel', () => (this.touchAim = false));
    }

    if (reloadBtn) {
      reloadBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchReload = true;
      });
    }
  }

  // --- Keyboard ---------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent) => this.keys.add(e.code);
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  // --- Pointer lock mouse look ------------------------------------------

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.firing = false;
      this.aiming = false;
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    const sens = this.aiming ? 0.0011 : 0.0022;
    this.yaw -= e.movementX * sens;
    this.pitch = clamp(this.pitch - e.movementY * sens, -1.35, 1.35);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (!this.locked) {
      this.requestLock();
      return;
    }
    if (e.button === 0) this.firing = true;
    else if (e.button === 2) this.aiming = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.firing = false;
    else if (e.button === 2) this.aiming = false;
  };

  // --- Touch / non-locked drag look -------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    if (this.locked) return;
    this.dragging = true;
    this.dragId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downTime = performance.now();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.locked || e.pointerId !== this.dragId) return;
    this.dragging = false;
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    if (moved < 8 && performance.now() - this.downTime < 300) {
      this.fireQueued = true;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.locked || !this.dragging || e.pointerId !== this.dragId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    this.yaw -= dx * 0.005;
    this.pitch = clamp(this.pitch - dy * 0.005, -1.35, 1.35);
  };

  // --- Virtual joystick -------------------------------------------------

  private onJoyStart = (e: PointerEvent) => {
    e.preventDefault();
    this.joyId = e.pointerId;
    this.updateJoy(e);
  };

  private onJoyMove = (e: PointerEvent) => {
    if (e.pointerId !== this.joyId) return;
    this.updateJoy(e);
  };

  private onJoyEnd = (e: PointerEvent) => {
    if (e.pointerId !== this.joyId) return;
    this.joyId = -1;
    this.joyVec.x = 0;
    this.joyVec.y = 0;
    if (this.stick) this.stick.style.transform = 'translate(-50%, -50%)';
  };

  private updateJoy(e: PointerEvent) {
    if (!this.joystick) return;
    const rect = this.joystick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;

    const dist = Math.hypot(dx, dy);
    if (dist > this.joyRadius) {
      dx = (dx / dist) * this.joyRadius;
      dy = (dy / dist) * this.joyRadius;
    }

    this.joyVec.x = dx / this.joyRadius;
    this.joyVec.y = -dy / this.joyRadius; // screen-down is +y; forward is -y

    if (this.stick) {
      this.stick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }
  }

  // --- Public API -------------------------------------------------------

  /** Combined movement intent from keyboard + joystick, length clamped to 1. */
  getMoveAxis(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;

    x += this.joyVec.x;
    y += this.joyVec.y;

    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  /** Returns true once per jump press (keyboard Space or touch button). */
  consumeJump(): boolean {
    if (this.keys.has('Space')) {
      this.keys.delete('Space');
      return true;
    }
    if (this.touchJump) {
      this.touchJump = false;
      return true;
    }
    return false;
  }

  /** Returns true once when a touch tap requests a shot. */
  consumeFire(): boolean {
    if (this.fireQueued) {
      this.fireQueued = false;
      return true;
    }
    return false;
  }

  /** True while the fire button is held (desktop auto-fire). */
  isFiring(): boolean {
    return this.firing;
  }

  /** True while aiming down sights (right mouse or touch aim button). */
  isAiming(): boolean {
    return this.aiming || this.touchAim;
  }

  /** Returns true once when the player requests a reload (R or touch button). */
  consumeReload(): boolean {
    if (this.keys.has('KeyR')) {
      this.keys.delete('KeyR');
      return true;
    }
    if (this.touchReload) {
      this.touchReload = false;
      return true;
    }
    return false;
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointermove', this.onJoyMove);
    window.removeEventListener('pointerup', this.onJoyEnd);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
