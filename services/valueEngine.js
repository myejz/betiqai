/**
 * valueEngine.js — BetIQ Çekirdek Analiz ve Değerleme Motoru
 * ============================================================
 * Schema input: DataNormalizer.normalizeMatch() output (v2.0)
 * Schema output: match.analysis bloğunu doldurur + valueReport ekler
 *
 * MODÜLLER (sıralı pipeline):
 *   M1 → PaceProjector        : Tempo & skor aralığı tahmini
 *   M2 → TrueProbabilityModel : Gerçek olasılık hesabı
 *   M3 → ValueDetector        : Edge & EV hesabı
 *   M4 → SafetyFirewall       : NO BET güvenlik duvarı
 *   M5 → TrapDetector         : Public bias & tuzak tespiti
 *   M0 → ValueEngine (class)  : Pipeline orkestratörü
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// SABITLER & AĞIRLIKLAR
// ═══════════════════════════════════════════════════════════════

/** Home advantage prior (futbol için lig bazlı, diğerleri için genel) */
const HOME_ADVANTAGE = {
  TR1:  0.072,  // Süper Lig
  TR2:  0.068,
  ENG1: 0.058,
  ESP1: 0.062,
  GER1: 0.055,
  ITA1: 0.060,
  FRA1: 0.057,
  UCL:  0.048,  // Nötr saha etkisi daha az
  UEL:  0.050,
  NBA:  0.038,  // Basketbolda home adv daha küçük
  BSL:  0.045,
  EURO: 0.040,
  DEFAULT: 0.060,
};

/** Gerçek olasılık modelinde her faktörün ağırlığı (toplam = 1.0) */
const PROB_WEIGHTS = {
  recentForm:   0.30,   // Son 5 maç form skoru
  longTermForm:  0.15,  // Son 10 maç genel form
  h2h:          0.20,   // Head-to-head geçmiş
  homeAdvantage: 0.15,  // Ev sahibi avantajı (liglere göre)
  momentum:      0.10,  // Form ivmesi (yükselen/düşen)
  injury:        0.10,  // Sakatlık/ceza etkisi
};

/** Değer tespiti için minimum edge eşiği */
const MIN_VALUE_EDGE = 0.020;          // %2.0 minimum pozitif edge
const MIN_CONFIDENCE_FOR_BET = 0.620; // %62 güven eşiği
const QUARTER_KELLY_DIVISOR  = 4;     // Konservatif Kelly çarpanı
const MAX_KELLY_FRACTION     = 0.12;  // Bankroll'un max %12'si

/** Public Bias tuzak eşikleri */
const TRAP_THRESHOLDS = {
  publicFavoriteImpliedMin: 0.65,  // Halk favori = implied prob >= 65%
  oddsDropSuspect: 0.08,           // Oranın "gerçek" değerden sapma eşiği
  formOverratedMin: 0.20,          // Formun implied prob'dan bu kadar yüksekse şüpheli
  recentBigWinWindow: 2,           // Son N maçta büyük galibiyet varsa bias riski
};

// ═══════════════════════════════════════════════════════════════
// M1 — PACE PROJECTOR
// ═══════════════════════════════════════════════════════════════

