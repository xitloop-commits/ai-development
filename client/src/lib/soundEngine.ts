/**
 * Sound Engine — Web Audio API-based alert sounds.
 * Generates programmatic tones for different alert types.
 * No external audio files required.
 */

type AlertSoundType = 'go_signal' | 'stop_loss' | 'target_profit' | 'module_down' | 'new_signal' | 'position_change';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  // Resume if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Unlock the audio context on first user interaction.
 * Call this once from a click handler or similar.
 */
export function unlockAudio(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    // Create a silent buffer to fully unlock
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Silently fail if audio is not available
  }
}

/**
 * Play a single tone at a given frequency and duration.
 */
function playTone(
  ctx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  volume: number,
  type: OscillatorType = 'sine',
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);

  // Envelope: quick attack, sustain, quick release
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.setValueAtTime(volume, startTime + duration - 0.05);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

/**
 * GO Signal — Rising triple-beep (ascending pitch, ~1.5s)
 * Conveys urgency and positive action.
 */
function playGoSignal(volume: number): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const v = volume * 0.35;

  playTone(ctx, 880, now, 0.15, v, 'sine');
  playTone(ctx, 1100, now + 0.2, 0.15, v, 'sine');
  playTone(ctx, 1320, now + 0.4, 0.15, v, 'sine');
  // Final sustained note
  playTone(ctx, 1320, now + 0.65, 0.4, v * 0.7, 'sine');
}

/**
 * Stop Loss Hit — Descending alarm tone (~2s)
 * Conveys danger / loss.
 */
function playStopLoss(volume: number): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const v = volume * 0.4;

  playTone(ctx, 880, now, 0.25, v, 'sawtooth');
  playTone(ctx, 660, now + 0.3, 0.25, v, 'sawtooth');
  playTone(ctx, 440, now + 0.6, 0.25, v, 'sawtooth');
  playTone(ctx, 330, now + 0.9, 0.6, v * 0.6, 'sawtooth');
}

/**
 * Target Profit Hit — Pleasant ascending chime (~1s)
 * Conveys success / profit.
 */
function playTargetProfit(volume: number): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const v = volume * 0.3;

  playTone(ctx, 523, now, 0.12, v, 'sine');       // C5
  playTone(ctx, 659, now + 0.12, 0.12, v, 'sine'); // E5
  playTone(ctx, 784, now + 0.24, 0.12, v, 'sine'); // G5
  playTone(ctx, 1047, now + 0.36, 0.5, v * 0.6, 'sine'); // C6 sustained
}

/**
 * Module Down — Low warning pulse (~1.5s)
 * Conveys system health issue.
 */
function playModuleDown(volume: number): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const v = volume * 0.3;

  playTone(ctx, 220, now, 0.3, v, 'square');
  playTone(ctx, 220, now + 0.5, 0.3, v, 'square');
  playTone(ctx, 165, now + 1.0, 0.4, v * 0.5, 'square');
}

/**
 * New Signal — Short single beep (~0.3s)
 * Subtle notification.
 */
function playNewSignal(volume: number): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const v = volume * 0.2;

  playTone(ctx, 1000, now, 0.08, v, 'sine');
  playTone(ctx, 1200, now + 0.1, 0.12, v * 0.7, 'sine');
}

/**
 * Position Change — Double-tap beep (~0.5s)
 */
function playPositionChange(volume: number): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const v = volume * 0.25;

  playTone(ctx, 800, now, 0.1, v, 'sine');
  playTone(ctx, 1000, now + 0.15, 0.1, v, 'sine');
}

/**
 * Play an alert sound by type.
 * @param type - The alert type
 * @param volume - Volume from 0 to 1 (will be scaled internally)
 */
export function playAlertSound(type: AlertSoundType, volume: number = 0.7): void {
  try {
    const clampedVolume = Math.max(0, Math.min(1, volume));

    switch (type) {
      case 'go_signal':
        playGoSignal(clampedVolume);
        break;
      case 'stop_loss':
        playStopLoss(clampedVolume);
        break;
      case 'target_profit':
        playTargetProfit(clampedVolume);
        break;
      case 'module_down':
        playModuleDown(clampedVolume);
        break;
      case 'new_signal':
        playNewSignal(clampedVolume);
        break;
      case 'position_change':
        playPositionChange(clampedVolume);
        break;
    }
  } catch {
    // Silently fail — audio is a nice-to-have
  }
}

export type { AlertSoundType };
