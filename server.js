/**
 * server.js — BetIQ Backend
 * Express sunucusu, veri API endpoint'leri ile birlikte.
 * Tüm kullanıcıya yönelik mesajlar Türkçe'dir.
 *
 * DEĞİŞİKLİKLER:
 *   1. CORS listesi düzeltildi — betiqai-production Railway URL eklendi
 *   2. CORS, CLIENT_URL env variable üzerinden dinamik olarak besleniyor
 *   3. /api/guncelle endpoint'i artık işlem bitince yanıt veriyor (race condition giderildi)
 *   4. REFRESH_TOKEN yoksa endpoint tamamen açık çalışıyor (geliştirme kolaylığı)
 *   5. Tüm hata blokları detaylandırıldı
 */

const express  = require('express');
const path     = require('path');
const store    = require('./services/dataStore');
const { runDataRefresh, startScheduler, initialLoad } = require('./jobs/dataJob');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

app.use(express.json());
app.use(express.static(__dirname));

// CORS — izin verilen kaynaklar
// CLIENT_URL env variable varsa dinamik olarak ekleniyor
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Sabit izin listesi
  const izinliOriginler = [
    'https://betiqai-production.up.railway.app',   // ← DÜZELTİLDİ (eski: betiq-production-76d1)
    'https://betiq-production-76d1.up.railway.app', // geriye dönük uyumluluk
    'http://localhost:3000',
    'http://localhost:5173',
  ];

  // Env variable üzerinden ek origin ekleme imkânı
  if (process.env.CLIENT_URL) {
    izinliOriginler.push(process.env.CLIENT_URL);
  }

  if (!origin || izinliOriginler.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // x-refresh-token header'ı da izin listesine eklendi
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-refresh-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// İstek günlükçüsü (minimal)
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ─────────────────────────────────────────────
// YARDIMCI FONKSİYONLAR
// ─────────────────────────────────────────────

/** Standart hata yanıtı */
function sendError(res, statusCode, message, details = null) {
  const body = { hata: message, durum: 'hata' };
  if (details) body.detay = details;
  return res.status(statusCode).json(body);
}

/** Store'u kontrol eder, hazır değilse hata gönderir */
function requireReadyStore(res) {
  const s = store.get();
  if (s.status === 'loading') {
    sendError(res, 503, 'Veriler şu an güncelleniyor, lütfen birkaç saniye sonra tekrar deneyin.');
    return null;
  }
  if (s.status === 'error') {
    sendError(res, 502, 'Veri kaynağından veri alınamadı.', s.error);
    return null;
  }
  if (s.status === 'empty' || !s.data) {
    sendError(res, 503, "Henüz veri yüklenmedi. Lütfen bekleyin veya /api/guncelle endpoint'ini kullanın.");
    return null;
  }
  return s.data;
}

// ─────────────────────────────────────────────
// API ROUTE'LAR
// ─────────────────────────────────────────────

/**
 * GET /api/durum
 * Sistem sağlık durumu ve son güncelleme zamanı
 */
app.get('/api/durum', (req, res) => {
  const s = store.get();
  const durumHaritasi = {
    empty:   'Veri yok',
    loading: 'Güncelleniyor',
    ready:   'Hazır',
    error:   'Hata',
  };
  res.json({
    durum:           durumHaritasi[s.status] || s.status,
    sonGuncelleme:   s.lastUpdated || null,
    toplamMac:       s.data?.totalMatches ?? 0,
    futbol:          s.data?.football?.length ?? 0,
    basketbol:       s.data?.basketball?.length ?? 0,
    eskiVeri:        store.isStale(60),
    sunucu:          'BetIQ v2.0',
  });
});

/**
 * GET /api/maclar
 * Tüm normalize edilmiş maçlar (filtrelenmiş)
 */
app.get('/api/maclar', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;

  const { spor = 'hepsi', platform = 'hepsi', lig } = req.query;

  let futbol     = data.football   || [];
  let basketbol  = data.basketball || [];

  if (spor === 'futbol')     basketbol = [];
  if (spor === 'basketbol')  futbol    = [];

  const platformFiltrele = (maclar) => {
    if (platform === 'hepsi') return maclar;
    return maclar.filter((m) => {
      if (platform === 'iddaa')    return ['iddaa', 'both'].includes(m.availablePlatform);
      if (platform === 'bilyoner') return ['bilyoner', 'both'].includes(m.availablePlatform);
      return true;
    });
  };

  const ligFiltrele = (maclar) => {
    if (!lig) return maclar;
    return maclar.filter((m) => m.leagueId === lig.toUpperCase());
  };

  futbol    = ligFiltrele(platformFiltrele(futbol));
  basketbol = ligFiltrele(platformFiltrele(basketbol));

  res.json({
    durum:          'hazır',
    tarih:          data.date,
    sonGuncelleme:  store.get().lastUpdated,
    toplamMac:      futbol.length + basketbol.length,
    futbol,
    basketbol,
  });
});

