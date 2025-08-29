// js/draft.js
// Controls the three states of the Draft page:
// 1) setup (pre-draft)  → show "Draft has not started yet", hide order, list contestants without buttons
// 2) drafting           → show active draft UI (as laid out in the HTML)
// 3) active (post-draft)→ relabel nav to "Roster" and redirect to roster.html

document.addEventListener('DOMContentLoaded', async () => {
  // Insert skeleton placeholders for main containers immediately
  if (document.getElementById('status-bar')) {
    document.getElementById('status-bar').innerHTML = `
      <div class="animate-pulse rounded-xl p-3 bg-white/10 h-14 w-full"></div>`;
  }
  if (document.getElementById('draft-order')) {
    document.getElementById('draft-order').innerHTML = `
      <div class="flex space-x-2 overflow-x-auto pb-2">
        ${Array.from({length:4}).map(() => `
          <div class="flex-shrink-0 flex flex-col items-center space-y-1 animate-pulse">
            <div class="w-10 h-10 rounded-full bg-white/10"></div>
            <div class="h-3 w-8 bg-white/10 rounded"></div>
          </div>
        `).join('')}
      </div>`;
  }
  if (document.getElementById('contestant-list')) {
    document.getElementById('contestant-list').innerHTML = `
      ${Array.from({length:6}).map(() => `
        <div class="contestant-available rounded-xl p-4 flex items-center space-x-4 animate-pulse">
          <div class="w-12 h-12 rounded-full bg-white/10 flex-shrink-0"></div>
          <div class="flex-1 space-y-2">
            <div class="h-4 bg-white/10 rounded w-32"></div>
            <div class="h-3 bg-white/10 rounded w-20"></div>
          </div>
          <div class="h-8 w-16 bg-white/10 rounded"></div>
        </div>
      `).join('')}
    `;
  }
  // Initialize Supabase client
  let supabaseClient;
  try {
    const response = await fetch('/supabase.txt');
    const text = await response.text();
    const url = text.match(/^SUPABASE_URL=(.*)$/m)[1].trim();
    const key = text.match(/^SUPABASE_ANON_KEY=(.*)$/m)[1].trim();
    supabaseClient = supabase.createClient(url, key);
  } catch (error) {
    console.error('Failed to initialize Supabase:', error);
    return;
  }

  // Check authentication
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = '/pages/auth.html?returnTo=/pages/draft.html';
    return;
  }

  // Resolve active league
  const ACTIVE_LEAGUE_KEY = 'activeLeagueId';
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = urlParams.get('league');
  let leagueId = fromUrl || localStorage.getItem(ACTIVE_LEAGUE_KEY);
  if (!leagueId) {
    window.location.href = '/pages/leagues.html';
    return;
  }
  try { localStorage.setItem(ACTIVE_LEAGUE_KEY, leagueId); } catch {}

  // Fetch league (status, season, commissioner)
  const { data: league, error: leagueError } = await supabaseClient
    .from('leagues')
    .select('id, status, season_id, commissioner_id, roster_size, draft_format, ownership_mode, max_owners_per_queen')
    .eq('id', leagueId)
    .single();

  if (leagueError || !league) {
    console.error('League not found:', leagueError);
    window.location.href = '/pages/leagues.html';
    return;
  }
  try { localStorage.setItem('activeLeagueStatus', league.status); } catch {}

  // Cache DOM elements
  const statusBar = document.getElementById('status-bar');
  const draftOrder = document.getElementById('draft-order');
  const contestantList = document.getElementById('contestant-list');
  const draftBtnLabel = document.getElementById('btn-nav-draft-label');
  const navDraftBtn = document.getElementById('btn-nav-draft');
  const draftButton = document.getElementById('draftButton');

  // Modal DOM
  const orderModal = document.getElementById('order-modal');
  const orderList = document.getElementById('order-list');
  const orderSave = document.getElementById('order-save');
  const orderCancel = document.getElementById('order-cancel');
  const orderClose = document.getElementById('order-modal-close');

  // Helper: set status bar content
  function setStatus(message, sub = '') {
    if (!statusBar) return;
    statusBar.innerHTML = `
      <div class="pick-notification rounded-xl p-3 flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <div class="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center">
            <i class="fi fi-sr-crown text-white text-xs"></i>
          </div>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-white">${message}</p>
            ${sub ? `<p class="text-xs text-white/60">${sub}</p>` : ''}
          </div>
        </div>
      </div>`;
  }

  // Helper: load contestants for the league's season
  async function loadSeasonContestants(seasonId) {
    const { data, error } = await supabaseClient
      .from('contestants')
      .select('id, name')
      .eq('season_id', seasonId)
      .order('name');
    if (error) {
      console.error('Error loading contestants:', error);
      return [];
    }
    return data || [];
  }


  // Map contestant_id -> number of distinct owners in this league
  async function loadOwnershipCountsByContestant(leagueId) {
    const { data, error } = await supabaseClient
      .from('draft_picks')
      .select('contestant_id, user_id')
      .eq('league_id', leagueId);
    if (error) { console.error('Error loading ownership counts', error); return new Map(); }
    const ownersByContestant = new Map();
    (data || []).forEach(row => {
      const key = row.contestant_id;
      const set = ownersByContestant.get(key) || new Set();
      set.add(row.user_id);
      ownersByContestant.set(key, set);
    });
    // convert sets to counts
    const counts = new Map();
    ownersByContestant.forEach((set, k) => counts.set(k, set.size));
    return counts;
  }

  // Get how many picks the given user already has in this league
  async function loadUserPickCount(leagueId, userId) {
    const { count, error } = await supabaseClient
      .from('draft_picks')
      .select('id', { count: 'exact', head: true })
      .eq('league_id', leagueId)
      .eq('user_id', userId);
    if (error) { console.error('Error loading user pick count', error); return 0; }
    return count || 0;
  }

  // Render contestants; if it's your turn, enable drafting controls based on league rules
  function renderContestantsInteractive({ contestants, ownershipCounts, currentIdx, members, meId, league, userPickCount }) {
    if (!contestantList) return;

    const isUnique = (league.ownership_mode || 'unique') === 'unique';
    const maxOwners = isUnique ? 1 : (league.max_owners_per_queen || null);
    const isYourTurn = members[currentIdx]?.user_id === meId;
    const remainingSlots = Math.max(0, (Number(league.roster_size) || 0) - (userPickCount || 0));

    // If "multiple" ownership and your turn, we allow selecting up to remainingSlots and submit as a batch
    let selectionBarHtml = '';
    if (!isUnique && isYourTurn && remainingSlots > 0) {
      selectionBarHtml = `
        <div id="multi-select-bar" class="sticky top-0 z-10 mb-3">
          <div class="glass-card rounded-xl p-3 flex items-center justify-between border border-white/15">
            <div class="text-sm">Select up to <strong>${remainingSlots}</strong> queens</div>
            <button id="submit-multi-picks" class="your-turn px-4 py-2 rounded-lg text-white font-semibold text-sm disabled:opacity-50" disabled>Draft 0</button>
          </div>
        </div>`;
    }

    const rowsHtml = contestants.map(r => {
      const initials = (r.name || '?').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
      const owners = ownershipCounts.get(r.id) || 0;
      const isFull = maxOwners !== null ? owners >= maxOwners : false;

      // Whether current user already owns this contestant (prevent re-pick)
      // We can't easily know per-contestant per-user without another query; simplest approach: we allow server to reject duplicates.

      // Determine availability
      const available = !isFull && league.status === 'drafting';

    let right;
    if (isYourTurn && available) {
      if (isUnique) {
        right = remainingSlots > 0
          ? `<button class="your-turn px-4 py-2 rounded-lg text-white font-semibold text-sm" data-draft-one data-id="${r.id}">Draft</button>`
          : `<button class="draft-btn px-4 py-2 rounded-lg text-white font-semibold text-sm opacity-50 cursor-not-allowed">Roster full</button>`;
      } else {
        // multiple: checkboxes for batch submit
        right = `<input type="checkbox" class="w-5 h-5 checkbox" data-pick-checkbox data-id="${r.id}" />`;
      }
    } else {
      const label = isFull ? 'Max owners reached' : (isYourTurn ? 'Unavailable' : 'Waiting');
      right = `<button class="draft-btn px-4 py-2 rounded-lg text-white font-semibold text-sm opacity-50 cursor-not-allowed">${label}</button>`;
    }

    const ownersBadge = (league.status === 'drafting' && maxOwners !== null)
      ? (owners >= (maxOwners || Infinity)
          ? `<span class="inline-flex items-center px-2 py-0.5 rounded bg-white/10 text-[11px] text-white/60">Full (${owners}/${maxOwners})</span>`
          : `<span class="text-[11px] text-white/50">${owners}/${maxOwners}</span>`)
      : '';

return `
  <div class="${isFull ? 'contestant-drafted' : 'contestant-available'} rounded-xl p-4 flex items-center space-x-4">
          <div class="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex-shrink-0 flex items-center justify-center">
            <span class="text-white font-bold text-lg">${initials}</span>
          </div>
          <div class="flex-1">
            <h3 class="font-semibold text-white">${r.name}</h3>
            ${ownersBadge}
          </div>
          <div>${right}</div>
        </div>`;
    }).join('');

    contestantList.innerHTML = (selectionBarHtml || '') + rowsHtml;

    // Wire events
    if (isYourTurn && isUnique) {
      contestantList.querySelectorAll('[data-draft-one]')?.forEach(btn => {
        btn.addEventListener('click', async () => {
          const cid = btn.getAttribute('data-id');
          await draftContestants([cid]);
        });
      });
    }

    if (isYourTurn && !isUnique) {
      const submitBtn = document.getElementById('submit-multi-picks');
      const boxes = contestantList.querySelectorAll('[data-pick-checkbox]');
      // Guard: prevent selecting more than remainingSlots
      let lastChanged = null;
      const updateState = () => {
        const chosen = Array.from(boxes).filter(b => b.checked).length;
        if (submitBtn) {
          submitBtn.textContent = `Draft ${chosen}`;
          submitBtn.disabled = !(chosen > 0 && chosen <= remainingSlots);
        }
      };
      boxes.forEach(b => b.addEventListener('change', (e) => {
        lastChanged = e.target;
        const chosenCount = Array.from(boxes).filter(x => x.checked).length;
        if (chosenCount > remainingSlots) {
          // Undo this check and briefly flash the bar as feedback
          e.target.checked = false;
          const bar = document.getElementById('multi-select-bar');
          if (bar) {
            bar.classList.add('ring-2','ring-pink-500/60');
            setTimeout(() => bar.classList.remove('ring-2','ring-pink-500/60'), 250);
          }
        }
        updateState();
      }));
      updateState();

      if (submitBtn) submitBtn.addEventListener('click', async () => {
        const ids = Array.from(boxes).filter(b => b.checked).map(b => b.getAttribute('data-id'));
        if (!ids.length) return;
        await draftContestants(ids);
      });
    }
  }

  async function draftContestants(contestantIds) {
    if (!Array.isArray(contestantIds) || !contestantIds.length) return;

    // Build rows to insert
    const rows = contestantIds.map(id => ({
      league_id: league.id,
      user_id: session.user.id,
      contestant_id: id
    }));

    // Insert picks
    const { error } = await supabaseClient.from('draft_picks').insert(rows);
    if (error) {
      console.error('Draft failed:', error);
      const msg = (error.message || '').toLowerCase();
      let friendly = 'Draft failed.';
      if (msg.includes('row-level security')) {
        friendly = "You're not allowed to draft right now. Make sure you're a member and the league is in the drafting phase.";
      } else if (msg.includes('unique') || msg.includes('duplicate')) {
        friendly = 'You already drafted this queen.';
      } else if (msg.includes('max owners') || msg.includes('reached')) {
        friendly = 'This queen has reached the maximum number of owners.';
      }
      alert(friendly);
      return;
    }

    // Refresh UI (order, contestants, status)
    await refreshDraftOrderFromServer();
    await renderContestantsForCurrentState();
  }

  async function renderContestantsForCurrentState() {
    const contestants = await loadSeasonContestants(league.season_id);
    const ownershipCounts = await loadOwnershipCountsByContestant(league.id);
    const members = await loadLeagueMembers(league.id);
    const pickCounts = await loadPickCounts(league.id);
    const currentIdx = computeCurrentPickerIndex(league, members, pickCounts);
    const userPickCount = await loadUserPickCount(league.id, session.user.id);
    renderContestantsInteractive({ contestants, ownershipCounts, currentIdx, members, meId: session.user.id, league, userPickCount });
  }

  // Load league members with profile names and avatar URLs (two-step fetch)
  async function loadLeagueMembers(leagueId) {
    // Step 1: get members (user_id, draft_position)
    const { data: members, error: mErr } = await supabaseClient
      .from('league_members')
      .select('user_id, draft_position')
      .eq('league_id', leagueId)
      .order('draft_position', { ascending: true, nullsFirst: false })
      .order('user_id', { ascending: true });
    if (mErr) { console.error('Error loading members', mErr); return []; }

    const rows = members || [];
    if (!rows.length) return [];

    // Step 2: fetch profiles for those users
    const userIds = Array.from(new Set(rows.map(r => r.user_id).filter(Boolean)));
    let profByUser = new Map();
    if (userIds.length) {
      const { data: profiles, error: pErr } = await supabaseClient
        .from('profiles')
        .select('id, display_name, avatar_url')
        .in('id', userIds);
      if (pErr) {
        console.warn('Could not load profiles, falling back to user ids', pErr);
      } else {
        (profiles || []).forEach(p => profByUser.set(p.id, { display_name: p.display_name, avatar_url: p.avatar_url }));
      }
    }

    // Merge names and avatars onto member rows, while preserving order
    return rows.map((r, idx) => {
      const prof = profByUser.get(r.user_id) || {};
      return {
        user_id: r.user_id,
        draft_position: r.draft_position,
        orderIndex: idx, // current order position (0-based) for rendering
        display_name: prof.display_name || 'Member',
        avatar_url: prof.avatar_url || 'https://i.pravatar.cc/40?img=' + ((idx % 8) + 1)
      };
    });
  }

  // Simple HTML5 drag-sort for the order list
  function renderOrderList(members) {
    if (!orderList) return;
    orderList.innerHTML = members.map((m, idx) => `
      <li class="rounded-xl bg-white/10 px-3 py-2 flex items-center justify-between"
          draggable="true"
          data-user-id="${m.user_id}">
        <span class="text-sm">${m.display_name || 'Member'} </span>
        <span class="text-xs text-white/50">#${idx+1}</span>
      </li>
    `).join('');

    let dragEl = null;
    orderList.querySelectorAll('li').forEach(li => {
      li.addEventListener('dragstart', (e) => {
        dragEl = li; li.classList.add('ring-2','ring-pink-500/60');
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => {
        if (dragEl) dragEl.classList.remove('ring-2','ring-pink-500/60');
        dragEl = null;
        // re-number
        Array.from(orderList.children).forEach((child, i) => {
          child.querySelector('span:last-child').textContent = `#${i+1}`;
        });
      });
      li.addEventListener('dragover', (e) => { e.preventDefault(); });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragEl || dragEl === li) return;
        const rect = li.getBoundingClientRect();
        const after = (e.clientY - rect.top) / rect.height > 0.5;
        if (after) li.after(dragEl); else li.before(dragEl);
      });
    });
  }

  function openOrderModal() { if (orderModal) orderModal.classList.remove('hidden'); }
  function closeOrderModal() { if (orderModal) orderModal.classList.add('hidden'); }

  // Load pick counts per user for this league
  async function loadPickCounts(leagueId) {
    const { data, error } = await supabaseClient
      .from('draft_picks')
      .select('user_id')
      .eq('league_id', leagueId);
    if (error) { console.error('Error loading picks', error); return new Map(); }
    const map = new Map();
    (data || []).forEach(row => map.set(row.user_id, (map.get(row.user_id) || 0) + 1));
    return map;
  }

  // Determine whose turn it is right now
  function computeCurrentPickerIndex(league, members, pickCounts) {
    const orderIds = members.map(m => m.user_id);
    const n = orderIds.length;
    if (!n) return 0;

    const rosterSize = Number(league.roster_size) || 0;
    const mode = (league.draft_format || 'linear').toLowerCase();

    // Helper: count total picks so far (unique mode)
    const totalPicks = orderIds.reduce((sum, uid) => sum + (pickCounts.get(uid) || 0), 0);

    if ((league.ownership_mode || 'unique') === 'unique') {
      // Each pick is one turn. Compute nominal index then advance to next who still needs picks.
      let idx = computeRoundMemberIndex(orderIds, totalPicks, mode);
      for (let i = 0; i < n; i++) {
        const check = (idx + i) % n;
        if ((pickCounts.get(orderIds[check]) || 0) < rosterSize) return check;
      }
      return 0; // draft complete fallback
    } else {
      // multiple: each member drafts up to roster_size in one turn; go to first who hasn't filled roster
      for (let i = 0; i < n; i++) {
        if ((pickCounts.get(orderIds[i]) || 0) < rosterSize) return i;
      }
      return 0; // everyone filled
    }
  }

  // Render the top draft-order avatar strip using live data and highlight current turn
  function renderDraftOrder(members, currentIndex, meId) {
    if (!draftOrder) return;
    const html = [
      '<div class="flex space-x-2 overflow-x-auto pb-2">',
      ...members.map((m, i) => {
        const isCurrent = (i === currentIndex);
        const wrapperCls = isCurrent
          ? 'w-10 h-10 rounded-full current-picker flex items-center justify-center'
          : 'w-10 h-10 rounded-full border-2 border-white/30 bg-white/10 flex items-center justify-center';
        const nameCls = isCurrent
          ? 'text-xs text-emerald-300 font-semibold'
          : 'text-xs text-white/70';
        const label = (m.user_id === meId) ? 'You' : (m.display_name || 'Member');
        const avatar = m.avatar_url || 'https://i.pravatar.cc/40?img=1';
        return `
          <div class="flex-shrink-0 flex flex-col items-center space-y-1">
            <div class="${wrapperCls}">
              <img src="${avatar}" class="w-8 h-8 rounded-full" alt="${label}" />
            </div>
            <span class="${nameCls}">${label}</span>
          </div>
        `;
      }),
      '</div>'
    ].join('');
    draftOrder.innerHTML = html;
  }

  // Helper: Show/hide and wire the commissioner-only draft toggle button
  async function setupDraftButton() {
    if (!draftButton) return;

    // Only the commissioner should see this button
    const isCommissioner = session.user.id === league.commissioner_id;
    if (!isCommissioner) {
      draftButton.classList.add('hidden');
      return;
    }

    // Set initial label based on current status
    if (league.status === 'setup') {
      draftButton.textContent = 'Open Draft';
    } else if (league.status === 'drafting') {
      draftButton.textContent = 'Close Draft';
    } else {
      draftButton.textContent = 'Roster';
    }

    draftButton.classList.remove('hidden');

    draftButton.addEventListener('click', async (e) => {
      e.preventDefault();
      if (league.status === 'setup') {
        // Open the "Set Draft Order" modal instead of immediately starting
        draftButton.disabled = true;
        const original = draftButton.textContent;
        draftButton.textContent = 'Loading members…';
        const members = await loadLeagueMembers(league.id);
        if (!members.length) {
          alert('No members found for this league.');
          draftButton.disabled = false; draftButton.textContent = original; return;
        }
        renderOrderList(members);
        openOrderModal();
        draftButton.disabled = false;
        draftButton.textContent = original;
      } else if (league.status === 'drafting') {
        // Close the draft → league becomes active
        draftButton.disabled = true;
        const original = draftButton.textContent;
        draftButton.textContent = 'Closing…';
        const { error } = await supabaseClient
          .from('leagues')
          .update({ status: 'active' })
          .eq('id', league.id)
          .eq('commissioner_id', session.user.id);
        if (error) {
          console.error('Failed to close draft:', error);
          alert('Could not close the draft.');
          draftButton.disabled = false;
          draftButton.textContent = original;
          return;
        }
        try { localStorage.setItem('activeLeagueStatus', 'active'); } catch {}
        // Update local state then redirect to roster
        league.status = 'active';
        try { if (draftBtnLabel) draftBtnLabel.textContent = 'Roster'; } catch {}
        const qp = `?league=${encodeURIComponent(league.id)}`;
        window.location.href = `/pages/roster.html${qp}`;
      } else {
        // If somehow visible while active, behave like roster link
        const qp = `?league=${encodeURIComponent(league.id)}`;
        window.location.href = `/pages/roster.html${qp}`;
      }
    });
  }

  // Modal actions
  if (orderCancel) orderCancel.addEventListener('click', closeOrderModal);
  if (orderClose) orderClose.addEventListener('click', closeOrderModal);
  if (orderSave) orderSave.addEventListener('click', async () => {
    // Collect order
    const userIds = Array.from(orderList.children).map(li => li.getAttribute('data-user-id'));
    console.log('[Draft] Saving draft order (top to bottom):', userIds);
    if (!userIds.length) return closeOrderModal();

    // Save draft_position sequentially
    for (let i = 0; i < userIds.length; i++) {
      const { error } = await supabaseClient
        .from('league_members')
        .update({ draft_position: i + 1 })
        .eq('league_id', league.id)
        .eq('user_id', userIds[i]);
      if (error) { console.error('Failed to save order', error); alert('Failed to save order'); return; }
    }

    // Start the draft
    const { error: updErr } = await supabaseClient
      .from('leagues')
      .update({ status: 'drafting' })
      .eq('id', league.id)
      .eq('commissioner_id', session.user.id);
    if (updErr) { console.error('Failed to start draft', updErr); alert('Could not start the draft'); return; }

    try { localStorage.setItem('activeLeagueStatus', 'drafting'); } catch {}
    league.status = 'drafting';
    closeOrderModal();
    setStatus('Draft in progress', 'Make your picks in turn order.');
    if (draftOrder) draftOrder.classList.remove('hidden');
    if (draftButton) draftButton.textContent = 'Close Draft';
    await refreshDraftOrderFromServer();
    // Also re-render contestants with the newly persisted order
    await renderContestantsForCurrentState();
    // Clean up selection bar (if any)
    const bar = document.getElementById('multi-select-bar');
    if (bar) bar.remove();
  });

  // ===== ROSTER VIEW (post-draft) =====
  async function loadLeagueRosters(leagueId) {
    // Load members (with profile info)
    const { data: members, error: mErr } = await supabaseClient
      .from('league_members')
      .select('user_id, draft_position')
      .eq('league_id', leagueId)
      .order('draft_position', { ascending: true, nullsFirst: true });
    if (mErr) { console.error('Error loading members for roster', mErr); return { members: [], picksByUser: new Map(), profilesById: new Map() }; }

    const ids = Array.from(new Set((members || []).map(m => m.user_id)));
    let profilesById = new Map();
    if (ids.length) {
      const { data: profiles, error: pErr } = await supabaseClient
        .from('profiles')
        .select('id, display_name, avatar_url')
        .in('id', ids);
      if (pErr) { console.warn('Profiles fetch failed for roster view', pErr); }
      (profiles || []).forEach(p => profilesById.set(p.id, p));
    }

    // Load picks with contestant names grouped by user
    const { data: picks, error: pkErr } = await supabaseClient
      .from('draft_picks')
      .select('user_id, contestants:contestant_id ( id, name )')
      .eq('league_id', leagueId)
      .order('created_at', { ascending: true });
    if (pkErr) { console.error('Error loading picks for roster', pkErr); }

    const picksByUser = new Map();
    (picks || []).forEach(row => {
      const arr = picksByUser.get(row.user_id) || [];
      if (row.contestants) arr.push(row.contestants); // {id, name}
      picksByUser.set(row.user_id, arr);
    });

    return { members: members || [], picksByUser, profilesById };
  }

  function renderRosterView({ members, picksByUser, profilesById, rosterSize }) {
    if (!contestantList) return;
    const totalPicked = Array.from(picksByUser.values()).reduce((n, arr) => n + (arr?.length || 0), 0);
if (!members.length) {
  contestantList.innerHTML = `
    <div class="glass-card rounded-2xl p-6 text-center text-white/70 border border-white/10">
      No members found in this league.
    </div>`;
  return;
}

    const cardHtml = (userId) => {
      const prof = profilesById.get(userId) || {};
      const name = prof.display_name || 'Member';
      const avatar = prof.avatar_url || 'https://i.pravatar.cc/64?img=5';
      const picks = picksByUser.get(userId) || [];
      const emptySlots = Math.max(0, (Number(rosterSize) || 0) - picks.length);
      const chips = picks.map(c => `
        <span class="inline-flex items-center px-2 py-1 rounded-lg bg-white/10 text-xs">${c.name}</span>
      `).join('');
      const empties = Array.from({length: emptySlots}).map(() => `
        <span class="inline-flex items-center px-2 py-1 rounded-lg bg-white/5 text-xs text-white/40">Empty</span>
      `).join('');

      return `
        <div class="rounded-2xl glass-card p-4 border border-white/10">
          <div class="flex items-center gap-3 mb-3">
            <img src="${avatar}" class="w-10 h-10 rounded-full" alt="${name}" />
            <div>
              <div class="text-sm font-semibold">${name}${(profilesById.get(userId)?.id === (session.user && session.user.id)) ? ' (You)' : ''}</div>
              <div class="text-xs text-white/60">${picks.length}/${rosterSize} drafted</div>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">${chips}${empties}</div>
        </div>
      `;
    };

    // Replace the contestants list container with roster cards
const header = `<div class="flex items-center justify-between mb-3">
  <h3 class="text-lg font-semibold">Rosters</h3>
  ${totalPicked === 0 ? '<span class="text-xs text-white/60">No picks yet</span>' : ''}
</div>`;

// Order by draft_position when available
const sorted = [...members].sort((a,b) => (a.draft_position || 1e9) - (b.draft_position || 1e9));

contestantList.innerHTML = header + `
  <div class="grid grid-cols-1 gap-3">${sorted.map(m => cardHtml(m.user_id)).join('')}</div>
`;
  }

  // --- State machine ---
  if (league.status === 'setup') {
    // PRE-DRAFT: commissioner hasn't opened the draft
    setStatus('Draft has not started yet', 'The commissioner will open the draft soon.');
    if (draftOrder) draftOrder.classList.add('hidden');

    // Show contestants with new renderer
    await renderContestantsForCurrentState();
    await setupDraftButton();

  } else if (league.status === 'drafting') {
    // LIVE DRAFT: show the static layout (already in HTML)
    setStatus('Draft in progress', 'Make your picks in turn order.');
    if (draftOrder) draftOrder.classList.remove('hidden');
    await setupDraftButton();
    await refreshDraftOrderFromServer();
    await renderContestantsForCurrentState();
    // (Future) Wire realtime and picking controls here

  } else {
    // POST-DRAFT / ACTIVE: show roster view on this page
    try { if (draftBtnLabel) draftBtnLabel.textContent = 'Roster'; } catch {}
    if (draftButton) draftButton.classList.add('hidden');

    setStatus('Draft complete', 'Final rosters below.');
    if (draftOrder) draftOrder.classList.add('hidden');

if (contestantList) {
  contestantList.innerHTML = `
    ${Array.from({length:3}).map(() => `
      <div class="rounded-2xl glass-card p-4 border border-white/10 animate-pulse">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 rounded-full bg-white/10"></div>
          <div class="h-4 bg-white/10 rounded w-24"></div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${Array.from({length:4}).map(()=>'<span class="inline-flex items-center px-6 py-3 rounded-lg bg-white/10 text-xs h-6"></span>').join('')}
        </div>
      </div>
    `).join('')}
  `;
}

    try {
      const data = await loadLeagueRosters(league.id);
      renderRosterView({ ...data, rosterSize: league.roster_size });
    } catch (e) {
      console.error('Failed to render roster view', e);
    }

    // Keep the nav button routing to roster.html if pressed
    if (navDraftBtn) {
      navDraftBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const qp = `?league=${encodeURIComponent(leagueId)}`;
        window.location.href = `/pages/roster.html${qp}`;
      });
    }
    return;
  }

  // Add: function to refresh draft order UI from the server
  async function refreshDraftOrderFromServer() {
    try {
      const members = await loadLeagueMembers(league.id);
      console.log('[Draft] Server order (by draft_position asc):', members.map(m => m.user_id));
      if (!members.length) return;
      const pickCounts = await loadPickCounts(league.id);
      const currentIdx = computeCurrentPickerIndex(league, members, pickCounts);
      renderDraftOrder(members, currentIdx, session.user.id);

      // Also reflect in status bar
      const currentName = members[currentIdx]?.display_name || 'Member';
      const yourTurn = members[currentIdx]?.user_id === session.user.id;
      setStatus(yourTurn ? 'Your Turn' : `${currentName}'s Turn`, yourTurn ? 'Select your pick' : 'Waiting for pick…');
    } catch (e) {
      console.error('Failed to refresh draft order', e);
    }
  }

  // --- Draft flow scaffolding ---
  function computeRoundMemberIndex(order, pickIndex, mode) {
    // order: array of user_ids in draft order
    // pickIndex: 0-based number of the current member turn (unique: each pick; multiple: each member's block)
    // mode: 'linear' | 'snake'
    const n = order.length; if (!n) return 0;
    const round = Math.floor(pickIndex / n);
    const pos = pickIndex % n;
    if (mode === 'snake' && (round % 2 === 1)) {
      return n - 1 - pos;
    }
    return pos;
  }

  async function refreshDraftState() {
    // TODO: Load order from league_members(draft_position), load picks to know ownership counts,
    // enable/disable buttons accordingly, and highlight whose turn based on ownership_mode and draft_format.
    // This scaffolding keeps the page ready to implement live picks.
    await renderContestantsForCurrentState();
  }
});