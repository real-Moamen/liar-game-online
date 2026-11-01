import { RANKS, createGame, applyAction, viewFor } from './engine.js';
import { sfx, unlockAudio, vibrate, getSfxPrefs, setSfxPrefs } from './sound.js';
import { initVoice, syncVoicePeers, setMic, isMicOn, setDeafened, isDeafened, stopVoice } from './voice.js';

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const PEER_PREFIX = 'kdb-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const SKIP_AFTER_MS = 15000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const store = {
    get(key, area = sessionStorage) { try { return JSON.parse(area.getItem(key)); } catch (e) { return null; } },
    set(key, val, area = sessionStorage) { try { area.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ } },
    del(key, area = sessionStorage) { try { area.removeItem(key); } catch (e) { /* ignore */ } },
};

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach(c => { if (c != null) node.append(c); });
    return node;
}

function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
}

function makeCode() {
    let code = '';
    const buf = new Uint32Array(5);
    crypto.getRandomValues(buf);
    buf.forEach(n => { code += CODE_CHARS[n % CODE_CHARS.length]; });
    return code;
}

const SEAT_COLORS = ['#e9b949', '#5ec2a8', '#e5734d', '#8f9cf2', '#e46a9b', '#6fb7e9', '#b7d36a', '#d39b6a'];
function colorFor(token) {
    let h = 0;
    for (const ch of token || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return SEAT_COLORS[h % SEAT_COLORS.length];
}
function initial(name) { return [...(name || '?').trim()][0] || '?'; }

let myToken = store.get('kaddab_token');
if (!myToken) {
    myToken = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    store.set('kaddab_token', myToken);
}

// ---------- app state ----------
const S = {
    role: null,          // 'host' | 'client'
    peer: null,
    code: '',
    name: '',
    leaving: false,
    // host-only
    lobby: [],           // [{token, name, peerId, connected}]
    conns: new Map(),    // token -> DataConnection
    game: null,
    phase: 'lobby',
    settings: { copies: 'auto' },
    kicked: [],
    wins: {},
    skipTimer: null,
    // client-only
    conn: null,
    joined: false,
    retryTimer: null,
    retries: 0,
    // shared view
    lobbyInfo: null,
    view: null,
    selected: {},        // rank -> count
    pending: false,
    speaking: new Set(),
    seatPos: {},
    revealUntil: 0,
    wakeLock: null,
};

// Surface unexpected errors instead of freezing silently (helps debug on friends' phones).
window.addEventListener('error', e => toast(`صار خطأ: ${e.message || e}`, 'error'));
window.addEventListener('unhandledrejection', e => toast(`صار خطأ: ${e.reason?.message || e.reason}`, 'error'));

// ---------- toasts / banners ----------
function toast(msg, kind = 'info') {
    const t = el('div', { class: `toast toast-${kind}` }, msg);
    $('toasts').append(t);
    setTimeout(() => t.classList.add('is-leaving'), 2600);
    setTimeout(() => t.remove(), 3000);
}

function showError(msg) { toast(msg, 'error'); sfx('error'); }

function banner(text, { home = false } = {}) {
    if (!text) { $('conn-banner').hidden = true; return; }
    $('conn-text').textContent = text;
    $('conn-home').hidden = !home;
    $('conn-banner').hidden = false;
}

function flash(text, kind = '') {
    const f = $('flash');
    f.textContent = text;
    f.className = 'flash';
    void f.offsetWidth;
    f.className = `flash is-on ${kind}`;
}

// ---------- screens & dialogs ----------
function showScreen(name) {
    ['home', 'lobby', 'game'].forEach(s => { $('screen-' + s).hidden = s !== name; });
    document.body.dataset.screen = name;
    if (name === 'game') requestWakeLock();
}

function openDialog(id) {
    const d = $(id);
    if (!d.open) d.showModal();
}
function closeDialog(id) { const d = $(id); if (d.open) d.close(); }

document.querySelectorAll('dialog').forEach(d => {
    d.addEventListener('click', e => {
        if (e.target === d || e.target.closest('[data-close]')) d.close();
    });
});

async function requestWakeLock() {
    try {
        if (!S.wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
            S.wakeLock = await navigator.wakeLock.request('screen');
            S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
        }
    } catch (e) { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.body.dataset.screen === 'game') requestWakeLock();
});

// ---------- peer helpers ----------
const STUN_SERVERS = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
let iceServers = STUN_SERVERS;
let hasRelay = false;

// TURN relay credentials come from a Netlify function (see netlify/functions/turn.mjs).
const iceReady = (async () => {
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch('/.netlify/functions/turn', { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.iceServers?.length) {
            iceServers = [...STUN_SERVERS, ...data.iceServers];
            hasRelay = true;
        }
    } catch (e) { /* no relay: direct connections only */ }
})();

function newPeer(id) {
    const opts = { debug: 1, config: { iceServers } };
    return id ? new Peer(id, opts) : new Peer(opts);
}

function networkBlockedMsg() {
    return hasRelay
        ? 'ما قدرنا نوصل للطاولة. تأكد من الإنترنت وجرّب مرة ثانية'
        : 'الشبكة تمنع الاتصال المباشر بالطاولة. جرّبوا نفس الواي فاي، أو طفّوا الـ VPN';
}

function watchPeer(peer) {
    peer.on('disconnected', () => {
        if (!S.leaving && !peer.destroyed) setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1000);
    });
}

// Phones pause background tabs; reconnect to the signaling server as soon as we're back.
document.addEventListener('visibilitychange', () => {
    const peer = S.peer;
    if (document.visibilityState === 'visible' && peer && !peer.destroyed && peer.disconnected && !S.leaving) peer.reconnect();
});

// Voice is optional: a browser without full WebAudio support must still be able to play.
function safeInitVoice(peer) {
    try { initVoice(peer, onSpeaking); } catch (e) { console.warn('voice disabled:', e); }
}
function safeSyncVoice(ids) {
    try { syncVoicePeers(ids); } catch (e) { console.warn('voice sync failed:', e); }
}

