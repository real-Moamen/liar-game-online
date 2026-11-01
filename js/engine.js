// Pure game rules. Runs only on the host; clients never see other hands or pot values.

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const MAX_LOG = 6;

function randInt(max) {
    if (globalThis.crypto?.getRandomValues) {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] % max;
    }
    return Math.floor(Math.random() * max);
}

export function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export function sortHand(hand) {
    return hand.sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b));
}

// lobbyPlayers: [{token, name, peerId, connected}], wins carried over between rounds
export function createGame(lobbyPlayers, { copies = 8, wins = {} } = {}) {
    const seats = shuffle(lobbyPlayers.map(p => ({ ...p })));
    const deck = shuffle(RANKS.flatMap(r => Array(copies).fill(r)));
    const players = seats.map(p => ({
        token: p.token,
        name: p.name,
        peerId: p.peerId,
        connected: p.connected !== false,
        hand: [],
        lastAction: null,
        wins: wins[p.token] || 0,
    }));
    deck.forEach((card, i) => players[i % players.length].hand.push(card));
    players.forEach(p => sortHand(p.hand));

    const state = {
        players,
        pot: [],
        claim: '',
        roundCount: 0,
        lastPlay: null,
        current: 0,
        winner: null,
        log: [],
        seq: 0,
    };
    addLog(state, `بدأت اللعبة! الدور عند ${players[0].name}`, 'info');
    return state;
}

function addLog(state, text, kind) {
    state.log.unshift({ text, kind, id: ++state.seq });
    state.log.length = Math.min(state.log.length, MAX_LOG);
}

function nextIndex(state, from) {
    const n = state.players.length;
    for (let step = 1; step <= n; step++) {
        const i = (from + step) % n;
        if (state.players[i].connected) return i;
    }
    return (from + 1) % n;
}

function hasCards(hand, cards) {
    const counts = {};
    hand.forEach(c => { counts[c] = (counts[c] || 0) + 1; });
    return cards.every(c => counts[c]-- > 0);
}

function removeCards(hand, cards) {
    cards.forEach(c => hand.splice(hand.indexOf(c), 1));
}

function checkWinner(state) {
    const idx = state.players.findIndex((p, i) =>
        p.hand.length === 0 && (!state.lastPlay || state.lastPlay.player !== i));
    if (idx !== -1) {
        state.winner = idx;
        state.players[idx].wins++;
        addLog(state, `🏆 ${state.players[idx].name} خلّص ورقه وفاز!`, 'win');
    }
}

// Returns { ok, error?, event? }. Mutates state.
export function applyAction(state, idx, action) {
    if (state.winner !== null) return { ok: false, error: 'الجولة انتهت' };
    const me = state.players[idx];
    if (!me) return { ok: false, error: 'لاعب غير معروف' };

    switch (action.type) {
        case 'play': {
            if (state.current !== idx) return { ok: false, error: 'مو دورك' };
            const cards = Array.isArray(action.cards) ? action.cards.map(String) : [];
            if (cards.length === 0) return { ok: false, error: 'اختر ورقة على الأقل' };
            if (!hasCards(me.hand, cards)) return { ok: false, error: 'الورق هذا مو عندك' };
            let claim = state.claim;
            if (!claim) {
                if (!RANKS.includes(action.claim)) return { ok: false, error: 'اختر الرتبة' };
                claim = action.claim;
                state.claim = claim;
                state.roundCount = 0;
            }
            removeCards(me.hand, cards);
            state.pot.push(...cards);
            state.roundCount += cards.length;
            state.lastPlay = { id: ++state.seq, player: idx, cards, claim };
            state.players.forEach(p => { if (p !== me) p.lastAction = null; });
            me.lastAction = { type: 'play', text: `نزّل ${cards.length}` };
            const next = nextIndex(state, idx);
            state.current = next;
            addLog(state, `🃏 ${me.name} نزّل ${cards.length} على إنها ${claim}`, 'play');
            checkWinner(state);
            return { ok: true, event: { kind: 'play', player: idx, count: cards.length, claim } };
        }

        case 'pass': {
            if (state.current !== idx) return { ok: false, error: 'مو دورك' };
            if (!state.claim || !state.lastPlay) return { ok: false, error: 'ما فيه لفة شغالة، لازم تنزّل ورق' };
            state.claim = '';
            state.roundCount = 0;
            state.lastPlay = null;
            me.lastAction = { type: 'pass', text: 'Pass' };
            state.current = nextIndex(state, idx);
            addLog(state, `💨 ${me.name} سوّى Pass، لفة جديدة عند ${state.players[state.current].name}`, 'pass');
            checkWinner(state);
            return { ok: true, event: { kind: 'pass', player: idx } };
        }

        case 'bluff': {
            const lp = state.lastPlay;
            if (!lp) return { ok: false, error: 'ما فيه ورق تكذّبه' };
            if (lp.player === idx) return { ok: false, error: 'ما تقدر تكذّب نفسك' };
            if (action.playId !== undefined && action.playId !== lp.id) return { ok: false, error: 'سبقك أحد' };
            const accused = state.players[lp.player];
            const lying = lp.cards.some(c => c !== lp.claim);
            const targetIdx = lying ? lp.player : idx;
            const target = state.players[targetIdx];
            const potSize = state.pot.length;
            target.hand.push(...state.pot);
            sortHand(target.hand);
            state.pot = [];
            state.claim = '';
            state.roundCount = 0;
            state.lastPlay = null;
            state.players.forEach(p => { p.lastAction = null; });
            me.lastAction = { type: 'bluff', text: 'كذّب' };
            accused.lastAction = lying ? { type: 'caught', text: 'انقفط 🤥' } : { type: 'honest', text: 'صادق 😇' };
            state.current = lying ? idx : lp.player;
            addLog(state, lying
                ? `💥 ${me.name} كشف ${accused.name}! الكومة (${potSize}) راحت له`
                : `🤦 ${me.name} ظلم ${accused.name}، وأخذ الكومة (${potSize})`, lying ? 'caught' : 'honest');
            checkWinner(state);
            return {
                ok: true,
                event: { kind: 'bluff', caller: idx, accused: lp.player, cards: lp.cards, claim: lp.claim, lying, potSize, target: targetIdx },
            };
        }

        case 'skip': {
            // Host-only: move past a disconnected player
            const cur = state.players[state.current];
            if (cur.connected) return { ok: false, error: 'اللاعب متصل' };
            const from = state.current;
            state.current = nextIndex(state, from);
            addLog(state, `⏭️ تخطّينا ${cur.name} (غير متصل)`, 'info');
            return { ok: true, event: { kind: 'skip', player: from } };
        }
    }
    return { ok: false, error: 'حركة غير معروفة' };
}

// What one player is allowed to see.
export function viewFor(state, idx) {
    return {
        players: state.players.map(p => ({
            name: p.name,
            token: p.token,
            peerId: p.peerId,
            count: p.hand.length,
            connected: p.connected,
            lastAction: p.lastAction,
            wins: p.wins,
        })),
        potCount: state.pot.length,
        claim: state.claim,
        roundCount: state.roundCount,
        lastPlay: state.lastPlay ? { id: state.lastPlay.id, player: state.lastPlay.player, count: state.lastPlay.cards.length } : null,
        current: state.current,
        winner: state.winner,
        log: state.log,
        you: idx,
        hand: idx >= 0 ? [...state.players[idx].hand] : [],
    };
}
