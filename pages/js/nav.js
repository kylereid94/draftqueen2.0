// /pages/js/nav.js
(function () {
  const ACTIVE_LEAGUE_KEY = 'activeLeagueId';
  const ACTIVE_LEAGUE_STATUS_KEY = 'activeLeagueStatus';

  function getActiveLeagueId() {
    try { return localStorage.getItem(ACTIVE_LEAGUE_KEY); } catch { return null; }
  }
  function getActiveLeagueStatus() {
    try { return localStorage.getItem(ACTIVE_LEAGUE_STATUS_KEY); } catch { return null; }
  }
  function setActiveLeagueStatus(status) {
    try { localStorage.setItem(ACTIVE_LEAGUE_STATUS_KEY, status); } catch {}
  }

  function go(page, { requireLeague = false } = {}) {
    const id = getActiveLeagueId();
    if (requireLeague && !id) {
      window.location.href = '/pages/leagues.html';
      return;
    }
    const qp = id ? `?league=${encodeURIComponent(id)}` : '';
    window.location.href = `/pages/${page}.html${qp}`;
  }

  function updateDraftNav() {
    const btn = document.getElementById('btn-nav-draft');
    const label = document.getElementById('btn-nav-draft-label');
    if (!btn) return;

    const status = (getActiveLeagueStatus() || '').toLowerCase();
    const isActive = status === 'active';
    if (label) label.textContent = isActive ? 'Roster' : 'Draft';

    // Remove previous listeners by cloning to avoid stacking
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = getActiveLeagueId();
      if (!id) return go('leagues');
      if (isActive) {
        window.location.href = `/pages/roster.html?league=${encodeURIComponent(id)}`;
      } else {
        window.location.href = `/pages/draft.html?league=${encodeURIComponent(id)}`;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const byId = (id) => document.getElementById(id);
    const btnLeagues  = byId('btn-nav-leagues');
    const btnOverview = byId('btn-nav-overview');
    const btnDraft    = byId('btn-nav-draft');
    const btnEpisodes = byId('btn-nav-episodes');

    if (btnLeagues)  btnLeagues .addEventListener('click', () => go('leagues'));
    if (btnOverview) btnOverview.addEventListener('click', () => go('overview', { requireLeague: true }));
    if (btnEpisodes) btnEpisodes.addEventListener('click', () => go('episodes', { requireLeague: true }));

    // Sync the Draft/Roster button label and destination based on stored status
    if (btnDraft) updateDraftNav();
  });

  // Expose a tiny API so pages can update the cached status and refresh the label immediately
  window.__dqSetActiveLeagueStatus = function (status) {
    setActiveLeagueStatus(status);
    try { updateDraftNav(); } catch {}
  };
})();