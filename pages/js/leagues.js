// js/leagues.js

document.addEventListener('DOMContentLoaded', async () => {
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
    window.location.href = '/pages/auth.html?returnTo=/leagues.html';
    return;
  }

  // Active league persistence key
  const ACTIVE_LEAGUE_KEY = 'activeLeagueId';
  let activeLeagueId = localStorage.getItem(ACTIVE_LEAGUE_KEY);

  // Load user's leagues
  await loadUserLeagues();

  // Set up event listeners
  document.getElementById('create-btn').addEventListener('click', () => {
    window.location.href = '/pages/create-league.html';
  });

  // Join modal wiring
  const joinBtn = document.getElementById('join-btn');
  const joinModal = document.getElementById('join-modal');
  const joinClose = document.getElementById('join-close');
  const joinSubmit = document.getElementById('join-submit');
  const joinInput = document.getElementById('join-code-input');
  const joinError = document.getElementById('join-error');

  function openJoin() {
    if (!joinModal) return;
    joinError && (joinError.classList.add('hidden'), joinError.textContent = '');
    joinInput && (joinInput.value = '', joinInput.focus());
    joinModal.classList.remove('hidden');
  }
  function closeJoin() {
    if (!joinModal) return;
    joinModal.classList.add('hidden');
  }
  if (joinBtn) joinBtn.addEventListener('click', openJoin);
  if (joinClose) joinClose.addEventListener('click', closeJoin);
  if (joinModal) joinModal.addEventListener('click', (e) => { if (e.target === joinModal) closeJoin(); });

  async function joinByCode(rawCode) {
    const code = (rawCode || '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0,5);
    if (code.length !== 5) {
      joinError && (joinError.textContent = 'Join code must be exactly 5 characters.', joinError.classList.remove('hidden'));
      return;
    }

    // Try RPC first (recommended). If it doesn't exist, fallback to select + insert.
    let leagueIdToJoin = null;
    try {
      const { data: rpcData, error: rpcErr } = await supabaseClient.rpc('join_league_by_code', { p_code: code });
      if (!rpcErr && rpcData) {
        leagueIdToJoin = rpcData; // function returns uuid
      } else {
        // Fallback path: select league by code (requires RLS to allow filtered select) and insert membership
        const { data: leagueRow, error: selErr } = await supabaseClient
          .from('leagues')
          .select('id, status')
          .eq('join_code', code)
          .single();
        if (selErr || !leagueRow) throw selErr || new Error('Invalid join code');

        const { error: insErr } = await supabaseClient
          .from('league_members')
          .insert({ league_id: leagueRow.id, user_id: session.user.id });
        if (insErr) throw insErr;
        leagueIdToJoin = leagueRow.id;
        try { localStorage.setItem('activeLeagueStatus', leagueRow.status); } catch {}
      }
    } catch (e) {
      console.error('Join failed:', e);
      joinError && (joinError.textContent = 'Could not join this league. Check the code or ask the owner to invite you.', joinError.classList.remove('hidden'));
      return;
    }

    if (!leagueIdToJoin) {
      joinError && (joinError.textContent = 'Invalid join code.', joinError.classList.remove('hidden'));
      return;
    }

    // Success → set as active and navigate
    try { localStorage.setItem('activeLeagueId', leagueIdToJoin); } catch {}
    closeJoin();
    window.location.href = `/pages/overview.html?league=${leagueIdToJoin}`;
  }

  if (joinSubmit) joinSubmit.addEventListener('click', () => joinByCode(joinInput && joinInput.value));
  if (joinInput) joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(joinInput.value); });

  async function loadUserLeagues() {
    try {
      // Get leagues where user is a member
      const { data: leagues, error } = await supabaseClient
        .from('league_members')
        .select(`
          leagues (
            id,
            name,
            status,
            max_players,
            banner_image_url,
            created_at,
            archived,
            seasons (
              name,
              season_number
            )
          ),
          league_id
        `)
        .eq('user_id', session.user.id)
        .neq('leagues.archived', true);

      if (error) {
        console.error('Error loading leagues:', error);
        return;
      }

      // Defensive client-side filter in case some rows slip through
      const visibleLeagues = (leagues || []).filter(m => m.leagues && m.leagues.archived !== true);
      // Get member counts for each league
      const leagueData = [];
      for (const member of visibleLeagues) {
        const { data: memberCount } = await supabaseClient
          .from('league_members')
          .select('id', { count: 'exact' })
          .eq('league_id', member.leagues.id);

        // Get user's current rank in league (placeholder for now)
        const rank = "2nd";
        const points = "847";

        leagueData.push({
          ...member.leagues,
          memberCount: memberCount?.length || 0,
          userRank: rank,
          userPoints: points
        });
      }
      if (activeLeagueId) {
        leagueData.sort((a, b) => {
          const aw = a.id === activeLeagueId ? 0 : 1;
          const bw = b.id === activeLeagueId ? 0 : 1;
          return aw - bw;
        });
      }
      
      displayLeagues(leagueData);
    } catch (error) {
      console.error('Error loading leagues:', error);
    }
  }

  function displayLeagues(leagues) {
    const leaguesContainer = document.getElementById('leagues-container');
    const emptyState = document.getElementById('empty-state');

    if (leagues.length === 0) {
      leaguesContainer.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    leaguesContainer.classList.remove('hidden');

    const leaguesHtml = leagues.map(league => {
      const statusClass = getStatusClass(league.status);
      const statusText = getStatusText(league.status);
      const isSelected = activeLeagueId === league.id;
      const selectedClass = isSelected ? 'active-league border-2' : '';
      
      return `
        <div class="league-card rounded-2xl overflow-hidden ${league.status === 'active' ? 'active-league border-2' : ''} ${selectedClass}">
          <!-- League Banner -->
          <div class="relative h-32">
            <img
              src="${league.banner_image_url || '/assets/SlaysianRoyaleCast.png'}"
              alt="League Banner"
              class="w-full h-full object-cover"
            />
            <div class="absolute inset-0 bg-gradient-to-r from-black/40 to-transparent"></div>
            <div class="absolute top-3 right-3">
              <span class="${statusClass} text-white text-xs px-3 py-1 rounded-full font-semibold ${league.status === 'drafting' ? 'animate-pulse' : ''}">
                ${statusText}
              </span>
            </div>
          </div>

          <!-- League Info -->
          <div class="p-5">
            <div class="flex justify-between items-center mb-3">
              <div class="flex-1">
                <h3 class="font-calsans text-lg text-white mb-1">${league.name}</h3>
                <p class="text-pink-300 text-xs mb-2">${league.seasons?.name || 'Season TBD'}</p>
                <div class="flex items-center space-x-4 text-xs text-white/60">
                  <span>${league.memberCount}/${league.max_players} players</span>
                </div>
              </div>
              <div class="text-right">
                <div class="text-lg font-bold text-white">${league.userRank}</div>
                <div class="text-xs text-white/50">${league.userPoints} pts</div>
              </div>
            </div>

            <div class="flex items-center justify-between pt-3 border-t border-white/10">
              <div class="text-xs text-white/60">
                ${getLeagueStatusMessage(league)}
              </div>
<button onclick="viewLeague('${league.id}', '${league.status}')" class="text-sm text-pink-400 hover:text-pink-300">
  ${isSelected ? 'Currently Viewing' : 'View League →'}
</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    leaguesContainer.innerHTML = leaguesHtml;
  }

  function getStatusClass(status) {
    switch (status) {
      case 'active': return 'status-active';
      case 'drafting': return 'status-draft';
      case 'setup': return 'status-setup';
      default: return 'status-setup';
    }
  }

  function getStatusText(status) {
    switch (status) {
      case 'active': return 'Active';
      case 'drafting': return 'Drafting';
      case 'setup': return 'Setup';
      default: return 'Setup';
    }
  }

  function getLeagueStatusMessage(league) {
    switch (league.status) {
      case 'active': return 'Next episode in 3 days';
      case 'drafting': return 'Draft in progress';
      case 'setup': return `Need ${league.max_players - league.memberCount} more players`;
      default: return 'Setting up';
    }
  }

  // Global function for viewing leagues
window.viewLeague = (leagueId, status) => {
  try {
    localStorage.setItem('activeLeagueId', leagueId);
    if (status) localStorage.setItem('activeLeagueStatus', status);  // <-- add this
  } catch {}
  window.location.href = `/pages/overview.html?league=${leagueId}`;
};
});