/**
 * services/dataStore.js — BetIQ Bellek İçi Veri Deposu
 *
 * DEĞİŞİKLİK:
 *   _rollbackToReady() eklendi — dış API başarısız olduğunda
 *   setLoading() ile işaretlenen durumu önceki 'ready' haline geri alır.
 *
 * Üretimde: Redis veya hafif SQLite/PostgreSQL önbelleği ile değiştirin.
 */

'use strict';

let _depo = {
  lastUpdated:   null,
  status:        'empty',   // 'empty' | 'loading' | 'ready' | 'error'
  error:         null,
  data:          null,      // DataNormalizer.normalizeAll() çıktısı
  rawData:       null,      // Normalize öncesi ham veri (debug için)
};

// Yedek depo — rollback için önceki 'ready' durumu
let _yedekDepo = null;

const store = {
  get() {
    return _depo;
  },

  setLoading() {
    // Mevcut 'ready' durumunu yedekle (rollback için)
    if (_depo.status === 'ready') {
      _yedekDepo = { ..._depo };
    }
    _depo.status = 'loading';
    _depo.error  = null;
  },

  setReady(normallestirilmisVeri, hammVeri = null) {
    _depo = {
      lastUpdated: new Date().toISOString(),
      status:      'ready',
      error:       null,
      data:        normallestirilmisVeri,
      rawData:     hammVeri,
    };
    // Başarılı güncelleme sonrası yedeğe gerek kalmaz
    _yedekDepo = null;
  },

  setError(hata) {
    _depo.status       = 'error';
    _depo.error        = hata instanceof Error ? hata.message : String(hata);
    _depo.lastUpdated  = new Date().toISOString();
  },

  /**
   * Dış API başarısız olduğunda yedeklenen 'ready' durumuna geri döner.
   * Bu sayede kullanıcı eski veriyi görmeye devam eder.
   */
  _rollbackToReady() {
    if (_yedekDepo && _yedekDepo.status === 'ready') {
      _depo = { ..._yedekDepo };
      console.log('[BetIQ Store] Rollback: eski "ready" durumuna geri dönüldü.');
      _yedekDepo = null;
    } else {
      // Yedek yoksa (ilk yükleme başarısız) — error durumu ata
      _depo.status      = 'error';
      _depo.error       = 'Dış API yanıt vermedi ve önceki veri mevcut değil.';
      _depo.lastUpdated = new Date().toISOString();
    }
  },

  /**
   * Verilerin belirtilen süre (dakika) içinde güncellenip güncellenmediğini kontrol eder.
   * @param {number} maksYasMinut
   * @returns {boolean} true = eskimiş
   */
  isStale(maksYasMinut = 60) {
    if (!_depo.lastUpdated) return true;
    const yasMs = Date.now() - new Date(_depo.lastUpdated).getTime();
    return yasMs > maksYasMinut * 60_000;
  },
};

module.exports = store;
