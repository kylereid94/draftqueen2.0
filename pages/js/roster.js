// pages/js/roster.js
// Renders the roster view for the active league
// Targets:
//   #my-roster            – current user's roster card
//   #league-members-list  – grid of other members' roster cards

(function(){
  const ACTIVE_LEAGUE_KEY = 'activeLeagueId';
  const ACTIVE_LEAGUE_STATUS_KEY = 'activeLeagueStatus';

  // Small DOM helpers
  const $ = (id) => document.getElementById(id);

  // Simple skeleton filler (in case HTML didn't include them)
  function ensureSkeletons() {
    const my = $('my-roster');
    if (my && !my.children.length) {
      my.innerHTML = `
        <div class="rounded-2xl glass-card p-4 border border-white/10 animate-pulse">
          <div class="flex items-center gap-3 mb-3">
            <div class="w-10 h-10 rounded-full bg-white/10"></div>
            <div class="h-4 bg-white/10 rounded w-24"></div>
          </div>
          <div class="flex flex-wrap gap-2">
            ${Array.from({length:4}).map(()=>'<span class="inline-flex items-center px-6 py-3 rounded-lg bg-white/10 text-xs h-6"></span>').join('')}
          </div>
        </div>`;
    }

    const list = $('league-members-list');
    if (list && !list.children.length) {
      list.innerHTML = `${Array.from({length:2}).map(()=>`
        <div class="member-card rounded-xl p-4 animate-pulse">
          <div class="flex items-center space-x-3 mb-3">
            <div class="w-8 h-8 rounded-full bg-white/10"></div>
            <div class="flex-1">
              <div class="h-4 bg-white/10 rounded w-20 mb-1"></div>
              <div class="h-3 bg-white/10 rounded w-16"></div>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <div class="h-4 bg-white/10 rounded w-10"></div>
            <div class="h-6 bg-white/10 rounded w-12"></div>
          </div>
        </div>`).join('')}`;
    }
  }

  // Supabase bootstrap (reads /supabase.txt like other pages)
  async function createSb() {
    const resp = await fetch('/supabase.txt');
    const text = await resp.text();
    const url = text.match(/^SUPABASE_URL=(.*)$/m)[1].trim();
    const key = text.match(/^SUPABASE_ANON_KEY=(.*)$/m)[1].trim();
    return supabase.createClient(url, key);
  }

  // Data loaders
  async function loadLeague(client, leagueId) {
    const { data, error } = await client
      .from('leagues')
      .select('id, status, roster_size, banner_image_url')
      .eq('id', leagueId)
      .single();
    if (error) throw error;
    return data;
  }

  async function loadMembers(client, leagueId) {
    // Get members in draft order
    const { data, error } = await client
      .from('league_members')
      .select('user_id, draft_position')
      .eq('league_id', leagueId)
      .order('draft_position', { ascending: true, nullsFirst: true });
    if (error) throw error;
    return data || [];
  }

  async function loadProfiles(client, userIds) {
    if (!userIds.length) return new Map();
    const { data, error } = await client
      .from('profiles')
      .select('id, display_name, avatar_url')
      .in('id', userIds);
    if (error) {
      console.warn('profiles RLS blocked or fetch failed:', error);
      return new Map();
    }
    const map = new Map();
    (data || []).forEach(p => map.set(p.id, p));
    return map;
  }

  async function loadPicks(client, leagueId) {
    // Helper to run the select with optional ordering
    async function run(orderBy) {
      let q = client
        .from('draft_picks')
        .select('user_id, contestant_id')
        .eq('league_id', leagueId);
      if (orderBy) q = q.order(orderBy, { ascending: true });
      return q;
    }

    // Try created_at → id → no order
    let picks, pErr;
    {
      const resp = await run('created_at');
      picks = resp.data; pErr = resp.error;
    }
    if (pErr) {
      const msg = (pErr.message || '').toLowerCase();
      const code = pErr.code || '';
      if (code === '42703' || msg.includes('created_at') || msg.includes('column') || msg.includes('bad request')) {
        const resp2 = await run('id');
        picks = resp2.data; pErr = resp2.error;
        if (pErr) {
          const resp3 = await run(null);
          picks = resp3.data; pErr = resp3.error;
        }
      }
    }
    if (pErr) { console.error('loadPicks failed after retries:', pErr); throw pErr; }

    const byUserIds = new Map();
    const contestantIds = new Set();
    (picks || []).forEach(row => {
      const arr = byUserIds.get(row.user_id) || [];
      arr.push(row.contestant_id);
      byUserIds.set(row.user_id, arr);
      if (row.contestant_id) contestantIds.add(row.contestant_id);
    });

    // Step 2: look up contestant names separately (avoids nested select RLS issues)
    let nameById = new Map();
    if (contestantIds.size) {
      const ids = Array.from(contestantIds);
      const { data: contestants, error: cErr } = await client
        .from('contestants')
        .select('id, name')
        .in('id', ids);
      if (cErr) {
        console.warn('contestants select blocked by RLS or failed:', cErr);
      } else {
        (contestants || []).forEach(c => nameById.set(c.id, c.name));
      }
    }

    // Build final map: user_id -> [{id, name}]
    const byUser = new Map();
    byUserIds.forEach((ids, uid) => {
      const rows = ids.map(id => ({ id, name: nameById.get(id) || `Contestant ${String(id).slice(0,4)}` }));
      byUser.set(uid, rows);
    });

    return byUser;
  }

  // Rendering
  function chip(name) {
    return `<span class="inline-flex items-center px-2 py-1 rounded-lg bg-white/10 text-xs">${name}</span>`;
  }
  function emptyChip() {
    return `<span class="inline-flex items-center px-2 py-1 rounded-lg bg-white/5 text-xs text-white/40">Empty</span>`;
  }

  function renderMyRoster({ meId, rosterSize, picksByUser, profilesById }) {
    const el = $('my-roster');
    if (!el) return;
    const prof = profilesById.get(meId) || {};
    const name = prof.display_name || 'You';
    const avatar = prof.avatar_url || 'https://i.pravatar.cc/64?img=4';
    const picks = picksByUser.get(meId) || [];
    const empties = Math.max(0, (Number(rosterSize) || 0) - picks.length);

    el.innerHTML = `
      <div class="rounded-2xl glass-card p-4 border border-white/10">
        <div class="flex items-center gap-3 mb-3">
          <img src="${avatar}" class="w-10 h-10 rounded-full" alt="${name}" />
          <div>
            <div class="text-sm font-semibold">${name} (You)</div>
            <div class="text-xs text-white/60">${picks.length}/${rosterSize} drafted</div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${picks.map(p => chip(p.name)).join('')}
          ${Array.from({length:empties}).map(() => emptyChip()).join('')}
        </div>
      </div>`;
  }

  function renderOtherMembers({ meId, rosterSize, members, picksByUser, profilesById }) {
    const list = $('league-members-list');
    if (!list) return;

    const sorted = [...members]
      .filter(m => m.user_id !== meId)
      .sort((a,b) => (a.draft_position || 1e9) - (b.draft_position || 1e9));

    if (!sorted.length) {
      list.innerHTML = `<div class="text-sm text-white/60">No other members yet.</div>`;
      return;
    }

    list.innerHTML = sorted.map(m => {
      const prof = profilesById.get(m.user_id) || {};
      const name = prof.display_name || 'Member';
      const avatar = prof.avatar_url || 'https://i.pravatar.cc/64?img=5';
      const picks = picksByUser.get(m.user_id) || [];
      const empties = Math.max(0, (Number(rosterSize) || 0) - picks.length);
      return `
        <div class="member-card rounded-xl p-4 glass-card border border-white/10">
          <div class="flex items-center space-x-3 mb-3">
            <img src="${avatar}" class="w-8 h-8 rounded-full" alt="${name}" />
            <div class="flex-1">
              <h4 class="font-semibold text-sm">${name}</h4>
              <p class="text-xs text-white/60">${picks.length}/${rosterSize} drafted</p>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            ${picks.map(p => chip(p.name)).join('')}
            ${Array.from({length:empties}).map(() => emptyChip()).join('')}
          </div>
        </div>`;
    }).join('');
  }

  // Main flow
  document.addEventListener('DOMContentLoaded', async () => {
    ensureSkeletons();

    let supabaseClient;
    try { supabaseClient = await createSb(); } catch (e) {
      console.error('Failed to init Supabase', e); return;
    }

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { window.location.href = '/pages/auth.html?returnTo=/pages/roster.html'; return; }

    // Resolve active league
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('league');
    let leagueId = fromUrl || localStorage.getItem(ACTIVE_LEAGUE_KEY);
    if (!leagueId) { window.location.href = '/pages/leagues.html'; return; }
    try { localStorage.setItem(ACTIVE_LEAGUE_KEY, leagueId); } catch {}

    // Load league
    let league;
    try {
      league = await loadLeague(supabaseClient, leagueId);
      try {
        localStorage.setItem(ACTIVE_LEAGUE_STATUS_KEY, league.status);
        // Update nav label immediately if helper exists
        if (window.__dqSetActiveLeagueStatus) window.__dqSetActiveLeagueStatus(league.status);
      } catch {}
    } catch (e) {
      console.error('Failed to load league', e);
      $('my-roster') && ($('my-roster').innerHTML = `<div class="text-sm text-pink-300">Failed to load league.</div>`);
      return;
    }

    // Load members + profiles + picks
    try {
      const members = await loadMembers(supabaseClient, leagueId);
      const userIds = Array.from(new Set(members.map(m => m.user_id)));
      const profilesById = await loadProfiles(supabaseClient, userIds);
      if (profilesById.size === 0) console.warn('No profiles visible; check profiles RLS if names/avatars are missing.');
      const picksByUser = await loadPicks(supabaseClient, leagueId);

      // Render my roster + others
      renderMyRoster({ meId: session.user.id, rosterSize: league.roster_size, picksByUser, profilesById });
      renderOtherMembers({ meId: session.user.id, rosterSize: league.roster_size, members, picksByUser, profilesById });
    } catch (e) {
      console.error('Failed to load roster data', e);
      const msg = (e && e.message) ? e.message : 'Failed to load roster data.';
      if ($('league-members-list')) {
        $('league-members-list').innerHTML = `<div class="text-sm text-pink-300">${msg}</div>`;
      }
    }
  });
})();
