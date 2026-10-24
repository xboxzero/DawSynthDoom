// TONE3000 integration (OAuth 2 + PKCE "select tone" flow, in a popup).
// Based on the official open-source client: https://github.com/tone-3000/api
// You need a free publishable key (t3k_pub_…) from tone3000.com → Settings → API Keys,
// with this site's callback.html registered as a redirect URI.

const API = 'https://www.tone3000.com';
const KEY_STORE = 'dsd.t3k.key';
const TOKEN_STORE = 'dsd.t3k.tokens';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

export const redirectUri = () => new URL('callback.html', window.location.href.split(/[?#]/)[0]).href;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } }

export class Tone3000 {
  constructor() {
    this.key = lsGet(KEY_STORE) || '';
    try { this.tokens = JSON.parse(lsGet(TOKEN_STORE) || 'null'); } catch { this.tokens = null; }
    this.refreshing = null;
  }

  setKey(k) { this.key = k.trim(); lsSet(KEY_STORE, this.key || null); }
  get connected() { return !!this.tokens?.refresh_token; }

  saveTokens(t) { this.tokens = t; lsSet(TOKEN_STORE, t ? JSON.stringify(t) : null); }
  disconnect() { this.saveTokens(null); }

  // Opens the TONE3000 picker. Resolves with { toneId } after the user picks.
  async select({ format = 'nam', gears, architecture } = {}) {
    if (!this.key.startsWith('t3k_pub_')) throw new Error('Paste your TONE3000 publishable key (t3k_pub_…) first.');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = b64url(new Uint8Array(hash));

    const url = new URL(`${API}/api/v1/oauth/authorize`);
    const q = {
      client_id: this.key,
      redirect_uri: redirectUri(),
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      prompt: 'select_tone',
      format,
      preview: 'true',
      menubar: 'true',
    };
    if (gears) q.gears = gears;
    if (architecture) q.architecture = String(architecture);
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);

    const w = 480, h = 720;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(url.toString(), 't3k_select', `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    if (!popup) throw new Error('Popup blocked — allow popups for this site and try again.');

    const msg = await new Promise((resolve, reject) => {
      const bc = new BroadcastChannel('t3k_oauth');
      const done = (fn, v) => { clearInterval(poll); window.removeEventListener('message', onMsg); bc.close(); fn(v); };
      const onMsg = (e) => {
        const d = e.data;
        if (d?.type !== 't3k_oauth_callback') return;
        if (e.origin && e.origin !== window.location.origin) return;
        done(resolve, d);
      };
      window.addEventListener('message', onMsg);
      bc.onmessage = onMsg;
      let closedFor = 0;
      const poll = setInterval(() => {
        // give the relay a moment after close in case it raced the close
        if (popup.closed && ++closedFor > 4) done(reject, new Error('Picker closed.'));
      }, 500);
    });

    if (msg.state !== state) throw new Error('Security check failed (state mismatch).');
    if (msg.error) throw new Error(`TONE3000: ${msg.error}`);
    if (!msg.code) throw new Error('Canceled.');

    const res = await fetch(`${API}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: msg.code,
        code_verifier: verifier,
        redirect_uri: redirectUri(),
        client_id: this.key,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Sign-in failed: ${err.error ?? res.status}`);
    }
    const data = await res.json();
    this.saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 });
    if (msg.canceled || !msg.tone_id) throw new Error('No tone picked.');
    return { toneId: msg.tone_id };
  }

  async accessToken() {
    if (!this.tokens) throw new Error('Not connected to TONE3000.');
    if (Date.now() < this.tokens.expires_at - 60000) return this.tokens.access_token;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const res = await fetch(`${API}/api/v1/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token, client_id: this.key }),
        });
        if (!res.ok) { this.disconnect(); throw new Error('TONE3000 session expired — pick again to reconnect.'); }
        const d = await res.json();
        this.saveTokens({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 });
        return d.access_token;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async api(path) {
    const token = await this.accessToken();
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`TONE3000 request failed (${res.status})`);
    return res;
  }

  async tone(id) { return (await this.api(`/api/v1/tones/${id}`)).json(); }

  async models(toneId, architecture) {
    const qs = new URLSearchParams({ tone_id: String(toneId), page_size: '50' });
    if (architecture) qs.set('architecture', String(architecture));
    const r = await (await this.api(`/api/v1/models?${qs}`)).json();
    return r.data ?? [];
  }

  async file(modelUrl) {
    const res = await this.api(modelUrl.replace(/^https?:\/\/[^/]+/, ''));
    return res.arrayBuffer();
  }
}