const PaceProjector = {

  /**
   * Futbol için tempo hesabı.
   * Yaklaşım: Ortalama gol/maç → maç temposu; "açık" maç mı yoksa
   * kilitli mi olduğunu formdan çıkartır.
   *
   * @param {Object} homeForm  - aggregateForm output
   * @param {Object} awayForm  - aggregateForm output
   * @param {Object} h2h       - normalizeH2H output
   * @returns {Object} footballPace
   */
  football(homeForm, awayForm, h2h) {
    const homeAttack  = homeForm.avgGoalsScored    || 1.2;
    const homeDef     = homeForm.avgGoalsConceded  || 1.0;
    const awayAttack  = awayForm.avgGoalsScored    || 1.0;
    const awayDef     = awayForm.avgGoalsConceded  || 1.2;

    // Beklenen gol: Dixon-Coles'tan esinlenen basitleştirilmiş λ
    const lambdaHome = parseFloat((homeAttack * awayDef * 1.08).toFixed(3)); // 1.08: ev avantajı
    const lambdaAway = parseFloat((awayAttack * homeDef * 0.92).toFixed(3));
    const expectedTotal = parseFloat((lambdaHome + lambdaAway).toFixed(2));

    // H2H gol ortalamasını ağırlıklı karıştır (%30 H2H, %70 form)
    const h2hTotal = h2h.avgTotal || expectedTotal;
    const blendedTotal = parseFloat((expectedTotal * 0.70 + h2hTotal * 0.30).toFixed(2));

    // Tempo sınıflandırması
    let tempo, label;
    if (blendedTotal < 2.2)       { tempo = 'slow';   label = 'Yavaş';  }
    else if (blendedTotal < 3.0)  { tempo = 'medium'; label = 'Orta';   }
    else                           { tempo = 'fast';   label = 'Hızlı';  }

    // Skor aralığı tahmini (lambda'dan ±0.7 std sapma)
    const scoreRange = {
      home: {
        low:  Math.max(0, Math.round(lambdaHome - 0.7)),
        mid:  Math.round(lambdaHome),
        high: Math.round(lambdaHome + 0.9),
      },
      away: {
        low:  Math.max(0, Math.round(lambdaAway - 0.7)),
        mid:  Math.round(lambdaAway),
        high: Math.round(lambdaAway + 0.9),
      },
    };

    // Alt/Üst 2.5 Poisson tahmini (P(X > 2.5) = 1 - P(X<=2) için λ=total)
    const over25Prob = PaceProjector._poissonCDF(blendedTotal, 2, false);
    const goalLine   = blendedTotal >= 2.75 ? 'Üst 2.5' : 'Alt 2.5';

    return {
      tempo,
      tempoLabel: label,
      lambdaHome,
      lambdaAway,
      expectedTotal,
      blendedTotal,
      scoreRange,
      projectedScore: `${scoreRange.home.mid}-${scoreRange.away.mid}`,
      over25Prob:    parseFloat(over25Prob.toFixed(4)),
      recommendedGoalLine: goalLine,
    };
  },

  /**
   * Basketbol için pace (possession) hesabı.
   * NBA pace standardı: ~100 possession/40 dk
   * BSL/EuroLeague: ~75-85 possession/40 dk
   *
   * @param {Object} homeForm
   * @param {Object} awayForm
   * @param {string} leagueId
   * @returns {Object} basketballPace
   */
  basketball(homeForm, awayForm, leagueId) {
    // Takım başına ortalama skor (form.avgGoalsScored basketbolda puan)
    const homePPG = homeForm.avgGoalsScored || 85;
    const awayPPG = awayForm.avgGoalsScored || 82;
    const homeAPG = homeForm.avgGoalsConceded || 84; // conceded = opponent scoring
    const awayAPG = awayForm.avgGoalsConceded || 83;

    // Lig bazlı pace referansı
    const leaguePace = { NBA: 98.5, BSL: 78.0, EURO: 76.5, DEFAULT: 80.0 };
    const basePace   = leaguePace[leagueId] || leaguePace.DEFAULT;

    // Her takımın oyun hızı skoru: (PPG + opp_PPG) / 2 × lig katsayısı
    const homePaceScore = (homePPG + homeAPG) / 2;
    const awayPaceScore = (awayPPG + awayAPG) / 2;
    const blendedPace   = parseFloat(((homePaceScore + awayPaceScore) / 2).toFixed(1));

    // Possession tahmini (pace = possession × efficiency yaklaşımı)
    const estPossessions = parseFloat((basePace * (blendedPace / (basePace * 0.9))).toFixed(1));

    // Beklenen toplam skor
    const homeProjected = parseFloat(((homePPG * 0.6 + awayAPG * 0.4) * 1.03).toFixed(1));
    const awayProjected = parseFloat(((awayPPG * 0.6 + homeAPG * 0.4) * 0.97).toFixed(1));
    const totalProjected = parseFloat((homeProjected + awayProjected).toFixed(1));

    let tempo, label;
    if (estPossessions < basePace * 0.93)       { tempo = 'slow';   label = 'Yavaş';  }
    else if (estPossessions < basePace * 1.05)  { tempo = 'medium'; label = 'Orta';   }
    else                                          { tempo = 'fast';   label = 'Hızlı';  }

    return {
      tempo,
      tempoLabel: label,
      estimatedPossessions: estPossessions,
      homeProjected,
      awayProjected,
      totalProjected,
      projectedScore: `${Math.round(homeProjected)}-${Math.round(awayProjected)}`,
      recommendedTotalLine: totalProjected >= 175 ? `Üst ${Math.round(totalProjected - 3)}.5` : `Alt ${Math.round(totalProjected + 3)}.5`,
    };
  },

  /**
   * Poisson CDF hesabı: P(X <= k) veya P(X > k)
   * @param {number} lambda - beklenen değer
   * @param {number} k      - eşik
   * @param {boolean} cumulative - true: P(X<=k), false: P(X>k)
   */
  _poissonCDF(lambda, k, cumulative = true) {
    let sum = 0;
    let eFactor = Math.exp(-lambda);
    let lambdaPow = 1;
    let factorial = 1;
    for (let i = 0; i <= k; i++) {
      if (i > 0) { lambdaPow *= lambda; factorial *= i; }
      sum += eFactor * lambdaPow / factorial;
    }
    return cumulative ? sum : 1 - sum;
  },
};

// ═══════════════════════════════════════════════════════════════
// M2 — TRUE PROBABILITY MODEL
// ═══════════════════════════════════════════════════════════════

