// Mesh voice chat over PeerJS media calls.
// Every player always has a call open with every other player; the outgoing
// stream is a WebAudio destination so toggling the mic never renegotiates.

import { getAudioContext } from './sound.js';

let peer = null;
let outDest = null;
let micStream = null;
let micSource = null;
let micGain = null;
let deafened = false;
const calls = {};      // peerId -> MediaConnection
const meters = {};     // peerId -> { analyser, data }
let localMeter = null;
let speakingCb = () => {};
let meterTimer = null;

export function initVoice(p, onSpeaking) {
    peer = p;
    speakingCb = onSpeaking || speakingCb;
    const ctx = getAudioContext();
    if (!ctx) return;
    outDest = ctx.createMediaStreamDestination();
    peer.on('call', call => {
        call.answer(outDest.stream);
        attachCall(call);
    });
    if (!meterTimer) meterTimer = setInterval(pollMeters, 120);
}

function attachCall(call) {
    const old = calls[call.peer];
    if (old && old !== call) old.close();
    calls[call.peer] = call;
    call.on('stream', remote => {
        let el = document.getElementById('audio-' + call.peer);
        if (!el) {
            el = document.createElement('audio');
            el.id = 'audio-' + call.peer;
            el.autoplay = true;
            el.playsInline = true;
            document.body.appendChild(el);
        }
        el.srcObject = remote;
        el.muted = deafened;
        el.play?.().catch(() => {});
        const ctx = getAudioContext();
        if (ctx && remote.getAudioTracks().length) {
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            ctx.createMediaStreamSource(remote).connect(analyser);
            meters[call.peer] = { analyser, data: new Uint8Array(analyser.fftSize) };
        }
    });
    const cleanup = () => {
        if (calls[call.peer] !== call) return;
        delete calls[call.peer];
        delete meters[call.peer];
        document.getElementById('audio-' + call.peer)?.remove();
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
}

// Keep calls in line with the current roster of peer IDs.
export function syncVoicePeers(peerIds) {
    if (!peer || !outDest || !peer.id) return;
    const wanted = new Set(peerIds.filter(id => id && id !== peer.id));
    Object.keys(calls).forEach(id => { if (!wanted.has(id)) calls[id].close(); });
    wanted.forEach(id => {
        // Only one side dials, so each pair gets exactly one call.
        if (!calls[id] && peer.id > id) {
            const call = peer.call(id, outDest.stream);
            if (call) attachCall(call);
        }
    });
}

export function isMicOn() { return !!micStream; }

export async function setMic(on) {
    const ctx = getAudioContext();
    if (!ctx || !outDest) throw new Error('no-audio');
    if (on && !micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        micSource = ctx.createMediaStreamSource(micStream);
        micGain = ctx.createGain();
        micSource.connect(micGain);
        micGain.connect(outDest);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        micSource.connect(analyser);
        localMeter = { analyser, data: new Uint8Array(analyser.fftSize) };
    } else if (!on && micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micGain?.disconnect();
        micSource?.disconnect();
        micStream = micSource = micGain = localMeter = null;
    }
    return !!micStream;
}

export function isDeafened() { return deafened; }
export function setDeafened(v) {
    deafened = v;
    document.querySelectorAll('audio[id^="audio-"]').forEach(el => { el.muted = v; });
}

function level(meter) {
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (let i = 0; i < meter.data.length; i++) {
        const v = (meter.data[i] - 128) / 128;
        sum += v * v;
    }
    return Math.sqrt(sum / meter.data.length);
}

function pollMeters() {
    const speaking = new Set();
    Object.entries(meters).forEach(([id, m]) => { if (level(m) > 0.03) speaking.add(id); });
    if (localMeter && peer?.id && level(localMeter) > 0.03) speaking.add(peer.id);
    speakingCb(speaking);
}

export function stopVoice() {
    Object.values(calls).forEach(c => c.close());
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    micStream = null;
}
