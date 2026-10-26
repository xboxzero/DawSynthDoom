// TONE3000 integration (OAuth 2 + PKCE "select tone" flow in a popup), based on
// the official open-source client: https://github.com/tone-3000/api
// Needs a free publishable key (t3k_pub_…) with this site's callback.html registered.

const API = 'https://www.tone3000.com';
const KEY_STORE = 'dsd.t3k.key';
const TOKEN_STORE = 'dsd.t3k.tokens';

interface Tokens { access_token: string; refresh_token: string; expires_at: number }
interface CallbackMsg { type: string; code: string | null; state: string | null; error: string | null; tone_id: string | null; canceled: boolean }
export interface T3kTone { id: number; title: string; format: string; user?: { username: string; display_name: string | null } }
export interface T3kModel { id: number; name: string; size?: string; model_url: string; architecture_version: string | null }
export interface SelectOptions { format?: 'nam' | 'ir'; gears?: string | undefined; architecture?: string | undefined }

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null): void => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } };

export const redirectUri = (): string => new URL('callback.html', window.location.href.split(/[?#]/)[0]).href;

export class Tone3000 {
  key = lsGet(KEY_STORE) ?? '';
  private tokens: Tokens | null = null;
  private refreshing: Promise<string> | null = null;

  constructor() {
    try { this.tokens = JSON.parse(lsGet(TOKEN_STORE) ?? 'null') as Tokens | null; } catch { this.tokens = null; }
  }

  setKey(k: string): void { this.key = k.trim(); lsSet(KEY_STORE, this.key || null); }
  get connected(): boolean { return !!this.tokens?.refresh_token; }
  private save(t: Tokens | null): void { this.tokens = t; lsSet(TOKEN_STORE, t ? JSON.stringify(t) : null); }
  disconnect(): void { this.save(null); }

  async select(o: SelectOptions = {}): Promise<{ toneId: string }> {
    if (!this.key.startsWith('t3k_pub_')) throw new Error('Paste your TONE3000 publishable key (t3k_pub_…) first.');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const url = new URL(`${API}/api/v1/oauth/authorize`);
    const q: Record<string, string> = {
      client_id: this.key, redirect_uri: redirectUri(), response_type: 'code', code_challenge: challenge,
      code_challenge_method: 'S256', state, prompt: 'select_tone', format: o.format ?? 'nam', preview: 'true', menubar: 'true',
    };
    if (o.gears) q.gears = o.gears;
    if (o.architecture) q.architecture = o.architecture;
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
    const w = 480, h = 720;
    const popup = window.open(url.toString(), 't3k_select', `width=${w},height=${h},left=${Math.round(window.screenX + (window.outerWidth - w) / 2)},top=${Math.round(window.screenY + (window.outerHeight - h) / 2)},resizable=yes,scrollbars=yes`);
    if (!popup) throw new Error('Popup blocked — allow popups for this site and try again.');

    const msg = await new Promise<CallbackMsg>((resolve, reject) => {
      const bc = new BroadcastChannel('t3k_oauth');
      let closedFor = 0;
      const poll = window.setInterval(() => { if (popup.closed && ++closedFor > 4) done(); }, 500);
      const onMsg = (e: MessageEvent): void => {
        if ((e.data as CallbackMsg | undefined)?.type !== 't3k_oauth_callback') return;
        if (e.origin && e.origin !== window.location.origin) return;
        done(e.data as CallbackMsg);
      };
      function done(d?: CallbackMsg): void {
        clearInterval(poll);
        window.removeEventListener('message', onMsg);
        bc.close();
        if (d) resolve(d); else reject(new Error('Picker closed.'));
      }
      window.addEventListener('message', onMsg);
      bc.onmessage = onMsg;
    });
    if (msg.state !== state) throw new Error('Security check failed (state mismatch).');
    if (msg.error) throw new Error(`TONE3000: ${msg.error}`);
    if (!msg.code) throw new Error('Canceled.');
    const res = await fetch(`${API}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: msg.code, code_verifier: verifier, redirect_uri: redirectUri(), client_id: this.key }),
    });
    if (!res.ok) throw new Error(`Sign-in failed: ${res.status}`);
    const d = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    this.save({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 });
    if (msg.canceled || !msg.tone_id) throw new Error('No tone picked.');
    return { toneId: msg.tone_id };
  }

  private async accessToken(): Promise<string> {
    const t = this.tokens;
    if (!t) throw new Error('Not connected to TONE3000.');
    if (Date.now() < t.expires_at - 60000) return t.access_token;
    this.refreshing ??= (async () => {
      const res = await fetch(`${API}/api/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: this.key }),
      });
      if (!res.ok) { this.disconnect(); throw new Error('TONE3000 session expired — pick again to reconnect.'); }
      const d = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
      this.save({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 });
      return d.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async api(path: string): Promise<Response> {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new Error(`TONE3000 request failed (${res.status})`);
    return res;
  }

  async tone(id: string): Promise<T3kTone> { return (await this.api(`/api/v1/tones/${id}`)).json() as Promise<T3kTone>; }

  async models(toneId: string, architecture?: string): Promise<T3kModel[]> {
    const qs = new URLSearchParams({ tone_id: toneId, page_size: '50' });
    if (architecture) qs.set('architecture', architecture);
    const r = (await (await this.api(`/api/v1/models?${qs}`)).json()) as { data?: T3kModel[] };
    return r.data ?? [];
  }

  async file(modelUrl: string): Promise<ArrayBuffer> { return (await this.api(modelUrl.replace(/^https?:\/\/[^/]+/, ''))).arrayBuffer(); }
}
