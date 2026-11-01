// Synthesized sound effects (no audio files to load).

const PREF_KEY = 'kaddab_sfx';
let ctx = null;
let master = null;
let noiseBuf = null;
let prefs = { on: true, volume: 0.7 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* private mode */ }

export function getAudioContext() {
    if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = prefs.on ? prefs.volume : 0;
        master.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
}

export function unlockAudio() { getAudioContext(); }

export function getSfxPrefs() { return { ...prefs }; }
export function setSfxPrefs(next) {
    Object.assign(prefs, next);
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
    if (master) master.gain.setTargetAtTime(prefs.on ? prefs.volume : 0, ctx.currentTime, 0.02);
}

function tone({ freq, type = 'sine', start = 0, dur = 0.2, gain = 0.3, attack = 0.005, endFreq, filter }) {
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (filter) {
        const f = ctx.createBiquadFilter();
        f.type = filter.type || 'lowpass';
        f.frequency.value = filter.freq;
        f.Q.value = filter.q || 1;
        osc.connect(f);
        node = f;
    }
    node.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
}

function noise({ start = 0, dur = 0.08, gain = 0.3, type = 'bandpass', freq = 2500, endFreq, q = 1 }) {
    const t = ctx.currentTime + start;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
}

const SOUNDS = {
    tap() { tone({ freq: 1400, dur: 0.04, gain: 0.08 }); },
    select() { noise({ dur: 0.05, gain: 0.18, freq: 3200, q: 0.8 }); tone({ freq: 900, dur: 0.05, gain: 0.05 }); },
    deselect() { noise({ dur: 0.04, gain: 0.12, freq: 2000, q: 0.8 }); },
    play() {
        noise({ dur: 0.09, gain: 0.45, freq: 1800, q: 0.6 });
        tone({ freq: 160, endFreq: 70, dur: 0.14, gain: 0.35 });
    },
    deal() {
        for (let i = 0; i < 8; i++) noise({ start: i * 0.06, dur: 0.05, gain: 0.22, freq: 2600 + Math.random() * 800, q: 0.7 });
    },
    turn() {
        tone({ freq: 659, dur: 0.5, gain: 0.18, type: 'triangle' });
        tone({ freq: 988, start: 0.12, dur: 0.7, gain: 0.16, type: 'triangle' });
        tone({ freq: 1976, start: 0.12, dur: 0.4, gain: 0.03 });
    },
    pass() { noise({ dur: 0.45, gain: 0.3, freq: 300, endFreq: 2400, q: 2 }); },
    bluff() {
        [0, 0.16, 0.32].forEach((s, i) => {
            tone({ freq: i % 2 ? 620 : 880, start: s, dur: 0.14, gain: 0.2, type: 'sawtooth', filter: { freq: 2400 } });
        });
        tone({ freq: 90, endFreq: 50, dur: 0.35, gain: 0.4 });
    },
    caught() {
        [392, 370, 349].forEach((f, i) => tone({ freq: f, start: i * 0.22, dur: 0.22, gain: 0.2, type: 'sawtooth', filter: { freq: 900, q: 4 } }));
        tone({ freq: 330, endFreq: 260, start: 0.66, dur: 0.6, gain: 0.22, type: 'sawtooth', filter: { freq: 700, q: 4 } });
    },
    honest() {
        [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, start: i * 0.07, dur: 0.35, gain: 0.14, type: 'triangle' }));
    },
    flip() { noise({ dur: 0.06, gain: 0.2, freq: 4000, q: 1.2 }); },
    win() {
        [523, 659, 784].forEach((f, i) => tone({ freq: f, start: i * 0.13, dur: 0.25, gain: 0.16, type: 'square', filter: { freq: 2500 } }));
        [523, 659, 784, 1047].forEach(f => tone({ freq: f, start: 0.42, dur: 1.2, gain: 0.1, type: 'triangle' }));
    },
    error() { tone({ freq: 180, dur: 0.18, gain: 0.18, type: 'square', filter: { freq: 800 } }); },
    join() { tone({ freq: 660, dur: 0.1, gain: 0.12 }); tone({ freq: 990, start: 0.08, dur: 0.14, gain: 0.12 }); },
    leave() { tone({ freq: 660, dur: 0.1, gain: 0.12 }); tone({ freq: 440, start: 0.08, dur: 0.16, gain: 0.12 }); },
};

export function sfx(name) {
    if (!prefs.on || !getAudioContext()) return;
    try { SOUNDS[name]?.(); } catch (e) { /* audio errors are never fatal */ }
}

export function vibrate(pattern) {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    try { navigator.vibrate?.(pattern); } catch (e) { /* unsupported */ }
}
