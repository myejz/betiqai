/**
 * oddsFilter.js
 * Filters raw fixture data to only include matches that are
 * available (or likely available) on İddaa and/or Bilyoner.
 *
 * İddaa coverage rules (approximated):
 *   - Süper Lig, 1. Lig, major European leagues, UCL, UEL
 *   - NBA, BSL, EuroLeague
 *   - Match must be scheduled (not postponed/cancelled)
 *   - Kickoff must be within the next 72 hours
 *
 * Bilyoner coverage rules:
 *   - Superset of İddaa (Bilyoner also hosts İddaa coupons)
 *   - Additionally covers some lower-tier leagues
 */

// ─────────────────────────────────────────────
// PLATFORM COVERAGE CONFIGS
// ─────────────────────────────────────────────

const IDDAA_FOOTBALL_LEAGUES = new Set([
  'TR1','TR2','ENG1','ESP1','GER1','ITA1','FRA1','UCL','UEL',
  'ENG2','ESP2','GER2','NED1','POR1','BEL1','SCO1',
]);

const IDDAA_BASKETBALL_LEAGUES = new Set([
  'NBA','BSL','EURO','FIBA','NBL',
]);

const BILYONER_EXTRA_FOOTBALL = new Set([
  'TR3','ENG3','ARG1','BRA1','MLS','SAFB',
]);

const BILYONER_EXTRA_BASKETBALL = new Set([
  'NCAAB','ACB',
]);

// How many hours ahead can a match be and still appear on the coupon?
const MAX_HOURS_AHEAD = 72;
// How many hours behind is still "live" (for in-play)?
const MAX_HOURS_BEHIND = 3;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Checks if a match's kickoff time is within the platform's
 * acceptable window (upcoming or recently started).
 * @param {string} kickoffTime - ISO timestamp
 * @returns {boolean}
 */
function isWithinWindow(kickoffTime) {
  const now = Date.now();
  const kickoff = new Date(kickoffTime).getTime();
  const diffHours = (kickoff - now) / 3_600_000;
  return diffHours >= -MAX_HOURS_BEHIND && diffHours <= MAX_HOURS_AHEAD;
}

/**
 * Determines which platform(s) a match is available on.
 * Returns null if not available on either platform.
 * @param {Object} match - raw fixture object
 * @returns {'iddaa'|'bilyoner'|'both'|null}
 */
function resolvePlatform(match) {
  const { leagueId, sport, status, kickoffTime, odds } = match;

  // Cancelled or postponed matches are never shown
  if (status === 'cancelled' || status === 'postponed') return null;

  // Must be within time window
  if (!isWithinWindow(kickoffTime)) return null;

  // If the mock already assigned a platform from odds generation, use it
  // but still validate against our league lists
  const leagueSet = sport === 'basketball'
    ? { iddaa: IDDAA_BASKETBALL_LEAGUES, bilyoner: BILYONER_EXTRA_BASKETBALL }
    : { iddaa: IDDAA_FOOTBALL_LEAGUES,    bilyoner: BILYONER_EXTRA_FOOTBALL };

  const onIddaa    = leagueSet.iddaa.has(leagueId);
  const onBilyoner = onIddaa || leagueSet.bilyoner.has(leagueId);

  if (onIddaa)    return 'both';   // Bilyoner is a superset of İddaa
  if (onBilyoner) return 'bilyoner';
  return null;
}

/**
 * Validates that odds exist and are within realistic bounds.
 * @param {Object} odds
 * @param {string} sport
 * @returns {boolean}
 */
function hasValidOdds(odds, sport) {
  if (!odds || !odds.iddaa) return false;
  const o = odds.iddaa;
  if (sport === 'football') {
    return (
      o.home > 1.0 && o.home < 20.0 &&
      o.draw > 1.0 && o.draw < 20.0 &&
      o.away > 1.0 && o.away < 20.0
    );
  }
  // basketball
  return o.home > 1.0 && o.home < 5.0 && o.away > 1.0 && o.away < 5.0;
}

// ─────────────────────────────────────────────
// FILTER PIPELINE
// ─────────────────────────────────────────────

/**
 * Filters a list of raw match objects to only those
 * available on İddaa and/or Bilyoner.
 *
 * @param {Array<Object>} matches - output of dataCollector.generateFixture()
 * @param {Object} options
 * @param {string} [options.platform] - 'iddaa' | 'bilyoner' | 'both' | 'any'
 * @param {string} [options.sport] - 'football' | 'basketball' | 'all'
 * @returns {{ filtered: Array<Object>, stats: Object }}
 */
function filterByPlatform(matches, options = {}) {
  const { platform = 'any', sport = 'all' } = options;
  const stats = {
    total:        matches.length,
    passed:       0,
    rejectedPlatform: 0,
    rejectedOdds: 0,
    rejectedTime:  0,
  };

  const filtered = [];

  for (const match of matches) {
    // Sport filter
    if (sport !== 'all' && match.sport !== sport) continue;

    // Odds validity
    if (!hasValidOdds(match.odds, match.sport)) {
      stats.rejectedOdds++;
      continue;
    }

    // Platform check
    const resolvedPlatform = resolvePlatform(match);
    if (!resolvedPlatform) {
      // Distinguish time vs coverage rejection
      if (!isWithinWindow(match.kickoffTime)) stats.rejectedTime++;
      else stats.rejectedPlatform++;
      continue;
    }

    // Platform filter
    if (platform === 'iddaa' && !['iddaa', 'both'].includes(resolvedPlatform)) continue;
    if (platform === 'bilyoner' && !['bilyoner', 'both'].includes(resolvedPlatform)) continue;

    filtered.push({
      ...match,
      availablePlatform: resolvedPlatform,
    });
    stats.passed++;
  }

  stats.rejectedPlatform = stats.total - stats.passed - stats.rejectedOdds - stats.rejectedTime;

  return { filtered, stats };
}

/**
 * Convenience — runs filter on both football and basketball
 * arrays coming from collectAllData().
 *
 * @param {Object} rawData - { football: [], basketball: [] }
 * @param {Object} options
 * @returns {Object} filtered data with stats
 */
function filterRawData(rawData, options = {}) {
  const allMatches = [...(rawData.football || []), ...(rawData.basketball || [])];
  const { filtered, stats } = filterByPlatform(allMatches, options);

  return {
    date:      rawData.date,
    fetchedAt: rawData.fetchedAt,
    football:  filtered.filter((m) => m.sport === 'football'),
    basketball: filtered.filter((m) => m.sport === 'basketball'),
    totalFiltered: filtered.length,
    filterStats: stats,
  };
}

module.exports = {
  filterByPlatform,
  filterRawData,
  resolvePlatform,
  hasValidOdds,
};