/** GET /api/maclar/:id */
app.get('/api/maclar/:id', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;

  const tumMaclar = [...(data.football || []), ...(data.basketball || [])];
  const mac = tumMaclar.find((m) => m.id === req.params.id);

  if (!mac) {
    return sendError(res, 404, `"${req.params.id}" ID'li maç bulunamadı.`);
  }
  res.json({ durum: 'hazır', mac });
});

/** GET /api/futbol */
app.get('/api/futbol', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;
  res.json({
    durum:         'hazır',
    tarih:         data.date,
    sonGuncelleme: store.get().lastUpdated,
    toplamMac:     data.football.length,
    maclar:        data.football,
  });
});

/** GET /api/basketbol */
app.get('/api/basketbol', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;
  res.json({
    durum:         'hazır',
    tarih:         data.date,
    sonGuncelleme: store.get().lastUpdated,
    toplamMac:     data.basketball.length,
    maclar:        data.basketball,
  });
});

/** GET /api/ligler */
app.get('/api/ligler', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;

  const ligleriCikar = (maclar) => {
    const gorulenler = new Map();
    maclar.forEach((m) => {
      if (!gorulenler.has(m.leagueId)) {
        gorulenler.set(m.leagueId, { id: m.leagueId, ad: m.league, ulke: m.country, macSayisi: 0 });
      }
      gorulenler.get(m.leagueId).macSayisi++;
    });
    return [...gorulenler.values()];
  };

  res.json({
    durum:     'hazır',
    futbol:    ligleriCikar(data.football),
    basketbol: ligleriCikar(data.basketball),
  });
});

/**
 * POST /api/guncelle
 * Manuel veri yenileme — FrontEnd'den "Yenile" butonuna basıldığında çağrılır.
 *
 * ÖNEMLİ DEĞİŞİKLİK:
 *   Eski: res.json() ile anında yanıt ver, sonra arka planda runDataRefresh() çalıştır.
 *   Yeni: runDataRefresh() BİTTİKTEN SONRA yanıt ver.
 *         Bu sayede frontend'deki await fetch('/api/guncelle') güvenle bekleyebilir.
 *
 * Güvenlik: REFRESH_TOKEN env variable ayarlıysa token kontrolü yapılır.
 *           Ayarlanmamışsa endpoint herkese açıktır (geliştirme ortamı için uygun).
 */
app.post('/api/guncelle', async (req, res) => {
  // Token koruması — yalnızca REFRESH_TOKEN env variable ayarlıysa aktif
  const token = process.env.REFRESH_TOKEN;
  if (token && req.headers['x-refresh-token'] !== token) {
    return sendError(res, 401, 'Yetkisiz erişim. Geçerli bir token sağlayın.');
  }

  // Güncelleme zaten devam ediyorsa çakışmayı engelle
  const current = store.get();
  if (current.status === 'loading') {
    return res.json({
      durum:   'devam_ediyor',
      mesaj:   'Güncelleme zaten devam ediyor. Lütfen tamamlanmasını bekleyin.',
      zaman:   new Date().toISOString(),
    });
  }

  try {
    // runDataRefresh() tamamlanana kadar burada bekliyoruz
    // Frontend await ile beklediğinden race condition ortadan kalkmış olur
    const ozet = await runDataRefresh();

    return res.json({
      durum:          'tamamlandi',
      mesaj:          'Veri yenileme başarıyla tamamlandı.',
      zaman:          new Date().toISOString(),
      toplamMac:      ozet.totalCollected,
      futbol:         ozet.football,
      basketbol:      ozet.basketball,
      valueBetSayisi: ozet.valueBets,
    });
  } catch (err) {
    console.error(`[BetIQ] Manuel güncelleme hatası: ${err.message}`);

    // Dış API yanıt vermediyse eski veriyi koruyarak bilgi dön
    const eskiVeriMevcut = store.get().status === 'ready';
    return res.status(eskiVeriMevcut ? 206 : 503).json({
      durum:   eskiVeriMevcut ? 'eski_veri' : 'hata',
      mesaj:   eskiVeriMevcut
        ? 'Dış API yanıt vermedi, eski veriler gösteriliyor.'
        : 'Veri güncellenemedi ve mevcut veri de yok.',
      hata:    err.message,
      zaman:   new Date().toISOString(),
    });
  }
});

/** GET /api/istatistik */
app.get('/api/istatistik', (req, res) => {
  const s = store.get();
  const data = requireReadyStore(res);
  if (!data) return;

  res.json({
    durum:          'hazır',
    schemaVersionu: data.schemaVersion,
    tarih:          data.date,
    olusturuldu:    data.generatedAt,
    sonGuncelleme:  s.lastUpdated,
    toplamMac:      data.totalMatches,
    futbolMac:      data.football.length,
    basketbolMac:   data.basketball.length,
    filtreBilgisi:  data.filterStats,
  });
});