const TrueProbabilityModel = {

  /**
   * Futbol maçı için gerçek olasılık hesabı.
   * Çıktı: { home, draw, away } — toplam = 1.0
   *
   * @param {Object} match - normalized match
   * @param {Object} pace  - PaceProjector.football() output
   * @returns {Object}
   */
  football(match, pace) {
    const { teams, h2h, analysis, leagueId } = match;
    const homeAdv = HOME_ADVANTAGE[leagueId] || HOME_ADVANTAGE.DEFAULT;

    // ── 1. FORM SKORU (son 5 maç ağırlıklı)
    const homeRecent5 = TrueProbabilityModel._formScore(teams.home.form, 5);
    const awayRecent5 = TrueProbabilityModel._formScore(teams.away.form, 5);
    const homeLong    = TrueProbabilityModel._formScore(teams.home.form, 10);
    const awayLong    = TrueProbabilityModel._formScore(teams.away.form, 10);

    // Form farkı → [0,1] aralığına normalize
    const recentDiff  = TrueProbabilityModel._normalizeDiff(homeRecent5, awayRecent5);
    const longDiff    = TrueProbabilityModel._normalizeDiff(homeLong, awayLong);

    // ── 2. H2H SKORU
    let h2hScore = 0.5; // nötr başlangıç
    if (h2h.played > 0) {
      h2hScore = h2h.homeWins / h2h.played * 0.6
               + (h2h.draws   / h2h.played * 0.5)  // beraberlikler ev lehine hafif
               + (h2h.awayWins / h2h.played * 0.4);
      // recent trend düzeltmesi
      if (h2h.recentTrend === 'home_dominant') h2hScore = Math.min(h2hScore + 0.10, 0.85);
      if (h2h.recentTrend === 'away_dominant') h2hScore = Math.max(h2hScore - 0.10, 0.15);
      h2hScore = parseFloat(h2hScore.toFixed(4));
    }

    // ── 3. MOMENTUM SKORU
    const homeMomentum = teams.home.form.momentum || 0;
    const awayMomentum = teams.away.form.momentum || 0;
    const momentumScore = TrueProbabilityModel._normalizeDiff(homeMomentum, awayMomentum);

    // ── 4. SAKATLIK ÇARPANI (ev lehine pozitif, deplasman lehine negatif)
    const injuryScore = 0.5 + (teams.away.injuryImpact - teams.home.injuryImpact) * 0.5;

    // ── 5. EV SAHİBİ AVANTAJI
    const homeAdvScore = 0.5 + homeAdv;

    // ── AĞIRLIKLI TOPLAM (ev sahibinin kazanma ham skoru)
    const homeRawScore =
      recentDiff   * PROB_WEIGHTS.recentForm   +
      longDiff     * PROB_WEIGHTS.longTermForm  +
      h2hScore     * PROB_WEIGHTS.h2h           +
      homeAdvScore * PROB_WEIGHTS.homeAdvantage +
      momentumScore * PROB_WEIGHTS.momentum     +
      injuryScore  * PROB_WEIGHTS.injury;

    // homeRawScore = P(home_win) ham değeri [0,1]
    // Beraberlik olasılığını tempo'dan ve tarihsel ortalamadan çıkar
    const baseDrawRate   = TrueProbabilityModel._baseDrawRate(pace.blendedTotal);
    const h2hDrawRate    = h2h.played > 0 ? h2h.draws / h2h.played : baseDrawRate;
    const blendedDraw    = baseDrawRate * 0.65 + h2hDrawRate * 0.35;

    // Kalan olasılığı home/away arasında paylaştır
    const remaining = 1.0 - blendedDraw;
    let pHome = homeRawScore * remaining;
    let pAway = (1 - homeRawScore) * remaining;
    let pDraw = blendedDraw;

    // Normalize (toplam = 1.0 garantisi)
    const total = pHome + pDraw + pAway;
    pHome = parseFloat((pHome / total).toFixed(4));
    pDraw = parseFloat((pDraw / total).toFixed(4));
    pAway = parseFloat((1 - pHome - pDraw).toFixed(4));

    // Over 2.5 gerçek olasılığı pace'den alınır
    const pOver25 = pace.over25Prob;
    const pUnder25 = parseFloat((1 - pOver25).toFixed(4));

    return {
      home:    pHome,
      draw:    pDraw,
      away:    pAway,
      over25:  pOver25,
      under25: pUnder25,
      // Debug bileşenleri
      _components: { recentDiff, longDiff, h2hScore, momentumScore, injuryScore, homeAdvScore, homeRawScore },
    };
  },

  /**
   * Basketbol maçı için gerçek olasılık hesabı.
   * Beraberlik yok; sadece home/away.
   *
   * @param {Object} match
   * @param {Object} pace - PaceProjector.basketball() output
   * @returns {Object}
   */
  basketball(match, pace) {
    const { teams, h2h, leagueId } = match;
    const homeAdv = HOME_ADVANTAGE[leagueId] || HOME_ADVANTAGE.NBA;

    const homeRecent5 = TrueProbabilityModel._formScore(teams.home.form, 5);
    const awayRecent5 = TrueProbabilityModel._formScore(teams.away.form, 5);
    const homeLong    = TrueProbabilityModel._formScore(teams.home.form, 10);
    const awayLong    = TrueProbabilityModel._formScore(teams.away.form, 10);

    const recentDiff  = TrueProbabilityModel._normalizeDiff(homeRecent5, awayRecent5);
    const longDiff    = TrueProbabilityModel._normalizeDiff(homeLong, awayLong);

    let h2hScore = 0.50;
    if (h2h.played > 0) {
      h2hScore = h2h.homeWins / h2h.played;
      if (h2h.recentTrend === 'home_dominant') h2hScore = Math.min(h2hScore + 0.08, 0.80);
      if (h2h.recentTrend === 'away_dominant') h2hScore = Math.max(h2hScore - 0.08, 0.20);
    }

    const momentumScore = TrueProbabilityModel._normalizeDiff(
      teams.home.form.momentum || 0,
      teams.away.form.momentum || 0
    );
    const injuryScore = 0.5 + (teams.away.injuryImpact - teams.home.injuryImpact) * 0.5;
    const homeAdvScore = 0.5 + homeAdv;

    const homeRawScore =
      recentDiff    * PROB_WEIGHTS.recentForm    +
      longDiff      * PROB_WEIGHTS.longTermForm   +
      h2hScore      * PROB_WEIGHTS.h2h            +
      homeAdvScore  * PROB_WEIGHTS.homeAdvantage  +
      momentumScore * PROB_WEIGHTS.momentum       +
      injuryScore   * PROB_WEIGHTS.injury;

    // Basketbolda total prob hesabı (Üst/Alt için)
    const totalProj   = pace.totalProjected;
    const totalLine   = parseFloat((totalProj - 3.0).toFixed(1)); // tipik handicap
    const pOver       = parseFloat(Math.min(0.85, Math.max(0.15,
      0.50 + (totalProj - totalLine - 3) * 0.05
    )).toFixed(4));
    const pUnder      = parseFloat((1 - pOver).toFixed(4));

    const total = homeRawScore + (1 - homeRawScore);
    const pHome = parseFloat(Math.min(0.88, Math.max(0.12, homeRawScore / total)).toFixed(4));
    const pAway = parseFloat((1 - pHome).toFixed(4));

    return {
      home:  pHome,
      away:  pAway,
      draw:  0,       // basketbolda beraberlik yok
      over:  pOver,
      under: pUnder,
      _components: { recentDiff, longDiff, h2hScore, momentumScore, injuryScore, homeAdvScore, homeRawScore },
    };
  },

  // ── YARDIMCI FONKSİYONLAR ──────────────────

  /**
   * Son N maçtan ağırlıklı form skoru [0, 1]
   * Daha yeni maçlara daha fazla ağırlık verir.
   */
  _formScore(form, n = 10) {
    const slice = form.last5 ? form.last5 : [];
    // form objesinden ham veriyi kullan
    const results = slice.slice(-n);
    if (results.length === 0) return 0.5;

    let weightedSum  = 0;
    let totalWeight  = 0;
    results.forEach((res, i) => {
      const weight = i + 1;  // en eski = 1, en yeni = n
      const score  = res === 'W' ? 1.0 : res === 'D' ? 0.45 : 0.0;
      weightedSum += score * weight;
      totalWeight += weight;
    });
    return parseFloat((weightedSum / totalWeight).toFixed(4));
  },

  /**
   * İki skoru [0,1] aralığına normalize eder.
   * 0.5 = eşit, >0.5 = a lehine, <0.5 = b lehine
   */
  _normalizeDiff(a, b) {
    const sum = Math.abs(a) + Math.abs(b);
    if (sum === 0) return 0.5;
    return parseFloat((a / sum).toFixed(4));
  },

  /**
   * Beklenen gol sayısına göre tarihsel beraberlik oranı.
   * Gerçek Süper Lig / Avrupa ligi istatistiklerinden türetilmiştir.
   */
  _baseDrawRate(expectedTotal) {
    if (expectedTotal < 1.8) return 0.32;
    if (expectedTotal < 2.3) return 0.28;
    if (expectedTotal < 2.8) return 0.24;
    if (expectedTotal < 3.3) return 0.20;
    return 0.16;
  },
};

