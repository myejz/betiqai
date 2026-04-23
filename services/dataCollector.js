/**
 * dataCollector.js
 * Responsible for fetching or simulating sports fixture data.
 * In production: replace mock generators with real HTTP calls
 * (Mackolik, Sofascore, Flashscore unofficial APIs or scrapers).
 */

const https = require('https');
const http = require('http');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const LEAGUES = {
  football: [
    { id: 'TR1',  name: 'Süper Lig',          country: 'Türkiye' },
    { id: 'ENG1', name: 'Premier League',      country: 'İngiltere' },
    { id: 'ESP1', name: 'La Liga',             country: 'İspanya' },
    { id: 'GER1', name: 'Bundesliga',          country: 'Almanya' },
    { id: 'ITA1', name: 'Serie A',             country: 'İtalya' },
    { id: 'FRA1', name: 'Ligue 1',             country: 'Fransa' },
    { id: 'UCL',  name: 'UEFA Şampiyonlar Ligi', country: 'Avrupa' },
    { id: 'UEL',  name: 'UEFA Avrupa Ligi',    country: 'Avrupa' },
    { id: 'TR2',  name: '1. Lig',              country: 'Türkiye' },
  ],
  basketball: [
    { id: 'NBA',  name: 'NBA',                 country: 'ABD' },
    { id: 'BSL',  name: 'BSL Türkiye',         country: 'Türkiye' },
    { id: 'EURO', name: 'EuroLeague',          country: 'Avrupa' },
  ],
};

const TEAMS = {
  TR1:  ['Galatasaray','Fenerbahçe','Beşiktaş','Trabzonspor','Başakşehir','Kasımpaşa','Sivasspor','Konyaspor','Adana Demirspor','Antalyaspor','Kayserispor','Hatayspor','Alanyaspor','Gaziantep FK','Rizespor','Eyüpspor','Samsunspor','Bodrum FK'],
  ENG1: ['Arsenal','Chelsea','Liverpool','Manchester City','Manchester United','Tottenham','Newcastle','Aston Villa','Brighton','West Ham'],
  ESP1: ['Real Madrid','Barcelona','Atletico Madrid','Sevilla','Valencia','Villarreal','Real Sociedad','Athletic Bilbao'],
  GER1: ['Bayern Munich','Borussia Dortmund','RB Leipzig','Bayer Leverkusen','Eintracht Frankfurt','Wolfsburg','Freiburg'],
  ITA1: ['Juventus','Inter Milan','AC Milan','Napoli','Roma','Lazio','Atalanta','Fiorentina'],
  FRA1: ['PSG','Olympique Marseille','Monaco','Lyon','Lille','Nice','Rennes'],
  UCL:  ['Real Madrid','Manchester City','Bayern Munich','PSG','Barcelona','Inter Milan','Chelsea','Arsenal'],
  UEL:  ['Galatasaray','Fenerbahçe','Roma','Villarreal','Ajax','Porto','Bayer Leverkusen'],
  TR2:  ['Eyüpspor','Sakaryaspor','Gençlerbirliği','Pendikspor','Çorum FK','Bandırmaspor'],
  NBA:  ['Lakers','Celtics','Warriors','Bucks','Nuggets','Heat','Suns','76ers','Clippers','Nets'],
  BSL:  ['Anadolu Efes','Fenerbahçe Beko','Galatasaray NEF','Tofaş','Pınar Karşıyaka','Büyükçekmece'],
  EURO: ['Real Madrid','CSKA Moscow','Panathinaikos','Maccabi Tel Aviv','Anadolu Efes','Fenerbahçe Beko'],
};

const FORM_RESULTS = ['W', 'D', 'L'];
const INJURY_POOL = {
  football: ['Kaleci','Sol Bek','Sağ Bek','Stoper','Orta Saha','Forvet','Ofansif Orta Saha','Defansif Orta Saha'],
  basketball: ['PG','SG','SF','PF','C'],
};

// ─────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────

/** Pseudorandom seeded float [0,1) — keeps mocks stable within a day */
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/** Random integer between min and max (inclusive) */
function randInt(min, max, seed = Math.random()) {
  return Math.floor(seededRandom(seed) * (max - min + 1)) + min;
}

/** Pick a random element from an array */
function pick(arr, seed = Math.random()) {
  return arr[Math.floor(seededRandom(seed) * arr.length)];
}

/** Generate today's date string YYYY-MM-DD */
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

