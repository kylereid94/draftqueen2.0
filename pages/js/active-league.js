// js/active-league.js
export function setActiveLeagueId(id) {
  if (!id) return;
  localStorage.setItem('activeLeagueId', id);
}

export function getActiveLeagueId() {
  return localStorage.getItem('activeLeagueId');
}

export function clearActiveLeagueId() {
  localStorage.removeItem('activeLeagueId');
}

/**
 * Resolves the league to use, in this order:
 * 1) ?league=<id> in the URL
 * 2) localStorage('activeLeagueId')
 * 3) fallback getter (e.g., user's most recent active league from DB)
 * If it finds one, it updates localStorage so all pages stay in sync.
 */
export async function resolveActiveLeagueId(fallbackGetter) {
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = urlParams.get('league');
  if (fromUrl) {
    setActiveLeagueId(fromUrl);
    return fromUrl;
  }
  const fromStorage = getActiveLeagueId();
  if (fromStorage) return fromStorage;

  const fromFallback = fallbackGetter ? await fallbackGetter() : null;
  if (fromFallback) setActiveLeagueId(fromFallback);
  return fromFallback;
}