// ═══════════════════════════════════════════════════════════════
// M3 — VALUE DETECTOR
// ═══════════════════════════════════════════════════════════════

const ValueDetector = {

  /**
   * Tüm pazarlar için edge ve EV hesaplar.
   * Her market için: edge = trueProb - impliedProb
   *
   * @param {Object} trueProbs     - TrueProbabilityModel output
   * @param {Object} impliedProbs  - normalizeOdds().impliedProb
   * @param {Object} rawOdds       - odds.raw.iddaa
   * @param {string} sport
   * @returns {Array<Object>} valueBets — edge > MIN_VALUE_EDGE olanlar
   */
  detect(trueProbs, impliedProbs, rawOdds, sport = 'football') {
    const markets = ValueDetector._buildMarkets(trueProbs, impliedProbs, rawOdds, sport);
    const valueBets = [];

    for (const market of markets) {
      const { key, label, trueProb, impliedProb, odd } = market;
      if (!trueProb || !impliedProb || !odd) continue;

      const edge = parseFloat((trueProb - impliedProb).toFixed(4));
      const ev   = parseFloat((trueProb * odd - 1).toFixed(4)); // EV per 1 unit stake

      if (edge > 0) {
        // Quarter-Kelly stake önerisi
        const b     = odd - 1;
        const q     = 1 - trueProb;
        const kelly = (b * trueProb - q) / b;
        const safeKelly = parseFloat(
          Math.min(Math.max(kelly / QUARTER_KELLY_DIVISOR, 0), MAX_KELLY_FRACTION).toFixed(4)
        );

        valueBets.push({
          market:      key,
          marketLabel: label,
          trueProb:    parseFloat(trueProb.toFixed(4)),
          impliedProb: parseFloat(impliedProb.toFixed(4)),
          edge,
          ev,
          odd,
          isValue:     edge >= MIN_VALUE_EDGE,
          kellyCriterion: safeKelly,
          fullKelly: parseFloat(Math.max(kelly, 0).toFixed(4)),
          rating: ValueDetector._rateEdge(edge),
        });
      }
    }

    // Edge'e göre büyükten küçüğe sırala
    valueBets.sort((a, b) => b.edge - a.edge);
    return valueBets;
  },

  /**
   * Tüm olası pazarları eşleştirir (market key → true/implied prob/odd)
   */
  _buildMarkets(trueProbs, impliedProbs, rawOdds, sport) {
    if (sport === 'football') {
      return [
        { key: 'home',    label: 'Ev Sahibi Kazanır (MS1)',  trueProb: trueProbs.home,    impliedProb: impliedProbs.home,    odd: rawOdds.home    },
        { key: 'draw',    label: 'Beraberlik (MS X)',         trueProb: trueProbs.draw,    impliedProb: impliedProbs.draw,    odd: rawOdds.draw    },
        { key: 'away',    label: 'Deplasman Kazanır (MS2)',   trueProb: trueProbs.away,    impliedProb: impliedProbs.away,    odd: rawOdds.away    },
        { key: 'over25',  label: 'Üst 2.5 Gol',              trueProb: trueProbs.over25,  impliedProb: 1 / (rawOdds.over25 || 99), odd: rawOdds.over25  },
        { key: 'under25', label: 'Alt 2.5 Gol',              trueProb: trueProbs.under25, impliedProb: 1 / (rawOdds.under25 || 99), odd: rawOdds.under25 },
      ];
    } else {
      return [
        { key: 'home',  label: 'Ev Sahibi Kazanır', trueProb: trueProbs.home,  impliedProb: impliedProbs.home,  odd: rawOdds.home  },
        { key: 'away',  label: 'Deplasman Kazanır', trueProb: trueProbs.away,  impliedProb: impliedProbs.away,  odd: rawOdds.away  },
        { key: 'over',  label: `Üst Total`,          trueProb: trueProbs.over,  impliedProb: 0.50, odd: 1.90 }, // total odds mock'ta yok, varsayılan
        { key: 'under', label: `Alt Total`,          trueProb: trueProbs.under, impliedProb: 0.50, odd: 1.85 },
      ];
    }
  },

  /**
   * Edge büyüklüğüne göre kalite etiketi
   */
  _rateEdge(edge) {
    if (edge >= 0.12) return 'PREMIUM';   // %12+ edge
    if (edge >= 0.07) return 'YÜKSEK';    // %7-12 edge
    if (edge >= 0.04) return 'ORTA';      // %4-7 edge
    if (edge >= 0.02) return 'DÜŞÜK';     // %2-4 edge
    return 'MARJİNAL';                    // < %2 edge
  },
};