function onSpeaking(set) {
    const changed = set.size !== S.speaking.size || [...set].some(id => !S.speaking.has(id));
    S.speaking = set;
    if (!changed) return;
    document.querySelectorAll('[data-peer]').forEach(node => {
        node.classList.toggle('is-speaking', set.has(node.dataset.peer));
    });
}

// =====================================================================
// HOST
// =====================================================================
async function hostStart(restore = null, attempt = 0) {
    await iceReady;
    S.role = 'host';
    const code = restore?.code || makeCode();
    banner(restore ? 'نرجّع الطاولة…' : '');
    const peer = newPeer(PEER_PREFIX + code);
    S.peer = peer;
    watchPeer(peer);

    peer.on('open', id => {
        banner('');
        S.code = code;
        if (restore) {
            Object.assign(S, {
                lobby: restore.lobby, game: restore.game, phase: restore.phase,
                settings: restore.settings, kicked: restore.kicked || [], wins: restore.wins || {},
            });
            S.lobby.forEach(p => { if (p.token !== myToken) p.connected = false; });
            if (S.phase === 'lobby') S.lobby = S.lobby.filter(p => p.token === myToken);
            S.game?.players.forEach(p => { if (p.token !== myToken) p.connected = false; });
            toast('رجعت الطاولة. ربعك بيرجعون تلقائياً', 'success');
        } else {
            S.lobby = [{ token: myToken, name: S.name, peerId: id, connected: true }];
        }
        const me = S.lobby.find(p => p.token === myToken);
        if (me) me.peerId = id;
        const gp = S.game?.players.find(p => p.token === myToken);
        if (gp) gp.peerId = id;
        safeInitVoice(peer);
        hostBroadcast();
        scheduleSkip();
    });

    peer.on('connection', conn => {
        conn.on('data', msg => hostOnMessage(conn, msg));
        conn.on('close', () => hostOnClose(conn));
        conn.on('error', () => hostOnClose(conn));
    });

    peer.on('error', err => {
        if (err.type === 'unavailable-id') {
            peer.destroy();
            if (restore && attempt < 15) setTimeout(() => hostStart(restore, attempt + 1), 2000);
            else if (restore) { banner('ما قدرنا نرجّع الطاولة', { home: true }); clearSession(); }
            else hostStart(null, attempt + 1);
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
            banner('مشكلة في الاتصال بالسيرفر، نحاول مرة ثانية…');
        } else if (err.type === 'browser-incompatible') {
            banner('متصفحك ما يدعم اللعب أونلاين، جرّب كروم أو سفاري', { home: true });
        }
    });
}

function uniqueName(name, token) {
    let candidate = name;
    let n = 2;
    while (S.lobby.some(p => p.token !== token && p.name === candidate)) candidate = `${name} ${n++}`;
    return candidate;
}

function hostOnMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
        const token = String(msg.token || '').slice(0, 64);
        const name = String(msg.name || '').trim().slice(0, 14) || 'لاعب';
        if (!token) return;
        if (S.kicked.includes(token)) { conn.send({ t: 'rejected', reason: 'kicked' }); setTimeout(() => conn.close(), 300); return; }

        let player = S.lobby.find(p => p.token === token);
        if (!player) {
            if (S.phase !== 'lobby') { conn.send({ t: 'rejected', reason: 'started' }); setTimeout(() => conn.close(), 300); return; }
            if (S.lobby.length >= MAX_PLAYERS) { conn.send({ t: 'rejected', reason: 'full' }); setTimeout(() => conn.close(), 300); return; }
            player = { token, name: uniqueName(name, token), peerId: msg.peerId, connected: true };
            S.lobby.push(player);
            toast(`${player.name} دخل الطاولة`);
        } else if (!player.connected) {
            toast(`${player.name} رجع`, 'success');
        }
        player.peerId = msg.peerId;
        player.connected = true;
        const old = S.conns.get(token);
        if (old && old !== conn) old.close();
        conn.token = token;
        S.conns.set(token, conn);

        const gp = S.game?.players.find(p => p.token === token);
        if (gp) { gp.connected = true; gp.peerId = msg.peerId; }

        conn.send({ t: 'welcome', code: S.code });
        sfx('join');
        hostBroadcast();
        return;
    }

    if (msg.t === 'act' && conn.token) {
        const idx = S.game ? S.game.players.findIndex(p => p.token === conn.token) : -1;
        if (idx === -1) return;
        hostApply(idx, msg.a || {}, conn);
    }
}

function hostOnClose(conn) {
    if (!conn.token || S.conns.get(conn.token) !== conn) return;
    S.conns.delete(conn.token);
    const player = S.lobby.find(p => p.token === conn.token);
    if (!player) return;
    if (S.phase === 'lobby') {
        S.lobby = S.lobby.filter(p => p !== player);
    } else {
        player.connected = false;
        const gp = S.game?.players.find(p => p.token === conn.token);
        if (gp) gp.connected = false;
    }
    if (!S.leaving) { toast(`${player.name} طلع`); sfx('leave'); }
    hostBroadcast();
    scheduleSkip();
}

function hostIndex() { return S.game ? S.game.players.findIndex(p => p.token === myToken) : -1; }

function hostApply(idx, action, conn = null) {
    if (!S.game || S.phase !== 'playing') return;
    const res = applyAction(S.game, idx, action);
    if (!res.ok) {
        if (conn) conn.send({ t: 'error', msg: res.error });
        else showError(res.error);
        if (!conn) S.pending = false;
        return;
    }
    if (S.game.winner !== null) {
        S.phase = 'ended';
        S.game.players.forEach(p => { S.wins[p.token] = p.wins; });
    }
    hostSend({ t: 'event', ev: res.event }, true);
    hostBroadcast();
    scheduleSkip();
}

