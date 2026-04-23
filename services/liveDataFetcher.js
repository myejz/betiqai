/**
 * services/liveDataFetcher.js — BetIQ Canlı Veri Çekici
 *
 * Bu modül dış bahis/skor API'lerinden veri çeker, formatlar
 * ve dataStore'a kaydeder. runDataRefresh() tarafından tetiklenir.
 *
 * Desteklenen sağlayıcılar:
 *   - The Odds API  (https://the-odds-api.com) — API_PROVIDER=odds_api
 *   - API-Football  (https://api-football.com) — API_PROVIDER=api_football
 *   - MOCK          (gerçek API key yokken)    — API_PROVIDER=mock (varsayılan)
 *
 * Ortam değişkenleri:
 *   API_PROVIDER     = 'mock' | 'odds_api' | 'api_football'
 *   ODDS_API_KEY     = The Odds API anahtarı
 *   API_FOOTBALL_KEY = API-Football anahtarı
 *
 * Özellikler:
 *   ✓ Retry mekanizması (üstel geri çekilme)
 *   ✓ Timeout koruması (istek başına 8 saniye)
 *   ✓ Dış API hata/timeout → store'a setError() yerine eski veri korunur
 *   ✓ Her adım Türkçe log mesajıyla takip edilebilir
 */

'use strict';

const https   = require('https');
const http    = require('http');
const store   = require('./dataStore');

// ─────────────────────────────────────────────
// SABİTLER
// ─────────────────────────────────────────────

const SAGLAYICI      = process.env.API_PROVIDER   || 'mock';
const ODDS_API_KEY   = process.env.ODDS_API_KEY   || '';
const AFOOTBALL_KEY  = process.env.API_FOOTBALL_KEY || '';

// Retry ayarları
const MAKS_DENEME      = 3;       // toplam deneme sayısı
const TEMEL_BEKLEME_MS = 1000;    // ilk retry bekleme süresi (ms)
const ISTEK_TIMEOUT_MS = 8000;    // her istek için maksimum süre

// The Odds API için sport anahtarları
const ODDS_API_SPORLAR = {
  futbol:    ['soccer_turkey_super_league', 'soccer_epl', 'soccer_spain_la_liga',
               'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one',
               'soccer_uefa_champs_league'],
  basketbol: ['basketball_nba'],
};

// API-Football için lig ID'leri
const AFOOTBALL_LIGLER = {
  futbol:    [203, 39, 140, 78, 135, 61, 2],   // Süper Lig, EPL, La Liga, Bundesliga, Serie A, L1, UCL
  basketbol: [120],                              // NBA
};

// ─────────────────────────────────────────────
// HTTP YARDIMCISI
// ─────────────────────────────────────────────

/**
 * Timeout'lu generic HTTP GET
 * @param {string} url
 * @param {Object} basliklar
 * @param {number} timeoutMs
 * @returns {Promise<Object>}
 */
function httpGet(url, basliklar = {}, timeoutMs = ISTEK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const istek = lib.get(url, { headers: basliklar }, (yanit) => {
      let govde = '';
      yanit.on('data', (parca) => (govde += parca));
      yanit.on('end', () => {
        try {
          const veri = JSON.parse(govde);
          // HTTP hata kodlarını fırlat
          if (yanit.statusCode >= 400) {
            reject(new Error(`API HTTP hatası: ${yanit.statusCode} — ${url}`));
          } else {
            resolve(veri);
          }
        } catch {
          reject(new Error(`JSON ayrıştırma hatası: ${url}`));
        }
      });
    });

    istek.setTimeout(timeoutMs, () => {
      istek.destroy();
      reject(new Error(`Zaman aşımı (${timeoutMs}ms): ${url}`));
    });

    istek.on('error', (hata) => {
      reject(new Error(`Ağ hatası: ${hata.message} — ${url}`));
    });
  });
}

// ─────────────────────────────────────────────
// RETRY MEKANİZMASI
// ─────────────────────────────────────────────

/**
 * Belirtilen fonksiyonu retry mantığıyla çalıştırır.
 * Her başarısız denemeden sonra üstel geri çekilme (exponential backoff) uygular.
 *
 * @param {Function} islevFn    - async () => sonuc döndüren fonksiyon
 * @param {string}   islemAdi  - loglama için açıklama
 * @param {number}   maksDeneme
 * @returns {Promise<any>}
 */
async function retryIle(islevFn, islemAdi, maksDeneme = MAKS_DENEME) {
  let sonHata;

  for (let deneme = 1; deneme <= maksDeneme; deneme++) {
    try {
      const sonuc = await islevFn();
      if (deneme > 1) {
        console.log(`[BetIQ Fetcher] "${islemAdi}" — ${deneme}. denemede başarılı.`);
      }
      return sonuc;
    } catch (hata) {
      sonHata = hata;
      const beklemeSuresi = TEMEL_BEKLEME_MS * Math.pow(2, deneme - 1); // 1s, 2s, 4s
      console.warn(
        `[BetIQ Fetcher] "${islemAdi}" başarısız (${deneme}/${maksDeneme}): ${hata.message}` +
        (deneme < maksDeneme ? ` — ${beklemeSuresi}ms içinde tekrar deneniyor...` : '')
      );

      if (deneme < maksDeneme) {
        await new Promise((r) => setTimeout(r, beklemeSuresi));
      }
    }
  }

  throw new Error(`"${islemAdi}" ${maksDeneme} denemeden sonra başarısız: ${sonHata.message}`);
}