// ═══════════════════════════════════════════════════════════════
// M4 — SAFETY FIREWALL
// ═══════════════════════════════════════════════════════════════

const SafetyFirewall = {

  /**
   * Bir bahsin oynanıp oynanamayacağına karar verir.
   * Çift kilitli sistem: HER İKİ koşul da sağlanmalı.
   *
   * @param {Object} valueBet  - ValueDetector.detect() çıktısından tek bet
   * @param {Object} trueProbs - TrueProbabilityModel output
   * @param {string} market    - kontrol edilecek market key
   * @returns {Object} { canBet, reason, blockReasons }
   */
  evaluate(valueBet, trueProbs, market) {
    const blockReasons = [];
    let canBet = true;

    const trueProb = trueProbs[market] ?? 0;

    // ── KİLİT 1: Minimum güven eşiği
    if (trueProb < MIN_CONFIDENCE_FOR_BET) {
      canBet = false;
      blockReasons.push(
        `GÜVEN EŞİĞİ: Gerçek olasılık %${(trueProb * 100).toFixed(1)} < %${(MIN_CONFIDENCE_FOR_BET * 100).toFixed(0)} eşiği`
      );
    }

    // ── KİLİT 2: Negatif edge
    if (valueBet.edge <= 0) {
      canBet = false;
      blockReasons.push(
        `NEGATİF EDGE: Edge = ${(valueBet.edge * 100).toFixed(2)}% → piyasa aleyhimize`
      );
    }

    // ── KİLİT 3: Minimum edge eşiği (MIN_VALUE_EDGE)
    if (valueBet.edge > 0 && valueBet.edge < MIN_VALUE_EDGE) {
      canBet = false;
      blockReasons.push(
        `DÜŞÜK EDGE: Edge %${(valueBet.edge * 100).toFixed(2)} < minimum %${(MIN_VALUE_EDGE * 100).toFixed(1)}`
      );
    }

    // ── KİLİT 4: Negatif Expected Value
    if (valueBet.ev < 0) {
      canBet = false;
      blockReasons.push(
        `NEGATİF EV: Beklenen değer = ${valueBet.ev.toFixed(3)} → uzun vadede zararlı`
      );
    }

    // ── KİLİT 5: Oran aralığı kontrolü (şüpheli düşük oran = piyasa manipülasyonu riski)
    if (valueBet.odd && valueBet.odd < 1.20) {
      canBet = false;
      blockReasons.push(
        `ORAN ÇOK DÜŞÜK: ${valueBet.odd} → edge marjı yetersiz, gerçek avantaj hesaplanamaz`
      );
    }

    // ── UYARI (engellemez ama raporlanır)
    const warnings = [];
    if (valueBet.fullKelly > 0.20) {
      warnings.push('Kelly fraksiyonu %20 üstünde → varyans yüksek, stake düşür');
    }
    if (trueProb > 0.80) {
      warnings.push('Aşırı yüksek olasılık (%80+) → aşırı uyum riski, modeli kontrol et');
    }

    return {
      canBet,
      verdict: canBet ? 'BET' : 'NO BET',
      verdictTR: canBet ? 'OYNANABİLİR ✓' : 'OYNANMAZ ✗',
      blockReasons,
      warnings,
    };
  },

  /**
   * Bir maçın TÜM value bet'lerini filtreler, sadece geçenleri döndürür.
   * @param {Array<Object>} valueBets
   * @param {Object} trueProbs
   * @returns {Object} { approved, rejected }
   */
  filterAll(valueBets, trueProbs) {
    const approved = [];
    const rejected = [];

    for (const vb of valueBets) {
      const result = SafetyFirewall.evaluate(vb, trueProbs, vb.market);
      const entry  = { ...vb, firewall: result };
      if (result.canBet) approved.push(entry);
      else               rejected.push(entry);
    }

    return { approved, rejected };
  },
};

