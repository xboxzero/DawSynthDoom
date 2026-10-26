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

/** The registered redirect URI. On GitHub Pages it is pinned to the canonical
 *  path so the URL still matches the key when the site is opened in lower case. */
export const redirectUri = (): string => {
  if (location.hostname === 'xboxzero.github.io') return 'https://xboxzero.github.io/DawSynthDoom/callback.html';
  return new URL('callback.html', location.href.split(/[?#]/)[0]).href;
};

const PENDING = 'dsd.t3k.pending';
const POPUP_FEATURES = 'width=480,height=720,resizable=yes,scrollbars=yes';

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

  private waiting: { cancel: () => void } | null = null;

  /** Stop waiting for the picker (the UI's CANCEL button). */
  cancel(): void { this.waiting?.cancel(); }

  private async authorizeUrl(o: SelectOptions): Promise<{ url: string; verifier: string; state: string }> {
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
    return { url: url.toString(), verifier, state };
  }

  /**
   * Opens the TONE3000 picker and resolves with the picked tone.
   * The popup is opened synchronously inside the click (Safari blocks popups
   * opened after an await). If popups are blocked, the page itself goes to
   * TONE3000 and resumeRedirect() finishes the job when it comes back.
   */
  async select(o: SelectOptions = {}): Promise<{ toneId: string }> {
    const popup = window.open('', 't3k_select', POPUP_FEATURES);
    if (!/^t3k_pub_[A-Za-z0-9_-]+$/.test(this.key)) {
      popup?.close();
      throw new Error('Paste your TONE3000 publishable key (starts with t3k_pub_) first.');
    }
    const { url, verifier, state } = await this.authorizeUrl(o);
    if (!popup) {
      sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, format: o.format ?? 'nam', architecture: o.architecture ?? '' }));
      location.href = url;
      return new Promise(() => {});   // the page is navigating away
    }
    popup.location.href = url;
    const msg = await new Promise<CallbackMsg>((resolve, reject) => {
      const bc = new BroadcastChannel('t3k_oauth');
      // No "popup closed" check: sign-in pages often cut the link to the popup
      // (it then looks closed while the user is still picking). Wait for the
      // callback instead; the user can cancel from the dialog.
      const timer = window.setTimeout(() => done(undefined, new Error('Timed out waiting for TONE3000.')), 15 * 60 * 1000);
      const onMsg = (e: MessageEvent): void => {
        const d = e.data as CallbackMsg | undefined;
        if (d?.type !== 't3k_oauth_callback') return;
        if (e.origin && e.origin !== location.origin) return;
        bc.postMessage({ type: 't3k_ack' });
        done(d);
      };
      const done = (d?: CallbackMsg, err?: Error): void => {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        bc.close();
        this.waiting = null;
        if (d) resolve(d); else reject(err ?? new Error('Canceled.'));
      };
      this.waiting = { cancel: () => { try { popup.close(); } catch { /* cross-origin */ } done(undefined, new Error('Canceled.')); } };
      window.addEventListener('message', onMsg);
      bc.onmessage = onMsg;
    });
    return this.finish(msg, verifier, state);
  }

  /** Same-tab fallback: finish a sign-in that came back via a full page redirect. */
  async resumeRedirect(): Promise<{ toneId: string; format: string; architecture: string } | null> {
    const q = new URLSearchParams(location.search);
    let pending: { verifier: string; state: string; format: string; architecture: string } | null = null;
    try { pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null'); } catch { pending = null; }
    if (!pending || !(q.has('code') || q.has('error') || q.has('canceled'))) return null;
    sessionStorage.removeItem(PENDING);
    history.replaceState(null, '', location.pathname);
    const msg: CallbackMsg = { type: 't3k_oauth_callback', code: q.get('code'), state: q.get('state'), error: q.get('error'), tone_id: q.get('tone_id'), canceled: q.get('canceled') === 'true' };
    const r = await this.finish(msg, pending.verifier, pending.state);
    return { ...r, format: pending.format, architecture: pending.architecture };
  }

  private async finish(msg: CallbackMsg, verifier: string, state: string): Promise<{ toneId: string }> {
    if (msg.state !== state) throw new Error('Security check failed (state mismatch). Try again.');
    if (msg.error) {
      const hint = /redirect/i.test(msg.error) ? ` — register ${redirectUri()} on your key` : /client/i.test(msg.error) ? ' — check the publishable key' : '';
      throw new Error(`TONE3000: ${msg.error}${hint}`);
    }
    if (!msg.code) throw new Error('Canceled.');
    const res = await fetch(`${API}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: msg.code, code_verifier: verifier, redirect_uri: redirectUri(), client_id: this.key }),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      throw new Error(`Sign-in failed: ${e.error_description ?? e.error ?? res.status}`);
    }
    const d = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    this.save({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 });
    if (msg.canceled || !msg.tone_id) throw new Error('Signed in, but no tone was picked.');
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
    if (res.status === 401) { this.disconnect(); throw new Error('TONE3000 session expired — pick again to reconnect.'); }
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

  async file(modelUrl: string): Promise<ArrayBuffer> {
    const u = new URL(modelUrl, API);
    if (u.origin === API) return (await this.api(u.pathname + u.search)).arrayBuffer();
    const res = await fetch(u, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return res.arrayBuffer();
  }
}
