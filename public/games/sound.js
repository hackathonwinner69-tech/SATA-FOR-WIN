// Chiptune sound for the cabinets, synthesised live with the Web Audio API:
// no audio files, nothing downloaded. Starts only after the player presses a
// button (browsers require a gesture) and remembers the mute choice.

const MUTE_KEY = 'chorecade.muted';

function loadMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // private windows can refuse storage; the toggle still works for this visit
  }
}

// A minor synthwave progression (Am - F - C - G) as MIDI note numbers.
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function createSound() {
  const Ctx = window.AudioContext ?? window.webkitAudioContext;
  let ac = null;
  let master = null;
  let sfx = null;
  let music = null;
  let muted = loadMuted();
  let musicTimer = null;
  let step = 0;
  let nextTime = 0;

  function ensure() {
    if (!Ctx) return false;
    if (!ac) {
      ac = new Ctx();
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.6;
      master.connect(ac.destination);
      sfx = ac.createGain();
      sfx.gain.value = 0.5;
      sfx.connect(master);
      music = ac.createGain();
      music.gain.value = 0.16;
      music.connect(master);
    }
    if (ac.state === 'suspended') ac.resume();
    return true;
  }

  /** One enveloped oscillator note. */
  function tone({ type = 'square', from, to = from, dur = 0.1, vol = 0.3, at = 0, dest = sfx }) {
    if (!ensure()) return;
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    amp.gain.setValueAtTime(vol, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A burst of filtered noise, for explosions. */
  function noise({ dur = 0.4, vol = 0.5, cutoff = 1800 }) {
    if (!ensure()) return;
    const t = ac.currentTime;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + dur);
    const amp = ac.createGain();
    amp.gain.setValueAtTime(vol, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(amp).connect(sfx);
    src.start(t);
  }

  // Look-ahead scheduler: a sawtooth bass on the beat and a square arpeggio on top.
  function scheduleMusic() {
    const beat = 60 / 112 / 2; // eighth notes at 112 bpm
    while (nextTime < ac.currentTime + 0.2) {
      const chord = CHORDS[Math.floor(step / 16) % CHORDS.length];
      const at = nextTime - ac.currentTime;
      if (step % 2 === 0) tone({ type: 'sawtooth', from: hz(chord[0] - 24), dur: beat * 1.6, vol: 0.5, at, dest: music });
      tone({ type: 'square', from: hz(chord[step % 3] + (step % 8 >= 4 ? 12 : 0)), dur: beat * 0.8, vol: 0.18, at, dest: music });
      if (step % 4 === 2) noiseHat(at);
      nextTime += beat;
      step++;
    }
  }

  function noiseHat(at) {
    const t = ac.currentTime + at;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.04), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const amp = ac.createGain();
    amp.gain.setValueAtTime(0.25, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(hp).connect(amp).connect(music);
    src.start(t);
  }

  return {
    get muted() {
      return muted;
    },
    get available() {
      return Boolean(Ctx);
    },
    setMuted(value) {
      muted = value;
      saveMuted(muted);
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.6, ac.currentTime, 0.02);
    },
    toggle() {
      this.setMuted(!muted);
      return muted;
    },
    startMusic() {
      if (!ensure() || musicTimer) return;
      nextTime = ac.currentTime + 0.05;
      musicTimer = setInterval(scheduleMusic, 50);
    },
    stopMusic() {
      clearInterval(musicTimer);
      musicTimer = null;
    },
    laser(kind = 'archive') {
      const pitch = { archive: 1400, trash: 900, unsubscribe: 1800, keep: 1100 }[kind] ?? 1200;
      tone({ type: 'square', from: pitch, to: pitch / 4, dur: 0.12, vol: 0.18 });
    },
    boom(big = false) {
      noise({ dur: big ? 0.7 : 0.35, vol: big ? 0.6 : 0.4, cutoff: big ? 2400 : 1600 });
      tone({ type: 'triangle', from: big ? 160 : 220, to: 40, dur: big ? 0.5 : 0.25, vol: 0.4 });
    },
    shield() {
      tone({ type: 'triangle', from: 600, to: 1200, dur: 0.15, vol: 0.3 });
      tone({ type: 'triangle', from: 900, to: 1800, dur: 0.15, vol: 0.2, at: 0.08 });
    },
    hurt() {
      tone({ type: 'sawtooth', from: 300, to: 60, dur: 0.4, vol: 0.4 });
      noise({ dur: 0.25, vol: 0.3, cutoff: 900 });
    },
    bomb() {
      noise({ dur: 1.2, vol: 0.7, cutoff: 3000 });
      for (let i = 0; i < 4; i++) tone({ type: 'square', from: 200 + i * 150, to: 50, dur: 0.6, vol: 0.2, at: i * 0.05 });
    },
    escape() {
      tone({ type: 'sine', from: 500, to: 200, dur: 0.3, vol: 0.2 });
    },
    combo(n) {
      tone({ type: 'square', from: hz(72 + Math.min(n, 12)), dur: 0.08, vol: 0.15 });
    },
    win() {
      [72, 76, 79, 84].forEach((m, i) => tone({ type: 'square', from: hz(m), dur: 0.2, vol: 0.25, at: i * 0.12 }));
    },
    close() {
      this.stopMusic();
      ac?.close().catch(() => {});
      ac = null;
    },
  };
}
