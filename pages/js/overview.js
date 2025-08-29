// js/overview.js
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
    window.location.href = '/pages/auth.html?returnTo=/overview.html';
    return;
  }

  // Resolve active league: URL param → localStorage → fallback
  const ACTIVE_LEAGUE_KEY = 'activeLeagueId';
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = urlParams.get('league');

  let leagueId = fromUrl || localStorage.getItem(ACTIVE_LEAGUE_KEY) || await getDefaultLeague();

  // Persist the chosen league so other pages stay in sync
  try {
    if (leagueId) {
      localStorage.setItem(ACTIVE_LEAGUE_KEY, leagueId);
    }
  } catch (_) {
    // If storage is unavailable, we still proceed with the resolved ID
  }

  if (!leagueId) {
    window.location.href = '/pages/leagues.html';
    return;
  }

  // Load league data
  await loadLeagueOverview(leagueId, session.user.id);

  async function getDefaultLeague() {
    // Get user's most recently active league
    const { data: leagues } = await supabaseClient
      .from('league_members')
      .select('league_id, leagues!inner(status)')
      .eq('user_id', session.user.id)
      .eq('leagues.status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);

    return leagues?.[0]?.league_id || null;
  }

  async function loadLeagueOverview(leagueId, userId) {
    try {
      // Load league details
      const { data: league, error: leagueError } = await supabaseClient
        .from('leagues')
        .select(`
          *,
          seasons (name, season_number)
        `)
        .eq('id', leagueId)
        .single();

      if (leagueError || !league) {
        console.error('League not found:', leagueError);
        window.location.href = '/pages/leagues.html';
        return;
      }

      try { localStorage.setItem('activeLeagueStatus', league.status); } catch {}

      // Wire the commissioner-only Reset Draft action
      const resetBtn = document.getElementById('resetDraftBtn');
      if (resetBtn) {
        resetBtn.addEventListener('click', async (e) => {
          e.preventDefault();

          // Optional: only allow the league owner/commissioner
          if (league.owner_id && league.owner_id !== userId) {
            alert('Only the league owner can reset the draft.');
            return;
          }

          const ok = confirm('Reset draft? This will delete all draft picks, clear draft order, and move the league back to setup.');
          if (!ok) return;

          resetBtn.disabled = true;
          resetBtn.classList.add('opacity-50');

          try {
            // 1) Delete all picks for this league, return deleted ids for verification
            const { data: deletedPicks, error: delErr } = await supabaseClient
              .from('draft_picks')
              .delete()
              .eq('league_id', leagueId)
              .select('id');
            if (delErr) throw delErr;
            console.log('[ResetDraft] Deleted picks:', deletedPicks?.length || 0);

            // Verify: ensure no lingering picks remain (RLS could block delete)
            const { count: remainingPicks, error: remErr } = await supabaseClient
              .from('draft_picks')
              .select('id', { count: 'exact', head: true })
              .eq('league_id', leagueId);
            if (remErr) console.warn('[ResetDraft] Could not verify remaining picks:', remErr);
            if ((remainingPicks || 0) > 0) {
              alert(`Warning: ${remainingPicks} picks remain. Check RLS delete policy on draft_picks.`);
            }

            // 2) Clear draft positions
            const { error: posErr } = await supabaseClient
              .from('league_members')
              .update({ draft_position: null })
              .eq('league_id', leagueId);
            if (posErr) throw posErr;

            // 3) Set league back to 'setup'
            const { error: upErr } = await supabaseClient
              .from('leagues')
              .update({ status: 'setup' })
              .eq('id', leagueId);
            if (upErr) throw upErr;

            try { localStorage.setItem('activeLeagueStatus', 'setup'); } catch {}
            alert('Draft has been reset. You can now set a new order and start again.');
            // Refresh the overview so UI reflects the new state
            await loadLeagueOverview(leagueId, userId);
            try {
              await Promise.all([
                supabaseClient.from('league_members').select('user_id, draft_position').eq('league_id', leagueId),
                supabaseClient.from('draft_picks').select('id', { count: 'exact', head: true }).eq('league_id', leagueId)
              ]);
            } catch {}
          } catch (err) {
            console.error('Failed to reset draft:', err);
            const msg = (err && err.message) ? err.message : 'Reset failed.';
            alert(msg);
          } finally {
            resetBtn.disabled = false;
            resetBtn.classList.remove('opacity-50');
          }
        });
      }

      // Load league members with their total points
      const { data: members, error: membersError } = await supabaseClient
        .from('league_members')
        .select(`
          *,
          profiles (display_name)
        `)
        .eq('league_id', leagueId)
        .order('draft_position');

      if (membersError) {
        console.error('Error loading members:', membersError);
        return;
      }

      // Calculate user stats and leaderboard
      const userMember = members.find(m => m.user_id === userId);
      const userRank = userMember ? userMember.draft_position : 1;
      const totalMembers = members.length;

      // --- Compute real points from episode_scores for each member ---
      // Fetch all draft picks for this league (user_id, contestant_id)
      const { data: picks, error: picksError } = await supabaseClient
        .from('draft_picks')
        .select('user_id, contestant_id')
        .eq('league_id', leagueId);
      if (picksError) {
        console.error('Error loading draft picks:', picksError);
        return;
      }

      // Fetch all episode scores for this league (contestant_id, points)
      const { data: scores, error: scoresError } = await supabaseClient
        .from('episode_scores')
        .select('contestant_id, points')
        .eq('league_id', leagueId);
      if (scoresError) {
        console.error('Error loading episode scores:', scoresError);
        return;
      }

      // Sum points per contestant across all episodes
      const pointsByContestant = new Map();
      for (const s of (scores || [])) {
        const prev = pointsByContestant.get(s.contestant_id) || 0;
        const p = Number(s.points) || 0;
        pointsByContestant.set(s.contestant_id, prev + p);
      }

      // Sum points per user based on their picks
      const pointsByUser = new Map();
      for (const p of (picks || [])) {
        const cPoints = pointsByContestant.get(p.contestant_id) || 0;
        pointsByUser.set(p.user_id, (pointsByUser.get(p.user_id) || 0) + cPoints);
      }

      // Build leaderboard from members list, defaulting missing users to 0 points
      const leaderboardRaw = members.map(m => ({
        user_id: m.user_id,
        name: m.profiles?.display_name || (m.user_id === userId ? (session.user.email.split('@')[0]) : 'Member'),
        points: pointsByUser.get(m.user_id) || 0,
        isUser: m.user_id === userId,
        avatar: 'https://i.pravatar.cc/40?img=1'
      }));

      // Sort by points desc, then name to stabilize
      leaderboardRaw.sort((a, b) => (b.points - a.points) || a.name.localeCompare(b.name));

      // Assign ranks 1..N and map to display shape
      const leaderboard = leaderboardRaw.map((row, idx) => ({
        rank: idx + 1,
        name: row.name,
        points: row.points,
        isUser: row.isUser,
        avatar: row.avatar
      }));

      // Determine this user's rank and points
      const meIdx = leaderboard.findIndex(x => x.isUser);
      const userPoints = meIdx >= 0 ? leaderboard[meIdx].points : 0;
      const userRankComputed = meIdx >= 0 ? leaderboard[meIdx].rank : 1;

      // Update the page content with real values
      updatePageContent(league, userPoints, userRankComputed, totalMembers, leaderboard);

    } catch (error) {
      console.error('Error loading league overview:', error);
    }
  }

  function updatePageContent(league, userPoints, userRank, totalMembers, leaderboard) {
    // Update league title
    // Update league banner image
    const bannerEl = document.getElementById('league-banner');
    if (bannerEl) {
      bannerEl.src = league.banner_image_url || '/assets/SlaysianRoyaleCast.png';
    }
    document.getElementById('league-name').textContent = league.name;
    document.getElementById('season-name').textContent = league.seasons?.name || 'Season TBD';

    // Update user stats
    document.getElementById('user-rank').textContent = userRank;
    document.getElementById('total-members').textContent = totalMembers;
    document.getElementById('user-points').textContent = userPoints;

    // Update rank badge
    const rankSuffix = getRankSuffix(userRank);
    document.getElementById('rank-badge').textContent = `${userRank}${rankSuffix} Place`;

    // Update leaderboard
    const leaderboardContainer = document.getElementById('leaderboard-container');
    leaderboardContainer.innerHTML = leaderboard.map((member, index) => {
      const medalColors = ['from-yellow-400 to-yellow-600', 'from-gray-300 to-gray-500', 'from-orange-400 to-orange-600'];
      const bgColor = medalColors[index] || 'from-blue-400 to-blue-600';
      
      return `
        <div class="leaderboard-item rounded-xl p-4 flex items-center space-x-4 ${member.isUser ? 'border-pink-500/40' : ''}">
          <div class="relative">
            <div class="size-10 rounded-full bg-gradient-to-br ${bgColor} flex items-center justify-center">
              <span class="text-white font-bold">${member.rank}</span>
            </div>
            ${member.rank === 1 ? '<div class="absolute -top-1 -right-1"><i class="fi fi-sr-crown text-yellow-400 text-sm crown-glow"></i></div>' : ''}
          </div>
          <div class="flex-1">
            <div class="flex items-center space-x-2">
              <h4 class="font-semibold text-white text-sm">${member.name}</h4>
              ${member.isUser ? '<span class="text-xs bg-pink-500 text-white px-2 py-1 rounded-full">You</span>' : ''}
            </div>
          </div>
          <div class="gap-1 flex items-center">
            <div class="text-md font-bold text-white">${member.points}</div>
            <img src="/assets/point.png" class="w-4" />
          </div>
        </div>
      `;
    }).join('');
  }

  function getRankSuffix(rank) {
    const lastDigit = rank % 10;
    const lastTwoDigits = rank % 100;
    
    if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
      return 'th';
    }
    
    switch (lastDigit) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  }
});