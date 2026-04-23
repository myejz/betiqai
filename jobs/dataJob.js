/**
 * jobs/dataJob.js — BetIQ Veri İş Zamanlayıcı
 *
 * DEĞİŞİKLİKLER:
 *   - collectAllData yerine liveDataFetcher.fetchLiveData() kullanılıyor
 *   - fetchLiveData başarısız olursa store.setError() ÇAĞRILMAZ
 *     → Eski "ready" durumu korunur, frontend eski veriyi gösterir
 *   - runDataRefresh artık dış API hatasında throw eder (üst katman yakalar)
 */

'use strict';

const cron = require('node-cron');
const { fetchLiveData }    = require('../services/liveDataFetcher');
const { filterRawData }    = require('../services/oddsFilter');
const { DataNormalizer }   = require('../services/dataNormalizer');
const { ValueEngine }      = require('../services/valueEngine');
const store                = require('../services/dataStore');

// ─────────────────────────────────────────────
// ANA YENİLEME FONKSİYONU
// ─────────────────────────────────────────────

/**
 * runDataRefresh — Tam veri işleme pipeline'ı çalıştırır:
 *   fetchLiveData → filterRawData → DataNormalizer.normalizeAll → ValueEngine → store
 *
 * Dış API başarısız olursa:
 *   - Store'daki mevcut veri silinmez (status 'ready' kalır)
 *   - Hata fırlatılır → server.js'deki /api/guncelle yakalayıp 206 döner
 *
 * @returns {Promise<Object>} Özet bilgi
 */
async function runDataRefresh() {
  console.log(`[BetIQ] ── Veri yenileme başladı: ${new Date().toISOString()} ──`);

  // store.setLoading() — yalnızca dış API başarılı veri döndürürse çağrılır
  // Bu sayede işlem başlangıcında eski veri silinmez; sadece yeni veri gelince yazılır.
  // Ancak çakışmayı önlemek için status'u 'loading' işaretliyoruz.
  // (Başarısız olursa setLoading'i geri almak için eskiDurum'u saklıyoruz.)
  const eskiDurum = store.get().status;
  store.setLoading();

  try {
    // ── Adım 1: Dış API'den ham veri çek ──────────────────────────────
    const hammVeri = await fetchLiveData();
    console.log(`[BetIQ] Ham veri toplandı: ${hammVeri.totalMatches} maç (kaynak: ${hammVeri.source})`);

    if (hammVeri.errors && hammVeri.errors.length > 0) {
      hammVeri.errors.forEach((h) =>
        console.warn(`[BetIQ] Veri toplama uyarısı [${h.sport}]: ${h.message}`)
      );
    }

    // ── Adım 2: Platform filtresi (İddaa + Bilyoner) ──────────────────
    const filtreli = filterRawData(hammVeri, { platform: 'any', sport: 'all' });
    console.log(`[BetIQ] Platform filtresi sonrası: ${filtreli.totalFiltered} maç`);

    // ── Adım 3: Normalize et ─────────────────────────────────────────
    const normallestirilmis = DataNormalizer.normalizeAll(filtreli);
    const temizCikti        = DataNormalizer.stripRaw(normallestirilmis);

    // ── Adım 4: Value Engine analizi ─────────────────────────────────
    const analizedVeri = ValueEngine.analyzeDataset(temizCikti);
    console.log(`[BetIQ] Value Engine: ${analizedVeri.engineMeta.totalValueBets} value bet tespit edildi.`);

    // ── Adım 5: Store'a kaydet ────────────────────────────────────────
    store.setReady(analizedVeri, hammVeri);

    const ozet = {
      completedAt:    new Date().toISOString(),
      totalCollected: hammVeri.totalMatches,
      totalFiltered:  filtreli.totalFiltered,
      football:       analizedVeri.football.length,
      basketball:     analizedVeri.basketball.length,
      valueBets:      analizedVeri.engineMeta.totalValueBets,
      filterStats:    filtreli.filterStats,
      source:         hammVeri.source,
    };

    console.log(`[BetIQ] ── Veri yenileme tamamlandı:`, ozet);
    return ozet;

  } catch (hata) {
    // ÖNEMLİ: Dış API başarısız olduğunda eski veriyi KORUYORUZ
    if (eskiDurum === 'ready') {
      // Store'u eski 'ready' durumuna geri döndür
      // (setLoading çağrıldı ama setError çağrılmamalı)
      // Not: dataStore'da "rollback" yok — bu nedenle store.setError yerine
      // sadece internal flag'i geri yazıyoruz.
      store._rollbackToReady(); // aşağıda dataStore'a ekliyoruz
      console.warn(`[BetIQ] Dış API hatası — eski veri korunuyor: ${hata.message}`);
    } else {
      // Daha önce hiç veri yoktu — hata durumunu kaydet
      store.setError(hata);
      console.error(`[BetIQ] Veri yenileme hatası (ilk yükleme): ${hata.message}`);
    }

    // Her iki durumda da hata fırlat — server.js 206/503 kararını versin
    throw hata;
  }
}

// ─────────────────────────────────────────────
// CRON ZAMANLAYICI
// ─────────────────────────────────────────────

/**
 * Zamanlayıcıyı başlatır.
 * Program: '0 6 * * *' = 06:00 UTC = 09:00 Türkiye (UTC+3)
 * Railway UTC üzerinde çalıştığından bu değer doğrudur.
 */
function startScheduler() {
  const cronIfadesi = '0 6 * * *';

  if (!cron.validate(cronIfadesi)) {
    console.error('[BetIQ] Geçersiz cron ifadesi. Zamanlayıcı başlatılamadı.');
    return null;
  }

  const gorev = cron.schedule(
    cronIfadesi,
    async () => {
      console.log('[BetIQ] Günlük otomatik veri yenileme tetiklendi (09:00 TR)');
      try {
        await runDataRefresh();
      } catch (hata) {
        console.error(`[BetIQ] Otomatik yenileme başarısız: ${hata.message}`);
        // Cron görevinin çökmesini engelle — bir sonraki gün tekrar dener
      }
    },
    { scheduled: true, timezone: 'UTC' }
  );

  console.log('[BetIQ] Zamanlayıcı aktif → Her gün 09:00 TR saatinde güncelleme yapılacak.');
  return gorev;
}

// ─────────────────────────────────────────────
// BAŞLANGIÇ YÜKLEMESİ
// ─────────────────────────────────────────────

/**
 * Sunucu ilk başladığında bir kez çağrılır.
 * API boş gelmesin diye başlangıçta veri yüklenir.
 */
async function initialLoad() {
  console.log('[BetIQ] Sunucu başlangıcında ilk veri yüklemesi yapılıyor...');
  try {
    await runDataRefresh();
    console.log('[BetIQ] İlk yükleme başarılı.');
  } catch (hata) {
    console.error(`[BetIQ] İlk yükleme başarısız: ${hata.message}`);
    // Kritik değil — API uygun hata yanıtı döner
  }
}

module.exports = {
  runDataRefresh,
  startScheduler,
  initialLoad,
};
