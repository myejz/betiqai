/**
 * dataNormalizer.js
 * Transforms raw (or filtered) fixture data into a standardized
 * JSON schema that the analysis/value-bet engine can consume.
 *
 * Output schema version: 2.0
 */

// ─────────────────────────────────────────────
// SCHEMA VERSION
// ─────────────────────────────────────────────
const SCHEMA_VERSION = '2.0';

// ─────────────────────────────────────────────
// FORM CALCULATORS
// ─────────────────────────────────────────────

/**
 * Converts raw form array into aggregated stats
 * @param {Array<Object>} form - array of match result objects
 * @param {string} sport
 * @returns {Object}
 */
function aggregateForm(form, sport = 'football') {
  if (!form || form.length === 0) {
    return { matches: 0, wins: 0, draws: 0, losses: 0, points: 0, goalsScored: 0, goalsConceded: 0, formString: '', winRate: 0, avgGoalsScored: 0, avgGoalsConceded: 0, last5: [] };
  }

  const wins   = form.filter((m) => m.result === 'W').length;
  const draws  = form.filter((m) => m.result === 'D').length;
  const losses = form.filter((m) => m.result === 'L').length;
  const points = form.reduce((acc, m) => acc + (m.points || 0), 0);
  const goalsScored    = form.reduce((acc, m) => acc + (m.goalsFor    || 0), 0);
  const goalsConceded  = form.reduce((acc, m) => acc + (m.goalsAgainst || 0), 0);
  const formString     = form.map((m) => m.result).join('');
  const last5          = form.slice(-5).map((m) => m.result);
  const recent5Points  = form.slice(-5).reduce((acc, m) => acc + (m.points || 0), 0);

  // Momentum: recent 5 vs earlier form
  const olderPoints = form.slice(0, -5).reduce((acc, m) => acc + (m.points || 0), 0);
  const olderCount  = Math.max(1, form.length - 5);
  const recentPPG   = recent5Points / 5;
  const olderPPG    = olderPoints / olderCount;
  const momentum    = recentPPG - olderPPG; // positive = improving

  return {
    matches:            form.length,
    wins,
    draws,
    losses,
    points,
    winRate:            parseFloat((wins / form.length).toFixed(3)),
    goalsScored,
    goalsConceded,
    goalDifference:     goalsScored - goalsConceded,
    avgGoalsScored:     parseFloat((goalsScored / form.length).toFixed(2)),
    avgGoalsConceded:   parseFloat((goalsConceded / form.length).toFixed(2)),
    formString,
    last5,
    momentum:           parseFloat(momentum.toFixed(3)),
  };
}

/**
 * Calculates home/away split from form data
 * @param {Array<Object>} form
 * @returns {Object}
 */
function formSplit(form) {
  const home = form.filter((m) => m.venue === 'home');
  const away = form.filter((m) => m.venue === 'away');

  return {
    home: {
      played: home.length,
      wins:   home.filter((m) => m.result === 'W').length,
      draws:  home.filter((m) => m.result === 'D').length,
      losses: home.filter((m) => m.result === 'L').length,
    },
    away: {
      played: away.length,
      wins:   away.filter((m) => m.result === 'W').length,
      draws:  away.filter((m) => m.result === 'D').length,
      losses: away.filter((m) => m.result === 'L').length,
    },
  };
}

// ─────────────────────────────────────────────
// H2H NORMALIZER
// ─────────────────────────────────────────────

/**
 * Aggregates H2H history into summary stats
 * @param {Array<Object>} h2h
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @returns {Object}
 */
function normalizeH2H(h2h, homeTeam, awayTeam) {
  if (!h2h || h2h.length === 0) {
    return { played: 0, homeWins: 0, awayWins: 0, draws: 0, homeGoals: 0, awayGoals: 0, recentTrend: 'unknown' };
  }

  const homeWins = h2h.filter((m) => m.result === 'home').length;
  const awayWins = h2h.filter((m) => m.result === 'away').length;
  const draws    = h2h.filter((m) => m.result === 'draw').length;

  const homeGoals = h2h.reduce((acc, m) => acc + (m.homeGoals || 0), 0);
  const awayGoals = h2h.reduce((acc, m) => acc + (m.awayGoals || 0), 0);

  // Recent trend: last 3 h2h results from home team's perspective
  const recent3 = h2h.slice(-3).map((m) => {
    if (m.result === 'home') return 'W';
    if (m.result === 'away') return 'L';
    return 'D';
  });

  let recentTrend = 'balanced';
  const recentHomeWins = recent3.filter((r) => r === 'W').length;
  if (recentHomeWins >= 2) recentTrend = 'home_dominant';
  else if (recent3.filter((r) => r === 'L').length >= 2) recentTrend = 'away_dominant';

  return {
    played:      h2h.length,
    homeWins,
    awayWins,
    draws,
    homeGoals,
    awayGoals,
    avgHomeGoals: parseFloat((homeGoals / h2h.length).toFixed(2)),
    avgAwayGoals: parseFloat((awayGoals / h2h.length).toFixed(2)),
    avgTotal:     parseFloat(((homeGoals + awayGoals) / h2h.length).toFixed(2)),
    recentTrend,
    last3Results: recent3,
    history:      h2h,
  };
}

// ─────────────────────────────────────────────
// INJURY IMPACT SCORE
// ─────────────────────────────────────────────

/**
 * Converts injury list into an impact score [0..1]
 * 1.0 = maximum disruption to squad
 * @param {Array<Object>} injuries
 * @returns {number}
 */
function calcInjuryImpact(injuries) {
  if (!injuries || injuries.length === 0) return 0;
  let score = 0;
  for (const inj of injuries) {
    score += inj.isKeySuspension ? 0.25 : 0.10;
    if (inj.status === 'suspended') score += 0.05;
  }
  return parseFloat(Math.min(score, 1.0).toFixed(3));
}