function scheduleSkip() {
    clearTimeout(S.skipTimer);
    const g = S.game;
    if (!g || S.phase !== 'playing' || g.winner !== null) return;
    if (g.players[g.current]?.connected) return;
    S.skipTimer = setTimeout(() => {
        if (S.game === g && !g.players[g.current]?.connected) hostApply(hostIndex(), { type: 'skip' });
    }, SKIP_AFTER_MS);
}

function lobbyInfo() {
    return {
        code: S.code,
        phase: S.phase,
        settings: S.settings,
        players: S.lobby.map(p => ({ name: p.name, token: p.token, peerId: p.peerId, connected: p.connected, isHost: p.token === myToken })),
    };
}

// Send a message to every client; `local` also runs it on the host itself.
function hostSend(msg, local = false) {
    S.conns.forEach(c => { if (c.open) { try { c.send(msg); } catch (e) { /* closed */ } } });
    if (local && msg.t === 'event') onEvent(msg.ev);
}

function hostBroadcast() {
    const info = lobbyInfo();
    S.conns.forEach((c, token) => {
        if (!c.open) return;
        const idx = S.game ? S.game.players.findIndex(p => p.token === token) : -1;
        try { c.send({ t: 'sync', lobby: info, view: S.game && S.phase !== 'lobby' ? viewFor(S.game, idx) : null }); } catch (e) { /* closed */ }
    });
    applySync(info, S.game && S.phase !== 'lobby' ? viewFor(S.game, hostIndex()) : null);
    persistHost();
}

function persistHost() {
    if (S.role !== 'host' || S.leaving) return;
    store.set('kaddab_host', {
        code: S.code, name: S.name, lobby: S.lobby, game: S.game, phase: S.phase,
        settings: S.settings, kicked: S.kicked, wins: S.wins,
    });
}

function deckCopies(n) {
    if (S.settings.copies !== 'auto') return Number(S.settings.copies);
    return n <= 4 ? 4 : 8;
}

function hostStartGame() {
    const players = S.lobby.filter(p => p.connected);
    if (players.length < 2) return showError('تحتاج لاعب ثاني على الأقل');
    S.lobby = players;
    S.game = createGame(players, { copies: deckCopies(players.length), wins: S.wins });
    S.phase = 'playing';
    S.selected = {};
    closeDialog('dlg-win');
    hostBroadcast();
    scheduleSkip();
}

function hostBackToLobby() {
    S.phase = 'lobby';
    S.game = null;
    S.lobby = S.lobby.filter(p => p.connected);
    closeDialog('dlg-win');
    hostBroadcast();
}

function hostKick(token) {
    const p = S.lobby.find(x => x.token === token);
    if (!p) return;
    S.kicked.push(token);
    const c = S.conns.get(token);
    S.lobby = S.lobby.filter(x => x.token !== token);
    S.conns.delete(token);
    if (c) { try { c.send({ t: 'kicked' }); } catch (e) { /* closed */ } setTimeout(() => c.close(), 400); }
    toast(`طردت ${p.name}`);
    hostBroadcast();
}

// =====================================================================
// CLIENT
// =====================================================================
async function clientJoin(code) {
    S.role = 'client';
    S.code = code;
    banner('نتصل بسيرفر اللعبة…');
    await iceReady;
    const peer = newPeer();
    S.peer = peer;
    watchPeer(peer);
    const openTimer = setTimeout(() => {
        if (S.peer !== peer || peer.open) return;
        if (S.joined) scheduleRetry();
        else failJoin('ما قدرنا نوصل لسيرفر اللعبة. تأكد من الإنترنت وجرّب مرة ثانية');
    }, 12000);
    peer.on('open', () => {
        clearTimeout(openTimer);
        if (!S.joined) banner('ندوّر على الطاولة…');
        connectToHost();
        safeInitVoice(peer);
    });
    peer.on('error', err => {
        if (err.type === 'peer-unavailable') {
            if (S.joined) scheduleRetry();
            else failJoin('ما لقينا طاولة بهذا الكود. تأكد منه وجرّب مرة ثانية');
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
            banner('مشكلة في الاتصال بالسيرفر، نحاول مرة ثانية…');
        } else if (err.type === 'browser-incompatible') {
            failJoin('متصفحك ما يدعم اللعب أونلاين، جرّب كروم أو سفاري');
        }
    });
}

function connectToHost() {
    if (S.leaving || !S.peer || S.peer.destroyed) return;
    const conn = S.peer.connect(PEER_PREFIX + S.code, { reliable: true });
    S.conn = conn;
    const giveUp = () => {
        if (S.conn !== conn || conn.open) return;
        clearTimeout(timeout);
        conn.close();
        if (S.joined) scheduleRetry();
        else failJoin(networkBlockedMsg());
    };
    const timeout = setTimeout(giveUp, 15000);
    const pc = conn.peerConnection;
    pc?.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed') giveUp();
    });
    conn.on('open', () => {
        clearTimeout(timeout);
        if (!S.joined) banner('وصلنا للطاولة، ننتظر المضيف…');
        conn.send({ t: 'hello', name: S.name, token: myToken, peerId: S.peer.id });
        setTimeout(() => {
            if (S.conn === conn && !S.joined && !S.leaving) {
                conn.close();
                failJoin('المضيف ما ردّ. تأكد إن صفحة اللعبة مفتوحة عنده وجرّب مرة ثانية');
            }
        }, 10000);
    });
    conn.on('data', msg => clientOnMessage(msg));
    conn.on('close', () => { clearTimeout(timeout); if (S.conn === conn) onHostLost(); });
}

function failJoin(msg) {
    showError(msg);
    clearSession();
    teardown();
    banner('');
    showScreen('home');
    $('btn-join').disabled = false;
}

function onHostLost() {
    if (S.leaving) return;
    if (!S.joined) return;
    scheduleRetry();
}

