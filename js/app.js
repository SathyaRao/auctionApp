/* ============================================================
   Cricket Auction - UI + auction engine.
   Data is persisted through Store (js/store.js), which writes to
   a GitHub JSON file (data/data.json) with a localStorage fallback,
   mirroring the IronWill gym-management app's storage mechanism.
   ============================================================ */

(function () {
  'use strict';

  var MIN_TEAMS = 4;
  var MAX_TEAMS = 8;

  /* -------------------- View-only (spectator) mode -------------------- */
  // Enabled via ?mode=view (or ?view=1) in the URL. Spectators can watch the
  // auction live but cannot bid, sell, add players, reset, or change settings.
  var VIEW_ONLY = (function () {
    try {
      var params = new URLSearchParams(window.location.search);
      var mode = (params.get('mode') || '').toLowerCase();
      return mode === 'view' || mode === 'spectator' || params.get('view') === '1';
    } catch (e) {
      return false;
    }
  })();
  var POLL_MS = 5000;          // how often spectators refresh from the store
  var pollTimer = null;

  /* ==========================================================
     AUTH - admin password gate (all views except ?mode=view)
     ----------------------------------------------------------
     Client-side apps can't offer real server-enforced auth, so this
     is a soft gate: the password is compared as a SHA-256 hash so the
     plaintext isn't in the source, and an unlock is remembered for the
     browser session. It deters casual access; it is NOT strong security.
     ========================================================== */
  var Auth = {
    HASH_KEY: 'cricket-auction-admin-hash',
    UNLOCK_KEY: 'cricket-auction-unlocked',
    DEFAULT_PASSWORD: 'admin123',

    // SHA-256 -> hex, always resolving. On file:// (a non-secure context)
    // crypto.subtle.digest() rejects with a SecurityError, so we only use it
    // in a secure context and fall back to a deterministic hash otherwise.
    // Any unexpected rejection also falls back, so verify() never hangs.
    hash: function (text) {
      var canSubtle = !!(window.crypto && window.crypto.subtle && window.isSecureContext === true);
      if (!canSubtle) {
        return Promise.resolve(Auth._fallbackHash(text));
      }
      try {
        var enc = new TextEncoder().encode(text);
        return window.crypto.subtle.digest('SHA-256', enc).then(function (buf) {
          var bytes = new Uint8Array(buf);
          var hex = '';
          for (var i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, '0');
          }
          return hex;
        }).catch(function () {
          return Auth._fallbackHash(text);
        });
      } catch (e) {
        return Promise.resolve(Auth._fallbackHash(text));
      }
    },

    // Deterministic non-crypto fallback (djb2). Only used when SubtleCrypto is missing.
    _fallbackHash: function (text) {
      var h = 5381;
      for (var i = 0; i < text.length; i++) {
        h = ((h << 5) + h) + text.charCodeAt(i);
        h = h & 0xffffffff;
      }
      return 'fb' + (h >>> 0).toString(16);
    },

    getStoredHash: function () {
      return localStorage.getItem(this.HASH_KEY) || '';
    },

    // Ensure a hash exists; seed with the default password on first run.
    ensureInitialized: function () {
      if (this.getStoredHash()) return Promise.resolve();
      var self = this;
      return this.hash(this.DEFAULT_PASSWORD).then(function (h) {
        localStorage.setItem(self.HASH_KEY, h);
      });
    },

    verify: function (password) {
      var self = this;
      return this.hash(password).then(function (h) {
        return h === self.getStoredHash();
      });
    },

    setPassword: function (password) {
      var self = this;
      return this.hash(password).then(function (h) {
        localStorage.setItem(self.HASH_KEY, h);
      });
    },

    isUnlocked: function () {
      return sessionStorage.getItem(this.UNLOCK_KEY) === '1';
    },

    markUnlocked: function () {
      sessionStorage.setItem(this.UNLOCK_KEY, '1');
    },

    lock: function () {
      sessionStorage.removeItem(this.UNLOCK_KEY);
    }
  };

  /* -------------------- Seed player pool -------------------- */
  var SEED_PLAYERS = [
    ['Virat Kohli', 'Batsman', 15],
    ['Rohit Sharma', 'Batsman', 14],
    ['Jasprit Bumrah', 'Bowler', 13],
    ['Ravindra Jadeja', 'All-rounder', 12],
    ['MS Dhoni', 'Wicket-keeper', 12],
    ['KL Rahul', 'Wicket-keeper', 11],
    ['Hardik Pandya', 'All-rounder', 12],
    ['Rashid Khan', 'Bowler', 12],
    ['Suryakumar Yadav', 'Batsman', 10],
    ['Shubman Gill', 'Batsman', 10],
    ['Mohammed Shami', 'Bowler', 9],
    ['Rishabh Pant', 'Wicket-keeper', 11],
    ['Yuzvendra Chahal', 'Bowler', 8],
    ['Shreyas Iyer', 'Batsman', 9],
    ['Bhuvneshwar Kumar', 'Bowler', 7],
    ['Axar Patel', 'All-rounder', 8],
    ['Ishan Kishan', 'Wicket-keeper', 8],
    ['Deepak Chahar', 'Bowler', 6],
    ['Washington Sundar', 'All-rounder', 6],
    ['Prithvi Shaw', 'Batsman', 5]
  ];

  /* -------------------- State -------------------- */
  // `state` is the in-memory object owned by Store; app.js mutates it then calls save().
  var state = null;

  function defaultState() {
    return {
      configured: false,
      purse: 100000,
      minSquad: 3,
      maxSquad: 8,
      teams: [],      // { id, name, purse, players: [playerId] }
      players: [],    // { id, name, category, base, status, soldTo, price }
      auction: {
        currentPlayerId: null,
        currentBid: 0,
        leadingTeamId: null,
        increment: 1000
      }
    };
  }

  function seedPlayers() {
    return SEED_PLAYERS.map(function (p, i) {
      return {
        id: 'p' + i,
        name: p[0],
        category: p[1],
        base: p[2],
        status: 'available', // available | sold | unsold
        soldTo: null,
        price: 0
      };
    });
  }

  /* -------------------- Persistence (delegates to Store) -------------------- */
  // Persist the current state through the GitHub-backed Store.
  // Store.set() writes a local snapshot immediately and pushes to GitHub if a
  // token is configured. This is fire-and-forget from the UI's perspective;
  // the sync badge reflects the remote result.
  function save() {
    setSyncBadge('saving');
    Store.set(state).then(function (remoteOk) {
      setSyncBadge(remoteOk ? 'synced' : (Store.isConfigured() ? 'error' : 'local'));
    }).catch(function () {
      setSyncBadge('error');
    });
  }

  // Load state from Store (GitHub -> local snapshot -> default).
  function load() {
    return Store.load().then(function (data) {
      state = data || defaultState();
      // Make sure the in-memory reference and Store's cache are the same object.
      Store._data = state;
      setSyncBadge(Store.isConfigured() ? 'synced' : 'local');
      return !!(state && state.configured);
    }).catch(function () {
      state = defaultState();
      Store._data = state;
      setSyncBadge('local');
      return false;
    });
  }

  /* -------------------- Sync badge -------------------- */
  function setSyncBadge(mode) {
    var badge = document.getElementById('syncBadge');
    if (!badge) return;
    var map = {
      local:  { text: 'Local only',  cls: 'sync-local' },
      saving: { text: 'Saving...',   cls: 'sync-saving' },
      synced: { text: 'Synced',      cls: 'sync-synced' },
      error:  { text: 'Sync error',  cls: 'sync-error' }
    };
    var m = map[mode] || map.local;
    badge.textContent = m.text;
    badge.className = 'sync-badge ' + m.cls;
  }

  /* -------------------- DOM helpers -------------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmt(n) {
    // trim trailing .0 but keep decimals when present
    return (Math.round(n * 100) / 100).toString();
  }

  var toastTimer = null;
  function toast(msg, type) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* -------------------- View switching -------------------- */
  function showView(name) {
    ['setup', 'auction', 'teams', 'players', 'settings'].forEach(function (v) {
      var sec = $('view-' + v);
      if (sec) sec.hidden = (v !== name);
    });
    document.querySelectorAll('.tab-btn[data-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === name);
    });
  }

  /* ==========================================================
     SETUP
     ========================================================== */
  function renderTeamNameInputs() {
    var wrap = $('teamNamesWrap');
    wrap.innerHTML = '';
    var n = clampTeams(parseInt($('numTeams').value, 10));
    for (var i = 0; i < n; i++) {
      var input = el('input');
      input.type = 'text';
      input.placeholder = 'Team ' + (i + 1);
      input.value = 'Team ' + (i + 1);
      input.setAttribute('data-team-idx', i);
      wrap.appendChild(input);
    }
  }

  function clampTeams(n) {
    if (isNaN(n)) return MIN_TEAMS;
    return Math.max(MIN_TEAMS, Math.min(MAX_TEAMS, n));
  }

  function setupError(msg) {
    var box = $('setupError');
    if (!msg) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = msg;
  }

  function startAuction() {
    setupError('');
    var n = clampTeams(parseInt($('numTeams').value, 10));
    var purse = parseFloat($('purse').value);
    var minSquad = parseInt($('minSquad').value, 10);
    var maxSquad = parseInt($('maxSquad').value, 10);

    if (isNaN(purse) || purse <= 0) return setupError('Purse must be a positive number.');
    if (isNaN(minSquad) || minSquad < 1) return setupError('Minimum squad size must be at least 1.');
    if (isNaN(maxSquad) || maxSquad < minSquad) return setupError('Maximum squad must be greater than or equal to minimum.');

    var nameInputs = document.querySelectorAll('#teamNamesWrap input');
    var names = [];
    for (var i = 0; i < nameInputs.length; i++) {
      var nm = nameInputs[i].value.trim() || ('Team ' + (i + 1));
      if (names.indexOf(nm.toLowerCase()) !== -1) {
        return setupError('Team names must be unique. Duplicate: "' + nm + '"');
      }
      names.push(nm.toLowerCase());
    }

    state = defaultState();
    state.configured = true;
    state.purse = purse;
    state.minSquad = minSquad;
    state.maxSquad = maxSquad;
    state.teams = [];
    for (var j = 0; j < n; j++) {
      state.teams.push({
        id: 't' + j,
        name: nameInputs[j].value.trim() || ('Team ' + (j + 1)),
        purse: purse,
        players: []
      });
    }
    state.players = seedPlayers();

    save();
    $('tabs').hidden = false;
    showView('auction');
    renderAll();
    toast('Auction started with ' + n + ' teams', 'success');
  }

  /* ==========================================================
     AUCTION ENGINE
     ========================================================== */
  function getPlayer(id) {
    return state.players.filter(function (p) { return p.id === id; })[0] || null;
  }
  function getTeam(id) {
    return state.teams.filter(function (t) { return t.id === id; })[0] || null;
  }
  function availablePlayers() {
    return state.players.filter(function (p) { return p.status === 'available'; });
  }

  function bringNextPlayer() {
    var pool = availablePlayers();
    if (pool.length === 0) {
      toast('No more players available', 'error');
      return;
    }
    var pick = pool[Math.floor(Math.random() * pool.length)];
    state.auction.currentPlayerId = pick.id;
    state.auction.currentBid = pick.base;
    state.auction.leadingTeamId = null;
    save();
    renderAuction();
  }

  function canTeamBid(team, nextBid) {
    if (!team) return false;
    if (team.players.length >= state.maxSquad) return false;
    if (team.purse < nextBid) return false;
    return true;
  }

  function placeBid(teamId) {
    var a = state.auction;
    if (!a.currentPlayerId) return;
    var team = getTeam(teamId);
    if (!team) return;

    // First bid lands at base price; subsequent bids add increment.
    var nextBid;
    if (a.leadingTeamId === null) {
      nextBid = a.currentBid; // base price
    } else {
      nextBid = a.currentBid + a.increment;
    }

    if (team.players.length >= state.maxSquad) {
      return toast(team.name + ' squad is full', 'error');
    }
    if (team.purse < nextBid) {
      return toast(team.name + ' cannot afford ' + fmt(nextBid), 'error');
    }
    // Prevent a team from bidding against itself.
    if (a.leadingTeamId === teamId) {
      return toast(team.name + ' already leads this bid', 'error');
    }

    a.currentBid = nextBid;
    a.leadingTeamId = teamId;
    save();
    renderAuction();
  }

  function sellToLeader() {
    var a = state.auction;
    if (!a.currentPlayerId || a.leadingTeamId === null) return;
    var player = getPlayer(a.currentPlayerId);
    var team = getTeam(a.leadingTeamId);
    if (!player || !team) return;

    if (team.purse < a.currentBid) {
      return toast('Insufficient purse', 'error');
    }

    team.purse = Math.round((team.purse - a.currentBid) * 100) / 100;
    team.players.push(player.id);
    player.status = 'sold';
    player.soldTo = team.id;
    player.price = a.currentBid;

    var soldMsg = player.name + ' sold to ' + team.name + ' for ' + fmt(a.currentBid);

    a.currentPlayerId = null;
    a.currentBid = 0;
    a.leadingTeamId = null;
    save();
    toast(soldMsg, 'success');
    renderAll();

    if (availablePlayers().length === 0) {
      toast('All players auctioned!', 'success');
    }
  }

  function markUnsold() {
    var a = state.auction;
    if (!a.currentPlayerId) return;
    var player = getPlayer(a.currentPlayerId);
    if (player) {
      player.status = 'unsold';
    }
    a.currentPlayerId = null;
    a.currentBid = 0;
    a.leadingTeamId = null;
    save();
    toast((player ? player.name : 'Player') + ' marked unsold');
    renderAll();
  }

  function setIncrement(inc) {
    state.auction.increment = inc;
    save();
    document.querySelectorAll('#incrementGroup .chip').forEach(function (c) {
      c.classList.toggle('active', parseInt(c.getAttribute('data-inc'), 10) === inc);
    });
  }

  /* -------------------- Auction render -------------------- */
  function renderAuction() {
    var a = state.auction;
    var block = $('playerBlock');
    var empty = $('auctionEmpty');
    var player = a.currentPlayerId ? getPlayer(a.currentPlayerId) : null;

    if (!player) {
      block.hidden = true;
      empty.hidden = false;
      var emptyMsg = $('auctionEmptyMsg');
      if (emptyMsg) {
        emptyMsg.textContent = VIEW_ONLY
          ? 'Waiting for the auctioneer to bring the next player...'
          : 'No player on the block.';
      }
      $('nextPlayerBtn').disabled = availablePlayers().length === 0;
    } else {
      empty.hidden = true;
      block.hidden = false;
      $('cpCategory').textContent = player.category;
      $('cpName').textContent = player.name;
      $('cpMeta').textContent = 'Base price: ' + fmt(player.base);
      $('cpBid').textContent = fmt(a.currentBid);
      var leader = a.leadingTeamId ? getTeam(a.leadingTeamId) : null;
      $('cpLeader').textContent = leader ? ('Leading: ' + leader.name) : 'No bids yet';
      $('sellBtn').disabled = a.leadingTeamId === null;

      renderTeamBidButtons();
    }

    renderPurseList();
    $('queueInfo').textContent = 'Players remaining: ' + availablePlayers().length;
  }

  function renderTeamBidButtons() {
    var wrap = $('teamBidButtons');
    wrap.innerHTML = '';
    var a = state.auction;
    var nextBid = a.leadingTeamId === null ? a.currentBid : a.currentBid + a.increment;

    state.teams.forEach(function (team) {
      var btn = el('button', 'team-bid-btn');
      if (a.leadingTeamId === team.id) btn.classList.add('leading');
      var affordable = canTeamBid(team, nextBid) && a.leadingTeamId !== team.id;
      // Spectators can never bid.
      btn.disabled = VIEW_ONLY || !affordable;

      var name = el('span', 'tname', team.name);
      var sub = el('span', 'tpurse',
        'Purse ' + fmt(team.purse) + ' | ' + team.players.length + '/' + state.maxSquad + ' players');
      btn.appendChild(name);
      btn.appendChild(sub);

      var label = el('span');
      label.style.fontSize = '13px';
      label.style.color = 'var(--accent)';
      if (VIEW_ONLY) {
        label.textContent = a.leadingTeamId === team.id ? 'Leading' : ('Next ' + fmt(nextBid));
      } else {
        label.textContent = a.leadingTeamId === team.id ? 'Leading' : ('Bid ' + fmt(nextBid));
      }
      btn.appendChild(label);

      if (!VIEW_ONLY) {
        btn.addEventListener('click', function () { placeBid(team.id); });
      }
      wrap.appendChild(btn);
    });
  }

  function renderPurseList() {
    var list = $('purseList');
    list.innerHTML = '';
    state.teams.forEach(function (team) {
      var li = el('li');
      var left = el('span', null, team.name);
      var right = el('span');
      var purse = el('strong', null, fmt(team.purse));
      var count = el('span', 'count', ' (' + team.players.length + '/' + state.maxSquad + ')');
      right.appendChild(purse);
      right.appendChild(count);
      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    });
  }

  /* ==========================================================
     TEAMS DASHBOARD
     ========================================================== */
  function renderTeams() {
    var grid = $('teamsGrid');
    grid.innerHTML = '';
    state.teams.forEach(function (team) {
      var spent = state.purse - team.purse;
      var card = el('div', 'card team-card');

      var head = el('div', 'team-head');
      head.appendChild(el('h3', null, team.name));
      var need = Math.max(0, state.minSquad - team.players.length);
      var badge = el('span', 'muted', need > 0 ? ('needs ' + need + ' more') : 'squad complete');
      head.appendChild(badge);
      card.appendChild(head);

      var stats = el('div', 'team-stats');
      stats.appendChild(statBox('Purse left', fmt(team.purse)));
      stats.appendChild(statBox('Spent', fmt(Math.round(spent * 100) / 100)));
      stats.appendChild(statBox('Players', String(team.players.length)));
      card.appendChild(stats);

      var roster = el('ul', 'roster');
      if (team.players.length === 0) {
        roster.appendChild(el('li', 'roster-empty', 'No players yet'));
      } else {
        team.players.forEach(function (pid) {
          var p = getPlayer(pid);
          if (!p) return;
          var li = el('li');
          var nm = el('span', null, p.name + '  ');
          var cat = el('span', 'muted', p.category);
          nm.appendChild(cat);
          li.appendChild(nm);
          li.appendChild(el('span', 'rprice', fmt(p.price)));
          roster.appendChild(li);
        });
      }
      card.appendChild(roster);
      grid.appendChild(card);
    });
  }

  function statBox(label, value) {
    var box = el('div', 'stat');
    box.appendChild(el('span', 'label', label));
    box.appendChild(el('span', 'value', value));
    return box;
  }

  /* ==========================================================
     PLAYERS POOL
     ========================================================== */
  function renderPlayers() {
    var tbody = $('playersTbody');
    tbody.innerHTML = '';
    state.players.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', null, p.name));
      tr.appendChild(el('td', null, p.category));
      tr.appendChild(el('td', null, fmt(p.base)));

      var statusTd = el('td');
      var tag = el('span', 'status-tag status-' + p.status, p.status);
      statusTd.appendChild(tag);
      tr.appendChild(statusTd);

      var soldTeam = p.soldTo ? getTeam(p.soldTo) : null;
      tr.appendChild(el('td', null, soldTeam ? soldTeam.name : '-'));
      tr.appendChild(el('td', null, p.status === 'sold' ? fmt(p.price) : '-'));

      var actionTd = el('td');
      if (!VIEW_ONLY) {
        if (p.status === 'available') {
          var del = el('button', 'link-btn', 'Remove');
          del.addEventListener('click', function () { removePlayer(p.id); });
          actionTd.appendChild(del);
        } else if (p.status === 'unsold') {
          var re = el('button', 'link-btn', 'Re-list');
          re.style.color = 'var(--primary)';
          re.addEventListener('click', function () { relistPlayer(p.id); });
          actionTd.appendChild(re);
        }
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
  }

  function addPlayer() {
    var name = $('newPlayerName').value.trim();
    var category = $('newPlayerCategory').value;
    var base = parseFloat($('newPlayerBase').value);
    if (!name) return toast('Enter a player name', 'error');
    if (isNaN(base) || base < 0) return toast('Enter a valid base price', 'error');

    var id = 'p' + Date.now();
    state.players.push({
      id: id, name: name, category: category, base: base,
      status: 'available', soldTo: null, price: 0
    });
    save();
    $('newPlayerName').value = '';
    $('newPlayerBase').value = '2';
    $('addPlayerForm').hidden = true;
    renderPlayers();
    renderAuction();
    toast(name + ' added to the pool', 'success');
  }

  function removePlayer(id) {
    state.players = state.players.filter(function (p) { return p.id !== id; });
    if (state.auction.currentPlayerId === id) {
      state.auction.currentPlayerId = null;
      state.auction.currentBid = 0;
      state.auction.leadingTeamId = null;
    }
    save();
    renderPlayers();
    renderAuction();
  }

  function relistPlayer(id) {
    var p = getPlayer(id);
    if (p && p.status === 'unsold') {
      p.status = 'available';
      save();
      renderPlayers();
      renderAuction();
      toast(p.name + ' is back in the pool');
    }
  }

  /* ==========================================================
     RESET
     ========================================================== */
  function resetAll() {
    if (!confirm('Reset the entire auction? This clears all teams, bids and player results.')) return;
    state = defaultState();
    // Persist the empty state to the store (local snapshot + GitHub if configured).
    Store.set(state).then(function (remoteOk) {
      setSyncBadge(remoteOk ? 'synced' : (Store.isConfigured() ? 'error' : 'local'));
    });
    Store._data = state;
    $('tabs').hidden = true;
    prefillSetup();
    showView('setup');
    toast('Auction reset');
  }

  /* ==========================================================
     RENDER ALL
     ========================================================== */
  function renderAll() {
    renderAuction();
    renderTeams();
    renderPlayers();
  }

  /* ==========================================================
     SETTINGS
     ========================================================== */
  function prefillSettingsForm() {
    var cfg = Store.getConfig();
    $('ghToken').value = Store.getToken();
    $('ghOwner').value = cfg.owner || '';
    $('ghRepo').value = cfg.repo || '';
    $('ghBranch').value = cfg.branch || 'main';
    $('ghPath').value = cfg.filePath || 'data/data.json';
  }

  function settingsMsg(msg, isError) {
    var box = $('settingsMsg');
    if (!msg) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = msg;
    box.style.borderColor = isError ? 'var(--danger)' : 'var(--success)';
    box.style.background = isError ? 'rgba(224,83,83,0.15)' : 'rgba(47,184,101,0.15)';
    box.style.color = isError ? '#ffb4b4' : '#7de0a5';
  }

  function applySettings() {
    Store.setToken($('ghToken').value);
    Store.saveConfig({
      owner: $('ghOwner').value.trim(),
      repo: $('ghRepo').value.trim(),
      branch: $('ghBranch').value.trim() || 'main',
      filePath: $('ghPath').value.trim() || 'data/data.json'
    });
  }

  function saveSettings() {
    applySettings();
    settingsMsg('Settings saved. Syncing current auction to GitHub...', false);
    setSyncBadge('saving');
    Store.set(state).then(function (ok) {
      if (ok) {
        settingsMsg('Saved and synced to GitHub successfully.', false);
        setSyncBadge('synced');
        toast('Synced to GitHub', 'success');
      } else if (Store.isConfigured()) {
        settingsMsg('Saved locally, but GitHub sync failed. Use "Test connection" to diagnose.', true);
        setSyncBadge('error');
      } else {
        settingsMsg('Saved locally (no token, running in local-only mode).', false);
        setSyncBadge('local');
      }
    });
  }

  function testConnection() {
    applySettings();
    settingsMsg('Testing connection...', false);
    Store.testConnection().then(function (res) {
      settingsMsg(res.message, !res.ok);
    });
  }

  /* ==========================================================
     WIRING
     ========================================================== */
  function prefillSetup() {
    $('numTeams').value = MIN_TEAMS;
    $('purse').value = 100000;
    $('minSquad').value = 3;
    $('maxSquad').value = 8;
    renderTeamNameInputs();
    setupError('');
  }

  function wireEvents() {
    // Setup steppers
    $('teamsMinus').addEventListener('click', function () {
      $('numTeams').value = clampTeams(parseInt($('numTeams').value, 10) - 1);
      renderTeamNameInputs();
    });
    $('teamsPlus').addEventListener('click', function () {
      $('numTeams').value = clampTeams(parseInt($('numTeams').value, 10) + 1);
      renderTeamNameInputs();
    });
    $('numTeams').addEventListener('change', function () {
      $('numTeams').value = clampTeams(parseInt($('numTeams').value, 10));
      renderTeamNameInputs();
    });
    $('startBtn').addEventListener('click', startAuction);

    // Tabs
    document.querySelectorAll('.tab-btn[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
    });
    $('resetBtn').addEventListener('click', resetAll);

    // Auction
    $('nextPlayerBtn').addEventListener('click', bringNextPlayer);
    $('sellBtn').addEventListener('click', sellToLeader);
    $('unsoldBtn').addEventListener('click', markUnsold);
    document.querySelectorAll('#incrementGroup .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        setIncrement(parseInt(c.getAttribute('data-inc'), 10));
      });
    });

    // Players
    $('addPlayerBtn').addEventListener('click', function () {
      var f = $('addPlayerForm');
      f.hidden = !f.hidden;
    });
    $('savePlayerBtn').addEventListener('click', addPlayer);
    $('cancelPlayerBtn').addEventListener('click', function () {
      $('addPlayerForm').hidden = true;
    });

    // Settings
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('testConnBtn').addEventListener('click', testConnection);

    // Spectator link
    var watchBtn = $('watchLinkBtn');
    if (watchBtn) watchBtn.addEventListener('click', shareViewLink);

    // Gate (admin password)
    var unlockBtn = $('gateUnlockBtn');
    if (unlockBtn) unlockBtn.addEventListener('click', attemptUnlock);
    var gatePwd = $('gatePassword');
    if (gatePwd) gatePwd.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') attemptUnlock();
    });
    var changeBtn = $('changePasswordBtn');
    if (changeBtn) changeBtn.addEventListener('click', changePassword);
    var resetLink = $('gateResetLink');
    if (resetLink) resetLink.addEventListener('click', resetPasswordToDefault);
  }

  /* ==========================================================
     GATE (admin password screen)
     ========================================================== */
  var afterUnlock = null; // callback to run once unlocked

  function showGate(onUnlock) {
    afterUnlock = onUnlock;
    document.body.classList.add('locked');
    var overlay = $('gateOverlay');
    overlay.hidden = false;
    var input = $('gatePassword');
    $('gateError').hidden = true;
    setTimeout(function () { if (input) input.focus(); }, 50);
  }

  function hideGate() {
    document.body.classList.remove('locked');
    document.documentElement.classList.remove('prelock');
    $('gateOverlay').hidden = true;
  }

  function resetPasswordToDefault(e) {
    if (e) e.preventDefault();
    if (!confirm('Reset the admin password back to the default ("admin123")?')) return;
    localStorage.removeItem(Auth.HASH_KEY);
    Auth.setPassword(Auth.DEFAULT_PASSWORD).then(function () {
      var errBox = $('gateError');
      errBox.hidden = false;
      errBox.style.borderColor = 'var(--success)';
      errBox.style.background = 'rgba(47,184,101,0.15)';
      errBox.style.color = '#7de0a5';
      errBox.textContent = 'Password reset to default. Enter "admin123" to unlock.';
      var input = $('gatePassword');
      if (input) { input.value = ''; input.focus(); }
    });
  }

  function attemptUnlock() {
    var pwd = $('gatePassword').value;
    var errBox = $('gateError');
    // Reset error styling to the default (red) each attempt.
    errBox.style.borderColor = 'var(--danger)';
    errBox.style.background = 'rgba(224,83,83,0.15)';
    errBox.style.color = '#ffb4b4';
    Auth.verify(pwd).then(function (ok) {
      if (ok) {
        Auth.markUnlocked();
        $('gatePassword').value = '';
        hideGate();
        if (typeof afterUnlock === 'function') afterUnlock();
      } else {
        errBox.hidden = false;
        errBox.textContent = 'Incorrect password. Try again.';
        $('gatePassword').select();
      }
    });
  }

  function passwordMsg(msg, isError) {
    var box = $('passwordMsg');
    if (!msg) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = msg;
    box.style.borderColor = isError ? 'var(--danger)' : 'var(--success)';
    box.style.background = isError ? 'rgba(224,83,83,0.15)' : 'rgba(47,184,101,0.15)';
    box.style.color = isError ? '#ffb4b4' : '#7de0a5';
  }

  function changePassword() {
    var cur = $('curPassword').value;
    var next = $('newPassword').value;
    var confirm2 = $('confirmPassword').value;

    if (!next) return passwordMsg('Enter a new password.', true);
    if (next.length < 4) return passwordMsg('New password must be at least 4 characters.', true);
    if (next !== confirm2) return passwordMsg('New passwords do not match.', true);

    Auth.verify(cur).then(function (ok) {
      if (!ok) return passwordMsg('Current password is incorrect.', true);
      Auth.setPassword(next).then(function () {
        $('curPassword').value = '';
        $('newPassword').value = '';
        $('confirmPassword').value = '';
        passwordMsg('Password changed successfully.', false);
        toast('Admin password updated', 'success');
      });
    });
  }

  /* ==========================================================
     VIEW-ONLY (SPECTATOR) MODE
     ========================================================== */
  function buildViewLink() {
    var base = window.location.href.split('#')[0].split('?')[0];
    return base + '?mode=view';
  }

  function shareViewLink() {
    var link = buildViewLink();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () {
        toast('Spectator link copied to clipboard', 'success');
      }, function () {
        window.prompt('Copy this spectator link:', link);
      });
    } else {
      window.prompt('Copy this spectator link:', link);
    }
  }

  function applyViewOnlyMode() {
    document.body.classList.add('view-only');
    var banner = $('spectatorBanner');
    if (banner) banner.hidden = false;
    // Spectators cannot reach Setup or Settings; keep them on the live views.
    var setup = $('view-setup');
    if (setup) setup.hidden = true;
    // Live remote updates require the shared GitHub store. Without it we can only
    // show whatever snapshot exists in this browser, so tell the spectator.
    if (!Store.getToken() && (!Store.getConfig().owner || Store.getConfig().owner === 'sathyarao')) {
      // Still poll GitHub anonymously - works for public repos even without a token.
      console.info('Spectator mode: polling the configured GitHub repo for live updates.');
    }
    startPolling();
  }

  function flashLive() {
    var flag = $('liveFlag');
    if (!flag) return;
    flag.classList.remove('pulsing');
    // reflow to restart the animation
    void flag.offsetWidth;
    flag.classList.add('pulsing');
  }

  function startPolling() {
    stopPolling();
    // Only poll when the tab is visible, to avoid needless GitHub calls.
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      Store.load().then(function (data) {
        if (!data) return;
        state = data;
        Store._data = state;
        // If the auction has started, make sure the live views are shown.
        if (state.configured) {
          $('tabs').hidden = false;
          var current = document.querySelector('.tab-btn[data-view].active');
          var activeView = current ? current.getAttribute('data-view') : 'auction';
          if (activeView === 'setup' || activeView === 'settings') activeView = 'auction';
          showView(activeView);
        }
        renderAll();
        flashLive();
      }).catch(function () { /* ignore transient poll errors */ });
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ==========================================================
     BOOT
     ========================================================== */
  function boot() {
    wireEvents();

    /* ---------- Spectator (view-only) path ---------- */
    if (VIEW_ONLY) {
      document.documentElement.classList.remove('prelock');
      applyViewOnlyMode();
      state = defaultState();
      showView('auction');
      load().then(function (configured) {
        if (configured && state && state.configured) {
          $('tabs').hidden = false;
          setIncrement((state.auction && state.auction.increment) || 1000);
          showView('auction');
          renderAll();
        } else {
          // Auction not started yet - show the waiting state.
          $('tabs').hidden = false;
          showView('auction');
          renderAll();
        }
      });
      return;
    }

    /* ---------- Admin path (password protected) ---------- */
    Auth.ensureInitialized().then(function () {
      if (Auth.isUnlocked()) {
        document.documentElement.classList.remove('prelock');
        startAdmin();
      } else {
        showGate(startAdmin);
      }
    });
  }

  // Admin startup: runs only after the password gate is passed.
  function startAdmin() {
    prefillSettingsForm();
    // Show setup immediately with a "loading" hint, then hydrate from Store.
    state = defaultState();
    prefillSetup();
    showView('setup');

    load().then(function (configured) {
      if (configured && state && state.configured) {
        $('tabs').hidden = false;
        setIncrement((state.auction && state.auction.increment) || 1000);
        showView('auction');
        renderAll();
      } else {
        state = defaultState();
        prefillSetup();
        showView('setup');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