// ═══════════════════════════════════════════════════════════════
// M5 — TRAP DETECTOR (PUBLIC BIAS FİLTRESİ)
// ═══════════════════════════════════════════════════════════════

const TrapDetector = {

  /**
   * Halk Yanılgısı (Public Bias) ve Tuzak maç tespiti.
   *
   * Tuzak maç işaretleri:
   *   1. Halk Favori Tuzağı: Popüler takım güçlü forma sahip,
   *      ama oranı beklenenden yüksek (piyasa düşürmeyi reddediyor)
   *   2. Abartılmış Form Tuzağı: Son 1-2 büyük galibiyet sahte ivme yaratmış,
   *      uzun vadeli form kötü
   *   3. Oran Tutarsızlığı: Model true prob ile implied prob arasındaki fark
   *      normalin çok üstünde (aşırı büyük edge = piyasa sürtünmesi şüpheli)
   *   4. H2H Yanılgısı: Halk son maç sonucuna bakıyor, ama tarihsel denge farklı
   *
   * @param {Object} match     - normalized match
   * @param {Object} trueProbs - TrueProbabilityModel output
   * @param {Object} valueBets - ValueDetector.detect() output
   * @returns {Object} trapReport
   */
  analyze(match, trueProbs, valueBets) {
    const { teams, h2h, odds } = match;
    const impliedProbs = odds.impliedProb || {};
    const rawOdds      = odds.raw?.iddaa  || {};
    const flags        = [];
    let trapScore      = 0; // 0–100, yüksek = daha şüpheli

    // ── TUZAK 1: Halk Favori Tuzağı ──────────────────────────────
    // Maçın net favorisi var mı?
    const homeImplied = impliedProbs.home || 0;
    const awayImplied = impliedProbs.away || 0;
    const publicFavKey    = homeImplied > awayImplied ? 'home' : 'away';
    const publicFavProb   = Math.max(homeImplied, awayImplied);
    const modelFavProb    = trueProbs[publicFavKey] || 0;
    const publicModelGap  = publicFavProb - modelFavProb; // + = halk abartmış, – = model abartmış

    if (publicFavProb >= TRAP_THRESHOLDS.publicFavoriteImpliedMin) {
      // Halk bu takımı çok favori görüyor
      if (publicModelGap > TRAP_THRESHOLDS.formOverratedMin) {
        trapScore += 35;
        flags.push({
          type:    'HALK_FAVORİ_TUZAĞI',
          detail:  `Halk ${publicFavKey === 'home' ? teams.home.name : teams.away.name}'ı %${(publicFavProb*100).toFixed(0)} ihtimalle favori görüyor, model %${(modelFavProb*100).toFixed(0)} hesaplıyor. Fark: %${(publicModelGap*100).toFixed(0)}.`,
          severity: 'YÜKSEK',
        });
      }
    }

    // ── TUZAK 2: Kısa Vadeli Form Yanılgısı ──────────────────────
    // Son 2 maç W ama genel form kötü → halk bu galibiyeti abartıyor
    const checkRecentBigWin = (formObj, teamName) => {
      const last5  = formObj.last5 || [];
      const recent = last5.slice(-TRAP_THRESHOLDS.recentBigWinWindow);
      const recentWins  = recent.filter((r) => r === 'W').length;
      const overallWR   = formObj.winRate || 0;

      if (recentWins === TRAP_THRESHOLDS.recentBigWinWindow && overallWR < 0.40) {
        trapScore += 25;
        flags.push({
          type:   'KISA_FORM_YANILGISI',
          detail: `${teamName} son ${TRAP_THRESHOLDS.recentBigWinWindow} maçı kazandı ama sezon geneli %${(overallWR*100).toFixed(0)} galibiyet oranıyla düşük formda. Sahte ivme riski.`,
          severity: 'ORTA',
        });
      }
    };
    checkRecentBigWin(teams.home.form, teams.home.name);
    checkRecentBigWin(teams.away.form, teams.away.name);

    // ── TUZAK 3: Abartılmış Edge (Model-Piyasa Sürtünmesi) ────────
    // Çok büyük edge genellikle hatalı model veya stale oran anlamına gelir
    for (const vb of valueBets) {
      if (vb.edge > 0.20) {
        trapScore += 20;
        flags.push({
          type:   'AŞIRI_EDGE',
          detail: `${vb.marketLabel} pazarında edge %${(vb.edge*100).toFixed(1)} — bu kadar büyük edge genellikle stale (güncel olmayan) oran veya model sapmasına işaret eder. Dikkatli ol.`,
          severity: 'ORTA',
        });
        break; // Aynı tuzaktan birden fazla ekleme
      }
    }

    // ── TUZAK 4: H2H Yanılgısı ────────────────────────────────────
    // Halk son H2H maça bakıyor, ama uzun vadeli H2H çok farklı
    if (h2h.played >= 4) {
      const last3Wins  = (h2h.last3Results || []).filter((r) => r === 'W').length;
      const overallH2HWR = h2h.homeWins / h2h.played;
      // Son 3'te 3 galibiyet ama tarihsel WR < 0.35 → yanıltıcı örneklem
      if (last3Wins === 3 && overallH2HWR < 0.35) {
        trapScore += 20;
        flags.push({
          type:   'H2H_YANILGISI',
          detail: `Ev sahibi son 3 karşılaşmanın tümünü kazandı ama tarihsel H2H galibiyet oranı yalnızca %${(overallH2HWR*100).toFixed(0)}. Kısa örneklem yanıltıcı olabilir.`,
          severity: 'DÜŞÜK',
        });
      }
    }

    // ── TUZAK 5: Oran Tutarsızlığı (İddaa/Bilyoner arası fark) ────
    const bilyonerHome = odds.raw?.bilyoner?.home;
    const iddaaHome    = rawOdds.home;
    if (bilyonerHome && iddaaHome) {
      const platformGap = Math.abs(bilyonerHome - iddaaHome);
      if (platformGap > 0.25) {
        trapScore += 15;
        flags.push({
          type:   'PLATFORM_ORAN_FARK',
          detail: `İddaa (${iddaaHome}) ile Bilyoner (${bilyonerHome}) oranları arasında ${platformGap.toFixed(2)} fark var. Piyasa konsensüs eksik, oran güvenilirliği düşük.`,
          severity: 'DÜŞÜK',
        });
      }
    }

    // ── SONUÇ SKORU → ETİKET ──────────────────────────────────────
    let trapLabel, trapAction;
    if (trapScore >= 55) {
      trapLabel  = 'YÜKSEK RİSK';
      trapAction = 'KAÇIN — Bu maçta piyasa yapısı ve halk algısı tehlikeli biçimde çakışıyor.';
    } else if (trapScore >= 30) {
      trapLabel  = 'ORTA RİSK';
      trapAction = 'DİKKATLİ — Value varsa stake\'i %50 azalt.';
    } else {
      trapLabel  = 'DÜŞÜK RİSK';
      trapAction = 'Normal değerlendirme kuralları geçerli.';
    }

    return {
      trapScore,
      trapLabel,
      trapAction,
      isTrap: trapScore >= 55,
      flags,
      publicFavKey,
      publicFavProb: parseFloat(publicFavProb.toFixed(4)),
      modelFavProb:  parseFloat(modelFavProb.toFixed(4)),
    };
  },
};

