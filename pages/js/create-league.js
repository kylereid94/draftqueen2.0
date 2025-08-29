// js/create-league.js
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
    window.location.href = '/pages/auth.html?returnTo=/create-league.html';
    return;
  }

  // Load available seasons
  await loadSeasons();

  // Prefill a random 5-char join code and wire regenerate
  const joinInput = document.getElementById('join-code');
  const regenBtn = document.getElementById('regen-code');
  function randomCode(len = 5) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }
  if (joinInput && !joinInput.value) joinInput.value = randomCode();
  if (regenBtn) regenBtn.addEventListener('click', () => { joinInput.value = randomCode(); });

  // Set up form submission
  document.getElementById('create-league-form').addEventListener('submit', handleFormSubmission);

  // Set up back button
  document.getElementById('back-btn').addEventListener('click', () => {
    window.location.href = '/pages/leagues.html';
  });

  async function loadSeasons() {
    try {
      const { data: seasons, error } = await supabaseClient
        .from('seasons')
        .select('*')
        .order('season_number', { ascending: false });

      if (error) {
        console.error('Error loading seasons:', error);
        return;
      }

      const seasonSelect = document.getElementById('season-select');
      seasonSelect.innerHTML = '<option value="">Select a season</option>';
      
      seasons.forEach(season => {
        const option = document.createElement('option');
        option.value = season.id;
        option.textContent = season.name;
        seasonSelect.appendChild(option);
      });

    } catch (error) {
      console.error('Error loading seasons:', error);
    }
  }

  async function handleFormSubmission(event) {
    event.preventDefault();

    // Get form data
    const formData = new FormData(event.target);
    // Read and validate join code
    const rawJoin = (formData.get('join-code') || '').toString().trim().toUpperCase();
    const joinCode = rawJoin.replace(/[^A-Z0-9]/g, '').slice(0,5);
    if (joinCode.length !== 5) {
      showAlert('Join code must be exactly 5 letters/numbers.', 'error');
      return;
    }
        // Read new Draft Rules inputs
    const ownershipMode = (formData.get('draft-ownership') || 'unique').toString();
    const maxOwnersRaw = formData.get('max-owners');
    const maxOwnersVal = maxOwnersRaw !== null && maxOwnersRaw !== '' ? parseInt(maxOwnersRaw, 10) : null;
    const leagueData = {
      name: formData.get('league-name').trim(),
      season_id: formData.get('season'),
      max_players: parseInt(formData.get('max-players')),
      roster_size: parseInt(formData.get('roster-size')),
      draft_format: formData.get('draft-format'),
      draft_occurrence: formData.get('draft-timing'),
      commissioner_id: session.user.id,
      status: 'setup',
      join_code: joinCode,
      ownership_mode: ownershipMode === 'multiple' ? 'multiple' : 'unique',
      max_owners_per_queen: ownershipMode === 'multiple' ? (Number.isFinite(maxOwnersVal) ? maxOwnersVal : null) : null
    };

    // Basic validation
    if (!leagueData.name) {
      showAlert('Please enter a league name', 'error');
      return;
    }

    if (!leagueData.season_id) {
      showAlert('Please select a season', 'error');
      return;
    }

        // Validate ownership settings
    if (ownershipMode === 'multiple') {
      if (!Number.isFinite(maxOwnersVal) || maxOwnersVal < 1) {
        showAlert('Please enter a valid Max Owners Per Queen (1 or more).', 'error');
        return;
      }
    }

    // Disable submit button and show loading
    const submitBtn = document.getElementById('submit-btn');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating League...';

    try {
      // Create the league
      const { data: league, error: leagueError } = await supabaseClient
        .from('leagues')
        .insert([leagueData])
        .select()
        .single();

      if (leagueError) {
        throw leagueError;
      }

      // Add the creator as the first league member
      const { error: memberError } = await supabaseClient
        .from('league_members')
        .insert([{
          league_id: league.id,
          user_id: session.user.id,
          draft_position: 1
        }]);

      if (memberError) {
        // If adding member fails, we should clean up the league
        await supabaseClient.from('leagues').delete().eq('id', league.id);
        throw memberError;
      }

      // Success! Redirect to the new league
      showAlert('League created successfully!', 'success');
      setTimeout(() => {
        window.location.href = `/pages/overview.html?league=${league.id}`;
      }, 1500);

    } catch (error) {
      console.error('Error creating league:', error);
      showAlert(error.message || 'Failed to create league', 'error');
      
      // Re-enable submit button
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }

  function showAlert(message, type) {
    const alertDiv = document.getElementById('alert');
    alertDiv.textContent = message;
    alertDiv.classList.remove('hidden');
    
    if (type === 'error') {
      alertDiv.className = 'mb-4 p-3 rounded-xl text-sm bg-red-500/20 border border-red-500/40 text-red-200';
    } else if (type === 'success') {
      alertDiv.className = 'mb-4 p-3 rounded-xl text-sm bg-green-500/20 border border-green-500/40 text-green-200';
    }

    // Hide alert after 5 seconds
    setTimeout(() => {
      alertDiv.classList.add('hidden');
    }, 5000);
  }
});