/** Generate a match UTC time string — always 1 to 24 hours in the future */
function matchTime(hourOffset) {
  const d = new Date();
  // Kick-offs between +1h and +23h from now so they always pass the time window filter
  d.setTime(d.getTime() + (1 + (hourOffset % 22)) * 3_600_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/** Weighted random result for form — better teams win more */
function generateFormResult(teamStrength) {
  const roll = Math.random();
  if (roll < teamStrength * 0.55) return 'W';
  if (roll < teamStrength * 0.55 + 0.25) return 'D';
  return 'L';
}

// ─────────────────────────────────────────────
// MOCK DATA GENERATORS
// ─────────────────────────────────────────────

/**
 * Generates a realistic form record (last N matches)
 * @param {string} teamName
 * @param {number} count - how many recent matches
 * @param {string} sport
 * @returns {Array<Object>}
 */
function generateTeamForm(teamName, count = 10, sport = 'football') {
  const strength = 0.4 + (teamName.length % 7) * 0.08; // deterministic pseudo-strength
  const form = [];
  for (let i = count; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    const result = generateFormResult(strength);
    const goalsFor    = sport === 'football' ? randInt(0, 4, i * 13) : randInt(80, 115, i * 17);
    const goalsAgainst = sport === 'football' ? randInt(0, 3, i * 17) : randInt(78, 112, i * 13);
    form.push({
      date:        d.toISOString().split('T')[0],
      opponent:    `Rakip ${i}`,
      venue:       i % 2 === 0 ? 'home' : 'away',
      result,
      goalsFor,
      goalsAgainst,
      points:      result === 'W' ? 3 : result === 'D' ? 1 : 0,
    });
  }
  return form;
}

/**
 * Generates H2H history between two teams
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {number} count
 * @returns {Array<Object>}
 */
function generateH2H(homeTeam, awayTeam, count = 5) {
  const history = [];
  for (let i = count; i >= 1; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i * 5);
    const homeGoals = randInt(0, 4, i * 7 + homeTeam.length);
    const awayGoals = randInt(0, 3, i * 11 + awayTeam.length);
    history.push({
      date:      d.toISOString().split('T')[0],
      homeTeam,
      awayTeam,
      homeGoals,
      awayGoals,
      result:    homeGoals > awayGoals ? 'home' : homeGoals < awayGoals ? 'away' : 'draw',
      venue:     i % 2 === 0 ? homeTeam : awayTeam,
    });
  }
  return history;
}

/**
 * Generates injury and suspension list for a team
 * @param {string} teamName
 * @param {string} sport
 * @returns {Array<Object>}
 */
function generateInjuryList(teamName, sport = 'football') {
  const positions = INJURY_POOL[sport] || INJURY_POOL.football;
  const count = randInt(0, 4, teamName.length * 3);
  const list = [];
  for (let i = 0; i < count; i++) {
    const returnDate = new Date();
    returnDate.setDate(returnDate.getDate() + randInt(3, 28, i * teamName.length));
    list.push({
      playerName:  `Oyuncu ${teamName.slice(0, 3).toUpperCase()}-${i + 1}`,
      position:    positions[i % positions.length],
      status:      i === 0 ? 'suspended' : 'injured',
      estimatedReturn: returnDate.toISOString().split('T')[0],
      isKeySuspension: i === 0,
    });
  }
  return list;
}

/**
 * Generates a realistic odds object for a match
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} sport
 * @returns {Object}
 */
function generateOdds(homeTeam, awayTeam, sport = 'football') {
  const seed = homeTeam.length + awayTeam.length;
  if (sport === 'football') {
    const home = (1.3 + seededRandom(seed) * 3.5).toFixed(2);
    const draw = (2.8 + seededRandom(seed + 1) * 1.5).toFixed(2);
    const away = (1.5 + seededRandom(seed + 2) * 4.0).toFixed(2);
    const over25 = (1.5 + seededRandom(seed + 3) * 1.2).toFixed(2);
    const under25 = (1.0 / (1.0 / over25 * 0.95)).toFixed(2); // correlated
    return {
      platform: pick(['İddaa', 'Bilyoner', 'both'], seed),
      iddaa: {
        home: parseFloat(home),
        draw: parseFloat(draw),
        away: parseFloat(away),
        over25: parseFloat(over25),
        under25: parseFloat(under25),
        btts: (1.6 + seededRandom(seed + 4) * 0.8).toFixed(2),
      },
      bilyoner: {
        home: (parseFloat(home) + (seededRandom(seed + 5) - 0.5) * 0.1).toFixed(2),
        draw: (parseFloat(draw) + (seededRandom(seed + 6) - 0.5) * 0.1).toFixed(2),
        away: (parseFloat(away) + (seededRandom(seed + 7) - 0.5) * 0.1).toFixed(2),
      },
    };
  } else {
    // basketball — moneyline + handicap + total
    return {
      platform: pick(['İddaa', 'Bilyoner', 'both'], seed),
      iddaa: {
        home: (1.5 + seededRandom(seed) * 1.5).toFixed(2),
        away: (1.5 + seededRandom(seed + 1) * 1.5).toFixed(2),
        handicap: `${pick(['-3.5','-5.5','-7.5','+3.5','+5.5'], seed)}`,
        total: `${randInt(185, 225, seed + 2)}.5`,
      },
      bilyoner: {
        home: (1.5 + seededRandom(seed + 3) * 1.5).toFixed(2),
        away: (1.5 + seededRandom(seed + 4) * 1.5).toFixed(2),
      },
    };
  }
}

/**
 * Generates a full fixture list for a given sport
 * @param {string} sport - 'football' | 'basketball'
 * @returns {Array<Object>} raw match objects
 */
function generateFixture(sport = 'football') {
  const leaguePool = LEAGUES[sport];
  const fixtures = [];
  let matchId = 1000;

  leaguePool.forEach((league) => {
    const teams = TEAMS[league.id] || [];
    if (teams.length < 2) return;

    // Generate 2–4 matches per league
    const matchCount = randInt(2, 4, league.id.length + sport.length);
    const usedPairs = new Set();

    for (let i = 0; i < matchCount; i++) {
      let homeIdx, awayIdx, pairKey;
      let attempts = 0;
      do {
        homeIdx = randInt(0, teams.length - 1, matchId + i + attempts);
        awayIdx = randInt(0, teams.length - 1, matchId + i + attempts + 100);
        pairKey = `${homeIdx}-${awayIdx}`;
        attempts++;
      } while ((homeIdx === awayIdx || usedPairs.has(pairKey)) && attempts < 20);

      usedPairs.add(pairKey);
      const homeTeam = teams[homeIdx];
      const awayTeam = teams[awayIdx];

      fixtures.push({
        id:       `${sport.toUpperCase()}-${league.id}-${matchId}`,
        sport,
        league:   league.name,
        country:  league.country,
        leagueId: league.id,
        matchDate: todayStr(),
        kickoffTime: matchTime(i + (league.id.length % 3)),
        homeTeam,
        awayTeam,
        odds:     generateOdds(homeTeam, awayTeam, sport),
        homeForm: generateTeamForm(homeTeam, 10, sport),
        awayForm: generateTeamForm(awayTeam, 10, sport),
        h2h:      generateH2H(homeTeam, awayTeam, 5),
        homeInjuries: generateInjuryList(homeTeam, sport),
        awayInjuries: generateInjuryList(awayTeam, sport),
        status: 'scheduled',
        fetchedAt: new Date().toISOString(),
        source: 'MOCK_DATA_v1', // change to 'mackolik' | 'sofascore' when real
      });

      matchId++;
    }
  });

  return fixtures;
}

// ─────────────────────────────────────────────
// REAL HTTP HELPER (for future real endpoints)
// ─────────────────────────────────────────────

/**
 * Generic HTTP GET with timeout
 * @param {string} url
 * @param {Object} headers
 * @param {number} timeoutMs
 * @returns {Promise<Object>}
 */
function httpGet(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`JSON parse hatası: ${url}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Zaman aşımı: ${url}`));
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

/**
 * Main entry point — collects all data for a given date.
 * Swap out generateFixture() with real API calls when ready.
 *
 * @param {string} date - YYYY-MM-DD (defaults to today)
 * @returns {Promise<Object>} { football: [], basketball: [], fetchedAt, errors: [] }
 */
async function collectAllData(date = todayStr()) {
  const errors = [];

  let footballFixtures = [];
  let basketballFixtures = [];

  try {
    footballFixtures = generateFixture('football');
  } catch (err) {
    errors.push({ sport: 'football', message: err.message });
  }

  try {
    basketballFixtures = generateFixture('basketball');
  } catch (err) {
    errors.push({ sport: 'basketball', message: err.message });
  }

  return {
    date,
    football:   footballFixtures,
    basketball: basketballFixtures,
    totalMatches: footballFixtures.length + basketballFixtures.length,
    fetchedAt:  new Date().toISOString(),
    errors,
  };
}

module.exports = {
  collectAllData,
  generateFixture,
  generateTeamForm,
  generateH2H,
  generateInjuryList,
  todayStr,
  httpGet,
};