function scheduleRetry() {
    clearTimeout(S.retryTimer);
    if (S.retries >= 25) {
        banner('الطاولة انقفلت أو المضيف طلع', { home: true });
        clearSession();
        return;
    }
    banner('انقطع الاتصال بالطاولة، نحاول نرجع…');
    S.retries++;
    S.retryTimer = setTimeout(connectToHost, 2500);
}

function clientOnMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
        case 'welcome':
            if (!S.joined) sfx('join');
            S.joined = true;
            S.retries = 0;
            banner('');
            store.set('kaddab_client', { code: S.code, name: S.name });
            break;
        case 'rejected': {
            const reasons = {
                started: 'اللعبة بدأت، ما تقدر تدخل الحين',
                full: 'الطاولة مليانة (٨ لاعبين)',
                kicked: 'المضيف طردك من هالطاولة',
            };
            S.leaving = true;
            failJoin(reasons[msg.reason] || 'ما قدرت تدخل الطاولة');
            break;
        }
        case 'kicked':
            S.leaving = true;
            failJoin('المضيف طردك من الطاولة');
            break;
        case 'closed':
            S.leaving = true;
            failJoin('المضيف قفل الطاولة');
            break;
        case 'sync':
            S.pending = false;
            applySync(msg.lobby, msg.view);
            break;
        case 'event':
            onEvent(msg.ev);
            break;
        case 'error':
            S.pending = false;
            showError(msg.msg);
            renderGame();
            break;
    }
}

// =====================================================================
// SHARED: sync, events, actions
// =====================================================================
function applySync(lobby, view) {
    const prev = S.view;
    S.lobbyInfo = lobby;
    S.view = view;
    S.pending = false;
    safeSyncVoice(lobby.players.filter(p => p.connected).map(p => p.peerId));

    if (lobby.phase === 'lobby' || !view) {
        closeDialog('dlg-win');
        closeDialog('dlg-rank');
        showScreen('lobby');
        renderLobby();
        return;
    }

    const newGame = !prev || (prev.winner !== null && view.winner === null);
    if (newGame) {
        S.selected = {};
        closeDialog('dlg-win');
        sfx('deal');
    }
    clampSelection();
    showScreen('game');
    renderGame();

    const myTurnNow = view.current === view.you && view.winner === null;
    const myTurnBefore = prev && !newGame && prev.current === prev.you && prev.winner === null;
    if (myTurnNow && !myTurnBefore) {
        setTimeout(() => { sfx('turn'); vibrate([30, 60, 30]); }, newGame ? 600 : 200);
        if (!newGame) flash('دورك!', 'is-gold');
    }
    if (!myTurnNow) closeDialog('dlg-rank');

    if (view.winner !== null && (!prev || prev.winner === null)) {
        setTimeout(showWin, Math.max(0, S.revealUntil - Date.now()) + 200);
    } else if (view.winner !== null && $('dlg-win').open) {
        renderWin();
    }
}

function handCounts(hand) {
    const counts = {};
    hand.forEach(c => { counts[c] = (counts[c] || 0) + 1; });
    return counts;
}

// Keep the selection valid when the hand changes (e.g. after picking up the pot).
function clampSelection() {
    const counts = handCounts(S.view?.hand || []);
    Object.keys(S.selected).forEach(r => {
        S.selected[r] = Math.min(S.selected[r], counts[r] || 0);
        if (!S.selected[r]) delete S.selected[r];
    });
}

function selectedCards() {
    return RANKS.flatMap(r => Array(S.selected[r] || 0).fill(r));
}

function sendAction(action) {
    if (S.pending) return;
    S.pending = true;
    renderGame();
    if (S.role === 'host') hostApply(hostIndex(), action);
    else if (S.conn?.open) S.conn.send({ t: 'act', a: action });
    else { S.pending = false; showError('مو متصل بالطاولة'); renderGame(); }
}

function playerName(i) { return S.view?.players[i]?.name ?? ''; }

function onEvent(ev) {
    if (!S.view) return;
    switch (ev.kind) {
        case 'play':
            sfx('play');
            flyCards(ev.player, Math.min(ev.count, 6));
            break;
        case 'pass':
            sfx('pass');
            flash(`💨 ${playerName(ev.player)} سوّى Pass`, 'is-cyan');
            break;
        case 'bluff':
            showReveal(ev);
            break;
        case 'skip':
            toast(`تخطّينا ${playerName(ev.player)} لأنه مو متصل`);
            break;
    }
}

// ---------- UI actions ----------
function onPlayClick() {
    const v = S.view;
    if (v?.winner !== null && v?.winner !== undefined) { renderWin(); openDialog('dlg-win'); return; }
    if (!v || v.current !== v.you) return;
    const cards = selectedCards();
    if (!cards.length) return showError('اختر ورقة على الأقل');
    if (v.claim) {
        S.selected = {};
        sendAction({ type: 'play', cards });
    } else {
        renderRankPicker(cards);
        openDialog('dlg-rank');
    }
}

function onPassClick() { sfx('tap'); sendAction({ type: 'pass' }); }

function onBluffClick() {
    const v = S.view;
    if (!v?.lastPlay) return;
    sendAction({ type: 'bluff', playId: v.lastPlay.id });
}

