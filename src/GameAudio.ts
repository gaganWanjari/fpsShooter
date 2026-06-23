/**
 * Lightweight sound effects synthesized with the Web Audio API.
 * No audio files needed — every sound is generated from oscillators, so it
 * works fully offline. The context is created on first user gesture (Start).
 */
export class GameAudio {
  private ctx: AudioContext;
  private master: GainNode;

  constructor() {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
  }

  /** Browsers start the context suspended until a user gesture occurs. */
  resume() {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Play a single tone with a quick attack/decay envelope. */
  private tone(
    freq: number,
    duration: number,
    type: OscillatorType = 'sine',
    gain = 0.6,
    slideTo?: number
  ) {
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    }

    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env).connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  coin() {
    this.tone(880, 0.08, 'triangle', 0.5);
    this.tone(1320, 0.12, 'triangle', 0.4, 1600);
  }

  jump() {
    this.tone(220, 0.18, 'square', 0.3, 520);
  }

  hit() {
    this.tone(160, 0.3, 'sawtooth', 0.5, 60);
  }

  shoot() {
    this.tone(700, 0.07, 'square', 0.3, 180);
  }

  kill() {
    this.tone(200, 0.22, 'sawtooth', 0.5, 50);
    this.tone(90, 0.3, 'square', 0.3, 40);
  }

  /** Player took damage. */
  hurt() {
    this.tone(180, 0.25, 'sawtooth', 0.55, 70);
    this.tone(110, 0.18, 'square', 0.35, 60);
  }

  /** New wave incoming. */
  wave() {
    const notes = [330, 440, 587];
    notes.forEach((n, i) => {
      setTimeout(() => this.tone(n, 0.18, 'triangle', 0.45), i * 90);
    });
  }

  /** Reloading the magazine. */
  reload() {
    this.tone(140, 0.07, 'square', 0.3, 90);
    setTimeout(() => this.tone(320, 0.08, 'square', 0.3, 200), 220);
  }

  /** Dry click when out of ammo. */
  empty() {
    this.tone(120, 0.05, 'square', 0.25, 80);
  }

  /** Picked up health or ammo. */
  pickup() {
    this.tone(660, 0.08, 'triangle', 0.45);
    this.tone(990, 0.12, 'triangle', 0.4, 1280);
  }

  win() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((n, i) => {
      setTimeout(() => this.tone(n, 0.25, 'triangle', 0.5), i * 120);
    });
  }

  lose() {
    const notes = [392, 311, 233, 175];
    notes.forEach((n, i) => {
      setTimeout(() => this.tone(n, 0.3, 'sawtooth', 0.45), i * 140);
    });
  }
}