// ─────────────────────────────────────────────
// ODDS NORMALIZER
// ─────────────────────────────────────────────

/**
 * Extracts implied probabilities from odds (margin-adjusted)
 * @param {Object} odds
 * @param {string} sport
 * @returns {Object}
 */
function normalizeOdds(odds, sport = 'football') {
  if (!odds || !odds.iddaa) return { raw: odds, impliedProb: null };

  const o = odds.iddaa;

  if (sport === 'football') {
    const pHome = 1 / o.home;
    const pDraw = 1 / o.draw;
    const pAway = 1 / o.away;
    const margin = pHome + pDraw + pAway;

    return {
      raw: odds,
      impliedProb: {
        home: parseFloat((pHome / margin).toFixed(4)),
        draw: parseFloat((pDraw / margin).toFixed(4)),
        away: parseFloat((pAway / margin).toFixed(4)),
        margin: parseFloat(((margin - 1) * 100).toFixed(2)), // overround %
      },
    };
  } else {
    const pHome = 1 / o.home;
    const pAway = 1 / o.away;
    const margin = pHome + pAway;
    return {
      raw: odds,
      impliedProb: {
        home: parseFloat((pHome / margin).toFixed(4)),
        away: parseFloat((pAway / margin).toFixed(4)),
        margin: parseFloat(((margin - 1) * 100).toFixed(2)),
      },
    };
  }
}

// ─────────────────────────────────────────────
// DATA NORMALIZER CLASS
// ─────────────────────────────────────────────

class DataNormalizer {
  /**
   * Normalizes a single raw match object into the standard schema.
   * @param {Object} rawMatch
   * @returns {Object} normalized match
   */
  static normalizeMatch(rawMatch) {
    const {
      id, sport, league, country, leagueId, matchDate, kickoffTime,
      homeTeam, awayTeam, odds, homeForm, awayForm, h2h,
      homeInjuries, awayInjuries, status, fetchedAt, source,
      availablePlatform,
    } = rawMatch;

    const normalizedHomeForm = aggregateForm(homeForm, sport);
    const normalizedAwayForm = aggregateForm(awayForm, sport);
    const normalizedOdds     = normalizeOdds(odds, sport);
    const h2hSummary         = normalizeH2H(h2h, homeTeam, awayTeam);

    const homeInjuryImpact = calcInjuryImpact(homeInjuries);
    const awayInjuryImpact = calcInjuryImpact(awayInjuries);

    // Composite form advantage score [-1, 1] (positive = home favoured)
    const formAdv = parseFloat(
      (normalizedHomeForm.winRate - normalizedAwayForm.winRate).toFixed(3)
    );
    const momentumAdv = parseFloat(
      (normalizedHomeForm.momentum - normalizedAwayForm.momentum).toFixed(3)
    );

    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      sport,
      league,
      country,
      leagueId,
      matchDate,
      kickoffTime,
      status,
      source,
      fetchedAt,
      availablePlatform: availablePlatform || 'unknown',

      teams: {
        home: {
          name:          homeTeam,
          form:          normalizedHomeForm,
          homeAwayForm:  formSplit(homeForm || []),
          injuries:      homeInjuries || [],
          injuryImpact:  homeInjuryImpact,
        },
        away: {
          name:          awayTeam,
          form:          normalizedAwayForm,
          homeAwayForm:  formSplit(awayForm || []),
          injuries:      awayInjuries || [],
          injuryImpact:  awayInjuryImpact,
        },
      },

      h2h: h2hSummary,

      odds: normalizedOdds,

      analysis: {
        formAdvantage:   formAdv,    // > 0 home, < 0 away
        momentumAdvantage: momentumAdv,
        injuryBalance:   parseFloat((awayInjuryImpact - homeInjuryImpact).toFixed(3)), // > 0 home benefits
        h2hTrend:        h2hSummary.recentTrend,
        // These fields are PLACEHOLDERS — filled by the value-bet engine
        predictedResult: null,
        valueBetMarket:  null,
        valueBetOdd:     null,
        edge:            null,
        kellyCriterion:  null,
        confidence:      null,
      },

      _raw: rawMatch, // kept for debugging; strip before production output
    };
  }

  /**
   * Normalizes an entire filtered dataset.
   * @param {Object} filteredData - output of oddsFilter.filterRawData()
   * @returns {Object} normalized dataset
   */
  static normalizeAll(filteredData) {
    const normalizedFootball   = (filteredData.football   || []).map((m) => DataNormalizer.normalizeMatch(m));
    const normalizedBasketball = (filteredData.basketball || []).map((m) => DataNormalizer.normalizeMatch(m));

    return {
      schemaVersion:  SCHEMA_VERSION,
      date:           filteredData.date,
      generatedAt:    new Date().toISOString(),
      totalMatches:   normalizedFootball.length + normalizedBasketball.length,
      filterStats:    filteredData.filterStats || {},
      football:       normalizedFootball,
      basketball:     normalizedBasketball,
    };
  }

  /**
   * Strips the _raw field from all matches (for production output).
   * @param {Object} normalizedDataset
   * @returns {Object}
   */
  static stripRaw(normalizedDataset) {
    const strip = (arr) => arr.map(({ _raw, ...rest }) => rest);
    return {
      ...normalizedDataset,
      football:   strip(normalizedDataset.football   || []),
      basketball: strip(normalizedDataset.basketball || []),
    };
  }
}

module.exports = {
  DataNormalizer,
  aggregateForm,
  normalizeH2H,
  normalizeOdds,
  calcInjuryImpact,
  SCHEMA_VERSION,
};