// ─────────────────────────────────────────────
// THE ODDS API ADAPTÖRÜ
// ─────────────────────────────────────────────

/**
 * The Odds API'den maç ve oran verisi çeker.
 * Dönüş: { football: [...], basketball: [...], toplamMac, kaynakSaglayici }
 */
async function oddsApidenCek() {
  if (!ODDS_API_KEY) {
    throw new Error('ODDS_API_KEY env variable ayarlanmamış.');
  }

  const tumFutbol    = [];
  const tumBasketbol = [];

  // Futbol sporlarını çek
  for (const sporKey of ODDS_API_SPORLAR.futbol) {
    const url = `https://api.the-odds-api.com/v4/sports/${sporKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`;
    const veri = await retryIle(() => httpGet(url), `Odds API futbol: ${sporKey}`);

    for (const etkinlik of (veri || [])) {
      const formatlananMac = oddsApiMacFormatla(etkinlik, 'football');
      if (formatlananMac) tumFutbol.push(formatlananMac);
    }
  }

  // Basketbol sporlarını çek
  for (const sporKey of ODDS_API_SPORLAR.basketbol) {
    const url = `https://api.the-odds-api.com/v4/sports/${sporKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const veri = await retryIle(() => httpGet(url), `Odds API basketbol: ${sporKey}`);

    for (const etkinlik of (veri || [])) {
      const formatlananMac = oddsApiMacFormatla(etkinlik, 'basketball');
      if (formatlananMac) tumBasketbol.push(formatlananMac);
    }
  }

  return {
    football:   tumFutbol,
    basketball: tumBasketbol,
    toplamMac:  tumFutbol.length + tumBasketbol.length,
    kaynakSaglayici: 'the_odds_api',
  };
}

/**
 * The Odds API yanıtını BetIQ iç formatına dönüştürür.
 */
function oddsApiMacFormatla(etkinlik, spor) {
  try {
    const basBookmaker = etkinlik.bookmakers?.[0];
    if (!basBookmaker) return null;

    const h2hPazari = basBookmaker.markets?.find((m) => m.key === 'h2h');
    const toplamPazari = basBookmaker.markets?.find((m) => m.key === 'totals');

    if (!h2hPazari || h2hPazari.outcomes.length < 2) return null;

    const evSahibiOran = h2hPazari.outcomes.find((o) => o.name === etkinlik.home_team)?.price;
    const misafirOran  = h2hPazari.outcomes.find((o) => o.name === etkinlik.away_team)?.price;
    const berabereOran = h2hPazari.outcomes.find((o) => o.name === 'Draw')?.price;

    return {
      id:          `LIVE-${spor.toUpperCase()}-${etkinlik.id}`,
      sport:       spor,
      league:      etkinlik.sport_title || 'Bilinmeyen Lig',
      country:     'Bilinmiyor',
      leagueId:    etkinlik.sport_key?.toUpperCase() || 'UNK',
      matchDate:   etkinlik.commence_time?.split('T')[0] || bugunStr(),
      kickoffTime: etkinlik.commence_time,
      homeTeam:    etkinlik.home_team,
      awayTeam:    etkinlik.away_team,
      status:      'scheduled',
      fetchedAt:   new Date().toISOString(),
      source:      'the_odds_api',
      odds: {
        platform: 'both',
        iddaa: {
          home:   evSahibiOran   || 2.0,
          draw:   berabereOran   || 3.0,
          away:   misafirOran    || 2.5,
          over25: toplamPazari?.outcomes?.find((o) => o.name === 'Over')?.price || 1.8,
          under25: toplamPazari?.outcomes?.find((o) => o.name === 'Under')?.price || 1.9,
        },
        bilyoner: {
          home: evSahibiOran  || 2.0,
          draw: berabereOran  || 3.0,
          away: misafirOran   || 2.5,
        },
      },
      // Form ve H2H verisi bu API'de yok — mock ile doldur
      homeForm:     [],
      awayForm:     [],
      h2h:          [],
      homeInjuries: [],
      awayInjuries: [],
      availablePlatform: 'both',
    };
  } catch (hata) {
    console.warn(`[BetIQ Fetcher] Odds API maç formatlama hatası: ${hata.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// API-FOOTBALL ADAPTÖRÜ
// ─────────────────────────────────────────────

/**
 * API-Football'dan bugünün maçlarını çeker.
 */
async function apiFootbaldenCek() {
  if (!AFOOTBALL_KEY) {
    throw new Error('API_FOOTBALL_KEY env variable ayarlanmamış.');
  }

  const bugun = bugunStr();
  const tumFutbol    = [];
  const tumBasketbol = [];

  for (const ligId of AFOOTBALL_LIGLER.futbol) {
    const url = `https://v3.football.api-sports.io/fixtures?date=${bugun}&league=${ligId}&season=2024`;
    const basliklar = { 'x-apisports-key': AFOOTBALL_KEY };
    const yanit = await retryIle(() => httpGet(url, basliklar), `API-Football lig ${ligId}`);

    for (const fikstür of (yanit.response || [])) {
      const formatlananMac = apiFootballMacFormatla(fikstür, 'football');
      if (formatlananMac) tumFutbol.push(formatlananMac);
    }
  }

  return {
    football:   tumFutbol,
    basketball: tumBasketbol,
    toplamMac:  tumFutbol.length + tumBasketbol.length,
    kaynakSaglayici: 'api_football',
  };
}

/**
 * API-Football yanıtını BetIQ iç formatına dönüştürür.
 */
function apiFootballMacFormatla(fikstür, spor) {
  try {
    const { fixture, league, teams, goals } = fikstür;
    return {
      id:          `LIVE-${spor.toUpperCase()}-${fixture.id}`,
      sport:       spor,
      league:      league.name,
      country:     league.country,
      leagueId:    `AF_${league.id}`,
      matchDate:   fixture.date?.split('T')[0] || bugunStr(),
      kickoffTime: fixture.date,
      homeTeam:    teams.home.name,
      awayTeam:    teams.away.name,
      status:      fixture.status?.short === 'NS' ? 'scheduled' : fixture.status?.short?.toLowerCase(),
      fetchedAt:   new Date().toISOString(),
      source:      'api_football',
      // Bu API'den oran gelmez — oddsFilter mock oran üretir
      odds:        null,
      homeForm:    [],
      awayForm:    [],
      h2h:         [],
      homeInjuries: [],
      awayInjuries: [],
    };
  } catch (hata) {
    console.warn(`[BetIQ Fetcher] API-Football maç formatlama hatası: ${hata.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// MOCK ADAPTÖRÜ
// ─────────────────────────────────────────────

/**
 * Gerçek API key yokken mock dataCollector'ı kullanır.
 * Üretim ortamında bu dalın hiç çalışmaması gerekir.
 */
async function mockVeriCek() {
  const { collectAllData } = require('./dataCollector');
  console.log('[BetIQ Fetcher] MOCK mod: Gerçek API yerine simüle veri kullanılıyor.');
  const veri = await collectAllData();
  return {
    football:   veri.football,
    basketball: veri.basketball,
    toplamMac:  veri.totalMatches,
    kaynakSaglayici: 'mock_v1',
  };
}

// ─────────────────────────────────────────────
// YARDIMCI FONKSİYONLAR
// ─────────────────────────────────────────────

/** Bugünün tarihini YYYY-MM-DD formatında döndürür */
function bugunStr() {
  return new Date().toISOString().split('T')[0];
}

// ─────────────────────────────────────────────
// ANA GİRİŞ NOKTASI
// ─────────────────────────────────────────────

/**
 * fetchLiveData — Aktif sağlayıcıya göre veri çeker.
 *
 * Dış API başarısız olursa:
 *   - store.setError() ÇAĞRILMAZ (eski veri korunur)
 *   - Hata fırlatılır, üst katman (dataJob) yakalayıp loglar
 *   - server.js /api/guncelle endpoint'i 206 ile eski veriyi döner
 *
 * @returns {Promise<Object>} { football, basketball, toplamMac, kaynakSaglayici }
 */
async function fetchLiveData() {
  console.log(`[BetIQ Fetcher] Canlı veri çekiliyor — Sağlayıcı: ${SAGLAYICI}`);
  const baslangic = Date.now();

  let hammVeri;

  switch (SAGLAYICI) {
    case 'odds_api':
      hammVeri = await oddsApidenCek();
      break;
    case 'api_football':
      hammVeri = await apiFootbaldenCek();
      break;
    case 'mock':
    default:
      hammVeri = await mockVeriCek();
      break;
  }

  const sureMs = Date.now() - baslangic;
  console.log(
    `[BetIQ Fetcher] Veri çekme tamamlandı: ${hammVeri.toplamMac} maç ` +
    `(${sureMs}ms, kaynak: ${hammVeri.kaynakSaglayici})`
  );

  return {
    date:         bugunStr(),
    football:     hammVeri.football     || [],
    basketball:   hammVeri.basketball   || [],
    totalMatches: hammVeri.toplamMac    || 0,
    fetchedAt:    new Date().toISOString(),
    source:       hammVeri.kaynakSaglayici,
    errors:       [],
  };
}

module.exports = {
  fetchLiveData,
  retryIle,
  httpGet,
  bugunStr,
};