// =====================================================================
// RENDER: lobby
// =====================================================================
function renderLobby() {
    const info = S.lobbyInfo;
    if (!info) return;
    const isHost = S.role === 'host';
    $('lobby-code').textContent = info.code;
    $('lobby-count').textContent = `${info.players.length} / ${MAX_PLAYERS}`;

    const list = $('lobby-players');
    list.replaceChildren(...info.players.map(p => {
        const tags = [];
        if (p.isHost) tags.push(el('span', { class: 'tag tag-gold' }, icon('crown'), 'المضيف'));
        if (p.token === myToken) tags.push(el('span', { class: 'tag' }, 'أنت'));
        const kick = isHost && p.token !== myToken
            ? el('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `اطرد ${p.name}`, title: 'طرد', onclick: () => confirmAction(`تطرد ${p.name}؟`, 'ما بيقدر يرجع لهالطاولة.', 'اطرده', () => hostKick(p.token)) }, icon('x'))
            : null;
        return el('li', { class: 'player-row', dataset: { peer: p.peerId || '' } },
            el('span', { class: 'avatar', style: `--c:${colorFor(p.token)}` }, initial(p.name)),
            el('span', { class: 'player-name' }, p.name),
            ...tags,
            kick);
    }));

    const copies = info.settings.copies;
    document.querySelectorAll('#deck-options button').forEach(b => {
        const on = b.dataset.copies === String(copies);
        b.setAttribute('aria-checked', on);
        b.disabled = !isHost;
    });
    const n = info.players.length;
    const effective = copies === 'auto' ? (n <= 4 ? 4 : 8) : Number(copies);
    const total = effective * RANKS.length;
    $('deck-hint').textContent = `${total} ورقة، يعني تقريباً ${Math.floor(total / Math.max(n, 1))} ورقة لكل لاعب`;

    const start = $('btn-start');
    start.hidden = !isHost;
    start.disabled = n < 2;
    $('start-hint').textContent = isHost
        ? (n < 2 ? 'شارك الكود مع ربعك، وخل هالصفحة مفتوحة لين يدخلون' : 'جاهزين؟ وزّع الورق لما يدخل الكل')
        : 'بانتظار المضيف يوزّع الورق';
    $('start-hint').classList.toggle('waiting-dots', !isHost);
    updateMicButtons();
}

// =====================================================================
// RENDER: game
// =====================================================================
function renderGame() {
    const v = S.view;
    if (!v) return;
    const me = v.you;
    const myTurn = v.current === me && v.winner === null;
    const cur = v.players[v.current];

    $('game-code').textContent = S.lobbyInfo?.code || S.code;

    // status
    const pill = $('status-pill');
    if (v.winner !== null) { pill.textContent = 'انتهت الجولة'; pill.className = 'status-pill'; }
    else if (myTurn) { pill.textContent = 'دورك!'; pill.className = 'status-pill is-me'; }
    else { pill.textContent = `دور ${cur?.name}${cur && !cur.connected ? ' (مو متصل)' : ''}`; pill.className = 'status-pill'; }

    renderSeats(v);
    renderCenter(v);
    renderLog(v);
    renderHand(v, myTurn);
    renderActions(v, myTurn);
    updateMicButtons();
}

function renderSeats(v) {
    const n = v.players.length;
    const seats = $('seats');
    seats.replaceChildren();
    S.seatPos = {};
    v.players.forEach((p, i) => {
        const rel = (i - v.you + n) % n;
        const angle = (90 + (360 / n) * rel) * Math.PI / 180;
        const x = 50 + 46 * Math.cos(angle);
        const y = 50 + 41 * Math.sin(angle);
        S.seatPos[i] = { x, y };
        const isMe = i === v.you;
        const classes = ['seat'];
        if (v.current === i && v.winner === null) classes.push('is-turn');
        if (!p.connected) classes.push('is-offline');
        if (isMe) classes.push('is-me');
        if (v.lastPlay?.player === i) classes.push('is-last');
        if (S.speaking.has(p.peerId)) classes.push('is-speaking');

        const status = p.lastAction
            ? el('span', { class: `seat-status st-${p.lastAction.type}` }, p.lastAction.text)
            : null;
        seats.append(el('div', { class: classes.join(' '), style: `left:${x}%;top:${y}%`, dataset: { peer: p.peerId || '' } },
            el('span', { class: 'avatar', style: `--c:${colorFor(p.token)}` }, initial(p.name),
                p.connected ? null : el('span', { class: 'offline-dot', title: 'مو متصل' })),
            el('span', { class: 'seat-name' }, isMe ? 'أنت' : p.name),
            el('span', { class: 'seat-count', title: 'عدد الورق' }, `🂠 ${p.count}`),
            status));
    });
}

function renderCenter(v) {
    const myTurn = v.current === v.you && v.winner === null;
    $('claim').classList.toggle('is-active', !!v.claim);
    $('claim-label').textContent = v.claim ? 'المطلوب' : (myTurn ? 'اختر رتبة وابدأ' : 'لفة جديدة');
    $('claim-rank').textContent = v.claim || '';

    const pot = $('pot');
    const shown = Math.min(v.potCount, 14);
    if (pot.childElementCount !== shown) {
        pot.replaceChildren(...Array.from({ length: shown }, (_, i) => {
            const r = ((i * 47) % 30) - 15;
            const dx = ((i * 13) % 9) - 4;
            return el('span', { class: 'pot-card', style: `--r:${r}deg;--dx:${dx}px;--dy:${-i * 1.2}px` });
        }));
    }
    const meta = [];
    if (v.potCount) meta.push(`الكومة ${v.potCount}`);
    if (v.claim && v.roundCount && v.roundCount !== v.potCount) meta.push(`منها ${v.roundCount} في هاللفة`);
    if (v.lastPlay) meta.push(`آخر شي: ${playerName(v.lastPlay.player)} نزّل ${v.lastPlay.count}`);
    $('pot-meta').textContent = meta.join(' · ') || 'الطاولة فاضية';
}

function renderLog(v) {
    const log = $('log');
    const key = v.log.map(e => e.id).join(',');
    if (log.dataset.key === key) return;
    log.dataset.key = key;
    log.replaceChildren(...v.log.slice(0, 2).map((entry, i) =>
        el('p', { class: `log-line log-${entry.kind} ${i ? 'is-old' : ''}` }, entry.text)));
}

function renderHand(v, myTurn) {
    const counts = handCounts(v.hand);
    $('hand-count').textContent = v.hand.length;
    $('hand-panel').classList.toggle('is-turn', myTurn);
    const selTotal = selectedCards().length;
    $('sel-summary').textContent = selTotal ? `مختار ${selTotal}` : (myTurn ? 'اختر الورق اللي بتنزّله' : '');
    $('btn-clear').hidden = !selTotal;

    const hand = $('hand');
    const ranks = RANKS.filter(r => counts[r]);
    hand.replaceChildren(...ranks.map(r => {
        const count = counts[r];
        const sel = S.selected[r] || 0;
        const isRed = ['J', 'Q', 'K', 'A'].includes(r);
        const main = el('button', {
            type: 'button',
            class: `card ${isRed ? 'is-court' : ''}`,
            'aria-label': `${r}، عندك ${count}${sel ? `، مختار ${sel}` : ''}`,
            'aria-pressed': sel > 0,
        },
            el('span', { class: 'card-corner' }, r),
            el('span', { class: 'card-rank' }, r),
            el('span', { class: 'card-corner is-flip' }, r));
        bindCardPress(main, r, count);
        return el('div', { class: `stack ${sel ? 'is-selected' : ''} ${count > 1 ? 'has-many' : ''} ${count > 2 ? 'has-lots' : ''}` },
            main,
            count > 1 ? el('span', { class: 'stack-count' }, `×${count}`) : null,
            sel ? el('span', { class: 'stack-sel' }, sel === count && count > 1 ? `الكل ${sel}` : String(sel)) : null,
            sel ? el('button', { type: 'button', class: 'stack-minus', 'aria-label': `شيل وحدة من ${r}`, onclick: () => { S.selected[r]--; if (!S.selected[r]) delete S.selected[r]; sfx('deselect'); renderGame(); } }, icon('minus')) : null);
    }));
    if (!ranks.length) hand.append(el('p', { class: 'muted center empty-hand' }, 'خلّص ورقك! 🎉'));
}

function bindCardPress(btn, rank, count) {
    let timer = null;
    let longPressed = false;
    btn.addEventListener('pointerdown', () => {
        longPressed = false;
        timer = setTimeout(() => {
            longPressed = true;
            S.selected[rank] = count;
            sfx('select'); vibrate(15);
            renderGame();
        }, 420);
    });
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('click', () => {
        if (longPressed) { longPressed = false; return; }
        const sel = S.selected[rank] || 0;
        if (sel < count) { S.selected[rank] = sel + 1; sfx('select'); }
        else { delete S.selected[rank]; sfx('deselect'); }
        renderGame();
    });
}

function renderActions(v, myTurn) {
    const selTotal = selectedCards().length;
    const play = $('btn-play');
    const pass = $('btn-pass');
    const bluff = $('btn-bluff');
    const over = v.winner !== null;

    if (over) { play.textContent = 'عرض النتيجة'; play.disabled = false; }
    else if (!myTurn) { play.textContent = `دور ${playerName(v.current)}`; play.disabled = true; }
    else if (!selTotal) { play.textContent = 'اختر ورق'; play.disabled = true; }
    else if (v.claim) { play.textContent = `نزّل ${selTotal} كـ ${v.claim}`; play.disabled = S.pending; }
    else { play.textContent = `نزّل ${selTotal}…`; play.disabled = S.pending; }

    pass.disabled = over || !myTurn || !v.claim || !v.lastPlay || S.pending;

    const canBluff = !over && v.lastPlay && v.lastPlay.player !== v.you;
    bluff.disabled = !canBluff || S.pending;
    $('bluff-sub').textContent = canBluff ? `على ${playerName(v.lastPlay.player)}` : '';
}

function renderRankPicker(cards) {
    const counts = handCounts(cards);
    const uniq = Object.keys(counts);
    $('rank-sub').textContent = uniq.length === 1
        ? `بتنزّل ${cards.length} ورق. لو قلت ${uniq[0]} تكون صادق`
        : `بتنزّل ${cards.length} ورق. اختر الرتبة اللي بتقولها`;
    $('rank-grid').replaceChildren(...RANKS.map(r => el('button', {
        type: 'button',
        class: `rank-btn ${counts[r] ? 'is-true' : ''}`,
        onclick: () => {
            closeDialog('dlg-rank');
            S.selected = {};
            sendAction({ type: 'play', cards, claim: r });
        },
    }, r, counts[r] ? el('span', { class: 'rank-hint' }, `منها ${counts[r]}`) : null)));
}

// ---------- animations ----------
function flyCards(playerIdx, count) {
    if (reducedMotion.matches) return;
    const from = S.seatPos[playerIdx];
    const table = $('table');
    if (!from || !table) return;
    for (let i = 0; i < count; i++) {
        const c = el('span', { class: 'fly-card' });
        table.append(c);
        const rot = (Math.random() * 40) - 20;
        const anim = c.animate([
            { left: `${from.x}%`, top: `${from.y}%`, transform: 'translate(-50%,-50%) scale(.7) rotate(0deg)', opacity: 0.4 },
            { left: '50%', top: '50%', transform: `translate(-50%,-50%) scale(1) rotate(${rot}deg)`, opacity: 1 },
        ], { duration: 420, delay: i * 60, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
        anim.onfinish = () => c.remove();
    }
}

let revealTimer = null;
function showReveal(ev) {
    const caller = playerName(ev.caller);
    const accused = playerName(ev.accused);
    const potSize = ev.potSize;
    const target = playerName(ev.target);
    const duration = reducedMotion.matches ? 2600 : 3400;
    S.revealUntil = Date.now() + duration;

    sfx('bluff');
    vibrate([60, 40, 60]);
    $('reveal-title').textContent = `🚨 ${caller} كذّب ${accused}!`;
    $('reveal-claim').textContent = `نزّل ${ev.cards.length} وقال إنها ${ev.claim}`;
    $('reveal-verdict').textContent = '';
    $('reveal-verdict').className = 'reveal-verdict';
    $('reveal-cards').replaceChildren(...ev.cards.map(c => el('div', { class: `flip ${c !== ev.claim ? 'is-wrong' : 'is-right'}` },
        el('div', { class: 'flip-inner' },
            el('span', { class: 'flip-back' }),
            el('span', { class: 'flip-face' }, c)))));
    const reveal = $('reveal');
    reveal.hidden = false;
    reveal.classList.remove('is-on');
    void reveal.offsetWidth;
    reveal.classList.add('is-on');

    setTimeout(() => {
        sfx('flip');
        reveal.querySelectorAll('.flip').forEach((f, i) => setTimeout(() => f.classList.add('is-open'), i * 90));
    }, 700);
    setTimeout(() => {
        const v = $('reveal-verdict');
        if (ev.lying) {
            v.textContent = `طلع كذّاب! 🤥 الكومة (${potSize}) راحت لـ\u00A0${target}`;
            v.classList.add('is-caught');
            sfx('caught');
        } else {
            v.textContent = `طلع صادق! 😇 الكومة (${potSize}) راحت لـ\u00A0${target}`;
            v.classList.add('is-honest');
            sfx('honest');
        }
    }, 1400);
    clearTimeout(revealTimer);
    revealTimer = setTimeout(hideReveal, duration);
}

function hideReveal() {
    clearTimeout(revealTimer);
    $('reveal').hidden = true;
    S.revealUntil = 0;
}
$('reveal').addEventListener('click', hideReveal);

// ---------- win ----------
function renderWin() {
    const v = S.view;
    if (!v || v.winner === null) return;
    const isMe = v.winner === v.you;
    $('win-title').textContent = isMe ? 'فزت! 🎉' : `${playerName(v.winner)} فاز!`;
    const order = v.players.map((p, i) => ({ ...p, i })).sort((a, b) => a.count - b.count);
    $('standings').replaceChildren(...order.map(p => el('li', { class: `standing ${p.i === v.winner ? 'is-winner' : ''}` },
        el('span', { class: 'avatar avatar-sm', style: `--c:${colorFor(p.token)}` }, initial(p.name)),
        el('span', { class: 'player-name' }, p.i === v.you ? `${p.name} (أنت)` : p.name),
        el('span', { class: 'muted small' }, p.count ? `باقي ${p.count}` : 'خلّص'),
        p.wins ? el('span', { class: 'tag tag-gold' }, `🏆 ${p.wins}`) : null)));
    const isHost = S.role === 'host';
    $('win-host-actions').hidden = !isHost;
    $('win-wait').hidden = isHost;
}

function showWin() {
    if (!S.view || S.view.winner === null) return;
    hideReveal();
    renderWin();
    openDialog('dlg-win');
    sfx('win');
    vibrate([40, 40, 40, 40, 120]);
    if (S.view.winner === S.view.you) confetti();
}

function confetti() {
    if (reducedMotion.matches) return;
    const box = $('confetti');
    const colors = ['#e9b949', '#f4efe3', '#5ec2a8', '#e5484d', '#8f9cf2'];
    for (let i = 0; i < 70; i++) {
        const p = el('span', { style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};--d:${1.8 + Math.random() * 1.6}s;--x:${(Math.random() - 0.5) * 160}px;--r:${Math.random() * 720}deg;animation-delay:${Math.random() * 0.4}s` });
        box.append(p);
        setTimeout(() => p.remove(), 4000);
    }
}

// ---------- mic ----------
function updateMicButtons() {
    const on = isMicOn();
    document.querySelectorAll('.js-mic').forEach(b => {
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-label', on ? 'اقفل المايك' : 'شغّل المايك');
        b.setAttribute('aria-pressed', on);
        b.querySelector('use').setAttribute('href', on ? '#i-mic' : '#i-mic-off');
        if (S.peer?.id) b.dataset.peer = S.peer.id;
    });
}

async function toggleMic() {
    try {
        const on = await setMic(!isMicOn());
        toast(on ? 'المايك شغّال 🎤' : 'المايك مقفل');
    } catch (e) {
        showError('ما قدرنا نوصل للمايك. اسمح للمتصفح يستخدمه من إعدادات الموقع');
    }
    updateMicButtons();
}

// ---------- leave / session ----------
function clearSession() {
    store.del('kaddab_host');
    store.del('kaddab_client');
}

function teardown() {
    clearTimeout(S.retryTimer);
    clearTimeout(S.skipTimer);
    stopVoice();
    try { S.peer?.destroy(); } catch (e) { /* already gone */ }
    S.peer = null;
    S.conn = null;
    S.joined = false;
    S.retries = 0;
}

function leaveTable() {
    S.leaving = true;
    if (S.role === 'host') hostSend({ t: 'closed' });
    clearSession();
    setTimeout(() => {
        teardown();
        location.href = location.pathname;
    }, 250);
}

function confirmAction(title, body, okLabel, onOk) {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    const ok = $('confirm-ok');
    ok.textContent = okLabel;
    ok.onclick = () => { closeDialog('dlg-confirm'); onOk(); };
    openDialog('dlg-confirm');
}

function askLeave() {
    closeDialog('dlg-menu');
    const hostMsg = 'إذا طلعت تنقفل الطاولة عند الكل.';
    const clientMsg = S.view && S.view.winner === null ? 'ورقك بيبقى محفوظ لو رجعت بنفس الكود من هالجهاز.' : '';
    confirmAction('تبي تطلع من الطاولة؟', S.role === 'host' ? hostMsg : clientMsg, 'اطلع', leaveTable);
}

window.addEventListener('beforeunload', e => {
    if (S.role === 'host' && S.phase === 'playing' && !S.leaving) { e.preventDefault(); e.returnValue = ''; }
});

// =====================================================================
// HOME
// =====================================================================
const nameInput = $('name-input');
const codeInput = $('code-input');
const params = new URLSearchParams(location.search);
const invited = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

nameInput.value = store.get('kaddab_name', localStorage) || '';
if (invited) {
    codeInput.value = invited;
    $('invite-code').textContent = invited;
    $('invite-banner').hidden = false;
    $('btn-create').hidden = true;
    $('home-divider').hidden = true;
    $('btn-join').classList.replace('btn-secondary', 'btn-primary');
}

function validName() {
    const name = nameInput.value.trim();
    $('name-error').hidden = !!name;
    nameInput.setAttribute('aria-invalid', !name);
    if (!name) { nameInput.focus(); sfx('error'); }
    return name;
}

nameInput.addEventListener('input', () => { if (nameInput.value.trim()) { $('name-error').hidden = true; nameInput.removeAttribute('aria-invalid'); } });
codeInput.addEventListener('input', () => {
    const clean = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean !== codeInput.value) codeInput.value = clean;
    $('code-error').hidden = true;
    codeInput.removeAttribute('aria-invalid');
});
codeInput.addEventListener('blur', () => {
    const bad = codeInput.value && codeInput.value.length !== 5;
    $('code-error').hidden = !bad;
    if (bad) codeInput.setAttribute('aria-invalid', 'true');
});

function beginSession(name) {
    unlockAudio();
    S.name = name;
    store.set('kaddab_name', name, localStorage);
}

$('btn-create').addEventListener('click', () => {
    const name = validName();
    if (!name) return;
    beginSession(name);
    sfx('tap');
    $('btn-create').disabled = true;
    hostStart();
});

$('home-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = validName();
    if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 5) {
        $('code-error').hidden = false;
        codeInput.setAttribute('aria-invalid', 'true');
        codeInput.focus();
        sfx('error');
        return;
    }
    beginSession(name);
    sfx('tap');
    $('btn-join').disabled = true;
    clientJoin(code);
});

// =====================================================================
// GLOBAL WIRING
// =====================================================================
document.querySelectorAll('.js-rules').forEach(b => b.addEventListener('click', () => { closeDialog('dlg-menu'); openDialog('dlg-rules'); }));
document.querySelectorAll('.js-leave').forEach(b => b.addEventListener('click', askLeave));
document.querySelectorAll('.js-mic').forEach(b => b.addEventListener('click', toggleMic));
$('conn-home').addEventListener('click', () => { S.leaving = true; clearSession(); teardown(); location.href = location.pathname; });

$('btn-play').addEventListener('click', onPlayClick);
$('btn-pass').addEventListener('click', onPassClick);
$('btn-bluff').addEventListener('click', onBluffClick);
$('btn-clear').addEventListener('click', () => { S.selected = {}; sfx('deselect'); renderGame(); });
$('btn-start').addEventListener('click', () => { sfx('tap'); hostStartGame(); });
$('btn-again').addEventListener('click', () => { sfx('tap'); hostStartGame(); });
$('btn-to-lobby').addEventListener('click', () => { sfx('tap'); hostBackToLobby(); });

document.querySelectorAll('#deck-options button').forEach(b => b.addEventListener('click', () => {
    if (S.role !== 'host') return;
    S.settings.copies = b.dataset.copies === 'auto' ? 'auto' : Number(b.dataset.copies);
    sfx('tap');
    hostBroadcast();
}));

async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg, 'success'); }
    catch (e) { toast(text); }
}
const inviteLink = () => `${location.origin}${location.pathname}?room=${S.code}`;
$('btn-copy-code').addEventListener('click', () => copyText(S.code, 'نسخت الكود'));
$('room-chip').addEventListener('click', () => copyText(S.code, 'نسخت الكود'));
$('btn-share-link').addEventListener('click', async () => {
    const url = inviteLink();
    if (navigator.share) {
        try { await navigator.share({ title: 'كذّاب', text: `تعال العب كذّاب معي! الكود: ${S.code}`, url }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
    }
    copyText(url, 'نسخت رابط الدعوة');
});

$('btn-menu').addEventListener('click', () => {
    const p = getSfxPrefs();
    $('sfx-toggle').checked = p.on;
    $('sfx-volume').value = p.volume;
    $('sfx-volume').disabled = !p.on;
    $('voice-toggle').checked = !isDeafened();
    openDialog('dlg-menu');
});
$('sfx-toggle').addEventListener('change', e => {
    setSfxPrefs({ on: e.target.checked });
    $('sfx-volume').disabled = !e.target.checked;
    sfx('tap');
});
$('sfx-volume').addEventListener('input', e => setSfxPrefs({ volume: Number(e.target.value) }));
$('sfx-volume').addEventListener('change', () => sfx('select'));
$('voice-toggle').addEventListener('change', e => setDeafened(!e.target.checked));

// Keyboard shortcuts during the game
document.addEventListener('keydown', e => {
    if (document.body.dataset.screen !== 'game' || document.querySelector('dialog[open]')) return;
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'Enter' && !e.target.closest('button') && !$('btn-play').disabled) { e.preventDefault(); onPlayClick(); }
    else if ((e.key === 'b' || e.key === 'B') && !$('btn-bluff').disabled) onBluffClick();
    else if ((e.key === 'p' || e.key === 'P') && !$('btn-pass').disabled) onPassClick();
    else if (e.key === 'Escape') { S.selected = {}; renderGame(); }
});

// =====================================================================
// BOOT: restore a session after reload
// =====================================================================
function boot() {
    if (typeof Peer === 'undefined') {
        banner('ما قدرنا نحمّل ملفات اللعبة. تأكد من الإنترنت وحدّث الصفحة');
        return;
    }
    const hostSave = store.get('kaddab_host');
    const clientSave = store.get('kaddab_client');
    if (hostSave?.code) {
        S.name = hostSave.name;
        showScreen(hostSave.phase === 'lobby' ? 'lobby' : 'game');
        hostStart(hostSave);
    } else if (clientSave?.code) {
        S.name = clientSave.name;
        S.joined = true;
        showScreen('lobby');
        clientJoin(clientSave.code);
        banner('نرجّعك للطاولة…');
    } else {
        showScreen('home');
        (invited && nameInput.value ? codeInput : nameInput).focus({ preventScroll: true });
    }
}
boot();

// Audio needs a user gesture; unlock on the first tap after a restore.
document.addEventListener('pointerdown', unlockAudio, { once: true });
