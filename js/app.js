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
  var BASE_PRICE = 1000; // every player starts at this base price
  var SEED_PLAYERS = [
    ['Virat Kohli', 'Batsman', BASE_PRICE],
    ['Rohit Sharma', 'Batsman', BASE_PRICE],
    ['Jasprit Bumrah', 'Bowler', BASE_PRICE],
    ['Ravindra Jadeja', 'All-rounder', BASE_PRICE],
    ['MS Dhoni', 'Wicket-keeper', BASE_PRICE],
    ['KL Rahul', 'Wicket-keeper', BASE_PRICE],
    ['Hardik Pandya', 'All-rounder', BASE_PRICE],
    ['Rashid Khan', 'Bowler', BASE_PRICE],
    ['Suryakumar Yadav', 'Batsman', BASE_PRICE],
    ['Shubman Gill', 'Batsman', BASE_PRICE],
    ['Mohammed Shami', 'Bowler', BASE_PRICE],
    ['Rishabh Pant', 'Wicket-keeper', BASE_PRICE],
    ['Yuzvendra Chahal', 'Bowler', BASE_PRICE],
    ['Shreyas Iyer', 'Batsman', BASE_PRICE],
    ['Bhuvneshwar Kumar', 'Bowler', BASE_PRICE],
    ['Axar Patel', 'All-rounder', BASE_PRICE],
    ['Ishan Kishan', 'Wicket-keeper', BASE_PRICE],
    ['Deepak Chahar', 'Bowler', BASE_PRICE],
    ['Washington Sundar', 'All-rounder', BASE_PRICE],
    ['Prithvi Shaw', 'Batsman', BASE_PRICE]
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
        increment: 1000,
        wheelIds: null   // null = "not initialized"; [] = explicitly empty
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
    return Store.set(state).then(function (remoteOk) {
      if (remoteOk) {
        setSyncBadge('synced');
      } else if (Store.isConfigured()) {
        setSyncBadge('error');
        toast('Could not save to the file (GitHub). Your change may be lost on refresh. Check Settings.', 'error');
      } else {
        setSyncBadge('local');
        toast('No GitHub token set — changes are local only and will be lost on refresh. Add a token in Settings.', 'error');
      }
      return remoteOk;
    }).catch(function () {
      setSyncBadge('error');
      toast('Save failed. Your change may be lost on refresh.', 'error');
      return false;
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
    updateTokenBanner();
  }

  // Show a prominent banner whenever there's no token, so the user knows
  // changes are NOT being written to the file and will be lost on refresh.
  function updateTokenBanner() {
    var banner = document.getElementById('noTokenBanner');
    if (!banner) return;
    banner.hidden = VIEW_ONLY || Store.isConfigured();
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

  /* -------------------- Pagination -------------------- */
  var PAGE_SIZES = { players: 10, teams: 10 };
  var pageState = { players: 0, teams: 0 };

  // Clamp a page index against the total item count and page size.
  function clampPage(view, total) {
    var size = PAGE_SIZES[view];
    var pages = Math.max(1, Math.ceil(total / size));
    if (pageState[view] > pages - 1) pageState[view] = pages - 1;
    if (pageState[view] < 0) pageState[view] = 0;
    return pageState[view];
  }

  // Return the slice of items for the current page of a view.
  function paginate(view, items) {
    var size = PAGE_SIZES[view];
    var page = clampPage(view, items.length);
    return items.slice(page * size, page * size + size);
  }

  // Render a pager control into the element with the given id.
  function renderPager(pagerId, view, total, onChange) {
    var pager = $(pagerId);
    if (!pager) return;
    var size = PAGE_SIZES[view];
    var pages = Math.max(1, Math.ceil(total / size));
    if (total <= size) { pager.hidden = true; pager.innerHTML = ''; return; }

    pager.hidden = false;
    pager.innerHTML = '';
    var page = clampPage(view, total);

    var prev = el('button', 'pager-btn', 'Prev');
    prev.disabled = page === 0;
    prev.addEventListener('click', function () {
      pageState[view] = Math.max(0, page - 1);
      onChange();
    });

    var start = page * size + 1;
    var end = Math.min(total, page * size + size);
    var info = el('span', 'pager-info', start + '-' + end + ' of ' + total + '  (page ' + (page + 1) + '/' + pages + ')');

    var next = el('button', 'pager-btn', 'Next');
    next.disabled = page >= pages - 1;
    next.addEventListener('click', function () {
      pageState[view] = Math.min(pages - 1, page + 1);
      onChange();
    });

    pager.appendChild(prev);
    pager.appendChild(info);
    pager.appendChild(next);
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

  // Put a specific available player onto the auction block.
  function putPlayerOnBlock(playerId) {
    var pick = getPlayer(playerId);
    if (!pick || pick.status !== 'available') return false;
    state.auction.currentPlayerId = pick.id;
    state.auction.currentBid = pick.base;
    state.auction.leadingTeamId = null;
    save();
    renderAuction();
    return true;
  }

  function bringNextPlayer() {
    var pool = availablePlayers();
    if (pool.length === 0) {
      toast('No more players available', 'error');
      return;
    }
    var pick = pool[Math.floor(Math.random() * pool.length)];
    putPlayerOnBlock(pick.id);
  }

  function canTeamBid(team, nextBid) {
    if (!team) return false;
    if (team.players.length >= state.maxSquad) return false;
    if (team.purse < nextBid) return false;
    return true;
  }

  /**
   * Maximum a team can bid for the current player while still being able to fill
   * its remaining required squad slots at base price.
   *
   *   maxBid = purse - (base * (totalSlots - playersBought - 1))
   *
   * where base is the current player's base price (the per-slot reserve) and
   * totalSlots is the maximum squad size. The "- 1" excludes the slot being
   * filled by this very player. Clamped to [0, purse]; returns null if the squad
   * is already full or there is no player on the block.
   */
  function maxBidForTeam(team) {
    if (!team) return null;
    if (team.players.length >= state.maxSquad) return null;
    var player = state.auction.currentPlayerId ? getPlayer(state.auction.currentPlayerId) : null;
    if (!player) return null;
    var base = player.base || 0;
    var slotsToReserve = Math.max(0, state.maxSquad - team.players.length - 1);
    var max = team.purse - (base * slotsToReserve);
    if (max < 0) max = 0;
    if (max > team.purse) max = team.purse;
    return Math.round(max * 100) / 100;
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

      var maxBid = maxBidForTeam(team);
      if (maxBid !== null) {
        var maxLine = el('span', 'tmaxbid', 'Max bid ' + fmt(maxBid));
        btn.appendChild(maxLine);
      }

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
      var maxBid = maxBidForTeam(team);
      if (maxBid !== null) {
        var maxEl = el('span', 'max-bid', ' max ' + fmt(maxBid));
        right.appendChild(maxEl);
      }
      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    });
  }

  /* ==========================================================
     TEAMS DASHBOARD
     ========================================================== */
  // Tracks which team card is currently in name-edit mode (id or null).
  var editingTeamId = null;
  // Tracks which team card has its manual "add player" form open (id or null).
  var manualAddTeamId = null;

  function renderTeams() {
    var grid = $('teamsGrid');
    grid.innerHTML = '';

    var pageTeams = paginate('teams', state.teams);

    pageTeams.forEach(function (team) {
      var spent = state.purse - team.purse;
      var card = el('div', 'card team-card');

      var head = el('div', 'team-head');
      if (!VIEW_ONLY && editingTeamId === team.id) {
        // Inline edit mode for the team name.
        var editRow = el('div', 'name-edit-row');
        var input = el('input');
        input.type = 'text';
        input.value = team.name;
        var saveT = el('button', 'icon-btn save', '\u2713');
        saveT.title = 'Save';
        var cancelT = el('button', 'icon-btn cancel', '\u2715');
        cancelT.title = 'Cancel';
        var commit = function () { saveTeamName(team.id, input.value); };
        saveT.addEventListener('click', commit);
        cancelT.addEventListener('click', function () { editingTeamId = null; renderTeams(); });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { editingTeamId = null; renderTeams(); }
        });
        editRow.appendChild(input);
        editRow.appendChild(saveT);
        editRow.appendChild(cancelT);
        head.appendChild(editRow);
        setTimeout(function () { input.focus(); input.select(); }, 20);
      } else {
        var titleWrap = el('span');
        titleWrap.style.display = 'inline-flex';
        titleWrap.style.alignItems = 'center';
        titleWrap.appendChild(el('h3', null, team.name));
        if (!VIEW_ONLY) {
          var editT = el('button', 'icon-btn edit', '\u270e');
          editT.title = 'Edit team name';
          editT.addEventListener('click', function () { editingTeamId = team.id; renderTeams(); });
          titleWrap.appendChild(editT);
        }
        head.appendChild(titleWrap);
        var need = Math.max(0, state.minSquad - team.players.length);
        var badge = el('span', 'muted', need > 0 ? ('needs ' + need + ' more') : 'squad complete');
        head.appendChild(badge);
      }
      card.appendChild(head);

      var stats = el('div', 'team-stats');
      stats.appendChild(statBox('Purse left', fmt(team.purse)));
      stats.appendChild(statBox('Spent', fmt(Math.round(spent * 100) / 100)));
      stats.appendChild(statBox('Players', String(team.players.length)));
      card.appendChild(stats);

      if (team.players.length === 0) {
        card.appendChild(el('p', 'roster-empty', 'No players yet'));
      } else {
        var rosterPlayers = team.players
          .map(function (pid) { return getPlayer(pid); })
          .filter(function (p) { return !!p; });

        var table = el('table', 'roster-table');
        var thead = el('thead');
        var htr = el('tr');
        htr.appendChild(el('th', null, '#'));
        htr.appendChild(el('th', null, 'Player'));
        htr.appendChild(el('th', null, 'Category'));
        htr.appendChild(el('th', 'ta-right', 'Sold price'));
        if (!VIEW_ONLY) htr.appendChild(el('th', null, ''));
        thead.appendChild(htr);
        table.appendChild(thead);

        var tbody = el('tbody');
        rosterPlayers.forEach(function (p, i) {
          var row = el('tr');
          row.appendChild(el('td', null, String(i + 1)));
          row.appendChild(el('td', null, p.name));
          row.appendChild(el('td', 'muted', p.category));
          row.appendChild(el('td', 'ta-right rprice', fmt(p.price)));
          if (!VIEW_ONLY) {
            var actTd = el('td', 'ta-right');
            var rel = el('button', 'icon-btn cancel', '\u2715');
            rel.title = 'Remove from team (return to pool)';
            rel.addEventListener('click', function () { releasePlayerFromTeam(team.id, p.id); });
            actTd.appendChild(rel);
            row.appendChild(actTd);
          }
          tbody.appendChild(row);
        });

        // Totals footer
        var totalSpent = rosterPlayers.reduce(function (sum, p) { return sum + (p.price || 0); }, 0);
        table.appendChild(tbody);

        var tfoot = el('tfoot');
        var ftr = el('tr');
        ftr.appendChild(el('td', null, ''));
        var ftd = el('td', null, 'Total (' + rosterPlayers.length + ')');
        ftd.colSpan = 2;
        ftr.appendChild(ftd);
        ftr.appendChild(el('td', 'ta-right rprice', fmt(Math.round(totalSpent * 100) / 100)));
        if (!VIEW_ONLY) ftr.appendChild(el('td', null, ''));
        tfoot.appendChild(ftr);
        table.appendChild(tfoot);

        card.appendChild(table);
      }

      // --- Admin: manually add an available player to this team ---
      if (!VIEW_ONLY) {
        var squadFull = team.players.length >= state.maxSquad;
        if (manualAddTeamId === team.id && !squadFull) {
          var addWrap = el('div', 'manual-add-row');
          var sel = el('select');
          var avail = availablePlayers();
          if (avail.length === 0) {
            sel.appendChild(el('option', null, 'No available players'));
            sel.disabled = true;
          } else {
            avail.forEach(function (p) {
              var opt = el('option', null, p.name + ' (' + p.category + ', base ' + fmt(p.base) + ')');
              opt.value = p.id;
              sel.appendChild(opt);
            });
          }
          var priceInput = el('input');
          priceInput.type = 'number';
          priceInput.min = '0';
          priceInput.step = '100';
          priceInput.placeholder = 'Price';
          // default price = selected player's base
          if (avail.length > 0) priceInput.value = avail[0].base;
          sel.addEventListener('change', function () {
            var p = getPlayer(sel.value);
            if (p) priceInput.value = p.base;
          });
          var addBtn = el('button', 'btn success', 'Add');
          addBtn.addEventListener('click', function () {
            addPlayerToTeamManually(team.id, sel.value, priceInput.value);
          });
          var cancelBtn = el('button', 'btn ghost', 'Cancel');
          cancelBtn.addEventListener('click', function () { manualAddTeamId = null; renderTeams(); });
          addWrap.appendChild(sel);
          addWrap.appendChild(priceInput);
          addWrap.appendChild(addBtn);
          addWrap.appendChild(cancelBtn);
          card.appendChild(addWrap);
        } else {
          var addPlayerBtn = el('button', 'btn ghost team-add-btn', '+ Add player');
          addPlayerBtn.disabled = squadFull;
          if (squadFull) addPlayerBtn.title = 'Squad is full';
          addPlayerBtn.addEventListener('click', function () {
            manualAddTeamId = team.id;
            renderTeams();
          });
          card.appendChild(addPlayerBtn);
        }
      }

      grid.appendChild(card);
    });

    renderPager('teamsPager', 'teams', state.teams.length, renderTeams);
  }

  function saveTeamName(id, newName) {
    var name = (newName || '').trim();
    if (!name) return toast('Team name cannot be empty', 'error');
    // Enforce uniqueness (case-insensitive), ignoring the team being edited.
    var dup = state.teams.some(function (t) {
      return t.id !== id && t.name.toLowerCase() === name.toLowerCase();
    });
    if (dup) return toast('Another team already has that name', 'error');

    var team = getTeam(id);
    if (!team) return;
    team.name = name;
    editingTeamId = null;
    save();
    renderTeams();
    renderAuction();   // purse panel + bid buttons show team names
    toast('Team renamed', 'success');
  }

  function statBox(label, value) {
    var box = el('div', 'stat');
    box.appendChild(el('span', 'label', label));
    box.appendChild(el('span', 'value', value));
    return box;
  }

  /* ==========================================================
     PDF EXPORT (print-to-PDF, no external dependency)
     ========================================================== */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Shared print styles + open/print a generated document in a new window.
  function openPrintDocument(title, bodyHtml) {
    var win = window.open('', '_blank');
    if (!win) {
      toast('Popup blocked. Allow popups to export PDF.', 'error');
      return;
    }
    var css =
      'body{font-family:"Segoe UI",Arial,sans-serif;color:#111;margin:24px;}' +
      'h1{font-size:20px;margin:0 0 4px;}' +
      '.meta{color:#666;font-size:12px;margin-bottom:18px;}' +
      'h2{font-size:15px;margin:18px 0 6px;border-bottom:2px solid #222;padding-bottom:3px;}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;}' +
      'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;}' +
      'th{background:#f0f0f0;}' +
      'td.num,th.num{text-align:right;}' +
      'tfoot td{font-weight:bold;background:#fafafa;}' +
      '.team-block{page-break-inside:avoid;margin-bottom:8px;}' +
      '@media print{.no-print{display:none;}}';
    var html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>' +
      '<style>' + css + '</style></head><body>' + bodyHtml +
      '<script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script>' +
      '</body></html>';
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  // Export the final team list: each team with its roster + spent/purse.
  function exportTeamsPdf() {
    if (!state.teams || state.teams.length === 0) {
      return toast('No teams to export', 'error');
    }
    var now = new Date().toLocaleString();
    var body = '<h1>Cricket Auction — Final Team List</h1>' +
      '<div class="meta">Generated ' + escapeHtml(now) + '</div>';

    state.teams.forEach(function (team) {
      var rosterPlayers = (team.players || [])
        .map(function (pid) { return getPlayer(pid); })
        .filter(function (p) { return !!p; });
      var spent = Math.round((state.purse - team.purse) * 100) / 100;

      body += '<div class="team-block"><h2>' + escapeHtml(team.name) +
        '  —  Players: ' + rosterPlayers.length +
        ' | Spent: ' + escapeHtml(fmt(spent)) +
        ' | Purse left: ' + escapeHtml(fmt(team.purse)) + '</h2>';

      if (rosterPlayers.length === 0) {
        body += '<p style="color:#888;">No players.</p></div>';
        return;
      }

      body += '<table><thead><tr><th>#</th><th>Player</th><th>Category</th>' +
        '<th class="num">Price</th></tr></thead><tbody>';
      rosterPlayers.forEach(function (p, i) {
        body += '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(p.name) +
          '</td><td>' + escapeHtml(p.category) + '</td><td class="num">' +
          escapeHtml(fmt(p.price)) + '</td></tr>';
      });
      var total = rosterPlayers.reduce(function (s, p) { return s + (p.price || 0); }, 0);
      body += '</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">' +
        escapeHtml(fmt(Math.round(total * 100) / 100)) + '</td></tr></tfoot></table></div>';
    });

    openPrintDocument('Final Team List', body);
  }

  // Export the sold list: every sold player with team + price, sorted by price desc.
  function exportSoldPdf() {
    var sold = state.players
      .filter(function (p) { return p.status === 'sold'; })
      .sort(function (a, b) { return (b.price || 0) - (a.price || 0); });

    if (sold.length === 0) {
      return toast('No players sold yet', 'error');
    }
    var now = new Date().toLocaleString();
    var totalSpend = sold.reduce(function (s, p) { return s + (p.price || 0); }, 0);

    var body = '<h1>Cricket Auction — Sold Players List</h1>' +
      '<div class="meta">Generated ' + escapeHtml(now) +
      ' &nbsp;|&nbsp; ' + sold.length + ' players sold &nbsp;|&nbsp; total spend ' +
      escapeHtml(fmt(Math.round(totalSpend * 100) / 100)) + '</div>';

    body += '<table><thead><tr><th>#</th><th>Player</th><th>Category</th>' +
      '<th>Team</th><th class="num">Base</th><th class="num">Sold price</th></tr></thead><tbody>';
    sold.forEach(function (p, i) {
      var team = p.soldTo ? getTeam(p.soldTo) : null;
      body += '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(p.name) +
        '</td><td>' + escapeHtml(p.category) + '</td><td>' +
        escapeHtml(team ? team.name : '-') + '</td><td class="num">' +
        escapeHtml(fmt(p.base)) + '</td><td class="num">' + escapeHtml(fmt(p.price)) +
        '</td></tr>';
    });
    body += '</tbody><tfoot><tr><td colspan="5">Total spend</td><td class="num">' +
      escapeHtml(fmt(Math.round(totalSpend * 100) / 100)) + '</td></tr></tfoot></table>';

    openPrintDocument('Sold Players List', body);
  }

  // Manually assign an available player to a team (outside the auction flow).
  // Deducts price from the team purse and marks the player sold - mirrors sellToLeader.
  function addPlayerToTeamManually(teamId, playerId, priceRaw) {
    var team = getTeam(teamId);
    if (!team) return;
    if (!playerId) return toast('Select a player to add', 'error');

    var player = getPlayer(playerId);
    if (!player) return toast('Player not found', 'error');
    if (player.status !== 'available') {
      return toast(player.name + ' is not available', 'error');
    }
    if (team.players.length >= state.maxSquad) {
      return toast(team.name + ' squad is full', 'error');
    }

    var price = parseFloat(priceRaw);
    if (isNaN(price) || price < 0) return toast('Enter a valid price', 'error');
    if (team.purse < price) {
      return toast(team.name + ' cannot afford ' + fmt(price) + ' (purse ' + fmt(team.purse) + ')', 'error');
    }

    team.purse = Math.round((team.purse - price) * 100) / 100;
    team.players.push(player.id);
    player.status = 'sold';
    player.soldTo = team.id;
    player.price = price;

    // If this player happened to be on the auction block, clear the block.
    if (state.auction.currentPlayerId === player.id) {
      state.auction.currentPlayerId = null;
      state.auction.currentBid = 0;
      state.auction.leadingTeamId = null;
    }

    manualAddTeamId = null;
    save().then(function (ok) {
      if (ok) toast(player.name + ' added to ' + team.name + ' for ' + fmt(price), 'success');
    });
    renderAll(); // teams, players pool, purse panel, wheel all reflect the change
  }

  // Release a player from a team back into the available pool, refunding the purse.
  function releasePlayerFromTeam(teamId, playerId) {
    var team = getTeam(teamId);
    var player = getPlayer(playerId);
    if (!team || !player) return;
    if (!confirm('Remove ' + player.name + ' from ' + team.name + ' and return them to the pool?')) {
      return;
    }

    team.players = team.players.filter(function (id) { return id !== playerId; });
    // Refund the price that was paid for this player.
    team.purse = Math.round((team.purse + (player.price || 0)) * 100) / 100;
    player.status = 'available';
    player.soldTo = null;
    player.price = 0;

    save().then(function (ok) {
      if (ok) toast(player.name + ' returned to the pool', 'success');
    });
    renderAll();
  }

  /* ==========================================================
     PLAYERS POOL
     ========================================================== */
  // Tracks which player row is currently in name-edit mode (id or null).
  var editingPlayerId = null;

  function renderPlayers() {
    var tbody = $('playersTbody');
    tbody.innerHTML = '';

    var all = state.players;
    var pagePlayers = paginate('players', all);

    var CATEGORIES = ['Batsman', 'Bowler', 'All-rounder', 'Wicket-keeper'];

    pagePlayers.forEach(function (p) {
      var tr = el('tr');
      var editing = !VIEW_ONLY && editingPlayerId === p.id;

      // --- Name cell (inline-editable when not view-only) ---
      var nameTd = el('td');
      var cell = el('div', 'player-name-cell');
      if (editing) {
        var input = el('input');
        input.type = 'text';
        input.value = p.name;
        var saveP = el('button', 'icon-btn save', '\u2713');
        saveP.title = 'Save';
        var cancelP = el('button', 'icon-btn cancel', '\u2715');
        cancelP.title = 'Cancel';
        var commit = function () {
          savePlayerRow(p.id, input.value, catSelect.value, baseInput.value);
        };
        saveP.addEventListener('click', commit);
        cancelP.addEventListener('click', function () { editingPlayerId = null; renderPlayers(); });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { editingPlayerId = null; renderPlayers(); }
        });
        cell.appendChild(input);
        cell.appendChild(saveP);
        cell.appendChild(cancelP);
        nameTd.appendChild(cell);
        setTimeout(function () { input.focus(); input.select(); }, 20);
      } else {
        cell.appendChild(el('span', null, p.name));
        if (!VIEW_ONLY) {
          var editP = el('button', 'icon-btn edit', '\u270e');
          editP.title = 'Edit player';
          editP.addEventListener('click', function () { editingPlayerId = p.id; renderPlayers(); });
          cell.appendChild(editP);
        }
        nameTd.appendChild(cell);
      }
      tr.appendChild(nameTd);

      // --- Category cell (editable when this row is in edit mode) ---
      var catSelect;
      var catTd = el('td');
      if (editing) {
        catSelect = el('select');
        CATEGORIES.forEach(function (c) {
          var opt = el('option', null, c);
          opt.value = c;
          if (c === p.category) opt.selected = true;
          catSelect.appendChild(opt);
        });
        catTd.appendChild(catSelect);
      } else {
        catTd.textContent = p.category;
      }
      tr.appendChild(catTd);

      // --- Base price cell (editable when this row is in edit mode) ---
      var baseInput;
      var baseTd = el('td');
      if (editing) {
        baseInput = el('input');
        baseInput.type = 'number';
        baseInput.min = '0';
        baseInput.step = '100';
        baseInput.value = p.base;
        baseInput.style.maxWidth = '110px';
        baseInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') savePlayerRow(p.id, input.value, catSelect.value, baseInput.value);
          if (e.key === 'Escape') { editingPlayerId = null; renderPlayers(); }
        });
        baseTd.appendChild(baseInput);
      } else {
        baseTd.textContent = fmt(p.base);
      }
      tr.appendChild(baseTd);

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

    renderPager('playersPager', 'players', all.length, renderPlayers);
  }

  function savePlayerRow(id, newName, newCategory, newBase) {
    var name = (newName || '').trim();
    if (!name) return toast('Player name cannot be empty', 'error');

    var base = parseFloat(newBase);
    if (isNaN(base) || base < 0) return toast('Enter a valid base price', 'error');

    var p = getPlayer(id);
    if (!p) return;

    p.name = name;
    if (newCategory) p.category = newCategory;
    p.base = base;
    // If this player is currently on the block and hasn't received a bid yet,
    // keep the current bid in sync with the (possibly changed) base price.
    if (state.auction.currentPlayerId === id && state.auction.leadingTeamId === null) {
      state.auction.currentBid = base;
    }

    editingPlayerId = null;
    save();
    renderPlayers();
    renderWheel();        // wheel labels reflect the new name
    renderAuction();      // reflect name/base if this player is on the block
    toast('Player updated', 'success');
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
    $('newPlayerName').value = '';
    $('newPlayerBase').value = String(BASE_PRICE);
    $('addPlayerForm').hidden = true;
    renderPlayers();
    renderAuction();
    // Only confirm success once the write to the file actually completes,
    // so a refresh right after can't lose the entry.
    save().then(function (ok) {
      if (ok) toast(name + ' added and saved to file', 'success');
    });
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

  // Remove every player from the pool (does not touch teams/purses).
  function deleteAllPlayers() {
    if (state.players.length === 0) {
      return toast('There are no players to delete', 'error');
    }
    if (!confirm('Delete ALL ' + state.players.length + ' players from the pool? This cannot be undone.')) {
      return;
    }
    state.players = [];
    // Clear anything that referenced players.
    state.auction.currentPlayerId = null;
    state.auction.currentBid = 0;
    state.auction.leadingTeamId = null;
    state.auction.wheelIds = [];
    save();
    renderPlayers();
    renderAuction();
    renderWheel();
    toast('All players deleted', 'success');
  }

  // Parse "Name, Category, BasePrice" lines and add them to the pool.
  function bulkUploadPlayers() {
    var raw = $('bulkUploadText').value;
    var lines = raw.split('\n');
    var validCats = ['Batsman', 'Bowler', 'All-rounder', 'Wicket-keeper'];
    // case-insensitive lookup for category normalization
    var catLookup = {};
    validCats.forEach(function (c) { catLookup[c.toLowerCase()] = c; });

    var added = 0;
    var skipped = 0;
    var errors = [];

    lines.forEach(function (line, idx) {
      var trimmed = line.trim();
      if (!trimmed) return; // ignore blank lines

      var parts = trimmed.split(',').map(function (s) { return s.trim(); });
      var name = parts[0];
      if (!name) { skipped++; return; }

      // Category (optional, default Batsman)
      var category = 'Batsman';
      if (parts.length >= 2 && parts[1]) {
        var norm = catLookup[parts[1].toLowerCase()];
        if (norm) {
          category = norm;
        } else {
          errors.push('Line ' + (idx + 1) + ': unknown category "' + parts[1] + '"');
          skipped++;
          return;
        }
      }

      // Base price (optional, default BASE_PRICE)
      var base = BASE_PRICE;
      if (parts.length >= 3 && parts[2] !== '') {
        var parsed = parseFloat(parts[2]);
        if (isNaN(parsed) || parsed < 0) {
          errors.push('Line ' + (idx + 1) + ': invalid base price "' + parts[2] + '"');
          skipped++;
          return;
        }
        base = parsed;
      }

      state.players.push({
        id: 'p' + Date.now() + '_' + idx,
        name: name,
        category: category,
        base: base,
        status: 'available',
        soldTo: null,
        price: 0
      });
      added++;
    });

    if (added === 0) {
      var msg = 'No players added.';
      if (errors.length) msg += ' ' + errors[0];
      return toast(msg, 'error');
    }

    save();
    $('bulkUploadText').value = '';
    $('bulkUploadForm').hidden = true;
    renderPlayers();
    renderAuction();
    renderWheel();

    var summary = 'Added ' + added + ' player' + (added === 1 ? '' : 's');
    if (skipped) summary += ', skipped ' + skipped;
    toast(summary, 'success');
    if (errors.length) {
      // surface the first couple of issues so the user knows what was skipped
      setTimeout(function () { toast(errors.slice(0, 2).join(' | '), 'error'); }, 400);
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
    renderWheel();
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

  /* ---------- Token transfer (link + QR) ---------- */
  function buildTokenTransferUrl() {
    var token = ($('ghToken').value || '').trim() || Store.getToken();
    if (!token) {
      settingsMsg('Save a token first, then generate a transfer link.', true);
      return null;
    }
    var base = window.location.href.split('#')[0].split('?')[0];
    return base + '#token=' + encodeURIComponent(token);
  }

  function generateTokenTransfer() {
    var url = buildTokenTransferUrl();
    if (!url) return;
    $('tokenTransferArea').hidden = false;
    $('tokenLink').value = url;

    var box = $('tokenQr');
    box.innerHTML = '';
    if (typeof qrcode === 'function') {
      var qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createImgTag(5, 8);
    } else {
      box.innerHTML = '<span style="color:#e05353;">QR library failed to load. Use the link instead.</span>';
    }
    settingsMsg('', false);
  }

  function copyTokenLink() {
    var url = buildTokenTransferUrl();
    if (!url) return;
    $('tokenTransferArea').hidden = false;
    $('tokenLink').value = url;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        toast('Token link copied', 'success');
      }, function () {
        window.prompt('Copy this token link:', url);
      });
    } else {
      window.prompt('Copy this token link:', url);
    }
  }

  // Read a token passed via the URL hash (settings page link / QR), store it,
  // and strip it from the address bar. Returns true if a token was applied.
  function loadTokenFromUrl() {
    var hash = window.location.hash || '';
    var m = hash.match(/[#&]token=([^&]+)/);
    if (!m) return false;
    var incoming = '';
    try { incoming = decodeURIComponent(m[1]); } catch (e) { incoming = m[1]; }
    incoming = (incoming || '').trim();
    // Remove the token from the URL immediately for safety.
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!incoming) return false;
    Store.setToken(incoming);
    return true;
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

    // Bulk upload + delete all
    $('bulkUploadBtn').addEventListener('click', function () {
      var f = $('bulkUploadForm');
      f.hidden = !f.hidden;
      // hide the single-add form when opening bulk, to avoid confusion
      if (!f.hidden) $('addPlayerForm').hidden = true;
    });
    $('bulkUploadSaveBtn').addEventListener('click', bulkUploadPlayers);
    $('bulkUploadCancelBtn').addEventListener('click', function () {
      $('bulkUploadForm').hidden = true;
    });
    $('deleteAllPlayersBtn').addEventListener('click', deleteAllPlayers);

    // Spinner wheel
    var spinBtn = $('spinBtn');
    if (spinBtn) spinBtn.addEventListener('click', spinWheel);
    var wheelAddBtn = $('wheelAddBtn');
    if (wheelAddBtn) wheelAddBtn.addEventListener('click', function () {
      var sel = $('wheelAddSelect');
      if (sel && sel.value) addToWheel(sel.value);
    });
    var wheelAddAllBtn = $('wheelAddAllBtn');
    if (wheelAddAllBtn) wheelAddAllBtn.addEventListener('click', addAllAvailableToWheel);
    var wheelClearBtn = $('wheelClearBtn');
    if (wheelClearBtn) wheelClearBtn.addEventListener('click', clearWheel);

    // Settings
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('testConnBtn').addEventListener('click', testConnection);
    var genTokenBtn = $('genTokenLinkBtn');
    if (genTokenBtn) genTokenBtn.addEventListener('click', generateTokenTransfer);
    var copyTokenBtn = $('copyTokenLinkBtn');
    if (copyTokenBtn) copyTokenBtn.addEventListener('click', copyTokenLink);

    // PDF exports (Teams view)
    var expTeamsBtn = $('exportTeamsPdfBtn');
    if (expTeamsBtn) expTeamsBtn.addEventListener('click', exportTeamsPdf);
    var expSoldBtn = $('exportSoldPdfBtn');
    if (expSoldBtn) expSoldBtn.addEventListener('click', exportSoldPdf);

    // Spectator link
    var watchBtn = $('watchLinkBtn');
    if (watchBtn) watchBtn.addEventListener('click', shareViewLink);

    // No-token banner -> jump to Settings
    var noTokenLink = $('noTokenBannerLink');
    if (noTokenLink) noTokenLink.addEventListener('click', function (e) {
      e.preventDefault();
      showView('settings');
    });

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
     SPINNER WHEEL
     ----------------------------------------------------------
     state.auction.wheelIds holds the player ids currently on the wheel.
     null => not initialized yet (auto-fill with all available players).
     The wheel only ever shows still-available players.
     ========================================================== */
  var WHEEL_COLORS = [
    '#2f7bff', '#33d1a6', '#e0a129', '#e05353', '#8b5cf6',
    '#22b8cf', '#f06595', '#82c91e', '#fd7e14', '#4dabf7'
  ];
  var spinning = false;
  var wheelRotation = 0; // accumulated degrees

  function ensureWheelInit() {
    var a = state.auction;
    if (a.wheelIds === null || a.wheelIds === undefined) {
      a.wheelIds = availablePlayers().map(function (p) { return p.id; });
    }
  }

  // Players currently on the wheel AND still available.
  function wheelPlayers() {
    ensureWheelInit();
    var ids = state.auction.wheelIds || [];
    return ids
      .map(function (id) { return getPlayer(id); })
      .filter(function (p) { return p && p.status === 'available'; });
  }

  // Drop sold/unsold/removed players from the wheel id list (keep it clean).
  function pruneWheel() {
    var a = state.auction;
    if (!a.wheelIds) return;
    a.wheelIds = a.wheelIds.filter(function (id) {
      var p = getPlayer(id);
      return p && p.status === 'available';
    });
  }

  function drawWheel() {
    var canvas = $('wheelCanvas');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var cx = W / 2, cy = H / 2, r = Math.min(cx, cy) - 4;
    ctx.clearRect(0, 0, W, H);

    var players = wheelPlayers();
    var n = players.length;

    if (n === 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#232e45';
      ctx.fill();
      ctx.fillStyle = '#8ea0bd';
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No players on the wheel', cx, cy);
      return;
    }

    var seg = (Math.PI * 2) / n;
    for (var i = 0; i < n; i++) {
      var start = i * seg - Math.PI / 2; // start at top
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + seg);
      ctx.closePath();
      ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,20,32,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + seg / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#0f1420';
      ctx.font = 'bold ' + (n > 16 ? 10 : n > 10 ? 12 : 13) + 'px "Segoe UI", sans-serif';
      var label = players[i].name;
      if (label.length > 16) label = label.slice(0, 15) + '\u2026';
      ctx.fillText(label, r - 12, 0);
      ctx.restore();
    }

    // Hub
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#161d2e';
    ctx.fill();
    ctx.strokeStyle = '#33d1a6';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function spinWheel() {
    if (spinning) return;
    if (state.auction.currentPlayerId) {
      return toast('Finish the current player first (sell or mark unsold).', 'error');
    }
    var players = wheelPlayers();
    if (players.length === 0) {
      return toast('Add players to the wheel first.', 'error');
    }

    spinning = true;
    var canvas = $('wheelCanvas');
    var resultBox = $('wheelResult');
    if (resultBox) resultBox.hidden = true;

    var n = players.length;
    var seg = 360 / n;
    var winnerIndex = Math.floor(Math.random() * n);

    // The pointer sits at the top (12 o'clock). Segment i is centered at
    // angle (i*seg + seg/2) measured clockwise from the top. To bring that
    // center under the pointer we rotate by -(center) plus full spins.
    var spins = 5; // full rotations for effect
    var center = winnerIndex * seg + seg / 2;
    var target = spins * 360 + (360 - center);

    // Accumulate so each spin continues from the last angle.
    wheelRotation += target;
    if (canvas) canvas.style.transform = 'rotate(' + wheelRotation + 'deg)';

    var winner = players[winnerIndex];
    var spinBtn = $('spinBtn');
    if (spinBtn) spinBtn.disabled = true;

    // CSS transition is 4s; reveal + place the player when it settles.
    setTimeout(function () {
      spinning = false;
      if (spinBtn) spinBtn.disabled = false;
      if (resultBox) {
        resultBox.hidden = false;
        resultBox.textContent = winner.name;
      }
      putPlayerOnBlock(winner.id);
      toast(winner.name + ' is on the block!', 'success');
    }, 4100);
  }

  function renderWheelManage() {
    // Count
    var players = wheelPlayers();
    var countEl = $('wheelCount');
    if (countEl) countEl.textContent = players.length + (players.length === 1 ? ' player on the wheel' : ' players on the wheel');

    // Manage list
    var list = $('wheelList');
    if (list) {
      list.innerHTML = '';
      if (players.length === 0) {
        list.appendChild(el('li', 'wheel-list-empty', 'Wheel is empty. Add available players below.'));
      } else {
        players.forEach(function (p) {
          var li = el('li');
          li.appendChild(el('span', null, p.name));
          var rm = el('button', 'wl-remove', '\u00d7');
          rm.title = 'Remove from wheel';
          rm.addEventListener('click', function () { removeFromWheel(p.id); });
          li.appendChild(rm);
          list.appendChild(li);
        });
      }
    }

    // Add-select: available players NOT already on the wheel
    var select = $('wheelAddSelect');
    if (select) {
      var onWheel = {};
      (state.auction.wheelIds || []).forEach(function (id) { onWheel[id] = true; });
      var addable = availablePlayers().filter(function (p) { return !onWheel[p.id]; });
      select.innerHTML = '';
      var ph = el('option', null, addable.length ? 'Add a player to the wheel...' : 'All available players are on the wheel');
      ph.value = '';
      select.appendChild(ph);
      addable.forEach(function (p) {
        var opt = el('option', null, p.name);
        opt.value = p.id;
        select.appendChild(opt);
      });
      select.disabled = addable.length === 0;
    }
  }

  function renderWheel() {
    pruneWheel();
    drawWheel();
    renderWheelManage();
  }

  function addToWheel(playerId) {
    if (!playerId) return;
    ensureWheelInit();
    if (state.auction.wheelIds.indexOf(playerId) === -1) {
      state.auction.wheelIds.push(playerId);
      save();
      renderWheel();
    }
  }

  function removeFromWheel(playerId) {
    ensureWheelInit();
    state.auction.wheelIds = state.auction.wheelIds.filter(function (id) { return id !== playerId; });
    save();
    renderWheel();
  }

  function addAllAvailableToWheel() {
    state.auction.wheelIds = availablePlayers().map(function (p) { return p.id; });
    save();
    renderWheel();
    toast('Added all available players to the wheel', 'success');
  }

  function clearWheel() {
    state.auction.wheelIds = [];
    save();
    renderWheel();
    toast('Wheel cleared');
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
    if (!Store.getToken() && (!Store.getConfig().owner || Store.getConfig().owner === 'SathyaRao')) {
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

    // If a token was passed in via a transfer link/QR, store it before anything
    // else (works even behind the admin gate). Confirm once the UI is ready.
    var tokenFromLink = loadTokenFromUrl();
    if (tokenFromLink) {
      setTimeout(function () { toast('Token loaded from link', 'success'); }, 300);
    }

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