/** GET /api/value-betler */
app.get('/api/value-betler', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;

  const { spor = 'hepsi' } = req.query;

  let liste = data.valueBetList || [];
  if (spor === 'futbol')    liste = liste.filter((m) => m.sport === 'football');
  if (spor === 'basketbol') liste = liste.filter((m) => m.sport === 'basketball');

  const slim = liste.map((m) => ({
    id:          m.id,
    sport:       m.sport,
    league:      m.league,
    homeTeam:    m.teams.home.name,
    awayTeam:    m.teams.away.name,
    kickoffTime: m.kickoffTime,
    platform:    m.availablePlatform,
    market:      m.valueReport.bestBet.marketLabel,
    odd:         m.valueReport.bestBet.odd,
    edge:        m.valueReport.bestBet.edge,
    edgePct:     parseFloat((m.valueReport.bestBet.edge * 100).toFixed(1)),
    rating:      m.valueReport.bestBet.rating,
    trueProb:    m.valueReport.bestBet.trueProb,
    trueProbPct: parseFloat((m.valueReport.bestBet.trueProb * 100).toFixed(1)),
    ev:          m.valueReport.bestBet.ev,
    kelly:       m.valueReport.bestBet.kellyCriterion,
    kellyPct:    parseFloat((m.valueReport.bestBet.kellyCriterion * 100).toFixed(1)),
    trapRisk:    m.valueReport.trapReport.trapLabel,
    trapScore:   m.valueReport.trapReport.trapScore,
    summary:     m.valueReport.summary,
    projScore:   m.valueReport.pace.projectedScore,
    tempo:       m.valueReport.pace.tempoLabel,
  }));

  res.json({
    durum:         'hazır',
    tarih:         data.date,
    toplamValue:   slim.length,
    valueBetler:   slim,
    uyari:         slim.length === 0
      ? 'Bugün için onaylanmış value bet bulunamadı. Yüksek standartlar nedeniyle bu normaldir.'
      : null,
  });
});

/** GET /api/maclar/:id/analiz */
app.get('/api/maclar/:id/analiz', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;

  const tumMaclar = [...(data.football || []), ...(data.basketball || [])];
  const mac = tumMaclar.find((m) => m.id === req.params.id);

  if (!mac) {
    return sendError(res, 404, `"${req.params.id}" ID'li maç bulunamadı.`);
  }
  if (!mac.valueReport) {
    return sendError(res, 422, 'Bu maç için analiz raporu mevcut değil.', mac.analysis?.engineError);
  }

  res.json({
    durum: 'hazır',
    mac: {
      id:          mac.id,
      sport:       mac.sport,
      league:      mac.league,
      homeTeam:    mac.teams.home.name,
      awayTeam:    mac.teams.away.name,
      kickoffTime: mac.kickoffTime,
    },
    analysis:    mac.analysis,
    valueReport: mac.valueReport,
  });
});

/** GET /api/motor-ozet */
app.get('/api/motor-ozet', (req, res) => {
  const data = requireReadyStore(res);
  if (!data) return;

  const tumMaclar   = [...(data.football || []), ...(data.basketball || [])];
  const raporluMaclar   = tumMaclar.filter((m) => m.valueReport);
  const raporsuzmaclar  = tumMaclar.filter((m) => !m.valueReport);

  const ratingDagilimi = { PREMIUM: 0, YÜKSEK: 0, ORTA: 0, DÜŞÜK: 0, MARJİNAL: 0 };
  (data.valueBetList || []).forEach((m) => {
    const r = m.valueReport?.bestBet?.rating;
    if (r && ratingDagilimi[r] !== undefined) ratingDagilimi[r]++;
  });

  res.json({
    durum:          'hazır',
    engineMeta:     data.engineMeta,
    totalMaclar:    tumMaclar.length,
    analizEdilen:   raporluMaclar.length,
    analizHatasi:   raporsuzmaclar.length,
    valueBetSayisi: (data.valueBetList || []).length,
    ratingDagilimi,
    trapliMac:      raporluMaclar.filter((m) => m.valueReport?.trapReport?.isTrap).length,
  });
});

// ─────────────────────────────────────────────
// FRONTEND CATCH-ALL
// ─────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────────
// GLOBAL HATA YÖNETİCİSİ
// ─────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error(`[BetIQ] Beklenmeyen hata: ${err.message}`);
  sendError(res, 500, 'Sunucu tarafında beklenmeyen bir hata oluştu.', err.message);
});

// ─────────────────────────────────────────────
// BAŞLANGIÇ
// ─────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  BetIQ v2.0 çalışıyor → port ${PORT}       ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Sunucu başlarken veriyi hemen yükle
  await initialLoad();

  // Her gün 09:00 TR saatinde otomatik yenileme
  startScheduler();
});

module.exports = app;
