/**
 * Store - GitHub-backed JSON file storage for the Cricket Auction app.
 *
 * Mirrors the mechanism used by the IronWill gym-management app:
 *   - Reads/writes data/data.json in a GitHub repo via the GitHub Contents API.
 *   - Uses a Personal Access Token (PAT with 'repo' scope) stored in localStorage.
 *   - Keeps an in-memory cache and tracks the file SHA to avoid write conflicts.
 *   - Falls back to a local snapshot (localStorage) so the app still works offline
 *     or before a token is configured.
 *
 * SETUP:
 *   1. Create a GitHub PAT with 'repo' scope: https://github.com/settings/tokens/new
 *   2. Create a repo (default owner/name below) containing data/data.json.
 *   3. Open the app's Settings tab and paste the token (and owner/repo if different).
 */

const Store = {
  // --- GitHub configuration (editable from Settings) ---
  OWNER: 'SathyaRao',
  REPO: 'auctionApp',
  FILE_PATH: 'data/data.json',
  BRANCH: 'main',

  // --- Local fallback ---
  LOCAL_KEY: 'cricket-auction-state-v1',
  CONFIG_KEY: 'cricket-auction-gh-config',
  TOKEN_KEY: 'github_token',

  // --- Internal state ---
  _data: null,
  _sha: null,
  _loading: false,

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */
  init() {
    try {
      const cfg = JSON.parse(localStorage.getItem(this.CONFIG_KEY) || '{}');
      if (cfg.owner) this.OWNER = cfg.owner;
      if (cfg.repo) this.REPO = cfg.repo;
      if (cfg.branch) this.BRANCH = cfg.branch;
      if (cfg.filePath) this.FILE_PATH = cfg.filePath;
    } catch (e) {
      console.warn('Could not read GitHub config', e);
    }
  },

  saveConfig(cfg) {
    if (cfg.owner) this.OWNER = cfg.owner;
    if (cfg.repo) this.REPO = cfg.repo;
    if (cfg.branch) this.BRANCH = cfg.branch;
    if (cfg.filePath) this.FILE_PATH = cfg.filePath;
    localStorage.setItem(this.CONFIG_KEY, JSON.stringify({
      owner: this.OWNER, repo: this.REPO, branch: this.BRANCH, filePath: this.FILE_PATH
    }));
  },

  getConfig() {
    return { owner: this.OWNER, repo: this.REPO, branch: this.BRANCH, filePath: this.FILE_PATH };
  },

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY) || '';
  },

  setToken(token) {
    localStorage.setItem(this.TOKEN_KEY, (token || '').trim());
  },

  isConfigured() {
    return this.getToken().length > 0;
  },

  /* ------------------------------------------------------------------ */
  /* Default data                                                        */
  /* ------------------------------------------------------------------ */
  _default() {
    return {
      configured: false,
      purse: 100000,
      minSquad: 3,
      maxSquad: 8,
      teams: [],
      players: [],
      auction: { currentPlayerId: null, currentBid: 0, leadingTeamId: null, increment: 1000, wheelIds: null }
    };
  },

  /* ------------------------------------------------------------------ */
  /* Local fallback snapshot                                             */
  /* ------------------------------------------------------------------ */
  _saveLocal() {
    try {
      localStorage.setItem(this.LOCAL_KEY, JSON.stringify(this._data));
    } catch (e) {
      console.warn('Local snapshot failed', e);
    }
  },

  _loadLocal() {
    try {
      const raw = localStorage.getItem(this.LOCAL_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('Local snapshot read failed', e);
    }
    return null;
  },

  /* ------------------------------------------------------------------ */
  /* Load from GitHub (falls back to local snapshot / default)           */
  /* ------------------------------------------------------------------ */
  async load() {
    if (this._loading) return this._data;
    this._loading = true;

    try {
      const url = `https://api.github.com/repos/${this.OWNER}/${this.REPO}/contents/${this.FILE_PATH}?ref=${this.BRANCH}&_=${Date.now()}`;
      const headers = { 'Accept': 'application/vnd.github.v3+json' };
      const token = this.getToken();
      if (token) headers['Authorization'] = `token ${token}`;

      const response = await fetch(url, { headers, cache: 'no-store' });

      if (!response.ok) {
        console.warn('GitHub load failed (' + response.status + '), using local/default.');
        this._data = this._loadLocal() || this._default();
        return this._data;
      }

      const json = await response.json();
      this._sha = json.sha;
      const content = atob((json.content || '').replace(/\n/g, ''));
      this._data = JSON.parse(decodeURIComponent(escape(content)));
      this._saveLocal();
    } catch (error) {
      console.error('Error loading from GitHub:', error);
      this._data = this._data || this._loadLocal() || this._default();
    } finally {
      this._loading = false;
    }

    return this._data;
  },

  /* ------------------------------------------------------------------ */
  /* Save to GitHub (always writes local snapshot too)                   */
  /* ------------------------------------------------------------------ */
  async save() {
    // Always keep a local snapshot so nothing is lost if the remote write fails.
    this._saveLocal();

    if (!this.isConfigured()) {
      // No token: local-only mode. Not an error - the app still works.
      return false;
    }

    try {
      const url = `https://api.github.com/repos/${this.OWNER}/${this.REPO}/contents/${this.FILE_PATH}`;
      const token = this.getToken();

      // Refresh SHA to avoid conflicts.
      const getResp = await fetch(`${url}?ref=${this.BRANCH}&_=${Date.now()}`, {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store'
      });
      if (getResp.ok) {
        const existing = await getResp.json();
        this._sha = existing.sha;
      }

      const content = btoa(unescape(encodeURIComponent(JSON.stringify(this._data, null, 2))));
      const body = {
        message: `Auction update - ${new Date().toLocaleString()}`,
        content: content,
        branch: this.BRANCH
      };
      if (this._sha) body.sha = this._sha;

      const putResp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify(body)
      });

      if (!putResp.ok) {
        const err = await putResp.json().catch(function () { return {}; });
        console.error('GitHub save failed:', err);
        return false;
      }

      const result = await putResp.json();
      this._sha = result.content.sha;
      return true;
    } catch (error) {
      console.error('Error saving to GitHub:', error);
      return false;
    }
  },

  /* ------------------------------------------------------------------ */
  /* Data accessors                                                      */
  /* ------------------------------------------------------------------ */
  async _ensure() {
    if (!this._data) await this.load();
    return this._data;
  },

  // Synchronous access to the cached state (after load()).
  get() {
    return this._data;
  },

  // Replace the whole state object and persist.
  async set(data) {
    this._data = data;
    return this.save();
  },

  // Test the current GitHub connection. Returns { ok, status, message }.
  async testConnection() {
    const token = this.getToken();
    const url = `https://api.github.com/repos/${this.OWNER}/${this.REPO}/contents/${this.FILE_PATH}?ref=${this.BRANCH}&_=${Date.now()}`;
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `token ${token}`;
    try {
      const resp = await fetch(url, { headers, cache: 'no-store' });
      if (resp.ok) return { ok: true, status: resp.status, message: 'Connected. data file found.' };
      if (resp.status === 404) return { ok: false, status: 404, message: 'Repo or data file not found. Check owner/repo/path.' };
      if (resp.status === 401) return { ok: false, status: 401, message: 'Unauthorized. Check your token.' };
      return { ok: false, status: resp.status, message: 'GitHub returned ' + resp.status };
    } catch (e) {
      return { ok: false, status: 0, message: 'Network error: ' + e.message };
    }
  },

  async clearAll() {
    this._data = this._default();
    return this.save();
  }
};

Store.init();
