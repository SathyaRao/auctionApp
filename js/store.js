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
  ACTIVE_KEY: 'cricket-auction-active-id',

  // --- Multi-auction container schema ---
  // The GitHub data file holds a container:
  //   { schema:'multi-v1', activeId, order:[id...], auctions:{ id:{ id, name, state } } }
  // where each `state` is a single-auction state object (the shape app.js uses).
  // Legacy files that are a bare state object are migrated into one auction on load.
  SCHEMA: 'multi-v1',

  // --- Internal state ---
  _data: null,        // the ACTIVE auction's state (what app.js reads/writes)
  _container: null,   // the full multi-auction container
  _activeId: null,    // id of the active auction within the container
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
  /* Multi-auction container helpers                                     */
  /* ------------------------------------------------------------------ */
  _newId() {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  },

  // Wrap a single state object into a fresh container with one auction.
  _wrapState(state, name) {
    const id = this._newId();
    const container = { schema: this.SCHEMA, activeId: id, order: [id], auctions: {} };
    container.auctions[id] = { id: id, name: name || 'Auction 1', state: state || this._default() };
    return container;
  },

  // Return true if the parsed object is already a multi-auction container.
  _isContainer(obj) {
    return !!(obj && obj.schema === this.SCHEMA && obj.auctions && typeof obj.auctions === 'object');
  },

  // Normalize any parsed file content into a valid container.
  // Legacy bare-state files are migrated into a single auction.
  _toContainer(obj) {
    if (this._isContainer(obj)) {
      if (!Array.isArray(obj.order)) obj.order = Object.keys(obj.auctions);
      if (!obj.activeId || !obj.auctions[obj.activeId]) obj.activeId = obj.order[0] || null;
      return obj;
    }
    // Legacy single-auction state (or null) -> wrap into a one-auction container.
    return this._wrapState(obj || this._default(), 'Auction 1');
  },

  // Pick which auction id should be active: a remembered local preference if it
  // still exists in the container, otherwise the container's own activeId.
  _resolveActiveId(container) {
    const preferred = localStorage.getItem(this.ACTIVE_KEY);
    if (preferred && container.auctions[preferred]) return preferred;
    if (container.activeId && container.auctions[container.activeId]) return container.activeId;
    return container.order[0] || null;
  },

  // Point internal pointers at the given auction id and sync container.activeId.
  _activate(id) {
    if (!this._container || !this._container.auctions[id]) return;
    this._activeId = id;
    this._container.activeId = id;
    this._data = this._container.auctions[id].state;
    localStorage.setItem(this.ACTIVE_KEY, id);
  },

  getActiveId() {
    return this._activeId;
  },

  // List auctions for the picker: [{ id, name, configured }] in container order.
  listAuctions() {
    if (!this._container) return [];
    return this._container.order
      .filter((id) => this._container.auctions[id])
      .map((id) => {
        const a = this._container.auctions[id];
        return { id: id, name: a.name, configured: !!(a.state && a.state.configured) };
      });
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
      // Persist the whole container so all auctions survive a refresh offline.
      const toStore = this._container || this._wrapState(this._data || this._default(), 'Auction 1');
      localStorage.setItem(this.LOCAL_KEY, JSON.stringify(toStore));
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
        this._container = this._toContainer(this._loadLocal());
        this._activate(this._resolveActiveId(this._container));
        return this._data;
      }

      const json = await response.json();
      this._sha = json.sha;
      const content = atob((json.content || '').replace(/\n/g, ''));
      const parsed = JSON.parse(decodeURIComponent(escape(content)));
      this._container = this._toContainer(parsed);
      this._activate(this._resolveActiveId(this._container));
      this._saveLocal();
    } catch (error) {
      console.error('Error loading from GitHub:', error);
      this._container = this._toContainer(this._container || this._loadLocal());
      this._activate(this._resolveActiveId(this._container));
    } finally {
      this._loading = false;
    }

    return this._data;
  },

  /* ------------------------------------------------------------------ */
  /* Save to GitHub (always writes local snapshot too)                   */
  /* ------------------------------------------------------------------ */
  // Fold the active in-memory state (_data) back into the container so the
  // container is the single source of truth before persisting.
  _syncActiveIntoContainer() {
    if (!this._container) {
      this._container = this._wrapState(this._data || this._default(), 'Auction 1');
      this._activeId = this._container.activeId;
    }
    if (this._activeId && this._container.auctions[this._activeId]) {
      this._container.auctions[this._activeId].state = this._data;
      this._container.activeId = this._activeId;
    }
  },

  async save() {
    // Make sure the container reflects the latest active-auction edits.
    this._syncActiveIntoContainer();
    // Always keep a local snapshot so nothing is lost if the remote write fails.
    this._saveLocal();

    if (!this.isConfigured()) {
      // No token: local-only mode. Not an error - the app still works.
      return false;
    }

    try {
      const url = `https://api.github.com/repos/${this.OWNER}/${this.REPO}/contents/${this.FILE_PATH}`;
      const token = this.getToken();

      // Refresh SHA AND merge: re-fetch the remote container so a concurrent edit
      // to a DIFFERENT auction (from another device) is not clobbered. We only
      // overwrite the active auction's slot; all other auctions keep remote state.
      const getResp = await fetch(`${url}?ref=${this.BRANCH}&_=${Date.now()}`, {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store'
      });
      if (getResp.ok) {
        const existing = await getResp.json();
        this._sha = existing.sha;
        try {
          const remoteRaw = atob((existing.content || '').replace(/\n/g, ''));
          const remote = this._toContainer(JSON.parse(decodeURIComponent(escape(remoteRaw))));
          // Start from the remote container, then apply our active auction.
          remote.auctions[this._activeId] = this._container.auctions[this._activeId];
          if (remote.order.indexOf(this._activeId) === -1) remote.order.push(this._activeId);
          remote.activeId = this._activeId;
          this._container = remote;
        } catch (mergeErr) {
          console.warn('Could not merge remote container; writing local container.', mergeErr);
        }
      }

      const content = btoa(unescape(encodeURIComponent(JSON.stringify(this._container, null, 2))));
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

  /* ------------------------------------------------------------------ */
  /* Auction management (multiple auctions)                              */
  /* ------------------------------------------------------------------ */

  // Create a new, empty auction, make it active, and persist. Returns its id.
  async createAuction(name) {
    this._syncActiveIntoContainer();
    const id = this._newId();
    const label = (name && name.trim()) || ('Auction ' + (this._container.order.length + 1));
    this._container.auctions[id] = { id: id, name: label, state: this._default() };
    this._container.order.push(id);
    this._activate(id);
    await this.save();
    return id;
  },

  // Activate an auction in memory only, WITHOUT saving (used by spectators who
  // must not write). Returns the active state, or null if the id is unknown.
  selectAuctionLocal(id) {
    if (!this._container || !this._container.auctions[id]) return null;
    this._syncActiveIntoContainer();
    this._activate(id);
    return this._data;
  },

  // Switch the active auction. Returns the newly active state (or null if unknown id).
  async switchAuction(id) {
    if (!this._container || !this._container.auctions[id]) return null;
    this._syncActiveIntoContainer();
    this._activate(id);
    // Persist the activeId change (also lets other devices see the switch).
    await this.save();
    return this._data;
  },

  // Rename an auction (defaults to the active one).
  async renameAuction(id, name) {
    const targetId = id || this._activeId;
    if (!this._container || !this._container.auctions[targetId]) return false;
    const label = (name && name.trim());
    if (!label) return false;
    this._container.auctions[targetId].name = label;
    await this.save();
    return true;
  },

  // Delete an auction. Refuses to delete the last remaining one. If the active
  // auction is deleted, activates the first remaining auction. Returns the new
  // active id, or null on failure.
  async deleteAuction(id) {
    const targetId = id || this._activeId;
    if (!this._container || !this._container.auctions[targetId]) return null;
    if (this._container.order.length <= 1) return null; // keep at least one
    delete this._container.auctions[targetId];
    this._container.order = this._container.order.filter((x) => x !== targetId);
    if (this._activeId === targetId) {
      this._activate(this._container.order[0]);
    }
    await this.save();
    return this._activeId;
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