// ═══════════════════════════════════════════════════════════════
// M0 — VALUE ENGINE (ANA SINIF — ORKESTRATÖr)
// ═══════════════════════════════════════════════════════════════

class ValueEngine {

  /**
   * Tek bir normalize edilmiş maçı tam pipeline'dan geçirir.
   * DataNormalizer.normalizeMatch() çıktısını input olarak alır.
   * match.analysis bloğunu in-place doldurur + valueReport ekler.
   *
   * @param {Object} match - DataNormalizer.normalizeMatch() output
   * @returns {Object} enriched match
   */
  static analyze(match) {
    const { sport, teams, h2h, odds } = match;
    const rawOdds     = odds.raw?.iddaa  || {};
    const impliedProb = odds.impliedProb || {};

    if (!rawOdds.home || !impliedProb.home) {
      match.analysis.engineError = 'Oran verisi eksik, analiz yapılamadı.';
      match.valueReport = null;
      return match;
    }

    // ── M1: PACE ────────────────────────────────────────────────
    const pace = sport === 'basketball'
      ? PaceProjector.basketball(teams.home.form, teams.away.form, match.leagueId)
      : PaceProjector.football(teams.home.form, teams.away.form, h2h);

    // ── M2: TRUE PROBABILITY ─────────────────────────────────────
    const trueProbs = sport === 'basketball'
      ? TrueProbabilityModel.basketball(match, pace)
      : TrueProbabilityModel.football(match, pace);

    // ── M3: VALUE DETECTION ──────────────────────────────────────
    const allValueBets = ValueDetector.detect(trueProbs, impliedProb, rawOdds, sport);

    // ── M4: SAFETY FIREWALL ──────────────────────────────────────
    const { approved, rejected } = SafetyFirewall.filterAll(allValueBets, trueProbs);

    // ── M5: TRAP DETECTION ───────────────────────────────────────
    const trapReport = TrapDetector.analyze(match, trueProbs, allValueBets);

    // ── BEST BET SEÇİMİ ──────────────────────────────────────────
    // Tuzak değilse en yüksek edge'li onaylı bet'i öner
    let bestBet = null;
    if (approved.length > 0 && !trapReport.isTrap) {
      bestBet = approved[0]; // zaten edge'e göre sıralı
    } else if (approved.length > 0 && trapReport.isTrap && trapReport.trapScore < 70) {
      // Tuzak riski var ama çok kritik değil — stake yarıya indirilmiş öneri
      bestBet = {
        ...approved[0],
        kellyCriterion: parseFloat((approved[0].kellyCriterion * 0.5).toFixed(4)),
        trapAdjusted:   true,
      };
    }

    // ── analysis BLOĞUNU DOLDUR ───────────────────────────────────
    match.analysis = {
      ...match.analysis,
      predictedResult: ValueEngine._predictResult(trueProbs, sport),
      valueBetMarket:  bestBet?.marketLabel  || null,
      valueBetOdd:     bestBet?.odd          || null,
      edge:            bestBet?.edge         || null,
      kellyCriterion:  bestBet?.kellyCriterion || null,
      confidence:      bestBet ? parseFloat((trueProbs[bestBet.market] || 0).toFixed(4)) : null,
      verdict:         bestBet ? bestBet.firewall.verdictTR : 'OYNANMAZ ✗',
    };

    // ── valueReport EKLE ─────────────────────────────────────────
    match.valueReport = {
      pace,
      trueProbs: ValueEngine._cleanProbs(trueProbs),
      allValueBets,
      approved,
      rejected,
      bestBet,
      trapReport,
      summary: ValueEngine._buildSummary(match, bestBet, trapReport, approved),
    };

    return match;
  }

