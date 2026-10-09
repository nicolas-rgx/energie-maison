/* Tableau de bord energie maison - v2
 * Lit le Shelly Pro 3EM (profil Monophase) via son API locale.
 * Voies : em1:0 = Compteur general, em1:1 = Production solaire, em1:2 = Borne voitures
 * Page servie par le Shelly lui-meme : http://192.168.1.163/script/1/app
 * Reglages (prix, heures creuses) stockes dans le Shelly (cle KVS "cfg"), donc partages entre appareils.
 */
(function () {
  // adresse des fichiers sur GitHub Pages (pour charger historique.json)
  var BASE_URL = ((document.currentScript && document.currentScript.src) || '').replace(/app\.js.*$/, '');
  'use strict';

  var VOIES = { general: 0, solaire: 1, borne: 2 };
  var JAUGE_MAX_W = 4000;          // echelle de la jauge, de chaque cote du zero
  var LIVE_INTERVAL_MS = 10000;    // rafraichissement de "En ce moment"
  // Contrat Octopus « Eco-conso fixe -2% » (depuis le 1er juillet 2026), modifiable dans Réglages
  var DEFAULT_CFG = { hp: 0.2111, hc: 0.1566, ab: 23.90, hcp: [[1 + 20 / 60, 6 + 20 / 60], [13 + 50 / 60, 16 + 50 / 60]] };

  var cfg = clone(DEFAULT_CFG);
  var app = document.getElementById('app');
  var state = { period: 'today', from: null, to: null, chart: null, loading: false, earliest: null, liveTimer: null };

  var nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  var fmtJourLong = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  var fmtJourCourt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  var fmtJourAxe = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
  var fmtMois = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });
  var fmtMoisLong = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
  var fmtHeure = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

  /* ---------- utilitaires ---------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sod(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return sod(x); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function kwh(wh) { return nf1.format(wh / 1000); }
  function kw(w) { return nf2.format(w / 1000); }
  function pct(x) { return x == null || !isFinite(x) ? '–' : nf0.format(x * 100); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function fmtH(h) { var hh = Math.floor(h), mm = Math.round((h - hh) * 60); return pad2(hh) + ':' + pad2(mm); }
  function hourFrac(d) { return d.getHours() + d.getMinutes() / 60; }
  function prixOk() { return typeof cfg.hp === 'number' && typeof cfg.hc === 'number'; }
  function isHC(h) {
    return (cfg.hcp || []).some(function (p) {
      return p[0] < p[1] ? (h >= p[0] && h < p[1]) : (h >= p[0] || h < p[1]);
    });
  }

  /* ---------- API Shelly ---------- */
  var rpcId = 0;
  function rpc(method, params) {
    return fetch('/rpc', {
      method: 'POST', cache: 'no-store',
      body: JSON.stringify({ id: ++rpcId, method: method, params: params || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { var e = new Error(method + ' : ' + (j.error.message || j.error.code)); e.code = j.error.code; throw e; }
      return j.result;
    });
  }

  async function chargerCfg() {
    try {
      var r = await rpc('KVS.Get', { key: 'cfg' });
      cfg = Object.assign(clone(DEFAULT_CFG), JSON.parse(r.value));
    } catch (e) { cfg = clone(DEFAULT_CFG); }
  }

  async function chargerEarliest() {
    try {
      var r = await rpc('EM1Data.GetRecords', { id: VOIES.general, ts: 0 });
      var b = (r.data_blocks || [])[0];
      if (b && b.ts > 1e9) state.earliest = b.ts;
    } catch (e) { /* inconnu */ }
  }

  // Mesures minute par minute : Map ts -> {imp, ret}
  async function getMinutes(id, ts, end) {
    var out = new Map(), next = ts, guard = 0;
    while (next < end && guard++ < 300) {
      var r = await rpc('EM1Data.GetData', { id: id, ts: next, end_ts: end, add_keys: true });
      var keys = r.keys || [];
      var iImp = keys.indexOf('total_act_energy'), iRet = keys.indexOf('total_act_ret_energy');
      if (iImp < 0) iImp = 0;
      if (iRet < 0) iRet = 1;
      (r.data || []).forEach(function (b) {
        (b.values || []).forEach(function (v, i) {
          var t = b.ts + i * b.period;
          if (t >= ts && t < end) out.set(t, { imp: v[iImp] || 0, ret: v[iRet] || 0 });
        });
      });
      if (typeof r.next_record_ts !== 'number' || r.next_record_ts <= next) break;
      next = r.next_record_ts;
    }
    return out;
  }

  // Bilans nets par tranche de 30 min : Map ts -> Wh (positif = consomme, negatif = renvoye)
  async function getNet(id, ts, end, periode) {
    var P = periode || 1800, out = new Map();
    var next = Math.ceil(ts / P) * P, guard = 0;
    while (next < end && guard++ < 100) {
      var r = await rpc('EM1Data.GetNetEnergies', { id: id, ts: next, end_ts: end, period: P, add_keys: true });
      (r.data || []).forEach(function (b) {
        (b.values || []).forEach(function (v, i) {
          var t = b.ts + i * (b.period || P);
          if (t >= ts && t < end) out.set(t, v[0] || 0);
        });
      });
      if (typeof r.next_record_ts !== 'number' || r.next_record_ts <= next) break;
      next = r.next_record_ts;
    }
    return out;
  }

  function union(maps) {
    var s = new Set();
    maps.forEach(function (m) { m.forEach(function (_, t) { s.add(t); }); });
    return Array.from(s).sort(function (a, b) { return a - b; });
  }

  async function intervallesMinute(ts, end) {
    var r = await Promise.all([getMinutes(VOIES.general, ts, end), getMinutes(VOIES.solaire, ts, end), getMinutes(VOIES.borne, ts, end)]);
    var g = r[0], s = r[1], b = r[2];
    var z = { imp: 0, ret: 0 };
    return union([g, s, b]).map(function (t) {
      var gg = g.get(t) || z, ss = s.get(t) || z, bb = b.get(t) || z;
      return { t: t, dur: 60, achat: gg.imp, inj: gg.ret, prod: ss.imp, ond: ss.ret, ev: Math.max(0, bb.imp - bb.ret) };
    });
  }

  async function intervallesNet(ts, end) {
    var g = await getNet(VOIES.general, ts, end);
    var s = await getNet(VOIES.solaire, ts, end);
    var b = await getNet(VOIES.borne, ts, end);
    return union([g, s, b]).map(function (t) {
      var n0 = g.get(t) || 0, n1 = s.get(t) || 0, n2 = b.get(t) || 0;
      return { t: t, dur: 1800, achat: Math.max(0, n0), inj: Math.max(0, -n0), prod: Math.max(0, n1), ond: Math.max(0, -n1), ev: Math.max(0, n2) };
    });
  }

  /* ---------- Mémoire des journées (cache dans le navigateur) ----------
   * Une journée terminée ne change plus : on la calcule une fois (par tranches de 5 min),
   * on la range dans la mémoire du navigateur, et les fois suivantes elle s'affiche instantanément.
   * Cette mémoire garde aussi le détail des jours au-delà des ~45 jours conservés par le Shelly. */
  var CACHE_VER = 'v1';
  var CHAMPS = ['achatHP', 'achatHC', 'injHP', 'injHC', 'prod', 'ond', 'ev', 'autoHP', 'autoHC', 'evAchatHP', 'evAchatHC'];
  function signatureHC() { return (cfg.hcp || []).map(function (p) { return p[0].toFixed(2) + '-' + p[1].toFixed(2); }).join('_'); }
  function cleCache(j) { return 'em:' + CACHE_VER + ':' + signatureHC() + ':' + j; }
  function lireJour(j) { try { var v = localStorage.getItem(cleCache(j)); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function ecrireJour(j, h) { try { localStorage.setItem(cleCache(j), JSON.stringify(h)); } catch (e) { /* mémoire pleine ou indisponible */ } }
  function versTableau(B) { return CHAMPS.map(function (k) { return Math.round(B[k] * 10) / 10; }); }
  function depuisTableau(B, a) { CHAMPS.forEach(function (k, i) { B[k] += a[i] || 0; }); return B; }

  // Renvoie { 'AAAA-MM-JJ': [24 heures x CHAMPS] } pour les jours demandés, en n'interrogeant le Shelly que pour les jours manquants
  async function chargerJours(jours, progres) {
    var res = {}, manquants = [], maintenant = new Date();
    jours.forEach(function (d) {
      var k = ymd(d), c = addDays(d, 1) <= maintenant ? lireJour(k) : null;
      if (c) res[k] = c; else manquants.push(d);
    });
    var faits = jours.length - manquants.length;
    if (progres) progres(faits, jours.length);
    // par paquets de 7 jours consécutifs pour afficher la progression
    for (var i = 0; i < manquants.length; i += 7) {
      var paquet = manquants.slice(i, i + 7);
      var s = Math.floor(paquet[0].getTime() / 1000);
      var e = Math.min(Math.floor(addDays(paquet[paquet.length - 1], 1).getTime() / 1000), Math.floor(Date.now() / 1000));
      if (state.earliest && s < state.earliest) s = Math.floor(state.earliest / 300) * 300;
      var parJour = {};
      paquet.forEach(function (d) {
        var l = [];
        for (var h = 0; h < 24; h++) l.push(seau(h, h + 'h'));
        parJour[ymd(d)] = { seaux: l, n: 0 };
      });
      if (s < e) {
        var r = await Promise.all([getNet(VOIES.general, s, e, 300), getNet(VOIES.solaire, s, e, 300), getNet(VOIES.borne, s, e, 300)]);
        union(r).forEach(function (t) {
          var n0 = r[0].get(t) || 0, n1 = r[1].get(t) || 0, n2 = r[2].get(t) || 0, d = new Date(t * 1000), J = parJour[ymd(d)];
          if (!J) return;
          J.n++;
          ajouter(J.seaux[d.getHours()], { t: t, dur: 300, achat: Math.max(0, n0), inj: Math.max(0, -n0),
            prod: Math.max(0, n1), ond: Math.max(0, -n1), ev: Math.max(0, n2) });
        });
      }
      paquet.forEach(function (d) {
        var k = ymd(d), J = parJour[k], tab = J.seaux.map(versTableau);
        res[k] = J.n ? tab : null;
        if (J.n && addDays(d, 1) <= maintenant) ecrireJour(k, tab);
      });
      faits += paquet.length;
      if (progres) progres(faits, jours.length);
    }
    return res;
  }

  async function chargerArchive() {
    var out = {}, offset = 0, total = Infinity, guard = 0;
    while (offset < total && guard++ < 10) {
      var r = await rpc('KVS.GetMany', { match: '*', offset: offset });
      var items = r.items || {}, n = 0;
      var add = function (k, v) { if (/^[mh]\d{6}$/.test(k)) { try { out[k] = JSON.parse(v); } catch (e) { } } n++; };
      if (Array.isArray(items)) items.forEach(function (it) { add(it.key, it.value); });
      else Object.keys(items).forEach(function (k) { add(k, items[k].value); });
      total = typeof r.total === 'number' ? r.total : offset + n;
      offset += n;
      if (!n) break;
    }
    return out;
  }

  /* ---------- calculs ---------- */
  function seau(key, label) {
    return { key: key, label: label, achatHP: 0, achatHC: 0, injHP: 0, injHC: 0, prod: 0, ond: 0, ev: 0, autoHP: 0, autoHC: 0, evAchatHP: 0, evAchatHC: 0, evApprox: false, hAchat: 0, hProd: 0, partiel: false };
  }
  // Part de l'intervalle [t, t + dur] situee en heures creuses (0 a 1), a la minute pres
  function partHC(t, dur) {
    var n = Math.max(1, Math.round(dur / 60)), hc = 0;
    for (var i = 0; i < n; i++) if (isHC(hourFrac(new Date((t + i * 60) * 1000)))) hc++;
    return hc / n;
  }
  function ajouter(B, iv) {
    var f = partHC(iv.t, iv.dur || 60), auto = Math.max(0, iv.prod - iv.inj);
    B.achatHC += iv.achat * f; B.achatHP += iv.achat * (1 - f);
    B.injHC += iv.inj * f; B.injHP += iv.inj * (1 - f);
    B.autoHC += auto * f; B.autoHP += auto * (1 - f);
    B.prod += iv.prod;
    B.ond += iv.ond;
    B.ev += iv.ev;
    // Part de l'achat réseau attribuée aux voitures : au prorata de leur poids dans la conso du moment
    var maison = Math.max(0, iv.achat - iv.inj + iv.prod - iv.ond);
    var evAchat = maison > 0 ? iv.achat * Math.min(1, iv.ev / maison) : 0;
    B.evAchatHC += evAchat * f; B.evAchatHP += evAchat * (1 - f);
  }
  function finir(B) {
    B.achat = B.achatHP + B.achatHC;
    B.inj = B.injHP + B.injHC;
    B.auto = B.autoHP + B.autoHC;
    // hAchat / hProd : historique importé (avant le Shelly), où l'autoconsommation n'est pas connue :
    // la consommation de cette partie est comptée au minimum (achats seulement)
    B.maison = Math.max(0, (B.achat - B.hAchat) - B.inj + (B.prod - B.hProd) - B.ond) + B.hAchat;
    B.autres = Math.max(0, B.maison - B.ev);
    B.evAchat = B.evAchatHP + B.evAchatHC;
    if (prixOk()) {
      B.cout = (B.achatHP * cfg.hp + B.achatHC * cfg.hc) / 1000;
      B.eco = (B.autoHP * cfg.hp + B.autoHC * cfg.hc) / 1000;
      B.perte = (B.injHP * cfg.hp + B.injHC * cfg.hc) / 1000;
      B.coutEv = (B.evAchatHP * cfg.hp + B.evAchatHC * cfg.hc) / 1000;
      B.coutAutres = B.cout - B.coutEv;
    }
    return B;
  }
  function somme(list) {
    var T = seau('total', 'Total');
    ['achatHP', 'achatHC', 'injHP', 'injHC', 'prod', 'ond', 'ev', 'autoHP', 'autoHC', 'evAchatHP', 'evAchatHC', 'hAchat', 'hProd'].forEach(function (k) {
      list.forEach(function (B) { T[k] += B[k]; });
    });
    T.partiel = list.some(function (B) { return B.partiel; });
    return finir(T);
  }

  /* ---------- periodes ---------- */
  function plage() {
    var today = sod(new Date()), now = new Date();
    switch (state.period) {
      case 'today': return { start: today, end: now, gran: 'hour' };
      case 'hier': return { start: addDays(today, -1), end: today, gran: 'hour' };
      case '30j': return { start: addDays(today, -29), end: now, gran: 'day' };
      case '12m': return { start: new Date(today.getFullYear(), today.getMonth() - 11, 1), end: now, gran: 'month' };
      default: {
        var a = state.from, b = state.to;
        if (b < a) { var x = a; a = b; b = x; }
        var e = addDays(b, 1);
        if (e > now) e = now;
        // au-delà de 2 mois : vue mois par mois (archive du Shelly), instantanée même sur 1 an ou plus
        if ((e - a) / 86400000 > 62) return { start: new Date(a.getFullYear(), a.getMonth(), 1), end: e, gran: 'month' };
        return { start: a, end: e, gran: addDays(a, 1) >= e ? 'hour' : 'day' };
      }
    }
  }

  function libellePeriode(R) {
    if (state.period === 'today') return "Aujourd'hui, " + fmtJourLong.format(R.start);
    if (state.period === 'hier') return 'Hier, ' + fmtJourLong.format(R.start);
    if (R.gran === 'hour') return cap(fmtJourLong.format(R.start));
    if (R.gran === 'month') return cap(fmtMoisLong.format(R.start)) + ' à ' + fmtMoisLong.format(new Date(R.end - 1));
    return 'Du ' + fmtJourCourt.format(R.start) + ' au ' + fmtJourCourt.format(new Date(R.end - 1));
  }

  function seaux(R) {
    var list = [];
    if (R.gran === 'hour') {
      for (var h = 0; h < 24; h++) list.push(seau(h, h + 'h'));
    } else if (R.gran === 'day') {
      for (var d = sod(R.start); d < R.end; d = addDays(d, 1)) list.push(seau(ymd(d), fmtJourAxe.format(d)));
    } else {
      var nbMois = (R.end.getFullYear() * 12 + R.end.getMonth()) - (R.start.getFullYear() * 12 + R.start.getMonth()) + 1;
      if (R.end.getDate() === 1 && R.end.getHours() === 0 && R.end.getMinutes() === 0) nbMois--;
      for (var i = 0; i < Math.max(1, nbMois); i++) {
        var m = new Date(R.start.getFullYear(), R.start.getMonth() + i, 1);
        var b = seau('m' + m.getFullYear() + pad2(m.getMonth() + 1), fmtMois.format(m));
        b.date = m;
        list.push(b);
      }
    }
    return list;
  }
  function cle(gran, d) { return gran === 'hour' ? d.getHours() : ymd(d); }

  /* ---------- rendu ---------- */
  function tile(label, value, unit, note, cls) {
    return '<div class="tile ' + (cls || '') + '"><div class="tile-label">' + label + '</div>' +
      '<div class="tile-value">' + value + (unit ? '<span class="unit">' + unit + '</span>' : '') + '</div>' +
      (note ? '<div class="tile-note">' + note + '</div>' : '') + '</div>';
  }

  function squelette() {
    app.innerHTML =
      '<div class="barre-charge" aria-hidden="true"></div>' +
      '<header class="hero">' +
        '<div class="scene" id="scene"></div>' +
        '<div class="hero-content">' +
          '<div><h1>Énergie maison</h1><div class="sub" id="maj"></div><div class="sub" id="sceneInfo"></div></div>' +
          '<div class="top-actions"><button id="btnCfg" class="btn ghost" aria-label="Réglages"><span class="ico" aria-hidden="true">⚙</span><span class="lbl">Réglages</span></button>' +
          '<button id="refresh" class="btn" aria-label="Actualiser"><span class="ico" aria-hidden="true">↻</span><span class="lbl">Actualiser</span></button></div>' +
        '</div>' +
      '</header>' +
      '<section id="cfgPanel" class="panel" hidden></section>' +

      '<section><div class="sec-head"><h2>En ce moment</h2><span class="sub" id="liveAt"></span></div>' +
        '<div id="jauge" class="jauge-card"></div>' +
        '<div class="grid" id="live"></div></section>' +

      '<section class="periode">' +
        '<div class="chips" role="group" aria-label="Période">' +
          '<button class="chip" data-p="today">Aujourd\'hui</button>' +
          '<button class="chip" data-p="hier">Hier</button>' +
          '<button class="chip" data-p="30j">30 derniers jours</button>' +
          '<button class="chip" data-p="12m">12 derniers mois</button>' +
          '<button class="chip" data-p="custom">Dates personnalisées</button>' +
        '</div>' +
        '<div id="custom" class="custom" hidden>' +
          '<label>Du <input type="date" id="dFrom"></label>' +
          '<label>au <input type="date" id="dTo"></label>' +
          '<button id="apply" class="btn small">Afficher</button>' +
        '</div>' +
        '<div class="periode-ligne"><div class="periode-label" id="periodeLabel"></div>' +
        '<div class="charge" aria-live="polite"><span class="spin" aria-hidden="true"></span><span id="chargeTxt"></span></div></div>' +
      '</section>' +
      '<div id="msg" class="msg" hidden></div>' +

      '<section><h2>Bilan de la période</h2><div class="grid" id="bilan"></div></section>' +

      '<section><div class="sec-head"><h2 id="chartTitle">Heure par heure</h2>' +
        '<button id="toggleTable" class="btn ghost small">Voir le tableau</button></div>' +
        '<div class="chart-wrap"><canvas id="chart" role="img" aria-label="Consommation, production et injection sur la période"></canvas></div>' +
        '<div id="chartDetail" class="detail" hidden></div>' +
        '<div class="chart-note" id="chartNote"></div>' +
        '<div id="table" class="table-wrap" hidden></div>' +
      '</section>' +
      '<section id="appareils"><div class="sec-head"><h2>Appareils récurrents</h2>' +
        '<button id="btnAnalyse" class="btn ghost small">Analyser les 7 derniers jours</button></div>' +
        '<div id="appList" class="app-list"><p class="tile-note">Repère les appareils qui démarrent régulièrement avec la même puissance ' +
        '(frigo, chauffe-eau, jacuzzi, pompe à chaleur…) pour savoir quand ils tournent et ce qu\'ils coûtent. L\'analyse prend quelques secondes.</p></div></section>' +
      '<footer class="foot" id="foot"></footer>';

    document.getElementById('refresh').onclick = function () { chargerLive(); chargerPeriode(); };
    document.getElementById('btnCfg').onclick = basculerReglages;
    document.getElementById('btnAnalyse').onclick = analyserAppareils;
    document.querySelectorAll('.chip').forEach(function (c) {
      c.onclick = function () {
        var p = c.getAttribute('data-p');
        document.getElementById('custom').hidden = p !== 'custom';
        if (p === 'custom') { majChips(p); return; }
        state.period = p;
        chargerPeriode();
      };
    });
    document.getElementById('apply').onclick = function () {
      var f = document.getElementById('dFrom').value, t = document.getElementById('dTo').value;
      if (!f || !t) { message('Choisis une date de début et une date de fin.', 'info'); return; }
      state.from = parseYmd(f); state.to = parseYmd(t); state.period = 'custom';
      chargerPeriode();
    };
    document.getElementById('toggleTable').onclick = function () {
      var t = document.getElementById('table');
      t.hidden = !t.hidden;
      this.textContent = t.hidden ? 'Voir le tableau' : 'Masquer le tableau';
    };
  }

  function majChips(p) {
    document.querySelectorAll('.chip').forEach(function (c) {
      c.classList.toggle('on', c.getAttribute('data-p') === (p || state.period));
    });
  }

  function majBornesCalendrier() {
    var max = ymd(new Date());
    var min = state.earliest ? ymd(new Date(state.earliest * 1000)) : '';
    ['dFrom', 'dTo'].forEach(function (id) {
      var el = document.getElementById(id);
      el.max = max;
      if (min) el.min = min;
      if (!el.value) el.value = max;
    });
  }

  function message(txt, type) {
    var m = document.getElementById('msg');
    if (!txt) { m.hidden = true; return; }
    m.hidden = false;
    m.className = 'msg ' + (type || '');
    m.textContent = txt;
  }

  /* --- En ce moment --- */
  function conseil(surplus, prod) {
    if (surplus >= 2000) return { cls: 'good', icon: '✓', titre: 'Gros surplus solaire',
      msg: 'Tu peux lancer un appareil puissant : lave-linge, lave-vaisselle, four, chauffe-eau ou recharge de la voiture.' };
    if (surplus >= 800) return { cls: 'good', icon: '✓', titre: 'Surplus solaire',
      msg: 'Un lave-vaisselle ou un lave-linge tournera en grande partie sur tes panneaux.' };
    if (surplus >= 150) return { cls: 'warn', icon: '!', titre: 'Petit surplus',
      msg: 'Assez pour de petits appareils seulement. Un appareil puissant ferait acheter du réseau.' };
    if (surplus > -150) return { cls: 'warn', icon: '=', titre: 'À l\'équilibre',
      msg: 'La maison consomme à peu près ce que produisent les panneaux.' };
    return { cls: 'bad', icon: '✕', titre: 'Tu achètes au réseau',
      msg: prod > 100 ? 'Les panneaux ne suffisent pas en ce moment : évite d\'allumer de nouveaux appareils.'
        : 'Pas de production solaire : tout vient du réseau. Privilégie les heures creuses.' };
  }

  function renderLive(st) {
    var pg = st['em1:' + VOIES.general].act_power;
    var psRaw = st['em1:' + VOIES.solaire].act_power;
    var ps = Math.max(0, psRaw);
    var pb = Math.max(0, st['em1:' + VOIES.borne].act_power);
    var maison = Math.max(0, pg + psRaw);
    var partSol = maison > 0 ? Math.min(ps, maison) / maison : (ps > 0 ? 1 : 0);
    var surplus = -pg;
    var c = conseil(surplus, ps);
    var imp = Math.min(1, Math.max(0, pg) / JAUGE_MAX_W) * 100;
    var sur = Math.min(1, Math.max(0, surplus) / JAUGE_MAX_W) * 100;
    var hc = isHC(hourFrac(new Date()));

    document.getElementById('jauge').innerHTML =
      '<div class="jauge-head"><span class="badge ' + c.cls + '"><span aria-hidden="true">' + c.icon + '</span> ' + c.titre + '</span>' +
      '<span class="jauge-val">' + (surplus >= 0 ? 'Surplus ' + kw(surplus) : 'Achat ' + kw(pg)) + ' kW</span></div>' +
      '<div class="jauge" role="meter" aria-valuemin="-' + JAUGE_MAX_W + '" aria-valuemax="' + JAUGE_MAX_W + '" aria-valuenow="' + Math.round(surplus) + '" aria-label="Équilibre réseau">' +
        '<div class="j-side j-left"><div class="j-fill imp" style="width:' + imp + '%"></div></div>' +
        '<div class="j-zero"></div>' +
        '<div class="j-side j-right"><div class="j-fill sur" style="width:' + sur + '%"></div></div>' +
      '</div>' +
      '<div class="jauge-scale"><span>← J\'achète au réseau</span><span>0</span><span>J\'ai du surplus →</span></div>' +
      '<p class="jauge-msg">' + c.msg + (hc ? ' <span class="hc-pill">Heures creuses en cours</span>' : '') + '</p>';

    var reseau = pg >= 0
      ? tile('Achat au réseau', kw(pg), 'kW', hc ? 'tarif heures creuses' : 'tarif heures pleines', 'achat')
      : tile('Injecté, donc gaspillé', kw(-pg), 'kW', 'envoyé au réseau sans être payé', 'perte');
    document.getElementById('live').innerHTML =
      tile('Production solaire', kw(ps), 'kW', '', 'solaire') +
      tile('Consommation maison', kw(maison), 'kW', '', '') +
      tile('Part solaire maintenant', pct(partSol), '%', 'de la conso couverte par les panneaux', 'solaire') +
      reseau +
      tile('Borne voitures', kw(pb), 'kW', pb > 50 ? 'charge en cours' : 'pas de charge', '');
    document.getElementById('liveAt').textContent = 'à ' + fmtHeure.format(new Date());
  }

  async function chargerLive() {
    try { renderLive(await rpc('Shelly.GetStatus')); }
    catch (e) { document.getElementById('jauge').innerHTML = '<p class="msg err">Lecture en direct impossible. Es-tu sur le WiFi de la maison ?</p>'; }
  }

  function demarrerLive() {
    clearInterval(state.liveTimer);
    state.liveTimer = setInterval(function () {
      if (document.visibilityState === 'visible' && !state.loading) chargerLive();
    }, LIVE_INTERVAL_MS);
  }

  /* --- Bilan --- */
  function renderBilan(T, jours) {
    var lienPrix = '<button class="link" data-open-cfg>renseigner les prix</button>';
    var abo = typeof cfg.ab === 'number' ? cfg.ab * 12 / 365 * jours : 0;
    var facture = prixOk() ? tile('Facture estimée', eur.format(T.cout + abo), '',
      'énergie ' + eur.format(T.cout) + (abo ? ' + abonnement ' + eur.format(abo) : ' (hors abonnement)'), 'achat')
      : tile('Facture estimée', '–', '', lienPrix, 'achat');
    var eco = prixOk() ? tile('Économisé grâce au solaire', eur.format(T.eco), '',
      kwh(T.auto) + ' kWh solaires consommés au lieu d\'être achetés', 'solaire')
      : tile('Économisé grâce au solaire', '–', '', lienPrix, 'solaire');

    var partSolEv = T.ev > 0 ? 1 - T.evAchat / T.ev : null;
    var autresAchat = T.achat - T.evAchat;
    var partSolAutres = T.autres > 0 ? 1 - autresAchat / T.autres : null;
    var voitures = tile('Voitures', prixOk() ? eur.format(T.coutEv) : kwh(T.ev), prixOk() ? '' : 'kWh',
      kwh(T.ev) + ' kWh, dont ' + pct(partSolEv) + ' % solaire gratuit' + (T.partiel ? ' (estimé)' : '') +
      (prixOk() && T.cout > 0 ? ' · ' + pct(T.coutEv / T.cout) + ' % de l\'énergie facturée' : ''), 'voiture');
    var autres = tile('Autres appareils', prixOk() ? eur.format(T.coutAutres) : kwh(T.autres), prixOk() ? '' : 'kWh',
      kwh(T.autres) + ' kWh, dont ' + pct(partSolAutres) + ' % solaire gratuit' + (T.partiel ? ' (estimé)' : '') +
      (prixOk() && T.cout > 0 ? ' · ' + pct(T.coutAutres / T.cout) + ' % de l\'énergie facturée' : ''), 'autres');

    // sur une période en partie importée, les ratios solaires ne portent que sur la partie mesurée par le Shelly
    var prodMes = T.prod - T.hProd, maisonMes = T.maison - T.hAchat, sur = T.partiel ? ' (période mesurée par le Shelly)' : '';
    document.getElementById('bilan').innerHTML =
      tile('Consommation totale', (T.partiel ? '≥ ' : '') + kwh(T.maison), 'kWh', T.partiel ? 'minimum : l\'autoconsommation avant le 6 oct. n\'est pas connue' : '', '') +
      tile('Production solaire', kwh(T.prod), 'kWh', T.partiel ? 'dont ' + kwh(T.hProd) + ' kWh relevés sur l\'onduleur' : '', 'solaire') +
      tile('Part solaire de la conso', pct(maisonMes > 0 ? T.auto / maisonMes : null), '%',
        'de ta consommation couverte par les panneaux' + sur, 'solaire') +
      tile('Production consommée sur place', pct(prodMes > 0 ? T.auto / prodMes : null), '%',
        'le reste part sur le réseau' + sur, 'solaire') +
      tile('Acheté à Octopus', kwh(T.achat), 'kWh', 'HP ' + kwh(T.achatHP) + ' · HC ' + kwh(T.achatHC) + ' kWh', 'achat') +
      tile('Injecté, donc gaspillé', kwh(T.inj), 'kWh',
        (prodMes > 0 ? pct(T.inj / prodMes) + ' % de la production' + sur : '') +
        (prixOk() && T.inj > 0 ? ', soit ' + eur.format(T.perte) + ' d\'achat évitable' : ''), 'perte') +
      facture + voitures + autres + eco;

    document.querySelectorAll('[data-open-cfg]').forEach(function (b) { b.onclick = function () { basculerReglages(true); }; });
  }

  /* --- Graphique --- */
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function bandesHC() {
    var out = [];
    (cfg.hcp || []).forEach(function (p) {
      if (p[0] < p[1]) out.push([p[0], p[1]]);
      else { out.push([p[0], 24]); out.push([0, p[1]]); }
    });
    return out;
  }

  var pluginHC = {
    id: 'bandesHC',
    beforeDatasetsDraw: function (chart) {
      if (!chart.$hc) return;
      var x = chart.scales.x, a = chart.chartArea, ctx = chart.ctx;
      var w = (x.right - x.left) / 24;
      ctx.save();
      ctx.fillStyle = css('--hc-band');
      chart.$hc.forEach(function (b) {
        ctx.fillRect(x.left + b[0] * w, a.top, (b[1] - b[0]) * w, a.bottom - a.top);
      });
      ctx.restore();
    }
  };

  var TACTILE = window.matchMedia && window.matchMedia('(hover: none)').matches;
  function fermerDetail() {
    var d = document.getElementById('chartDetail');
    if (d) d.hidden = true;
    if (state.chart) { state.chart.setActiveElements([]); state.chart.update('none'); }
  }
  function afficherDetail(list, R, i, titre) {
    var B = list[i], d = document.getElementById('chartDetail');
    var ligne = function (cls, lib, v) { return '<li><span class="pastille ' + cls + '"></span>' + lib + '<b>' + nf2.format(v / 1000) + ' kWh</b></li>'; };
    d.innerHTML = '<div class="detail-tete"><b>' + titre([{ dataIndex: i }]) + '</b>' +
      '<button class="detail-fermer" aria-label="Fermer le détail">✕</button></div><ul>' +
      ligne('p-prod', 'Production solaire', B.prod) + ligne('p-autres', 'Autres appareils', B.autres) +
      ligne('p-ev', 'Voitures', B.ev) + ligne('p-inj', 'Injecté (gaspillé)', B.inj) + '</ul>' +
      (prixOk() && B.cout != null ? '<div class="detail-pied">Coût achat : <b>' + eur.format(B.cout) + '</b>' +
        (B.coutEv > 0.005 ? ' (voitures ' + eur.format(B.coutEv) + ')' : '') + '</div>' : '');
    d.hidden = false;
    d.querySelector('.detail-fermer').onclick = fermerDetail;
  }

  function renderChart(list, R) {
    var c = { autres: css('--series-1'), ev: css('--series-2'), inj: css('--series-3'), prod: css('--series-4'),
      surface: css('--surface-1'), texte: css('--text-secondary'), grille: css('--grid') };
    var k = function (wh) { return Math.round(wh) / 1000; };
    var bar = function (label, data, color) {
      return { label: label, data: data, backgroundColor: color, stack: 's', order: 1, borderRadius: 4,
        borderSkipped: false, borderWidth: 1, borderColor: c.surface, categoryPercentage: 0.8, barPercentage: 0.9 };
    };
    var data = {
      labels: list.map(function (B) { return B.label; }),
      datasets: [
        { type: 'line', label: 'Production solaire', data: list.map(function (B) { return k(B.prod); }),
          borderColor: c.prod, backgroundColor: c.prod, borderWidth: 2, pointRadius: R.gran === 'hour' ? 0 : 3,
          pointHoverRadius: 5, pointHitRadius: 12, cubicInterpolationMode: 'monotone', stack: 'prod', order: 0 },
        bar('Autres appareils', list.map(function (B) { return k(B.autres); }), c.autres),
        bar('Voitures', list.map(function (B) { return k(B.ev); }), c.ev),
        bar('Injecté (gaspillé)', list.map(function (B) { return -k(B.inj); }), c.inj)
      ]
    };
    var titre = function (it) {
      var B = list[it[0].dataIndex];
      if (R.gran === 'hour') return B.key + 'h à ' + (B.key + 1) + 'h · ' + (isHC(B.key + 0.5) ? 'heures creuses' : 'heures pleines');
      if (R.gran === 'day') return cap(fmtJourLong.format(parseYmd(B.key)));
      return cap(fmtMoisLong.format(B.date));
    };
    var opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      // sur téléphone : pas d'infobulle qui reste bloquée, le détail s'affiche sous le graphique
      events: TACTILE ? ['click'] : ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
      onClick: function (evt, els, chart) {
        if (!TACTILE) return;
        var pts = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
        if (!pts.length) { fermerDetail(); return; }
        chart.setActiveElements(pts.map(function (p) { return { datasetIndex: p.datasetIndex, index: p.index }; }));
        chart.update('none');
        afficherDetail(list, R, pts[0].index, titre);
      },
      scales: {
        x: { stacked: true, grid: { display: false },
          ticks: { color: c.texte, maxRotation: 0, autoSkip: true, maxTicksLimit: R.gran === 'hour' ? 12 : 10 } },
        y: { stacked: true, grid: { color: c.grille }, border: { display: false },
          ticks: { color: c.texte, callback: function (v) { return nf1.format(v); } },
          title: { display: true, text: 'kWh', color: c.texte } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: c.texte, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14 } },
        tooltip: { enabled: !TACTILE, callbacks: {
          title: titre,
          label: function (ctx) { return ' ' + ctx.dataset.label + ' : ' + nf2.format(Math.abs(ctx.raw)) + ' kWh'; },
          footer: function (it) {
            var B = list[it[0].dataIndex];
            return prixOk() && B.cout != null ? 'Coût achat : ' + eur.format(B.cout) +
              (B.coutEv > 0.005 ? ' (voitures ' + eur.format(B.coutEv) + ')' : '') : '';
          }
        } }
      }
    };
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(document.getElementById('chart'), { type: 'bar', data: data, options: opts, plugins: [pluginHC] });
    state.chart.$hc = R.gran === 'hour' ? bandesHC() : null;
    state.chart.update();

    document.getElementById('chartTitle').textContent =
      R.gran === 'hour' ? 'Heure par heure' : R.gran === 'day' ? 'Jour par jour' : 'Mois par mois';
    var plages = (cfg.hcp || []).map(function (p) { return fmtH(p[0]) + '–' + fmtH(p[1]); }).join(', ');
    document.getElementById('chartNote').innerHTML = R.gran === 'hour'
      ? '<span class="hc-swatch"></span> Zones grisées : heures creuses (' + plages + '). Le reste : heures pleines.'
      : 'Répartition heures pleines / creuses : voir « Acheté à Octopus » et le tableau.';
  }

  function renderTable(list, R) {
    var rows = list.filter(function (B) { return B.maison > 0 || B.prod > 0 || B.inj > 0; }).map(function (B) {
      var lib = R.gran === 'hour' ? B.key + 'h' + (isHC(B.key + 0.5) ? ' (HC)' : '') : B.label;
      return '<tr><td>' + lib + '</td><td>' + kwh(B.prod) + '</td><td>' + kwh(B.maison) + '</td><td>' +
        kwh(B.ev) + '</td><td>' + kwh(B.achatHP) + '</td><td>' + kwh(B.achatHC) + '</td><td>' + kwh(B.inj) + '</td>' +
        (prixOk() ? '<td>' + eur.format(B.cout) + '</td><td>' + eur.format(B.coutEv) + '</td>' : '') + '</tr>';
    }).join('');
    document.getElementById('table').innerHTML = '<table><thead><tr><th>Période</th><th>Production</th>' +
      '<th>Conso</th><th>Voitures</th><th>Achat HP</th><th>Achat HC</th><th>Injecté</th>' +
      (prixOk() ? '<th>Coût achat</th><th>dont voitures</th>' : '') + '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="9">Pas de données sur cette période.</td></tr>') + '</tbody></table>' +
      '<p class="tile-note">Énergies en kWh.</p>';
  }

  /* --- Chargement d'une periode --- */
  function setChargement(on, txt) {
    document.body.classList.toggle('chargement', on);
    var el = document.getElementById('chargeTxt');
    if (el) el.textContent = on ? (txt || 'Chargement…') : '';
  }

  async function chargerPeriode() {
    if (state.loading) { state.relancer = true; majChips(); return; } // le dernier choix sera pris en compte
    state.loading = true;
    state.relancer = false;
    var btn = document.getElementById('refresh');
    btn.disabled = true; btn.classList.add('busy'); btn.querySelector('.lbl').textContent = 'Chargement…';
    majChips();
    message('');
    fermerDetail();
    setChargement(true);
    try {
      var R = plage();
      document.getElementById('periodeLabel').textContent = libellePeriode(R);
      var list = seaux(R), map = {};
      list.forEach(function (B) { map[B.key] = B; });
      var note = '';
      var jours = Math.max(0, (R.end - R.start) / 86400000);

      if (R.gran === 'month') {
        var arch = await chargerArchive();
        var nb = 0;
        jours = 0; // abonnement compté seulement sur les mois enregistrés
        list.forEach(function (B) {
          var v = arch[B.key], hv = arch['h' + B.key.slice(1)];
          if (hv && hv.length >= 4) {
            // historique importé : achats (Octopus), production (onduleur), voitures estimées
            B.achatHP += hv[0]; B.achatHC += hv[1]; B.hAchat += hv[0] + hv[1];
            B.prod += hv[2]; B.hProd += hv[2];
            B.ev += hv[3]; B.evAchatHC += hv[3];
            B.partiel = true;
          }
          if (!(v && v.length >= 9) && !hv) return;
          nb++;
          var finMois = new Date(B.date.getFullYear(), B.date.getMonth() + 1, 1);
          jours += (Math.min(finMois, R.end) - B.date) / 86400000;
          if (!(v && v.length >= 9)) return;
          B.achatHP += v[0]; B.achatHC += v[1]; B.injHP += v[2]; B.injHC += v[3];
          B.prod += v[4]; B.ond += v[5]; B.ev += v[6]; B.autoHP += v[7]; B.autoHC += v[8];
          if (v.length >= 11) { B.evAchatHP += v[9]; B.evAchatHC += v[10]; }
          else {
            // ancien format : répartition au prorata sur le mois
            var m = Math.max(1, v[0] + v[1] - v[2] - v[3] + v[4] - v[5]), r = Math.min(1, v[6] / m);
            B.evAchatHP += v[0] * r; B.evAchatHC += v[1] * r;
          }
        });
        if (list.some(function (B) { return B.partiel; })) note = 'Avant le 6 octobre (installation du Shelly) : achats Octopus et production de l\'onduleur importés, voitures estimées. ' +
          'L\'injection et l\'autoconsommation de cette période ne sont pas connues : consommation, parts solaires et économies sont calculées sur la période mesurée par le Shelly.';
        if (!nb) note = "L'historique mensuel se remplit à partir de l'installation du script sur le Shelly. Reviens dans quelques heures.";
      } else {
        var joursListe = [];
        for (var d = sod(R.start); d < R.end; d = addDays(d, 1)) joursListe.push(d);
        var data = await chargerJours(joursListe, function (f, t) {
          if (t > 1 && f < t) setChargement(true, 'Lecture des mesures : ' + f + ' / ' + t + ' jours…');
        });
        var avec = 0, premier = null;
        joursListe.forEach(function (d) {
          var k = ymd(d), tab = data[k];
          if (!tab) return;
          avec++;
          if (!premier) premier = d;
          if (R.gran === 'hour') tab.forEach(function (a, h) { depuisTableau(list[h], a); });
          else tab.forEach(function (a) { depuisTableau(map[k], a); });
        });
        if (!avec) note = 'Aucune donnée enregistrée sur cette période.';
        else if (premier > sod(R.start)) {
          jours = Math.max(0, (R.end - premier) / 86400000);
          note = 'Pas de mesures avant le ' + fmtJourLong.format(premier) + ' sur cet appareil. Pour une vue plus longue, utilise « 12 derniers mois ».';
        }
      }

      list.forEach(finir);
      var T = somme(list);
      renderBilan(T, jours);
      renderChart(list, R);
      renderTable(list, R);
      if (note) message(note, 'info');
      document.getElementById('foot').textContent = R.gran === 'month'
        ? 'Vue mensuelle : cumuls enregistrés toutes les 5 minutes par le script du Shelly.'
        : 'Calcul par tranches de 5 minutes à partir du Shelly Pro 3EM. Les journées terminées sont gardées en mémoire sur cet appareil pour un affichage instantané.';
      document.getElementById('maj').textContent = 'Mis à jour à ' + fmtHeure.format(new Date());
    } catch (err) {
      message("Impossible de lire le Shelly (" + err.message + "). Vérifie que tu es bien sur le WiFi de la maison.", 'err');
    } finally {
      state.loading = false;
      setChargement(false);
      btn.disabled = false; btn.classList.remove('busy'); btn.querySelector('.lbl').textContent = 'Actualiser';
      if (state.relancer) chargerPeriode();
    }
  }

  /* --- Reglages --- */
  function parsePlages(txt) {
    var out = [], re = /(\d{1,2})(?:[:h](\d{2}))?\s*[-–à]\s*(\d{1,2})(?:[:h](\d{2}))?/g, m;
    while ((m = re.exec(txt))) {
      var a = +m[1] + (+(m[2] || 0)) / 60, b = +m[3] + (+(m[4] || 0)) / 60;
      if (a <= 24 && b <= 24 && a !== b) out.push([a, b]);
    }
    return out;
  }
  function num(v) { var x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; }

  function basculerReglages(forcer) {
    var p = document.getElementById('cfgPanel');
    if (!p.hidden && forcer !== true) { p.hidden = true; return; }
    var plages = (cfg.hcp || []).map(function (x) { return fmtH(x[0]) + '-' + fmtH(x[1]); }).join(', ');
    p.innerHTML =
      '<h2>Réglages Octopus</h2>' +
      '<p class="tile-note">Enregistrés dans le Shelly : valables pour tous les téléphones et ordinateurs de la maison. Prix TTC, voir ta facture ou ton espace client.</p>' +
      '<div class="form">' +
        '<label>Prix kWh heures pleines (€)<input id="fHP" inputmode="decimal" placeholder="ex. 0,2516" value="' + (cfg.hp != null ? String(cfg.hp).replace('.', ',') : '') + '"></label>' +
        '<label>Prix kWh heures creuses (€)<input id="fHC" inputmode="decimal" placeholder="ex. 0,1828" value="' + (cfg.hc != null ? String(cfg.hc).replace('.', ',') : '') + '"></label>' +
        '<label>Abonnement (€ par mois)<input id="fAB" inputmode="decimal" placeholder="facultatif" value="' + (cfg.ab != null ? String(cfg.ab).replace('.', ',') : '') + '"></label>' +
        '<label>Plages heures creuses<input id="fHCP" placeholder="ex. 22:00-06:00 ou 01:30-07:30, 12:30-14:30" value="' + plages + '"></label>' +
      '</div>' +
      '<div class="form-actions"><button id="fSave" class="btn">Enregistrer</button><button id="fCancel" class="btn ghost">Fermer</button><span id="fMsg" class="tile-note"></span></div>' +
      '<h2 class="sep">Journal annuel (Google Sheets)</h2>' +
      '<p class="tile-note">Le Shelly envoie une ligne toutes les 30 minutes dans ton Google Sheet. C\'est la base de l\'analyse sur un an (batterie, panneaux, forfait, revente).</p>' +
      '<div class="form">' +
        '<label>Adresse du script Google (se termine par /exec)<input id="jURL" placeholder="https://script.google.com/macros/s/…/exec"></label>' +
        '<label>Code secret<input id="jKEY" placeholder="le même que dans le script Google"></label>' +
      '</div>' +
      '<div class="form-actions"><button id="jSave" class="btn">Enregistrer le journal</button>' +
        '<button id="jHisto" class="btn ghost">Envoyer l\'historique</button><span id="jMsg" class="tile-note"></span></div>' +
      '<p class="tile-note" id="jStat"></p>' +
      '<h2 class="sep">Historique avant le Shelly</h2>' +
      '<p class="tile-note">Juillet → 6 octobre : achats jour par jour (Octopus), production par mois (onduleur), recharges des voitures estimées. ' +
        'Visible dans « 12 derniers mois ». Envoyé aussi dans l\'onglet « Avant Shelly » du Google Sheet si le journal est configuré.</p>' +
      '<div class="form-actions"><button id="hImport" class="btn ghost">Importer juillet → 6 octobre</button><span id="hMsg" class="tile-note"></span></div>';
    p.hidden = false;
    document.getElementById('hImport').onclick = importerHistorique;
    initJournal();
    document.getElementById('fCancel').onclick = function () { p.hidden = true; };
    document.getElementById('fSave').onclick = async function () {
      var hcp = parsePlages(document.getElementById('fHCP').value);
      var nc = { hp: num(document.getElementById('fHP').value), hc: num(document.getElementById('fHC').value),
        ab: num(document.getElementById('fAB').value), hcp: hcp.length ? hcp : cfg.hcp };
      var m = document.getElementById('fMsg');
      try {
        await rpc('KVS.Set', { key: 'cfg', value: JSON.stringify(nc) });
        cfg = Object.assign(clone(DEFAULT_CFG), nc);
        m.textContent = 'Enregistré ✓';
        setTimeout(function () { p.hidden = true; }, 800);
        chargerLive(); chargerPeriode();
      } catch (e) { m.textContent = 'Erreur : ' + e.message; }
    };
  }

  /* ---------- Journal annuel Google Sheets ---------- */
  async function lireKVS(cle) { try { var r = await rpc('KVS.Get', { key: cle }); return r.value; } catch (e) { return null; } }

  async function initJournal() {
    var j = null, st = await lireKVS('jstat');
    try { j = JSON.parse(await lireKVS('journal')); } catch (e) { j = null; }
    if (j) { document.getElementById('jURL').value = j.u || ''; document.getElementById('jKEY').value = j.k || ''; }
    document.getElementById('jStat').textContent = !j ? 'Journal pas encore configuré.'
      : st ? 'Dernière demi-heure envoyée par le Shelly : ' + st + '.' : 'Configuré. Le premier envoi du Shelly arrive dans les 30 minutes.';
    document.getElementById('jSave').onclick = async function () {
      var u = document.getElementById('jURL').value.trim(), k = document.getElementById('jKEY').value.trim(), m = document.getElementById('jMsg');
      if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(u) || !k) { m.textContent = 'Adresse ou code secret invalide.'; return; }
      try { await rpc('KVS.Set', { key: 'journal', value: JSON.stringify({ u: u, k: k }) }); m.textContent = 'Enregistré ✓';
        document.getElementById('jStat').textContent = 'Configuré. Le Shelly enverra sa première ligne dans les 30 minutes.'; }
      catch (e) { m.textContent = 'Erreur : ' + e.message; }
    };
    document.getElementById('jHisto').onclick = envoyerHistorique;
  }

  // Envoie au Google Sheet tout l'historique encore conservé par le Shelly (demi-heures terminées)
  async function envoyerHistorique() {
    var m = document.getElementById('jMsg'), b = document.getElementById('jHisto');
    var u = document.getElementById('jURL').value.trim(), k = document.getElementById('jKEY').value.trim();
    if (!u || !k) { m.textContent = 'Renseigne et enregistre d\'abord l\'adresse et le code.'; return; }
    b.disabled = true;
    try {
      var debut = state.earliest ? Math.ceil(state.earliest / 1800) * 1800 : Math.floor(Date.now() / 1000) - 45 * 86400;
      var fin = Math.floor(Date.now() / 1000 / 1800) * 1800, lignes = {};
      for (var t = debut; t < fin; t += 7 * 86400) {
        var e = Math.min(fin, t + 7 * 86400);
        m.textContent = 'Lecture du Shelly : ' + new Date(t * 1000).toLocaleDateString('fr-FR') + '…';
        var r = await Promise.all([getNet(VOIES.general, t, e, 300), getNet(VOIES.solaire, t, e, 300), getNet(VOIES.borne, t, e, 300)]);
        union(r).forEach(function (ts) {
          var n0 = r[0].get(ts) || 0, n1 = r[1].get(ts) || 0, n2 = r[2].get(ts) || 0;
          var slot = Math.floor(ts / 1800) * 1800, d = new Date(slot * 1000);
          var cle = ymd(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
          var L = lignes[cle] || (lignes[cle] = [cle, 0, 0, 0, 0, 0, 0, isHC(hourFrac(d)) ? 1 : 0]);
          var prod = Math.max(0, n1), inj = Math.max(0, -n0);
          L[1] += Math.max(0, n0); L[2] += inj; L[3] += prod; L[4] += Math.max(0, -n1); L[5] += Math.max(0, n2);
          L[6] += Math.max(0, prod - inj);
        });
      }
      var tab = Object.keys(lignes).sort().map(function (c) {
        return lignes[c].map(function (v, i) { return i === 0 || i === 7 ? v : Math.round(v * 10) / 10; });
      });
      for (var i = 0; i < tab.length; i += 300) {
        m.textContent = 'Envoi au Google Sheet : ' + Math.min(i + 300, tab.length) + ' / ' + tab.length + ' demi-heures…';
        await fetch(u, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ token: k, source: 'historique', rows: tab.slice(i, i + 300) }) });
      }
      m.textContent = tab.length + ' demi-heures envoyées ✓ Vérifie l\'onglet « Journal » du Google Sheet.';
    } catch (err) { m.textContent = 'Erreur : ' + err.message; }
    finally { b.disabled = false; }
  }

  // Historique d'avant le Shelly : fichier historique.json publié à côté de app.js sur GitHub
  async function importerHistorique() {
    var m = document.getElementById('hMsg'), b = document.getElementById('hImport');
    b.disabled = true; m.textContent = 'Lecture du fichier…';
    try {
      var rep = await fetch(BASE_URL + 'historique.json?v=' + Date.now());
      if (!rep.ok) throw new Error('historique.json introuvable sur GitHub');
      var h = await rep.json(), cles = Object.keys(h.mois || {});
      for (var i = 0; i < cles.length; i++) {
        m.textContent = 'Enregistrement dans le Shelly : ' + (i + 1) + ' / ' + cles.length + ' mois…';
        await rpc('KVS.Set', { key: cles[i], value: JSON.stringify(h.mois[cles[i]]) });
      }
      var txt = cles.length + ' mois importés ✓';
      var u = document.getElementById('jURL').value.trim(), k = document.getElementById('jKEY').value.trim();
      if (u && k && h.jours) {
        m.textContent = 'Envoi au Google Sheet…';
        await fetch(u, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ token: k, type: 'historique', jours: h.jours, mois: h.mois }) });
        txt += ' Envoyé aussi au Google Sheet (onglet « Avant Shelly »).';
      }
      m.textContent = txt;
      if (plage().gran === 'month') chargerPeriode();
    } catch (err) { m.textContent = 'Erreur : ' + err.message; }
    finally { b.disabled = false; }
  }

  /* ---------- Appareils récurrents : détection des cycles de puissance ---------- */
  var JOURS_ANALYSE = 7;
  var SEUIL_W = 90;           // variation minimale pour repérer un démarrage / arrêt
  var noms = {};

  function med(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function moy(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function ecart(a) { var m = moy(a); return Math.sqrt(moy(a.map(function (x) { return (x - m) * (x - m); }))); }
  function signature(p, dur) { return Math.round(p / 200) * 200 + 'W' + Math.max(1, Math.round(dur / 15)) * 15 + 'm'; }
  function fmtDuree(min) { return min < 90 ? nf0.format(min) + ' min' : nf1.format(min / 60) + ' h'; }

  async function chargerNoms() {
    try { var r = await rpc('KVS.Get', { key: 'noms' }); noms = JSON.parse(r.value) || {}; } catch (e) { noms = {}; }
  }
  function nomPour(sig) {
    if (noms[sig]) return noms[sig];
    var m = /^(\d+)W(\d+)m$/.exec(sig);
    if (!m) return null;
    for (var dp = -200; dp <= 200; dp += 200) for (var dd = -15; dd <= 15; dd += 15) {
      var k = (+m[1] + dp) + 'W' + (+m[2] + dd) + 'm';
      if (noms[k]) return noms[k];
    }
    return null;
  }

  // Série minute par minute : puissance des « autres appareils » (hors voitures) et achat réseau, en W
  async function serieAutres(ts, end, progres) {
    var P = new Map(), A = new Map(), j = 0;
    for (var t = ts; t < end; t += 86400) {
      progres(++j);
      var ivs = await intervallesMinute(t, Math.min(end, t + 86400));
      ivs.forEach(function (iv) {
        P.set(iv.t, Math.max(0, (iv.achat - iv.inj + iv.prod - iv.ond - iv.ev) * 60));
        A.set(iv.t, iv.achat * 60);
      });
    }
    return { P: P, A: A };
  }

  // Repère les démarrages / arrêts et associe chaque démarrage à l'arrêt de même amplitude
  function detecterCycles(S) {
    var ts = Array.from(S.P.keys()).sort(function (a, b) { return a - b; });
    var d = [];
    for (var i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1] === 60 ? S.P.get(ts[i]) - S.P.get(ts[i - 1]) : null);
    var fronts = [];
    i = 0;
    while (i < d.length) {
      if (d[i] === null || Math.abs(d[i]) < 60) { i++; continue; }
      var sgn = Math.sign(d[i]), tot = d[i], k = i + 1;
      // un appareil qui démarre en cours de minute s'étale sur 2 ou 3 minutes : on cumule
      while (k < d.length && k - i < 3 && d[k] !== null && Math.sign(d[k]) === sgn && Math.abs(d[k]) >= 60) { tot += d[k]; k++; }
      if (Math.abs(tot) >= SEUIL_W) fronts.push({ t: ts[i + 1], m: tot });
      i = k;
    }
    var cycles = [], pris = new Set();
    fronts.forEach(function (on, a) {
      if (on.m <= 0) return;
      for (var b = a + 1; b < fronts.length; b++) {
        var off = fronts[b];
        if (off.t - on.t > 8 * 3600) break;
        if (off.m >= 0 || pris.has(b)) continue;
        var r = -off.m / on.m;
        if (r > 0.75 && r < 1.33) {
          var p = (on.m - off.m) / 2;
          // la puissance doit rester élevée pendant tout le cycle, sinon ce n'est pas le même appareil
          var base = S.P.get(on.t - 60) || 0, haut = 0, tot = 0;
          for (var tt = on.t; tt < off.t; tt += 60) { tot++; if ((S.P.get(tt) || 0) >= base + 0.5 * p) haut++; }
          if (!tot || haut / tot < 0.8) continue;
          pris.add(b);
          var paye = 0;
          for (var t = on.t; t < off.t; t += 60) paye += Math.min(p, S.A.get(t) || 0) / 60000; // kWh achetés au réseau
          cycles.push({ t: on.t, dur: (off.t - on.t) / 60, p: p, paye: paye });
          break;
        }
      }
    });
    return cycles;
  }

  function regrouper(cycles, jours) {
    cycles.sort(function (a, b) { return a.p - b.p; });
    var groupes = [];
    cycles.forEach(function (c) {
      var g = groupes.find(function (g) { return Math.abs(c.p - g.p) / g.p < 0.2 && Math.abs(Math.log(c.dur / g.dur)) < Math.log(2.2); });
      if (!g) { g = { p: c.p, dur: c.dur, items: [] }; groupes.push(g); }
      g.items.push(c);
      g.p = moy(g.items.map(function (x) { return x.p; }));
      g.dur = med(g.items.map(function (x) { return x.dur; }));
    });
    return groupes.filter(function (g) { return g.items.length >= 3; })
      .map(function (g) { return statsGroupe(g, jours); })
      .sort(function (a, b) { return b.kwhJour - a.kwhJour; });
  }

  function statsGroupe(g, jours) {
    var it = g.items.sort(function (a, b) { return a.t - b.t; });
    var p = med(it.map(function (x) { return x.p; })), dur = med(it.map(function (x) { return x.dur; }));
    var ints = [];
    for (var i = 1; i < it.length; i++) ints.push((it[i].t - it[i - 1].t) / 60);
    // régulier si la plupart des écarts sont des multiples de l'écart habituel (un cycle manqué double l'écart)
    // rythme habituel : l'écart dont le plus de cycles sont des multiples (robuste aux cycles manqués ou parasites)
    function score(c) { return ints.filter(function (x) { var k = Math.round(x / c); return k >= 1 && k <= 4 && Math.abs(x - k * c) <= 0.2 * c; }).length; }
    var mi = med(ints), okInt = ints.length ? score(mi) : 0;
    ints.forEach(function (c) { if (c >= 5) { var sc = score(c); if (sc > okInt || (sc === okInt && c > mi)) { okInt = sc; mi = c; } } });
    var regulier = ints.length >= 2 && mi > 0 && okInt / ints.length >= 0.7;
    var heures = [], kwh = 0, paye = 0, payeHP = 0, cout = 0;
    for (var h = 0; h < 24; h++) heures.push(0);
    it.forEach(function (c) {
      var dt = new Date(c.t * 1000), hc = isHC(hourFrac(dt));
      heures[dt.getHours()]++;
      kwh += c.p * c.dur / 60000;
      paye += c.paye;
      if (!hc) payeHP += c.paye;
      if (prixOk()) cout += c.paye * (hc ? cfg.hc : cfg.hp);
    });
    return {
      p: p, dur: dur, n: it.length, parJour: it.length / jours, intervalle: mi,
      regulier: regulier, heures: heures,
      kwhJour: kwh / jours, partSolaire: kwh > 0 ? 1 - paye / kwh : 0,
      partHPpaye: kwh > 0 ? payeHP / kwh : 0,
      coutMois: cout / jours * 30.4,
      gainMois: prixOk() ? payeHP / jours * 30.4 * (cfg.hp - cfg.hc) : 0,
      sig: signature(p, dur)
    };
  }

  function devine(s) {
    var p = s.p, d = s.dur, n = s.parJour, m = new Date().getMonth() + 1, saisonChauffe = m >= 10 || m <= 4;
    if (p < 350 && d <= 60 && n >= 6) return 'Réfrigérateur ou congélateur';
    if (p >= 350 && p < 1000 && d >= 45) return 'Chauffe-eau thermodynamique (compresseur)';
    if (p >= 1000 && d <= 12 && !s.regulier) return 'Four, plaques ou bouilloire';
    if (p >= 700 && saisonChauffe && n >= 6 && d <= 60) return 'Pompe à chaleur Ecodan (cycles de chauffe)';
    if (p >= 1500 && p <= 2800 && d > 12 && d <= 40 && !s.regulier && n <= 3) return 'Lave-linge ou lave-vaisselle (chauffe de l\'eau)';
    if (p >= 1000 && d >= 60 && n <= 2.5) return 'Chauffe-eau (appoint électrique) ou chauffage du jacuzzi';
    if (p >= 1500 && p <= 3500 && s.regulier) return 'Jacuzzi (chauffage ou filtration)';
    if (p >= 700 && saisonChauffe && n >= 4) return 'Pompe à chaleur Ecodan (cycles de chauffe)';
    return 'Appareil non identifié';
  }

  function conseilAppareil(s, hyp) {
    if (/^Pompe/.test(hyp)) return 'Cycles pilotés par le thermostat. Piste : monter un peu la consigne pendant le soleil et les heures creuses (13h50-16h50) pour stocker la chaleur dans la dalle du plancher chauffant, et la baisser en soirée.';
    if (s.partSolaire >= 0.7) return 'Déjà bien calé sur le soleil : ' + pct(s.partSolaire) + ' % de son énergie vient des panneaux.';
    if (s.gainMois >= 1) return 'Tourne surtout en heures pleines sur le réseau. Le programmer entre 13h50 et 16h50 (heures creuses + soleil) ferait gagner au moins ' + eur.format(s.gainMois) + ' par mois.';
    if (s.regulier && s.p < 350) return 'Cycles réguliers typiques d\'un appareil de froid. Si les cycles s\'allongent avec le temps : joints ou dégivrage à vérifier.';
    return pct(s.partSolaire) + ' % de son énergie vient des panneaux. Le faire tourner quand la jauge indique un surplus réduirait son coût.';
  }

  function histo(heures) {
    var max = Math.max.apply(null, heures) || 1;
    return '<div class="hist" aria-hidden="true">' + heures.map(function (v, h) {
      return '<span class="' + (isHC(h + 0.5) ? 'hc' : '') + '"><i style="height:' + Math.round(v / max * 100) + '%"></i></span>';
    }).join('') + '</div><div class="hist-axe"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>24h</span></div>';
  }

  function renderAppareils(liste, jours) {
    var el = document.getElementById('appList');
    if (!liste.length) {
      el.innerHTML = '<p class="tile-note">Aucun appareil récurrent repéré sur ' + nf0.format(jours) + ' jour(s). Il faut en général au moins une semaine de mesures pour que les cycles ressortent.</p>';
      return;
    }
    el.innerHTML = liste.map(function (s) {
      var nom = nomPour(s.sig), hyp = devine(s);
      return '<div class="app-card">' +
        '<div class="app-head"><div><div class="app-nom">' + (nom || hyp) + '</div>' +
          '<div class="tile-note">' + (nom ? 'Hypothèse automatique : ' + hyp : 'Hypothèse, à confirmer') + '</div></div>' +
          '<button class="link" data-renommer="' + s.sig + '">' + (nom ? 'Renommer' : 'C\'est quoi ?') + '</button></div>' +
        '<div class="app-stats"><span><b>' + kw(s.p) + ' kW</b> pendant <b>' + fmtDuree(s.dur) + '</b></span>' +
          '<span><b>' + nf1.format(s.parJour) + '</b> fois par jour</span>' +
          (s.n > 1 ? '<span>toutes les <b>' + fmtDuree(s.intervalle) + '</b>' + (s.regulier ? ' · <span class="tag">régulier</span>' : '') + '</span>' : '') + '</div>' +
        histo(s.heures) +
        '<div class="app-foot">≈ ' + nf0.format(s.kwhJour * 30.4) + ' kWh par mois · ' + pct(s.partSolaire) + ' % solaire' +
          (prixOk() ? ' · coût réseau ≈ ' + eur.format(s.coutMois) + ' par mois' : '') + '</div>' +
        '<p class="conseil">' + conseilAppareil(s, nom || hyp) + '</p>' +
        '</div>';
    }).join('') + '<p class="tile-note">Démarrages et arrêts de même puissance repérés minute par minute (hors borne voitures). Les barres montrent les heures de démarrage ; zones grisées = heures creuses.</p>';
    el.querySelectorAll('[data-renommer]').forEach(function (b) {
      b.onclick = async function () {
        var sig = b.getAttribute('data-renommer');
        var v = window.prompt('Quel appareil est-ce ? (ex. Jacuzzi, Congélateur garage)', nomPour(sig) || '');
        if (v === null) return;
        v = v.trim().slice(0, 30);
        if (v) noms[sig] = v; else delete noms[sig];
        try { await rpc('KVS.Set', { key: 'noms', value: JSON.stringify(noms) }); }
        catch (e) { window.alert('Enregistrement impossible : trop de noms ou Shelly injoignable.'); }
        renderAppareils(liste, jours);
      };
    });
  }

  async function analyserAppareils() {
    var btn = document.getElementById('btnAnalyse'), el = document.getElementById('appList');
    btn.disabled = true;
    try {
      await chargerNoms();
      var fin = Math.floor(Date.now() / 1000);
      var debut = Math.floor(addDays(sod(new Date()), -(JOURS_ANALYSE - 1)).getTime() / 1000);
      if (state.earliest && debut < state.earliest) debut = state.earliest;
      var nbJours = Math.max(1, Math.ceil((fin - debut) / 86400));
      var S = await serieAutres(debut, fin, function (j) { el.innerHTML = '<p class="tile-note">Lecture des mesures : jour ' + j + ' sur ' + nbJours + '…</p>'; });
      var jours = Math.max(1, (fin - debut) / 86400);
      renderAppareils(regrouper(detecterCycles(S), jours), jours);
    } catch (e) {
      el.innerHTML = '<p class="msg err">Analyse impossible (' + e.message + ').</p>';
    } finally { btn.disabled = false; }
  }

  /* ---------- Paysage animé de l'en-tête (saison + course du soleil) ---------- */
  var LIEU = { lat: 45.596, lon: 5.876 }; // La Motte-Servolex
  var scene = { key: null };

  function rnd(seed) { // generateur pseudo-aleatoire reproductible
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Position du soleil (elevation et azimut en degres) - formules astronomiques simplifiees
  function positionSoleil(date) {
    var r = Math.PI / 180;
    var d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
    var g = (357.529 + 0.98560028 * d) * r;
    var q = 280.459 + 0.98564736 * d;
    var L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r;
    var e = (23.439 - 0.00000036 * d) * r;
    var ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    var dec = Math.asin(Math.sin(e) * Math.sin(L));
    var gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    var ha = ((gmst + LIEU.lon / 15) * 15 * r) - ra;
    var lat = LIEU.lat * r;
    var elev = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
    var az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
    return { elev: elev / r, az: (az / r + 360) % 360 };
  }

  function leverCoucher(date) {
    var j = sod(date), lever = null, coucher = null, prev = null;
    for (var m = 0; m <= 1440; m += 4) {
      var t = new Date(j.getTime() + m * 60000), el = positionSoleil(t).elev;
      if (prev !== null) {
        if (prev < -0.833 && el >= -0.833) lever = t;
        if (prev >= -0.833 && el < -0.833) coucher = t;
      }
      prev = el;
    }
    return { lever: lever, coucher: coucher };
  }

  function saisonDu(date) {
    var m = date.getMonth() + 1, j = date.getDate(), v = m * 100 + j;
    if (v >= 1221 || v < 320) return 'hiver';
    if (v < 621) return 'printemps';
    if (v < 923) return 'ete';
    return 'automne';
  }

  // Permet de prévisualiser : ?saison=hiver&heure=21.5
  function maintenantScene() {
    var p = new URLSearchParams(location.search), d = new Date();
    if (p.get('heure')) { var h = parseFloat(p.get('heure')); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0); }
    var s = p.get('saison');
    if (s) {
      var dates = { hiver: [0, 15], printemps: [3, 20], ete: [6, 15], automne: [9, 20] };
      if (dates[s]) d.setMonth(dates[s][0], dates[s][1]);
    }
    return d;
  }

  function mix(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    var g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    var bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  // Couleurs du ciel selon l'elevation du soleil : [elevation, haut, bas]
  var CIEL = [
    [-90, '#070b1d', '#141b38'], [-12, '#0b1230', '#1d2a55'], [-6, '#1f2f63', '#5a4c7c'],
    [-2, '#3a4f8f', '#e58a5e'], [2, '#5b84c8', '#ffb46b'], [8, '#5f9be0', '#ffd9a0'],
    [18, '#4a90dc', '#b9dcf7'], [90, '#2f7fd6', '#cfeaff']
  ];
  function couleursCiel(elev, saison) {
    for (var i = 1; i < CIEL.length; i++) {
      if (elev <= CIEL[i][0]) {
        var a = CIEL[i - 1], b = CIEL[i], t = (elev - a[0]) / (b[0] - a[0]);
        var haut = mix(a[1], b[1], t), bas = mix(a[2], b[2], t);
        if (saison === 'hiver' && elev > 0) { haut = mix(haut, '#9aa7b8', 0.3); bas = mix(bas, '#e3e8ee', 0.3); }
        return [haut, bas];
      }
    }
    return [CIEL[CIEL.length - 1][1], CIEL[CIEL.length - 1][2]];
  }

  var SOL = { ete: '#5f9e45', printemps: '#79b955', automne: '#9a8a3e', hiver: '#eef2f7' };
  var COLLINE = { ete: '#4c8a3a', printemps: '#68a84a', automne: '#8c6d34', hiver: '#dfe6ee' };

  function arbre(saison, R) {
    var s = '<g class="arbre" transform="translate(905 0)">' +
      '<path d="M-9 205 L-6 140 Q-5 128 -18 112 M-6 150 Q2 132 22 118 M-4 165 L-4 205" stroke="#5b3a24" stroke-width="10" stroke-linecap="round" fill="none"/>' +
      '<path d="M-10 206 L-6 132 L6 132 L10 206 Z" fill="#5b3a24"/>';
    if (saison === 'hiver') {
      s += '<g stroke="#5b3a24" stroke-width="4" stroke-linecap="round" fill="none">' +
        '<path d="M0 135 L-38 95 M-20 115 L-30 82 M0 135 L36 92 M20 112 L42 80 M0 132 L4 70 M2 95 L-14 72 M3 98 L18 74"/></g>' +
        '<g fill="#ffffff"><ellipse cx="-36" cy="93" rx="9" ry="3"/><ellipse cx="34" cy="90" rx="9" ry="3"/><ellipse cx="4" cy="69" rx="7" ry="3"/><ellipse cx="-29" cy="80" rx="6" ry="2.5"/><ellipse cx="41" cy="78" rx="6" ry="2.5"/></g>';
    } else {
      var feuillage = { ete: ['#2e7d32', '#388e3c', '#43a047'], printemps: ['#5aae4f', '#6cc160', '#4f9d45'],
        automne: ['#c0392b', '#e67e22', '#d35400'] }[saison];
      var blobs = [[0, 95, 48], [-34, 110, 34], [34, 110, 36], [-18, 75, 32], [20, 76, 32], [0, 120, 36]];
      blobs.forEach(function (b, i) { s += '<circle cx="' + b[0] + '" cy="' + b[1] + '" r="' + b[2] + '" fill="' + feuillage[i % 3] + '"/>'; });
      if (saison === 'printemps') {
        for (var i = 0; i < 26; i++) {
          s += '<circle cx="' + (R() * 100 - 50).toFixed(1) + '" cy="' + (60 + R() * 70).toFixed(1) + '" r="3" fill="' + (i % 2 ? '#f8bbd0' : '#ffffff') + '"/>';
        }
      }
      if (saison === 'ete') {
        for (var k = 0; k < 6; k++) s += '<circle cx="' + (R() * 80 - 40).toFixed(1) + '" cy="' + (85 + R() * 40).toFixed(1) + '" r="4" fill="#e53935"/>';
      }
    }
    return s + '</g>';
  }

  // Notre maison, dessinée d'après la photo (coordonnées de la photo, puis mise à l'échelle)
  var MAISON_T = 'translate(500 207) scale(0.2) translate(-140 -607)';
  function lattes(x1, x2, y1, y2, pas, couleur, ep) {
    var s = '';
    for (var x = x1 + pas / 2; x < x2; x += pas) s += '<rect x="' + x + '" y="' + y1 + '" width="' + ep + '" height="' + (y2 - y1) + '" fill="' + couleur + '"/>';
    return s;
  }
  function bardage(x1, x2, y1, y2, couleur, ligne) {
    var s = '<rect x="' + x1 + '" y="' + y1 + '" width="' + (x2 - x1) + '" height="' + (y2 - y1) + '" fill="' + couleur + '"/>';
    for (var y = y1 + 14; y < y2; y += 14) s += '<rect x="' + x1 + '" y="' + y + '" width="' + (x2 - x1) + '" height="2" fill="' + ligne + '"/>';
    return s;
  }
  function petitArbre(saison) {
    var c = { ete: ['#4f8f34', '#c0392b'], printemps: ['#b03a2e', '#6aa84f'], automne: ['#d35400', '#c0392b'], hiver: null }[saison];
    var s = '<rect x="790" y="530" width="8" height="80" fill="#6b4a3a"/>';
    if (!c) {
      s += '<path d="M794 535 L770 495 M794 535 L820 492 M794 540 L794 485 M782 515 L765 505 M806 512 L826 504" stroke="#6b4a3a" stroke-width="5" fill="none" stroke-linecap="round"/>' +
        '<ellipse cx="770" cy="494" rx="9" ry="4" fill="#fff"/><ellipse cx="820" cy="491" rx="9" ry="4" fill="#fff"/><ellipse cx="794" cy="484" rx="8" ry="4" fill="#fff"/>';
    } else {
      s += '<circle cx="794" cy="520" r="48" fill="' + c[0] + '"/>';
      for (var i = 0; i < 9; i++) s += '<circle cx="' + (770 + (i * 37) % 50) + '" cy="' + (490 + (i * 23) % 55) + '" r="7" fill="' + c[1] + '"/>';
    }
    return s;
  }
  function maisonSvg(saison) {
    var neige = saison === 'hiver';
    var s = '<g class="maison" transform="' + MAISON_T + '">';
    // terrasse et bacs à plantes
    s += '<rect x="215" y="265" width="150" height="70" fill="#2f3336"/>' +
      (neige ? '<rect x="215" y="258" width="150" height="10" rx="4" fill="#fff"/>'
        : '<path d="M240 265 L235 225 M245 265 L262 220 M290 265 L285 215 M300 265 L318 228 M340 265 L338 205" stroke="#4f7d3a" stroke-width="7"/>');
    // étage en bois
    s += bardage(490, 1575, 170, 335, '#c9a27e', '#b48c66');
    s += '<rect x="375" y="172" width="115" height="160" fill="#5a3d2b"/>' + lattes(375, 490, 172, 332, 18, '#8a5a3b', 9);
    s += '<rect class="fen" x="797" y="213" width="58" height="84"/><rect class="fen" x="935" y="213" width="85" height="84"/><rect class="fen" x="1320" y="213" width="190" height="84"/>';
    s += '<rect x="1413" y="213" width="4" height="84" fill="#1b1d20"/>';
    // toit à deux pans (faîtage parallèle à la façade) : on voit le pan avant
    s += '<path d="M340 172 L1665 172 L1628 52 L378 52 Z" fill="' + (neige ? '#f3f6fa' : '#4a4e52') + '"/>';
    if (!neige) for (var ty = 64; ty < 172; ty += 12) s += '<rect x="' + (378 - (ty - 52) * 0.31) + '" y="' + ty + '" width="' + (1250 + (ty - 52) * 0.62) + '" height="2" fill="#3c4044"/>';
    // 12 panneaux solaires (2 rangées de 6)
    s += '<g fill="#1d3557" stroke="#8fb3d6" stroke-width="2">';
    for (var r = 0; r < 2; r++) for (var c = 0; c < 6; c++) {
      var x0 = 690 + c * 128 - r * 10, y0 = 66 + r * 50;
      s += '<path d="M' + (x0 + 8) + ' ' + y0 + ' L' + (x0 + 128) + ' ' + y0 + ' L' + (x0 + 120) + ' ' + (y0 + 44) + ' L' + x0 + ' ' + (y0 + 44) + ' Z"' + (neige ? ' opacity="0.55"' : '') + '/>';
    }
    s += '</g>';
    // bois de la rive et chéneau
    s += '<path d="M1628 52 L1665 172 L1680 172 L1641 52 Z" fill="#8a5a3b"/><rect x="335" y="168" width="1335" height="8" fill="#3a3d40"/>';
    // rez-de-chaussée : cadre béton
    s += '<rect x="140" y="335" width="1620" height="272" fill="#cfccc4"/>';
    s += '<rect x="515" y="392" width="1120" height="215" fill="#3a3d40"/>';
    s += '<rect x="200" y="392" width="210" height="213" fill="#3c4247"/>';
    s += '<rect class="fen" x="515" y="400" width="510" height="38"/>';
    s += bardage(515, 1025, 438, 590, '#c98b4e', '#b07a42');
    s += '<rect x="1025" y="400" width="85" height="190" fill="#2e3236"/>';
    s += bardage(1110, 1282, 405, 590, '#c98b4e', '#b07a42') + '<text x="1128" y="470" font-size="26" fill="#2b2b2b" font-family="sans-serif">71</text>';
    s += '<rect x="1310" y="395" width="325" height="212" fill="#3b2a20"/>' + lattes(1310, 1635, 395, 607, 20, '#8a5a3b', 11);
    s += '<rect x="140" y="597" width="1620" height="10" fill="#bdb9b0"/>';
    if (neige) s += '<rect x="135" y="326" width="1630" height="12" rx="6" fill="#fff"/>';
    s += petitArbre(saison);
    return s + '</g>';
  }

  function construireScene(saison, jour) {
    var R = rnd(jour.getFullYear() * 400 + jour.getMonth() * 31 + jour.getDate());
    var s = '<svg viewBox="0 0 1200 240" preserveAspectRatio="xMidYMax slice" aria-hidden="true">' +
      '<defs><linearGradient id="gCiel" x1="0" y1="0" x2="0" y2="1"><stop id="cHaut" offset="0"/><stop id="cBas" offset="1"/></linearGradient>' +
      '<radialGradient id="gHalo"><stop offset="0" stop-color="#fff3c4" stop-opacity="0.9"/><stop offset="1" stop-color="#fff3c4" stop-opacity="0"/></radialGradient></defs>' +
      '<rect width="1200" height="240" fill="url(#gCiel)"/>';
    // etoiles
    s += '<g id="etoiles">';
    for (var i = 0; i < 70; i++) {
      s += '<circle class="etoile" cx="' + (R() * 1200).toFixed(0) + '" cy="' + (R() * 140).toFixed(0) + '" r="' + (0.6 + R() * 1.2).toFixed(1) +
        '" style="animation-delay:-' + (R() * 4).toFixed(1) + 's"/>';
    }
    s += '</g>';
    // lune et soleil
    s += '<g id="lune"><circle cx="1040" cy="48" r="16" fill="#f4f1de"/><circle id="luneOmbre" cx="1048" cy="43" r="14"/></g>';
    s += '<g id="soleil"><circle r="70" fill="url(#gHalo)"/><circle id="soleilDisque" r="20"/></g>';
    // nuages
    var nbNuages = saison === 'hiver' ? 6 : saison === 'automne' ? 5 : 3;
    s += '<g id="nuages">';
    for (var n = 0; n < nbNuages; n++) {
      var y = 25 + R() * 70, sc = 0.6 + R() * 0.7, dur = 90 + R() * 80;
      s += '<g class="nuage" style="animation-duration:' + dur.toFixed(0) + 's;animation-delay:-' + (R() * dur).toFixed(0) + 's">' +
        '<g transform="translate(0 ' + y.toFixed(0) + ') scale(' + sc.toFixed(2) + ')">' +
        '<ellipse cx="0" cy="0" rx="46" ry="16"/><ellipse cx="-26" cy="4" rx="28" ry="12"/><ellipse cx="28" cy="5" rx="30" ry="12"/><ellipse cx="6" cy="-10" rx="24" ry="14"/></g></g>';
    }
    s += '</g>';
    // montagnes (massifs savoyards)
    s += '<path id="montagnes" d="M0 172 L70 128 L120 150 L190 96 L250 140 L330 108 L400 150 L470 118 L540 160 L620 112 L664 128 L694 80 L706 80 L736 126 L760 124 L840 160 L930 104 L1010 146 L1080 118 L1150 150 L1200 132 L1200 240 L0 240 Z"/>';
    s += '<path id="neigeMont" d="M190 96 L172 110 L184 108 L196 114 L208 106 Z M620 112 L604 124 L616 122 L628 128 L638 120 Z M930 104 L912 118 L926 116 L938 122 L950 114 Z M330 108 L318 117 L332 116 L344 120 Z M694 80 L684 94 L696 91 L706 96 L718 89 L706 80 Z M1080 118 L1068 127 L1082 126 L1092 130 Z" fill="#ffffff" opacity="' + (saison === 'hiver' ? 1 : saison === 'ete' ? 0.35 : 0.75) + '"/>';
    // collines et sol
    s += '<path d="M0 190 Q200 160 420 185 T840 178 T1200 186 L1200 240 L0 240 Z" fill="' + COLLINE[saison] + '"/>';
    s += '<path d="M0 205 Q300 192 600 204 T1200 200 L1200 240 L0 240 Z" fill="' + SOL[saison] + '"/>';
    s += maisonSvg(saison) + arbre(saison, R);
    // particules
    s += '<g id="particules">';
    if (saison === 'hiver') {
      for (var f = 0; f < 70; f++) {
        var dF = 7 + R() * 9;
        s += '<circle class="flocon" cx="' + (R() * 1200).toFixed(0) + '" cy="-10" r="' + (1 + R() * 2.2).toFixed(1) +
          '" style="animation-duration:' + dF.toFixed(1) + 's;animation-delay:-' + (R() * dF).toFixed(1) + 's"/>';
      }
    } else if (saison === 'automne') {
      var cols = ['#c0392b', '#e67e22', '#d35400', '#f1c40f'];
      for (var l = 0; l < 16; l++) {
        var dL = 8 + R() * 8;
        s += '<path class="feuille" d="M0 0 Q5 -6 10 0 Q5 6 0 0 Z" fill="' + cols[l % 4] + '" transform="translate(' + (835 + R() * 160).toFixed(0) + ' 90)" ' +
          'style="animation-duration:' + dL.toFixed(1) + 's;animation-delay:-' + (R() * dL).toFixed(1) + 's"/>';
      }
    } else if (saison === 'printemps') {
      for (var p = 0; p < 14; p++) {
        var dP = 9 + R() * 8;
        s += '<circle class="petale" cx="' + (845 + R() * 140).toFixed(0) + '" cy="90" r="2.4" fill="#f8bbd0" ' +
          'style="animation-duration:' + dP.toFixed(1) + 's;animation-delay:-' + (R() * dP).toFixed(1) + 's"/>';
      }
    } else {
      for (var c = 0; c < 14; c++) {
        s += '<circle class="luciole" cx="' + (R() * 1200).toFixed(0) + '" cy="' + (175 + R() * 50).toFixed(0) + '" r="2" ' +
          'style="animation-delay:-' + (R() * 5).toFixed(1) + 's"/>';
      }
    }
    s += '</g>';
    s += '<rect id="nuit" width="1200" height="240" fill="#060a1f"/>';
    // fenetres allumees par-dessus la nuit
    s += '<g id="lumieres" transform="' + MAISON_T + '" fill="#ffd27a"><rect x="797" y="213" width="58" height="84"/><rect x="935" y="213" width="85" height="84"/>' +
      '<rect x="1320" y="213" width="190" height="84"/><rect x="515" y="400" width="510" height="38" opacity="0.8"/></g>';
    // croix du Nivolet, éclairée la nuit
    s += '<g id="croix"><path d="M700 81 L700 65 M694.5 69.5 L705.5 69.5" stroke-width="2.2" stroke-linecap="round" fill="none"/></g>';
    return s + '</svg>';
  }

  function majScene() {
    var el = document.getElementById('scene');
    if (!el) return;
    var now = maintenantScene(), saison = saisonDu(now);
    var key = saison + ymd(now);
    if (scene.key !== key) { el.innerHTML = construireScene(saison, now); scene.key = key; }
    var svg = el.querySelector('svg'), mobile = el.clientWidth < 640;
    svg.setAttribute('viewBox', mobile ? '435 10 400 230' : '0 0 1200 240');
    var sol = positionSoleil(now), elev = sol.elev;
    var c = couleursCiel(elev, saison);
    document.getElementById('cHaut').setAttribute('stop-color', c[0]);
    document.getElementById('cBas').setAttribute('stop-color', c[1]);
    // soleil : azimut 50 a 310 degres -> gauche a droite ; elevation -> hauteur
    var x = 120 + (Math.min(310, Math.max(50, sol.az)) - 50) / 260 * 960;
    var y = 196 - Math.max(-10, elev) / 68 * 176;
    var soleil = document.getElementById('soleil');
    soleil.setAttribute('transform', 'translate(' + x.toFixed(0) + ' ' + y.toFixed(0) + ')');
    soleil.style.opacity = elev > -3 ? 1 : 0;
    document.getElementById('soleilDisque').setAttribute('fill', mix('#ff8a3d', '#fff1b8', Math.min(1, Math.max(0, elev / 25))));
    var obscur = Math.min(1, Math.max(0, (4 - elev) / 14)); // 0 en plein jour, 1 la nuit
    document.getElementById('nuit').style.opacity = (obscur * 0.55).toFixed(2);
    document.getElementById('etoiles').style.opacity = Math.max(0, (obscur - 0.5) * 2).toFixed(2);
    document.getElementById('lune').style.opacity = obscur > 0.7 ? 1 : 0;
    document.getElementById('luneOmbre').setAttribute('fill', c[0]);
    document.getElementById('montagnes').setAttribute('fill', mix(saison === 'hiver' ? '#8796ab' : '#6f86a3', c[0], 0.25));
    document.querySelectorAll('#nuages ellipse').forEach(function (n) { n.setAttribute('fill', obscur > 0.6 ? '#39426a' : saison === 'hiver' ? '#e4e8ee' : '#ffffff'); });
    document.querySelectorAll('.fen').forEach(function (f) { f.setAttribute('fill', '#2b2f33'); });
    var croix = document.querySelector('#croix path');
    croix.setAttribute('stroke', obscur > 0.5 ? '#fff4c2' : '#f5f5f5');
    croix.style.filter = obscur > 0.5 ? 'drop-shadow(0 0 3px #ffe9a0)' : 'none';
    document.getElementById('lumieres').style.opacity = obscur > 0.5 ? 1 : 0;
    document.querySelectorAll('.luciole').forEach(function (f) { f.style.display = obscur > 0.7 ? '' : 'none'; });
    var hero = document.querySelector('.hero');
    hero.classList.toggle('sombre', obscur > 0.45);
    var lc = leverCoucher(now);
    var noms = { hiver: 'Hiver', printemps: 'Printemps', ete: 'Été', automne: 'Automne' };
    document.getElementById('sceneInfo').textContent = noms[saison] +
      (lc.lever && lc.coucher ? ' · lever ' + fmtHeure.format(lc.lever) + ' · coucher ' + fmtHeure.format(lc.coucher) : '');
  }

  /* ---------- demarrage ---------- */
  async function init() {
    squelette();
    try { majScene(); } catch (e) { /* le paysage est decoratif */ }
    setInterval(function () { try { majScene(); } catch (e) { } }, 60000);
    window.addEventListener('resize', function () { try { majScene(); } catch (e) { } });
    await chargerCfg();
    chargerLive();
    await chargerEarliest();
    majBornesCalendrier();
    await chargerPeriode();
    demarrerLive();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { chargerLive(); chargerPeriode(); }
  });

  init();
})();
