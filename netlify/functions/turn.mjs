// Returns short-lived TURN credentials so players on strict networks
// (mobile data, CGNAT, some routers) can still reach each other.
// Configure in Netlify: Site configuration > Environment variables
//   CF_TURN_KEY_ID + CF_TURN_API_TOKEN  (Cloudflare Realtime TURN, free 1000 GB/month)
//   or METERED_CREDENTIALS_URL          (Metered.ca credentials API URL)

const TTL_SECONDS = 6 * 60 * 60;

// Browsers block port 53, so drop those URLs.
function browserSafe(servers) {
    return servers
        .map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) }))
        .filter(s => s.urls.length);
}

async function cloudflare(keyId, token) {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!res.ok) throw new Error(`cloudflare ${res.status}`);
    const data = await res.json();
    return [].concat(data.iceServers || []);
}

async function metered(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`metered ${res.status}`);
    return res.json();
}

export default async () => {
    const { CF_TURN_KEY_ID, CF_TURN_API_TOKEN, METERED_CREDENTIALS_URL } = process.env;
    let iceServers = [];
    try {
        if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) iceServers = await cloudflare(CF_TURN_KEY_ID, CF_TURN_API_TOKEN);
        else if (METERED_CREDENTIALS_URL) iceServers = await metered(METERED_CREDENTIALS_URL);
    } catch (e) {
        console.error('TURN credentials failed:', e.message);
    }
    return new Response(JSON.stringify({ iceServers: browserSafe(iceServers) }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
};