  /**
   * Bir maç listesinin tamamını analiz eder.
   * @param {Array<Object>} matches
   * @returns {Array<Object>}
   */
  static analyzeAll(matches) {
    return matches.map((m) => {
      try {
        return ValueEngine.analyze(m);
      } catch (err) {
        m.analysis.engineError = `Analiz hatası: ${err.message}`;
        m.valueReport = null;
        return m;
      }
    });
  }

  /**
   * Tüm dataset'i (football + basketball) analiz eder.
   * DataNormalizer.normalizeAll() çıktısını alır.
   * @param {Object} normalizedDataset
   * @returns {Object}
   */
  static analyzeDataset(normalizedDataset) {
    const analyzedFootball   = ValueEngine.analyzeAll(normalizedDataset.football   || []);
    const analyzedBasketball = ValueEngine.analyzeAll(normalizedDataset.basketball || []);

    // Sadece value olan maçları ayır
    const valueBetList = [...analyzedFootball, ...analyzedBasketball]
      .filter((m) => m.valueReport?.bestBet !== null)
      .sort((a, b) => (b.valueReport?.bestBet?.edge || 0) - (a.valueReport?.bestBet?.edge || 0));

    return {
      ...normalizedDataset,
      football:     analyzedFootball,
      basketball:   analyzedBasketball,
      valueBetList,
      engineMeta: {
        analyzedAt:     new Date().toISOString(),
        totalAnalyzed:  analyzedFootball.length + analyzedBasketball.length,
        totalValueBets: valueBetList.length,
        engineVersion:  '2.0',
      },
    };
  }

  // ── ÖZEL YARDIMCILAR ────────────────────────────────────────

  static _predictResult(trueProbs, sport) {
    if (sport === 'basketball') {
      return trueProbs.home > trueProbs.away ? 'Ev Sahibi' : 'Deplasman';
    }
    const max = Math.max(trueProbs.home, trueProbs.draw, trueProbs.away);
    if (max === trueProbs.home) return 'Ev Sahibi';
    if (max === trueProbs.draw) return 'Beraberlik';
    return 'Deplasman';
  }

  static _cleanProbs(p) {
    const clean = {};
    for (const [k, v] of Object.entries(p)) {
      if (k !== '_components') clean[k] = v;
    }
    return clean;
  }

  static _buildSummary(match, bestBet, trapReport, approved) {
    if (!bestBet) {
      return trapReport.isTrap
        ? `⛔ TUZAK ALGILANDI — ${trapReport.trapAction}`
        : `❌ OYNANMAZ — Onaylanmış value bet bulunamadı. ${approved.length} pozitif edge var ama güvenlik duvarından geçemedi.`;
    }
    const edgePct = (bestBet.edge * 100).toFixed(1);
    const prob    = (bestBet.trueProb * 100).toFixed(0);
    const kelly   = (bestBet.kellyCriterion * 100).toFixed(1);
    const trap    = trapReport.isTrap ? ` ⚠ Tuzak skoru ${trapReport.trapScore}/100 — stake yarıya indirildi.` : '';
    return `✅ ${bestBet.marketLabel} @ ${bestBet.odd} | Gerçek ihtimal: %${prob} | Edge: %${edgePct} | Kelly stake: %${kelly}${trap}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  ValueEngine,
  PaceProjector,
  TrueProbabilityModel,
  ValueDetector,
  SafetyFirewall,
  TrapDetector,
  // Sabitler — test ve harici kullanım için
  PROB_WEIGHTS,
  HOME_ADVANTAGE,
  MIN_VALUE_EDGE,
  MIN_CONFIDENCE_FOR_BET,
};
