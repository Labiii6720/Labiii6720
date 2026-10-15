"use strict";
/* =========================================================================
   Kommandozentrale – Skript (CSP: script-src 'self', kein Inline-Code).
   Alle Werte vom Server sind fremd (Auftragstexte stammen von Claude, Namen aus
   Dateien): DOM nur über createElement + textContent, Aktionen nur über
   data-*-Attribute und Event-Delegation. Kein innerHTML.
   ========================================================================= */
(() => {
  const TZ = "Europe/Zurich";
  const MIN = 60000, STD = 3600000;
  const $ = (id) => document.getElementById(id);

  /* ---------- Speicher: im privaten Modus kann jeder Zugriff werfen ---------- */
  // Eigener Schlüssel: /gesture (gleicher Ursprung) legt seine Felder ungefragt unter «jarvis.<feld>» ab, also auch «jarvis.token»
  const TOKEN_KEY = "jarvis.kommandozentrale.token";
  const ALT_SITZUNG = "jarvis.token"; // Sitzungsspeicher der Kommandozentrale vor diesem Schlüssel; localStorage dort gehört /gesture
  const KONSOLE_KEY = "jarvis.token"; // Feld «token» der Gesten-Konsole (localStorage)
  function lies(art, k) { try { return window[art].getItem(k); } catch { return null; } }
  function schreib(art, k, v) { try { window[art].setItem(k, v); return true; } catch { return false; } }
  function entferne(art, k) { try { window[art].removeItem(k); } catch { /* nichts zu tun */ } }

  /* ---------- DOM-Helfer (nur createElement/textContent) ---------- */
  function h(tag, attrs, ...kinder) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kinder.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }
  const NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kinder) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
    for (const k of kinder.flat(Infinity)) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }
  function ikon(name, klein, extra) {
    const svg = s("svg", { class: "i" + (klein ? " s" : "") + (extra ? " " + extra : ""), "aria-hidden": "true" });
    svg.append(s("use", { href: "#i-" + name }));
    return svg;
  }

  /* ---------- Formatierer (de-CH, Europe/Zurich) ---------- */
  let versatz = 0; // Serverzeit minus Browserzeit: relative Zeiten stimmen auch bei falsch gehender Uhr im Gerät
  const jetzt = () => new Date(Date.now() + versatz);
  const f2 = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const f0 = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 0 });
  const istZahl = (n) => typeof n === "number" && Number.isFinite(n);
  const geld = (b, w) => (istZahl(b) ? f2.format(b) : "–") + " " + w;
  const ganz = (n) => (istZahl(n) ? f0.format(n) : "–");
  function alsDatum(x) {
    if (x == null || x === "") return null;
    const d = typeof x === "number" ? new Date(x) : new Date(/^\d{4}-\d{2}-\d{2}$/.test(x) ? x + "T12:00:00Z" : x);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const isoTag = (d) => d.toLocaleDateString("sv-SE", { timeZone: TZ });
  /** Kalendertag n Tage neben «YYYY-MM-DD» – nicht ±24 h: an den Umstellungstagen hat ein Tag 23 oder 25 Stunden */
  const nachbar = (iso, n) => { const [j, m, t] = iso.split("-").map(Number); return new Date(Date.UTC(j, m - 1, t + n, 12)).toISOString().slice(0, 10); };
  const heuteTag = () => isoTag(jetzt());
  const datum = (x) => { const d = alsDatum(x); return d ? d.toLocaleDateString("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }) : String(x ?? ""); };
  const datumKurz = (x) => { const d = alsDatum(x); return d ? d.toLocaleDateString("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit" }).replace(/\.?$/, ".") : ""; };
  const zeit = (x) => { const d = alsDatum(x); return d ? d.toLocaleTimeString("de-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) : "–"; };
  const stunde = () => Number(jetzt().toLocaleTimeString("de-CH", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).slice(0, 2));
  function dauer(x) {
    const d = alsDatum(x);
    if (!d) return "–";
    const m = Math.max(1, Math.round((jetzt() - d) / MIN));
    if (m < 60) return m + " Min";
    const st = Math.round(m / 60);
    if (st < 48) return st + " Std";
    return Math.round(st / 24) + " Tagen";
  }
  const seit = (x) => "seit " + dauer(x);
  const vorZeit = (x) => "vor " + dauer(x);
  const MONATE_LANG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const ZAHLWORT = ["Nichts", "Eine Sache", "Zwei Dinge", "Drei Dinge", "Vier Dinge", "Fünf Dinge"];
  function tagName(x) {
    const d = alsDatum(x); if (!d) return "Unbekannt";
    const t = isoTag(d), heute = heuteTag(), gestern = nachbar(heute, -1);
    if (t === heute) return "Heute · " + datum(t);
    if (t === gestern) return "Gestern · " + datum(t);
    return alsDatum(t).toLocaleDateString("de-CH", { timeZone: TZ, weekday: "long" }) + " · " + datum(t);
  }
  /** «heute», «morgen» oder «Sa 17.10.» für einen kommenden Zeitpunkt */
  function wannTag(x) {
    const d = alsDatum(x); if (!d) return "–";
    const t = isoTag(d), heute = heuteTag(), morgen = nachbar(heute, 1);
    if (t === heute) return "heute";
    if (t === morgen) return "morgen";
    return d.toLocaleDateString("de-CH", { timeZone: TZ, weekday: "short" }).replace(".", "") + " " + datumKurz(d);
  }
  function gruss() {
    const st = stunde();
    return st >= 5 && st < 11 ? "Guten Morgen, Sir." : st >= 11 && st < 18 ? "Guten Tag, Sir." : "Guten Abend, Sir.";
  }
  /** Servertexte ohne führendes Emoji (Telegram-Stil) und gekürzt: Jarvis spricht hier ohne Symbole. */
  function ohneSymbol(t, max = 220) {
    const x = String(t ?? "").replace(/^[\p{Extended_Pictographic}️‍\s]+/u, "").trim();
    return x.length > max ? x.slice(0, max - 1) + "…" : x;
  }
  function summeText(summe) {
    const w = Object.keys(summe || {}).sort((a, b) => (a === "CHF" ? -1 : b === "CHF" ? 1 : a.localeCompare(b)));
    return w.length ? w.map((k) => geld(summe[k], k)).join(" · ") : "–";
  }

  /* ---------- API ---------- */
  let token = null;
  let angemeldet = false;
  async function api(pfad, opt = {}) {
    if (!token) return { status: 401, daten: null };
    const headers = { Authorization: "Bearer " + token, Accept: opt.bild ? "image/jpeg" : "application/json" };
    const init = { method: opt.methode || "GET", headers, cache: "no-store", credentials: "omit" };
    if (opt.body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opt.body); }
    // Zeitlimit: eine angenommene, nie beantwortete Anfrage (WLAN-Wechsel, alter Socket) hielte sonst den Status-Takt an.
    // Lesen 15 s; Aktionen warten serverseitig länger (Telegram-Versand mit Wiederholung), Gespräch bis 60 s → opt.frist.
    const frist = opt.frist ?? (init.method === "GET" ? 15000 : 120000);
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(frist);
    let res;
    // Zeitlimit getrennt vom Netzfehler: eine lange Aktion (Slicer, Upload) läuft im Dienst weiter, er ist nicht weg
    try { res = await fetch(pfad, init); } catch (e) { return { status: 0, daten: null, zeitlimit: Boolean(e && e.name === "TimeoutError") }; }
    // Kamerabild: als Blob (der Token geht nur als Header mit, deshalb kein <img src> auf die API)
    if (opt.bild && res.ok) { try { return { status: res.status, daten: null, bild: await res.blob() }; } catch { return { status: 0, daten: null }; } }
    let daten = null;
    try { daten = await res.json(); } catch { daten = null; }
    if (res.status === 401 && angemeldet) abgewiesen();
    return { status: res.status, daten };
  }
  /** lang: Text für ein abgelaufenes Zeitlimit (die Aktion läuft im Dienst weiter) */
  function fehlerText(r, rueckfall, lang) {
    if (r.daten && typeof r.daten.text === "string" && r.daten.text) return ohneSymbol(r.daten.text);
    if (r.status === 0 && r.zeitlimit) return lang || "Das dauert länger, Sir. Es läuft weiter; den Stand sehen Sie gleich hier.";
    if (r.status === 0) return "Ich erreiche den Dienst nicht, Sir.";
    if (r.status === 423) return "Im Notfall gesperrt, Sir. Erst /entwarnung in Telegram.";
    return (rueckfall || "Das hat nicht geklappt") + " (HTTP " + r.status + "), Sir.";
  }

  /* ---------- Zustand und Datenquellen ---------- */
  /** Quellen der Bereiche; jede wird beim Öffnen ihres Bereichs und dann alle 60 s geholt. */
  const QUELLEN = {
    auftraege: "/api/auftraege?status=alle&stufe=alle&limit=200",
    kosten14: "/api/kosten?tage=14",
    kosten: () => "/api/kosten?tage=" + kTage,
    finanzen: "/api/finanzen",
    zeitplaene: "/api/zeitplaene",
    wachen: "/api/wachen",
    audit: "/api/audit",
  };
  const pfadVon = (name) => (typeof QUELLEN[name] === "function" ? QUELLEN[name]() : QUELLEN[name]);
  /** Zeitraum der Kosten-Ansicht (7/30/90 Tage) */
  let kTage = 30;
  /** Für Zähler an den Reitern immer mitholen. */
  const IMMER = ["finanzen"];
  /** Q.status: letzte /status.json; Q.<quelle>: { daten } oder { fehler, text } (letzte gute Daten bleiben bei Netzfehlern stehen). */
  const Q = { status: null };
  const fehler = { status: false, quellen: new Set() };
  const inArbeit = new Set();
  /** Steigt bei jedem Leeren: Antworten auf vorher gestartete Abfragen füllen den Speicher nicht wieder */
  let quellenGen = 0;
  /**
   * Laufende Nummer je Quelle (und für /status.json): Antworten kommen nicht in Startreihenfolge an (Takt, Bereichswechsel,
   * Neuladen nach dem Speichern). Eine Antwort, die vor der zuletzt übernommenen gestartet wurde, ist veraltet und wird
   * verworfen – sonst stellte eine langsame, ältere Antwort den alten Stand bis zum nächsten Takt wieder her.
   */
  const abfrage = { gestartet: {}, uebernommen: {} };
  const abfrageStart = (k) => (abfrage.gestartet[k] = (abfrage.gestartet[k] || 0) + 1);
  /** true, wenn die Antwort zur Abfrage nr übernommen werden darf (und merkt sie dann als neueste) */
  function abfrageNeu(k, nr) {
    if (nr < (abfrage.uebernommen[k] || 0)) return false;
    abfrage.uebernommen[k] = nr;
    return true;
  }
  let aktuell = "uebersicht";
  let letzteSig = {};

  /** Alle Inhalte aus dem Speicher: Quellen, Kamerabilder, Gesprächsverlauf, letzte Ansage und Toast (Notfall, Entwarnung, Abmelden) */
  function leereQuellen() {
    quellenGen++;
    for (const k of Object.keys(QUELLEN)) delete Q[k];
    fehler.quellen.clear();
    letzteSig = {};
    bilderLeeren();
    gespraech.verlauf = []; gespraech.laeuft = false; gespraech.entwurf = ""; gespraech.gen++;
    rueckmeldungLeeren();
    // Verborgene Bereiche behalten sonst ihren letzten Aufbau (etwa den Gesprächsverlauf); der sichtbare zeichnet gleich neu
    for (const k of Object.keys(BEREICHE)) if (k !== aktuell) V(k).replaceChildren();
  }

  async function holeQuelle(name) {
    const pfad = pfadVon(name);
    const gen = quellenGen;
    const nr = abfrageStart(name);
    const r = await api(pfad);
    // Abgemeldet, inzwischen geleert (Notfall, Entwarnung) oder im Notfall: die Antwort kommt nicht mehr in den Speicher
    if (!angemeldet || gen !== quellenGen || (Q.status && Q.status.notfall)) return;
    if (pfadVon(name) !== pfad) return; // Zeitraum inzwischen gewechselt: alte Antwort verwerfen
    if (!abfrageNeu(name, nr)) return; // eine neuere Antwort steht schon im Speicher
    if (r.status === 200 && r.daten && r.daten.ok) { Q[name] = { daten: r.daten }; fehler.quellen.delete(name); }
    else if (r.status === 0 || (r.status >= 500 && r.status !== 503)) fehler.quellen.add(name);
    else if (r.status !== 401) { Q[name] = { fehler: r.status, text: r.daten && typeof r.daten.text === "string" ? r.daten.text : "" }; fehler.quellen.delete(name); }
  }

  function uebernehmeStatus(d) {
    const t = Date.parse(d.zeit);
    if (Number.isFinite(t)) versatz = t - Date.now();
    const vorher = Q.status ? Boolean(Q.status.notfall) : null;
    Q.status = d;
    if (vorher !== null && vorher !== Boolean(d.notfall)) {
      // Notfall: keine Inhalte im Speicher behalten. Entwarnung: alles neu aufbauen.
      leereQuellen();
      if (!d.notfall) void holeBereich();
    }
    // Ein offenes Modal liegt über der gesperrten Seite: es darf keine Inhalte mehr zeigen
    if (d.notfall && vorher !== true) dialogeLeeren();
  }

  async function holeStatus() {
    const nr = abfrageStart("/status.json");
    const r = await api("/status.json");
    if (!angemeldet || !abfrageNeu("/status.json", nr)) return;
    if (r.status === 200 && r.daten && r.daten.ok) { fehler.status = false; uebernehmeStatus(r.daten); }
    else if (r.status !== 401) fehler.status = true;
    stoerungZeigen();
    rendern();
  }

  /** Quellen des sichtbaren Bereichs. Fehler anderer Quellen zählen nicht: sie werden hier nicht mehr geholt, also nie gelöscht. */
  const sichtbareQuellen = () => new Set([...IMMER, ...BEREICHE[aktuell].quellen]);
  function fremdeFehlerWeg() {
    const namen = sichtbareQuellen();
    for (const q of [...fehler.quellen]) if (!namen.has(q)) fehler.quellen.delete(q);
    return namen;
  }

  async function holeBereich() {
    if (!angemeldet) return;
    if (Q.status && Q.status.notfall) { rendern(); return; }
    const namen = fremdeFehlerWeg();
    await Promise.all([...namen].map(holeQuelle));
    stoerungZeigen();
    rendern();
  }

  /* ---------- Abfrage-Takt: Status 5 s, Bereich 60 s, Pause im Hintergrund ---------- */
  let tStatus = 0, tBereich = 0, tKamera = 0, lauf = 0;
  function stopp() { clearTimeout(tStatus); clearTimeout(tBereich); clearTimeout(tKamera); lauf++; }
  function zyklen() {
    stopp();
    if (!angemeldet || document.hidden) return;
    const n = lauf;
    const statusZyklus = async () => { await holeStatus(); if (n === lauf && angemeldet) tStatus = setTimeout(statusZyklus, 5000); };
    const bereichZyklus = async () => { await holeBereich(); if (n === lauf && angemeldet) tBereich = setTimeout(bereichZyklus, 60000); };
    // Standbilder nur, solange der Bereich Kameras offen ist (route() und visibilitychange starten neu)
    const kameraZyklus = async () => { if (n !== lauf) return; await kameraRunde(); if (n === lauf && angemeldet) tKamera = setTimeout(kameraZyklus, 15000); };
    const erster = statusZyklus();
    void bereichZyklus();
    if (aktuell === "kameras") void erster.then(kameraZyklus);
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopp(); else if (angemeldet) zyklen(); });

  let stoerungAn = false;
  /**
   * Störungsanzeige im Kopf; jeder Wechsel wird hörbar angesagt (ansageAktiv: auch bei offenem Dialog, der den Kopf inert macht).
   * nurBereich: der Wechsel kommt nur vom Bereichswechsel (die gestörte Quelle ist nicht mehr sichtbar) – dann kein «wieder da».
   */
  function stoerungZeigen(nurBereich) {
    const namen = sichtbareQuellen();
    const an = fehler.status || [...fehler.quellen].some((q) => namen.has(q));
    if (an === stoerungAn) return; // nur Wechsel anfassen: kein Flackern, beim Start kein falsches «wieder da»
    stoerungAn = an;
    $("stoerung").hidden = !an;
    $("main").classList.toggle("halten", an);
    // Abgemeldet (Token weg) oder nur der Bereich gewechselt: nichts ansagen
    if (!token || (!an && nurBereich)) return;
    ansageAktiv(an ? "Verbindung gestört, Sir. Ich zeige den letzten Stand." : "Verbindung wieder da, Sir.");
  }

  /* ---------- Anmelden und Abmelden ---------- */
  function feldFehler(gr, text) {
    const el = gr.querySelector(".fehler");
    gr.classList.toggle("ungueltig", Boolean(text));
    if (el) { el.hidden = !text; el.replaceChildren(...(text ? [ikon("warn", true), text] : [])); }
    gr.querySelectorAll(".feld, .wahl").forEach((x) => { if (text) x.setAttribute("aria-invalid", "true"); else x.removeAttribute("aria-invalid"); });
  }

  /** Alle Dialoge ausser der Anmeldung zu und ihre Felder leer (Notfall, Abmelden): Auftragstexte, Fragen und Namen bleiben nicht im DOM */
  function dialogeLeeren() {
    document.querySelectorAll("dialog").forEach((d) => {
      if (d.id === "dlgAnmelden") return;
      if (d.open) d.close("abbruch");
      const a = dlgAnsage.get(d);
      if (a) a.textContent = "";
    });
    for (const f of ["planForm", "wacheForm", "pinForm"]) $(f).reset();
    fehlerZeigen($("planForm"), {});
    fehlerZeigen($("wacheForm"), {});
    feldFehler($("pinGr"), "");
    zaehler();
    $("wKamera").replaceChildren();
    for (const id of ["pinText", "pinHilfeText", "frageTitel", "frageText", "bildTitel", "bildStand"]) $(id).textContent = "";
    planId = null; wacheId = null; pinSenden = null;
  }

  function anmeldenZeigen(meldung) {
    angemeldet = false;
    stopp();
    document.body.classList.add("abgemeldet");
    dialogeLeeren();
    $("anmTitel").textContent = gruss();
    $("anmToken").value = "";
    $("anmMerken").checked = lies("localStorage", TOKEN_KEY) !== null;
    feldFehler($("anmGr"), meldung || "");
    const d = $("dlgAnmelden");
    if (!d.open) { d.showModal(); toastNachOben(); }
    $("anmToken").focus();
  }
  // Ohne Token gibt es nichts hinter dem Dialog: Esc schliesst ihn nicht
  $("dlgAnmelden").addEventListener("cancel", (e) => { if (!angemeldet) e.preventDefault(); });
  // Chromium lässt preventDefault beim zweiten Esc ohne neue Nutzeraktivierung nicht mehr gelten: dann sofort wieder öffnen
  $("dlgAnmelden").addEventListener("close", () => {
    if (angemeldet) return;
    requestAnimationFrame(() => {
      const d = $("dlgAnmelden");
      if (angemeldet || d.open) return;
      d.showModal();
      $("anmToken").focus();
    });
  });

  $("anmForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = $("anmToken").value.trim();
    if (!t) { feldFehler($("anmGr"), "Ohne Token geht es nicht, Sir."); $("anmToken").focus(); return; }
    const knopf = $("anmOk");
    knopf.disabled = true;
    token = t;
    const r = await api("/status.json");
    knopf.disabled = false;
    if (r.status === 200 && r.daten && r.daten.ok) {
      schreib("sessionStorage", TOKEN_KEY, t);
      if ($("anmMerken").checked) schreib("localStorage", TOKEN_KEY, t); else entferne("localStorage", TOKEN_KEY);
      $("anmToken").value = "";
      $("dlgAnmelden").close("ok");
      starten(r.daten);
      return;
    }
    token = null;
    feldFehler($("anmGr"), r.status === 401 ? "Diesen Token kenne ich nicht, Sir." : r.status === 0 ? "Ich erreiche den Dienst nicht, Sir." : "Das hat nicht geklappt (HTTP " + r.status + "), Sir.");
    $("anmToken").select();
    $("anmToken").focus();
  });

  function tokenVergessen() {
    token = null;
    entferne("sessionStorage", TOKEN_KEY);
    entferne("localStorage", TOKEN_KEY);
    entferne("sessionStorage", ALT_SITZUNG);
    entferne("localStorage", "jarvis.dash"); // Speicherort der Übergangsseite vor 0.22
  }
  function allesLeeren() {
    Q.status = null;
    leereQuellen();
    inArbeit.clear();
    for (const k of Object.keys(BEREICHE)) V(k).replaceChildren();
    fehler.status = false;
    stoerungZeigen();
  }
  /** 401 während der Sitzung: einmal zur Anmeldung, keine Schleife (Abfragen stehen, bis ein neuer Token gilt). */
  function abgewiesen() {
    tokenVergessen();
    allesLeeren();
    anmeldenZeigen("Der Token gilt nicht mehr, Sir. Bitte neu anmelden.");
  }
  function abmelden() {
    const alt = token;
    tokenVergessen();
    // /gesture legt denselben Token ungefragt unter «jarvis.token» ab (ebenso «merken» im Zwischenstand von 0.22).
    // Abmelden heisst «aus diesem Browser»: diese Kopie geht mit; einen anderen Wert der Gesten-Konsole lasse ich stehen.
    const kopie = (art, k) => Boolean(alt) && lies(art, k) === alt;
    if (kopie("localStorage", KONSOLE_KEY)) entferne("localStorage", KONSOLE_KEY);
    const bleibt = [["sessionStorage", TOKEN_KEY], ["localStorage", TOKEN_KEY], ["sessionStorage", ALT_SITZUNG], ["localStorage", KONSOLE_KEY]].some(([art, k]) => kopie(art, k));
    allesLeeren();
    anmeldenZeigen("");
    toast(bleibt ? "Abgemeldet, Sir. Den Token konnte ich in diesem Browser nicht löschen – bitte die Websitedaten löschen."
      : "Abgemeldet, Sir. Der Token ist aus diesem Browser gelöscht.");
  }

  function starten(status) {
    angemeldet = true;
    document.body.classList.remove("abgemeldet");
    if (status) uebernehmeStatus(status);
    uhr();
    route();
  }

  /* ---------- Dialoge: native Fokusfalle und Esc; Fokus kehrt zurück ---------- */
  function schluessel(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.dataset.merk) return "m:" + el.dataset.merk;
    if (el.id) return "#" + el.id;
    if (el.dataset.aktion) return "a:" + el.dataset.aktion + ":" + (el.dataset.id ?? el.dataset.name ?? "");
    if (el.dataset.modus) return "modus:" + el.dataset.modus;
    if (el.dataset.fstatus) return "fs:" + el.dataset.fstatus;
    return null;
  }
  function findeSchluessel(wurzel, key) {
    if (!key) return null;
    for (const el of wurzel.querySelectorAll("[data-merk],[id],[data-aktion],[data-modus],[data-fstatus]")) {
      if (schluessel(el) === key && el.getClientRects().length) return el;
    }
    return null;
  }
  /**
   * Ersatz für den Auslöser eines Dialogs, beim Öffnen gemerkt: erst die Nachbarn in seiner Karte, dann die übrigen im Bereich,
   * die nächsten zuerst (bei Gleichstand der vorherige). Greift, wenn der Auslöser beim Schliessen gesperrt oder weg ist.
   */
  function dialogErsatz(el) {
    if (!(el instanceof Element)) return [];
    const keys = ersatzSchluessel(el);
    const view = el.closest(".view");
    if (view) {
      const alle = [...view.querySelectorAll(FOKUSSIERBAR)];
      const i = alle.indexOf(el);
      if (i >= 0) for (let n = 1; n < alle.length; n++) for (const x of [alle[i - n], alle[i + n]]) if (x) keys.push(schluessel(x));
    }
    return [...new Set(keys.filter(Boolean))];
  }
  function zeigeDialog(d, fokus) {
    const vorher = document.activeElement;
    d._vorher = vorher;
    d._vorherKey = schluessel(vorher);
    d._ersatz = dialogErsatz(vorher);
    d.returnValue = "";
    d.showModal();
    toastNachOben();
    if (fokus) fokus.focus();
  }
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("close", () => {
    // Ein Toast, der für diesen Dialog nach oben ausgewichen ist, verdeckte sonst die Leiste samt Notaus: Lage neu bestimmen
    toastLage();
    const v = d._vorher;
    const ersatz = d._ersatz || [];
    d._vorher = null; d._ersatz = null;
    if (!angemeldet && d.id !== "dlgAnmelden") return;
    const ziel = v && v.isConnected && v.getClientRects().length ? v : findeSchluessel(document, d._vorherKey);
    if (ziel) ziel.focus({ preventScroll: true });
    if (ziel && document.activeElement === ziel) return;
    // Auslöser weg oder gesperrt (etwa «Mit PIN fortsetzen» nach dem Fortsetzen): Nachbar, sonst main – nie <body>
    if (!angemeldet || d.id === "dlgAnmelden" || !(v instanceof Element) || v === document.body) return;
    const nachbar = ersatz.map((k) => findeSchluessel(document, k)).find((el) => { if (!el) return false; el.focus({ preventScroll: true }); return document.activeElement === el; });
    if (!nachbar) $("main").focus({ preventScroll: true });
    insBild(nachbar || $("main"));
  }));

  function frage(titel, text, okText, gefahr) {
    const d = $("dlgFrage");
    $("frageTitel").textContent = titel;
    $("frageText").textContent = text;
    const ok = $("frageOk");
    ok.textContent = okText;
    ok.className = "knopf " + (gefahr ? "gefahr-voll" : "prim");
    return new Promise((res) => {
      d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true });
      zeigeDialog(d);
    });
  }

  let pinSenden = null;
  /**
   * PIN-Dialog statt prompt(): senden(pin) liefert { fertig, meldung } oder { fehler } (Dialog bleibt offen).
   * Die meldung kommt erst nach dem Schliessen: im offenen Dialog landete sie in seiner Ansage, die «close» gleich wieder leert.
   */
  function pinAbfrage(o) {
    pinSenden = o.senden;
    $("pinTitel").textContent = o.titel || "PIN, bitte";
    $("pinText").textContent = o.text;
    $("pinOk").textContent = o.ok;
    $("pinHilfeText").textContent = o.hilfe;
    $("pinFeld").value = "";
    feldFehler($("pinGr"), "");
    zeigeDialog($("dlgPin"), $("pinFeld"));
  }
  $("pinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const feld = $("pinFeld");
    const pin = feld.value;
    if (!pin) { feldFehler($("pinGr"), "Die PIN fehlt, Sir."); feld.focus(); return; }
    if (pin.length < 4 || /\s/.test(pin)) { feldFehler($("pinGr"), "Die PIN hat mindestens vier Zeichen und keine Leerzeichen, Sir."); feld.focus(); return; }
    const ok = $("pinOk");
    ok.disabled = true;
    const erg = pinSenden ? await pinSenden(pin) : { fertig: true };
    ok.disabled = false;
    feld.value = "";
    if (erg.fertig) {
      $("dlgPin").close("ok");
      if (erg.meldung && angemeldet) toast(erg.meldung);
      return;
    }
    feldFehler($("pinGr"), erg.fehler || "Das hat nicht geklappt, Sir.");
    feld.focus();
  });
  $("dlgPin").addEventListener("close", () => { $("pinFeld").value = ""; pinSenden = null; });

  /* ---------- Rückmeldung ---------- */
  /*
   * Ein offenes Modal legt seinen Hintergrund über die Seite und macht sie inert (auch für Live-Regionen). Darum:
   * sichtbar als Popover in der obersten Ebene, hörbar über eine Live-Region im offenen Dialog (ohne Dialog: #ansage).
   */
  const toastEl = $("toast");
  // Geschlossen ist das Popover display:none, also nicht im Barrierefreiheitsbaum: eine Live-Region, die mit ihrem Inhalt
  // neu erscheint, sagt kaum ein Screenreader an. Der Toast ist nur sichtbar; hörbar wird er über #ansage bzw. dlg-ansage.
  toastEl.removeAttribute("role");
  toastEl.removeAttribute("aria-live");
  const toastPopover = typeof toastEl.showPopover === "function";
  if (toastPopover) {
    toastEl.setAttribute("popover", "manual");
    // UA-Regeln für [popover] (inset 0, margin auto, Rahmen, Canvas-Farben) zurücknehmen; Lage und Aussehen kommen aus .toast
    Object.assign(toastEl.style, { top: "auto", right: "auto", margin: "0", border: "0", color: "inherit", overflow: "visible" });
  }
  const dlgAnsage = new Map();
  document.querySelectorAll("dialog").forEach((d) => {
    const a = h("div", { class: "sr dlg-ansage", role: "status", "aria-live": "polite" });
    d.append(a);
    dlgAnsage.set(d, a);
    d.addEventListener("close", () => { a.textContent = ""; });
  });
  /** Hörbare Ansage: in die Live-Region des fokussierten bzw. obersten offenen Dialogs, ohne Dialog in #ansage */
  function ansageAktiv(text) {
    const offen = [...document.querySelectorAll("dialog[open]")];
    const dlg = offen.find((d) => d.contains(document.activeElement)) || offen[offen.length - 1];
    const a = dlg && dlgAnsage.get(dlg);
    if (a) { a.textContent = ""; a.textContent = text; } else ansage(text);
  }
  /** Holt einen sichtbaren Toast über das zuletzt geöffnete Modal */
  function toastNachOben() {
    if (!toastPopover || !toastEl.matches(":popover-open")) return;
    toastEl.hidePopover();
    toastEl.showPopover();
    toastLage();
  }
  /**
   * Lage des Toasts: unten Mitte (dashboard.css). Läge er dort über den Knöpfen oder dem Fokus des offenen Dialogs
   * (auf dem Handy reicht der Dialog bis an den Rand), kommt er oben hin. Per CSSOM, CSP-konform.
   */
  function toastLage() {
    const el = toastEl;
    el.style.top = "auto"; el.style.bottom = "";
    const offen = [...document.querySelectorAll("dialog[open]")];
    const dlg = offen[offen.length - 1];
    if (!dlg || !el.offsetHeight) return;
    const b = el.offsetWidth, hh = el.offsetHeight;
    const unten = parseFloat(getComputedStyle(el).bottom) || 24;
    const t = { l: (innerWidth - b) / 2, r: (innerWidth + b) / 2, o: innerHeight - unten - hh - 8, u: innerHeight - unten + 8 };
    const wichtig = [...dlg.querySelectorAll(".dlg-fuss button")];
    if (dlg.contains(document.activeElement)) wichtig.push(document.activeElement);
    const deckt = wichtig.some((x) => {
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.left < t.r && r.right > t.l && r.top < t.u && r.bottom > t.o;
    });
    if (deckt) { el.style.top = "16px"; el.style.bottom = "auto"; }
  }
  let toastTimer = 0, toastWeg = 0;
  function toast(text) {
    const el = toastEl;
    el.textContent = text;
    clearTimeout(toastTimer); clearTimeout(toastWeg);
    if (toastPopover) {
      if (el.matches(":popover-open")) el.hidePopover();
      el.showPopover();
      if (!el.classList.contains("an")) void el.offsetWidth; // Ausgangszustand setzen, damit das Einblenden animiert
    }
    toastLage();
    el.classList.add("an");
    ansageAktiv(text);
    toastTimer = setTimeout(() => {
      el.classList.remove("an");
      if (toastPopover) toastWeg = setTimeout(() => { if (!el.classList.contains("an") && el.matches(":popover-open")) el.hidePopover(); }, 250);
    }, Math.min(8000, 3200 + text.length * 25));
  }
  /** Ansage und Toast leeren: ausgeblendet stünde der letzte Text (etwa eine Chat-Antwort) sonst weiter im DOM */
  function rueckmeldungLeeren() {
    clearTimeout(toastTimer); clearTimeout(toastWeg);
    toastEl.classList.remove("an");
    if (toastPopover && toastEl.matches(":popover-open")) toastEl.hidePopover();
    toastEl.textContent = "";
    $("ansage").textContent = "";
  }

  /* ---------- Bausteine ---------- */
  const STATUS = {
    offen: ["kreis", "z-warn", "offen"], laeuft: ["lauf", "z-neutral", "läuft"], erledigt: ["check", "z-gut", "erledigt"],
    abgelehnt: ["x", "z-neutral", "abgelehnt"], fehler: ["warn", "z-krit", "Fehler"],
  };
  const SCHWERE = { krit: ["krit", "z-krit"], ernst: ["warn", "z-ernst"], warn: ["kreis", "z-warn"] };
  function statusEl(st) { const [i, k, w] = STATUS[st] || ["info", "z-neutral", String(st)]; return h("span", { class: "zustand " + k }, ikon(i), w); }
  function stufeEl(stufe) {
    if (stufe === "sensibel") return h("span", { class: "stufe sensibel" }, ikon("lock", true), "sensibel");
    if (stufe === "extern") return h("span", { class: "stufe extern" }, ikon("out", true), "extern");
    return h("span", { class: "stufe" }, stufe === "auto" ? "auto" : String(stufe ?? ""));
  }
  function kopf(id, titel, text, rechts, eyebrow) {
    return h("div", { class: "kopf" }, h("div", null, eyebrow || null, h("h1", { id: "h-" + id, text: titel }), text ? h("p", { text }) : null), rechts || null);
  }
  const marke = (t) => h("span", { class: "marke", text: t });
  function kpi(lab, wert, einheit, unter, extra, labRechts) {
    return h("div", { class: "karte kpi" }, h("p", { class: "lab" }, lab, labRechts || null),
      h("div", { class: "val" + (wert === "–" ? " ohne" : "") }, wert, einheit ? h("small", { text: einheit }) : null),
      extra || null, unter ? (unter instanceof Node ? unter : h("div", { class: "unter", text: unter })) : null);
  }
  function leer(sym, satz, erklaerung, extraKlasse) {
    return h("div", { class: "leer" + (extraKlasse ? " " + extraKlasse : "") }, ikon(sym), h("b", { text: satz }), erklaerung || null);
  }
  function gesperrtKarte() {
    return h("div", { class: "karte gesperrt-karte" }, leer("lock", "Im Notfall gesperrt, Sir.", "Inhalte erst nach /entwarnung in Telegram. Der Notaus ist bereits aktiv.", "gesperrt"));
  }
  /** Mini-Säulen für die Kostenkachel – dekorativ, die Werte stehen in der Kachel */
  function funke(werte) {
    const n = werte.length; if (!n) return null;
    const W = 140, H = 28, g = 2, bw = (W - g * (n - 1)) / n, max = Math.max(...werte, 0.01);
    const svg = s("svg", { class: "funke", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    werte.forEach((v, i) => { const hh = Math.max(1.5, (v / max) * H); svg.append(s("rect", { x: i * (bw + g), y: H - hh, width: bw, height: hh, rx: 1, class: i === n - 1 ? "heute" : null })); });
    return svg;
  }

  /* ---------- Säulendiagramm: handgebautes SVG (Slot 1/2, Haarlinien, Tooltip bei Zeiger und Tastaturfokus) ---------- */
  const MONATE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  function schritt(max, ziel) {
    const roh = max / ziel; const p = Math.pow(10, Math.floor(Math.log10(roh)));
    const n = roh / p; const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return f * p;
  }
  /** «schöne» Obergrenze nahe am Maximum: unter 3–5 Teilungen die kleinste, bei Gleichstand ~4 Teilungen */
  function achse(max) {
    let best = null;
    for (let z = 3; z <= 5; z++) {
      const st = schritt(max, z); const top = Math.ceil(max / st - 1e-9) * st; const teile = Math.round(top / st);
      if (teile > 5) continue;
      if (!best || top < best.top - 1e-9 || (Math.abs(top - best.top) < 1e-9 && Math.abs(teile - 4) < Math.abs(best.teile - 4))) best = { st, top, teile };
    }
    return best || { st: max, top: max, teile: 1 };
  }
  /** Achsenwerte kompakt: 0 · 1k · 2k; Dezimalstellen nur so viele, wie der Schritt braucht */
  function kompakt(v, st) {
    if (v >= 1000) return new Intl.NumberFormat("de-CH", { maximumFractionDigits: 1 }).format(v / 1000) + "k";
    let d = 0; while (d < 4 && Math.abs(st * 10 ** d - Math.round(st * 10 ** d)) > 1e-9) d++;
    return new Intl.NumberFormat("de-CH", { minimumFractionDigits: 0, maximumFractionDigits: d }).format(v);
  }
  /** Säule mit 4-px-Kappe oben, eckig an der Basis */
  function saeulenPfad(x, y, w, hgt, r) {
    if (hgt <= 0) return "";
    r = Math.min(r, w / 2, hgt);
    const yb = y + hgt;
    return `M${x},${yb}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${yb}Z`;
  }
  /** Zuletzt per Tastatur gewählte Gruppe je Diagramm: übersteht das Neuzeichnen (Roving-Tabindex) */
  const diagAktiv = {};
  /**
   * cfg: merk, titel, zeilen [{label, lang, werte}], reihen [{key, label, klasse}], fmt, extra(z), direkt [{i, key, text}], fuellen.
   * Text steht nie in Datenfarbe; der Tooltip ist nicht der einzige Zugang (Tabellenansicht).
   */
  function saeulen(host, cfg) {
    const W = host.clientWidth, Hh = host.clientHeight;
    if (!W || host.closest("[hidden]")) return;
    const hatteFokus = host.contains(document.activeElement);
    host.replaceChildren();
    const tip = h("div", { class: "tip", "aria-hidden": "true" });
    const mobil = W < 520;
    const H = Math.max(mobil ? 220 : 260, cfg.fuellen ? Hh : 0);
    const n = cfg.zeilen.length, R = cfg.reihen.length;
    const max = Math.max(...cfg.zeilen.flatMap((z) => cfg.reihen.map((r) => z.werte[r.key] || 0)), 0);
    const { st, top } = achse(max > 0 ? max : 1);
    const ticks = []; for (let v = 0; v <= top + st / 1e6; v += st) ticks.push(v);
    const tickTxt = ticks.map((v) => kompakt(v, st));
    const links = 10 + Math.max(...tickTxt.map((t) => t.length)) * 7;
    const oben = 26, unten = 30, rechts = 4;
    const pw = W - links - rechts, ph = H - oben - unten;
    const band = pw / n;
    const luecke = 2;
    const bw = Math.max(1.5, Math.min(24, R === 1 ? band * 0.62 : (band * 0.66 - luecke) / R));
    const gruppeB = bw * R + luecke * (R - 1);
    const y = (v) => oben + ph - (v / top) * ph;
    const svg = s("svg", { class: "plot", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": cfg.titel + ". Pfeiltasten wählen einen Wert, die Tabellenansicht zeigt alle." });
    ticks.forEach((v, i) => {
      const yy = Math.round(y(v)) + 0.5;
      svg.append(s("line", { x1: links, x2: W - rechts, y1: yy, y2: yy, class: i === 0 ? "basis-l" : "raster-l", "stroke-width": 1 }));
      svg.append(s("text", { x: links - 10, y: yy + 4, "text-anchor": "end", class: "achse" }, tickTxt[i]));
    });
    const lmax = Math.max(...cfg.zeilen.map((z) => z.label.length));
    const jede = Math.max(1, Math.ceil((lmax * 6.6 + 22) / band));
    cfg.zeilen.forEach((z, i) => {
      if ((n - 1 - i) % jede !== 0) return;
      const halb = z.label.length * 3.3;
      const cx = Math.max(links + halb, Math.min(W - rechts - halb, links + band * i + band / 2));
      svg.append(s("text", { x: cx, y: H - 8, "text-anchor": "middle", class: "achse" }, z.label));
    });
    const gewaehlt = Number.isInteger(diagAktiv[cfg.merk]) && diagAktiv[cfg.merk] < n ? diagAktiv[cfg.merk] : n - 1;
    const gruppen = cfg.zeilen.map((z, i) => {
      const g = s("g", { class: "gruppe", tabindex: i === gewaehlt ? 0 : -1, role: "img", "data-merk": cfg.merk + ":" + i,
        "aria-label": z.lang + ": " + cfg.reihen.map((r) => r.label + " " + cfg.fmt(z.werte[r.key] || 0)).join(", ") + (cfg.extra ? ". " + cfg.extra(z).join(". ") : "") });
      const bx = links + band * i;
      g.append(s("rect", { class: "band", x: bx, y: oben - 10, width: band, height: ph + 10, rx: 6 }));
      const x0 = bx + (band - gruppeB) / 2;
      cfg.reihen.forEach((r, j) => {
        const v = z.werte[r.key] || 0;
        const p = saeulenPfad(x0 + j * (bw + luecke), y(v), bw, (v / top) * ph, 4);
        if (p) g.append(s("path", { class: "balken " + r.klasse, d: p }));
      });
      svg.append(g);
      return g;
    });
    for (const { i, key, text } of cfg.direkt || []) {
      const j = cfg.reihen.findIndex((r) => r.key === key); const v = cfg.zeilen[i] && cfg.zeilen[i].werte[key];
      if (j < 0 || !(v > 0)) continue;
      const xm = links + band * i + (band - gruppeB) / 2 + j * (bw + luecke) + bw / 2;
      const anker = xm > W - 40 ? "end" : xm < links + 30 ? "start" : "middle";
      svg.append(s("text", { x: xm, y: y(v) - 8, "text-anchor": anker, class: "direkt" }, text || cfg.fmt(v)));
    }
    host.append(svg, tip);
    host._groesse = host.clientWidth + "x" + host.clientHeight;

    let aktiv = -1;
    function zeige(i) {
      if (aktiv >= 0 && gruppen[aktiv]) { gruppen[aktiv].classList.remove("aktiv"); gruppen[aktiv].querySelector(".band").classList.remove("aktiv"); }
      aktiv = i; host.classList.add("fokus");
      const g = gruppen[i]; g.classList.add("aktiv"); g.querySelector(".band").classList.add("aktiv");
      const z = cfg.zeilen[i];
      tip.replaceChildren(h("div", { class: "tt", text: z.lang }),
        ...cfg.reihen.map((r) => h("div", { class: "zeile" }, h("i", { class: r.klasse === "s1" ? "k1" : "k2" }), h("b", { text: cfg.fmt(z.werte[r.key] || 0) }), h("span", { text: r.label }))),
        ...(cfg.extra ? cfg.extra(z) : []).map((t) => h("div", { class: "zusatz", text: t })));
      tip.classList.add("an");
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const cx = links + band * i + band / 2;
      let left = cx + band / 2 + 8;
      if (left + tw > W) left = cx - band / 2 - 8 - tw;
      let obenPx;
      if (left < 0) { left = Math.max(0, Math.min(W - tw, cx - tw / 2)); obenPx = Math.max(0, y(Math.max(...cfg.reihen.map((r) => z.werte[r.key] || 0))) - th - 14); }
      else obenPx = Math.min(H - th - unten, Math.max(0, oben + ph / 2 - th / 2));
      tip.style.left = left + "px"; tip.style.top = obenPx + "px";
    }
    function verstecke() {
      tip.classList.remove("an"); host.classList.remove("fokus");
      if (aktiv >= 0 && gruppen[aktiv]) { gruppen[aktiv].classList.remove("aktiv"); gruppen[aktiv].querySelector(".band").classList.remove("aktiv"); }
      aktiv = -1;
    }
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left - links) / band);
      if (i >= 0 && i < n) { if (i !== aktiv) zeige(i); } else verstecke();
    });
    svg.addEventListener("pointerleave", () => { if (!host.contains(document.activeElement)) verstecke(); });
    gruppen.forEach((g, i) => {
      g.addEventListener("focus", () => { diagAktiv[cfg.merk] = i; gruppen.forEach((gg, k) => gg.setAttribute("tabindex", k === i ? 0 : -1)); zeige(i); });
      g.addEventListener("blur", () => setTimeout(() => { if (!host.contains(document.activeElement)) verstecke(); }, 0));
      g.addEventListener("keydown", (e) => {
        let k = null;
        if (e.key === "ArrowRight") k = Math.min(n - 1, i + 1); else if (e.key === "ArrowLeft") k = Math.max(0, i - 1);
        else if (e.key === "Home") k = 0; else if (e.key === "End") k = n - 1; else if (e.key === "Escape") { verstecke(); return; }
        if (k != null) { e.preventDefault(); gruppen[k].focus(); }
      });
    });
    if (hatteFokus) gruppen[gewaehlt].focus({ preventScroll: true });
  }
  /** Zeichnen erst im Dokument (Breite bekannt) und bei Grössenänderung neu; nachher[] läuft nach dem Einsetzen. */
  let nachher = [];
  const zeichner = new WeakMap();
  const ro = new ResizeObserver((eintraege) => {
    for (const e of eintraege) {
      const f = zeichner.get(e.target);
      const g = Math.round(e.target.clientWidth) + "x" + Math.round(e.target.clientHeight);
      if (f && e.contentRect.width > 0 && e.target._groesse !== g) f();
    }
  });
  function diagramm(cfg, klasse) {
    const host = h("div", { class: "diagramm" + (klasse ? " " + klasse : "") });
    const f = () => saeulen(host, cfg);
    zeichner.set(host, f);
    nachher.push(() => { ro.observe(host); f(); });
    return host;
  }
  function ansichtKnopf(id) {
    const an = ansicht[id];
    return h("button", { class: "knopf leise", type: "button", "data-aktion": "ansicht", "data-id": id, "aria-pressed": String(an) },
      ikon(an ? "diag" : "tabelle", true), h("span", { text: an ? "Diagramm" : "Tabelle" }));
  }
  /** Tabellen- statt Diagrammansicht je Diagramm (Zugänglichkeit); übersteht das Neuzeichnen */
  const ansicht = { kosten: false, finanzen: false };

  /* ---------- Anbindungen (Gesundheit aus robust.ts) ---------- */
  const ANB_NAMEN = {
    internet: "Internet", claude: "Claude-API", telegram: "Telegram", "telegram-empfang": "Telegram-Empfang", homeassistant: "Home Assistant",
    frigate: "Frigate", mqtt: "MQTT", whoop: "WHOOP", wetter: "Wetter", kalender: "Kalender", gmail: "Gmail", shopify: "Shopify",
    stt: "Spracherkennung", tts: "Sprachausgabe", octoprint: "OctoPrint",
  };
  /** Nur Befehle, die es in package.json wirklich gibt */
  const ABHILFE = { whoop: "npm run whoop:auth", gmail: "npm run google:auth" };
  const istAuth = (z) => /^HTTP 40[13]$/.test(z.kurz || "") || /abgelehnt|anmeldung|unauthori[sz]ed|forbidden/i.test((z.kurz || "") + " " + (z.letzterFehler || ""));
  function anbindungen() {
    const g = (Q.status && Q.status.gesundheit) || {};
    return Object.entries(g).filter(([, z]) => z && typeof z === "object").map(([k, z]) => {
      const auth = !z.ok && istAuth(z);
      const netz = /^(Netzfehler|Zeitlimit)$/.test(z.kurz || "");
      return { k, name: ANB_NAMEN[k] || k, ok: Boolean(z.ok), seit: z.seit, fehler: z.fehler, kurz: z.kurz, auth,
        schwere: z.ok ? null : auth ? "ernst" : "warn", wort: auth ? "getrennt" : netz ? "nicht erreichbar" : "gestört" };
    }).sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  function anbErklaerung(a) {
    if (a.auth) {
      const cmd = ABHILFE[a.k];
      return cmd ? ["Zugang abgelehnt. Neu verbinden: ", h("code", { class: "cmd", text: cmd })] : ["Zugang abgelehnt. Bitte die Zugangsdaten in .env prüfen, Sir."];
    }
    const n = istZahl(a.fehler) ? a.fehler : 1;
    return [(n === 1 ? "Ein Fehler" : n + " Fehler in Folge") + (a.kurz ? " (" + a.kurz + ")" : "") + ". Ich versuche es weiter."];
  }

  /* ---------- Lage: Dringliches nach Rang, höchstens fünf Punkte ---------- */
  const DATEIEN = [
    ["auftraegeUnlesbar", "data/auftraege.json", "Freigaben", "#freigaben"],
    ["rechnungenUnlesbar", "data/rechnungen.json", "Finanzen", "#finanzen"],
    ["zeitplaeneUnlesbar", "data/zeitplaene.json", "Zeitpläne", "#zeitplaene"],
    ["wachenUnlesbar", "data/wachen.json", "Wachen", "#zeitplaene"],
    ["camerasUnlesbar", "cameras.json", "Kameras", "#kameras"],
    ["vorgaengeUnlesbar", "data/vorgaenge.json", "Vorgänge", null],
  ];
  function lagePunkte() {
    const st = Q.status; const p = [];
    if (st.notfall) p.push({ k: "notfall", s: "krit", t: "Notfall aktiv", d: "Entwarnung nur per /entwarnung in Telegram", w: "Sicherheit", href: "#sicherheit" });
    for (const [feld, datei, w, href] of DATEIEN) if (st[feld]) p.push({ k: "datei:" + feld, s: "ernst", t: datei + " unlesbar", d: "Reparieren und Jarvis neu starten, Sir", w, href: href || "#uebersicht", ziel: href ? null : "vorgAnker" });
    for (const a of anbindungen().filter((x) => !x.ok)) p.push({ k: "anb:" + a.k, s: a.schwere, t: a.name + " " + a.wort, d: (a.auth ? "Zugang abgelehnt" : a.kurz || "Störung") + " · " + seit(a.seit), w: "Anbindungen", ziel: "anbAnker" });
    const fd = !st.notfall && Q.finanzen && Q.finanzen.daten;
    if (fd && Array.isArray(fd.ueberfaellig) && fd.ueberfaellig.length) {
      const ue = fd.ueberfaellig; const summe = {};
      for (const r of ue) if (istZahl(r.betrag)) summe[r.waehrung] = (summe[r.waehrung] || 0) + r.betrag;
      p.push({ k: "ueberfaellig", s: "ernst", t: ue.length === 1 ? "Eine Rechnung überfällig" : ue.length + " Rechnungen überfällig", d: summeText(summe) + " · älteste seit " + datum(ue[0].faellig), w: "Finanzen", href: "#finanzen" });
    }
    const w = wartende();
    if (w.length) {
      const sens = w.filter((a) => a.stufe === "sensibel").length;
      p.push({ k: "freigaben", s: "warn", t: w.length === 1 ? "Eine Freigabe wartet" : w.length + " Freigaben warten", d: sens ? (sens === 1 ? (w.length === 1 ? "sensibel, mit PIN" : "eine davon sensibel, mit PIN") : sens + " davon sensibel, mit PIN") : "Tippen genügt", w: "Prüfen", ziel: "auftrAnker" });
    }
    if (st.pausiert && !st.notfall) p.push({ k: "notaus", s: "warn", t: "Notaus aktiv", d: "Ich tue nichts, bis Sie mit PIN fortsetzen", w: "Sicherheit", href: "#sicherheit" });
    const rang = { krit: 3, ernst: 2, warn: 1 };
    return p.sort((a, b) => rang[b.s] - rang[a.s]).slice(0, 5);
  }

  /* ---------- Bereiche ---------- */
  const V = (id) => $("v-" + id);
  /** Offene Aufträge: wartende zuerst (neueste oben), laufende darunter – sie brauchen keinen Klick. */
  const offene = () => {
    const l = Q.status && Array.isArray(Q.status.auftraege) ? [...Q.status.auftraege] : [];
    return l.sort((a, b) => Number(Boolean(a.gestartetAm)) - Number(Boolean(b.gestartetAm)) || Number(b.id) - Number(a.id));
  };
  const wartende = () => offene().filter((a) => !a.gestartetAm);

  /** Knopf während seiner Aktion: aria-disabled statt disabled – ein gesperrter Knopf verliert den Tastaturfokus (Aussehen wie .knopf[disabled]) */
  function besetzt(el, an) {
    if (an) { el.setAttribute("aria-disabled", "true"); el.style.opacity = ".45"; el.style.cursor = "not-allowed"; }
    return el;
  }
  function auftragKarte(a) {
    const meta = h("div", { class: "meta" }, stufeEl(a.stufe), h("span", { class: "mono", text: "#" + a.id }), h("span", { class: "mono", text: a.tool }), h("span", { text: vorZeit(a.seit) }));
    if (a.gestartetAm) {
      return h("article", { class: "auftrag laeuft" }, meta, h("div", { class: "was", text: a.summary }),
        h("div", { class: "laufzeit" }, ikon("lauf", true), "läuft " + seit(a.gestartetAm)),
        h("div", { class: "laufband", "aria-hidden": "true" }, h("i")));
    }
    const beschaeftigt = inArbeit.has(String(a.id));
    const sens = a.stufe === "sensibel";
    const ok = h("button", { class: "knopf prim", type: "button", "data-aktion": "freigeben", "data-id": a.id, "aria-label": (sens ? "Auftrag #" + a.id + " mit PIN freigeben" : "Auftrag #" + a.id + " freigeben") },
      sens ? ikon("lock", true) : null, sens ? "Mit PIN freigeben" : "Freigeben");
    const nein = h("button", { class: "knopf", type: "button", "data-aktion": "ablehnen", "data-id": a.id, "aria-label": "Auftrag #" + a.id + " ablehnen" }, "Ablehnen");
    return h("article", { class: "auftrag" }, meta, h("div", { class: "was", text: a.summary }), h("div", { class: "aktion" }, besetzt(nein, beschaeftigt), besetzt(ok, beschaeftigt)));
  }

  function anbKarte() {
    const alle = anbindungen(); const stoer = alle.filter((a) => !a.ok); const oks = alle.filter((a) => a.ok);
    const kopfzeile = h("h2", { class: "etikett" }, "Anbindungen", alle.length ? h("span", { class: "rest t3", text: `${oks.length} von ${alle.length} in Ordnung` }) : null);
    if (!alle.length) return h("div", { class: "karte anb", id: "anbAnker", tabindex: "-1" }, kopfzeile, h("p", { class: "ruhig", text: "Noch keine Meldungen. Ich trage Anbindungen ein, sobald ich sie benutze." }));
    return h("div", { class: "karte anb", id: "anbAnker", tabindex: "-1" }, kopfzeile,
      h("ul", { class: "liste" },
        stoer.map((a) => h("li", { class: "stoer" }, ikon(a.schwere === "ernst" ? "warn" : "kreis", false, "z-" + a.schwere),
          h("div", { class: "haupt" }, h("div", { class: "kopfz" }, h("b", { text: a.name }), h("span", { class: "zustand" }, a.wort, h("span", { class: "t3", text: "· " + seit(a.seit) }))),
            h("p", null, anbErklaerung(a))))),
        oks.length ? h("li", null, h("details", { "data-merk": "anb-ok" }, h("summary", { "data-merk": "anb-ok-s" }, ikon("check", false, "z-gut"), h("span", { text: stoer.length ? `${oks.length} weitere in Ordnung` : `Alle ${oks.length} in Ordnung` }), h("span", { class: "zeigen", text: "zeigen" })),
          h("ul", { class: "ok-liste" }, oks.map((a) => h("li", null, a.name, h("span", { text: seit(a.seit) })))))) : null));
  }

  function renderUebersicht(v) {
    const st = Q.status;
    const eb = h("p", { class: "eyebrow" }, jetzt().toLocaleDateString("de-CH", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }), h("span", { class: "nur-handy", text: " · " + zeit(jetzt()) }));
    if (!st) { v.append(kopf("uebersicht", gruss(), "Einen Moment, Sir. Ich hole die Lage.", null, eb)); return; }
    const punkte = lagePunkte();
    const satz = st.notfall ? "Ich habe isoliert, gesperrt und alarmiert. Den Rest zeige ich nach der Entwarnung."
      : punkte.length ? `${ZAHLWORT[punkte.length] || punkte.length + " Dinge"} ${punkte.length === 1 ? "verlangt" : "verlangen"} Ihre Aufmerksamkeit. Der Rest ist ruhig.` : "Alles ruhig. Nichts wartet auf Sie.";
    const modusM = h("div", { class: "seg seg-mobil", role: "radiogroup", "aria-label": "Modus" },
      [["normal", "Normal"], ["fokus", "Fokus"], ["nacht", "Nacht"]].map(([k, l]) => h("button", { type: "button", role: "radio", "aria-checked": String(st.modus === k), "data-modus": k }, l)));
    v.append(kopf("uebersicht", gruss(), satz, modusM, eb));

    if (punkte.length) {
      v.append(h("div", { class: "karte" }, h("h2", { class: "etikett" }, "Lage", h("span", { class: "rest t3", text: "nach Dringlichkeit" })),
        h("ul", { class: "lage-liste" }, punkte.map((p) => {
          const [ic, kl] = SCHWERE[p.s];
          return h("li", null, h("a", { href: p.href || "#uebersicht", "data-ziel": p.ziel || null, "data-merk": "lage:" + p.k }, ikon(ic, false, "sym " + kl), h("b", { text: p.t }), h("span", { class: "detail", text: p.d }), h("span", { class: "weiter", text: p.w + " ›" })));
        }))));
    }

    const alle = anbindungen(); const stoer = alle.filter((a) => !a.ok);
    const skala = alle.length ? h("div", { class: "skala", "aria-hidden": "true" }, [...alle].sort((a, b) => b.ok - a.ok).map((a) => h("i", { class: a.ok ? null : a.schwere }))) : null;
    const anbKpi = kpi("Anbindungen", alle.length ? `${alle.length - stoer.length} von ${alle.length}` : "–", null,
      !alle.length ? "noch keine Meldungen" : stoer.length ? `in Ordnung · ${stoer.length} gestört` : "alle in Ordnung", skala);
    anbKpi.classList.add("breit");

    if (st.notfall) {
      const n = istZahl(st.offeneAuftraege) ? st.offeneAuftraege : 0;
      v.append(h("div", { class: "raster r-2 kacheln mt" },
        kpi("Offene Aufträge", String(n), null, "Inhalte erst nach /entwarnung"), anbKpi));
      const auftr = h("div", { class: "karte auftr-karte", id: "auftrAnker", tabindex: "-1" }, h("h2", { class: "etikett", text: "Offene Aufträge" }),
        leer("lock", n === 0 ? "Keine offenen Aufträge." : n === 1 ? "Ein offener Auftrag." : n + " offene Aufträge.", "Inhalte erst nach /entwarnung.", "gesperrt"),
        h("p", { class: "kfuss" }, ikon("lock", true), "Im Notfall gebe ich nichts frei und zeige keine Inhalte. Die Aufträge bleiben offen."));
      v.append(h("div", { class: "raster r-2-1 mt" }, auftr, h("div", { class: "spalte" }, anbKarte())));
      const rest = gesperrtKarte(); rest.classList.add("mt");
      rest.querySelector(".leer b").textContent = "Den Rest zeige ich erst nach der Entwarnung, Sir.";
      v.append(rest);
      return;
    }

    /* Stat-Kacheln */
    const offen = offene(); const warten = wartende();
    const aelteste = warten.reduce((m, a) => (!m || String(a.seit) < String(m) ? a.seit : m), null);
    // Unlesbare data/auftraege.json: die leere Liste heisst dann nicht «nichts wartet»
    const auftrUnlesbar = Boolean(st.auftraegeUnlesbar) && !offen.length;
    const auftrKpi = auftrUnlesbar
      ? kpi("Offene Aufträge", "–", null, h("div", { class: "unter zustand z-ernst" }, ikon("warn", true), "data/auftraege.json unlesbar"))
      : kpi("Offene Aufträge", String(offen.length), null, offen.length ? `${warten.length} warten · ${offen.length - warten.length} läuft` : "nichts wartet",
        aelteste ? h("div", { class: "zweit-t", text: "älteste wartet " + seit(aelteste) }) : null);

    const kd = Q.kosten14 && Q.kosten14.daten;
    const monatName = MONATE_LANG[Number(isoTag(jetzt()).slice(5, 7)) - 1];
    const kostenKpi = kd
      ? kpi("Kosten " + monatName, f2.format(kd.monat.kostenUsd), "USD", "heute " + geld(kd.heute.kostenUsd, "USD"), funke(kd.tage.map((t) => t.kostenUsd)), marke("Schätzung"))
      : kpi("Kosten " + monatName, "–", null, Q.kosten14 ? "nicht verfügbar" : "wird geladen", null, marke("Schätzung"));

    const fq = Q.finanzen; const fd = fq && fq.daten;
    let rechnungKpi;
    if (fd) {
      const summe = (fd.offen && fd.offen.summe) || {};
      const w = Object.keys(summe).sort((a, b) => (a === "CHF" ? -1 : b === "CHF" ? 1 : summe[b] - summe[a]));
      const haupt = w[0] || "CHF";
      const ue = (fd.ueberfaellig || []).length;
      const anz = (fd.offen && fd.offen.anzahl) || 0;
      const unterText = (anz === 1 ? "1 Rechnung" : anz + " Rechnungen") + (ue ? " · " + ue + " überfällig" : "") + (fd.unklar ? " · " + fd.unklar + " ohne Betrag" : "");
      rechnungKpi = h("div", { class: "karte kpi breit" }, h("p", { class: "lab", text: "Offene Rechnungen" }),
        h("div", { class: "val" }, f2.format(summe[haupt] || 0), h("small", { text: haupt })),
        w.slice(1).map((x) => h("div", { class: "zweit" }, f2.format(summe[x]), h("small", { text: x }))),
        ue ? h("div", { class: "unter zustand z-ernst" }, ikon("warn", true), unterText) : h("div", { class: "unter", text: anz ? unterText : "keine offen" }));
    } else {
      const unlesbar = fq && fq.fehler === 503;
      rechnungKpi = kpi("Offene Rechnungen", "–", null, unlesbar ? h("div", { class: "unter zustand z-ernst" }, ikon("warn", true), "data/rechnungen.json unlesbar") : fq ? "nicht verfügbar" : "wird geladen");
      rechnungKpi.classList.add("breit");
    }
    v.append(h("div", { class: "kpis mt" }, auftrKpi, kostenKpi, rechnungKpi, anbKpi));

    /* Aufträge links – Anbindungen und «Als Nächstes» rechts */
    const auftr = h("div", { class: "karte auftr-karte", id: "auftrAnker", tabindex: "-1" }, h("h2", { class: "etikett" }, "Offene Aufträge", h("a", { class: "rest", href: "#freigaben", "data-merk": "u-historie", text: "Historie ›" })),
      offen.length ? h("div", { class: "auftraege" }, offen.map(auftragKarte))
        : auftrUnlesbar ? leer("warn", "data/auftraege.json ist unlesbar.", AUFTR_UNLESBAR_TEXT)
        : leer("leer", "Nichts zu tun, Sir.", "Neue Aufträge erscheinen hier."),
      h("p", { class: "kfuss" }, ikon("lock", true), "Sensibles gebe ich nur mit Ihrer PIN frei. Telegram und diese Seite zählen gleich."));
    v.append(h("div", { class: "raster r-2-1 mt" }, auftr, h("div", { class: "spalte" }, anbKarte(), naechstKarte())));

    const ziele = Array.isArray(st.ziele) ? st.ziele : [];
    const zieleK = h("div", { class: "karte" }, h("h2", { class: "etikett", text: "Ziele" }),
      ziele.length ? h("ul", { class: "liste" }, ziele.map((z) => h("li", null, h("div", { class: "haupt" }, h("b", { text: z.text }),
        h("span", { text: z.frist ? "bis " + (/^\d{4}-\d{2}-\d{2}$/.test(z.frist) ? datum(z.frist) : z.frist) : "ohne Frist" })))))
        : h("p", { class: "ruhig", text: "Noch keine Ziele. Nennen Sie mir eines im Gespräch, Sir." }));
    const vorgaenge = Array.isArray(st.vorgaenge) ? [...st.vorgaenge].reverse() : [];
    const vorgK = h("div", { class: "karte", id: "vorgAnker", tabindex: "-1" }, h("h2", { class: "etikett", text: "Vorgänge" }),
      st.vorgaengeUnlesbar ? h("p", { class: "ruhig", text: "data/vorgaenge.json ist unlesbar. Ich starte keine Vorgänge, bis sie repariert ist." })
        : vorgaenge.length ? h("ul", { class: "liste" }, vorgaenge.map((g) => h("li", null, h("div", { class: "haupt" }, h("b", { text: g.auftrag }),
          h("span", { text: `#${g.id} · ${g.status} · ${istZahl(g.steps) ? (g.steps === 1 ? "1 Schritt" : g.steps + " Schritte") : "–"}` })))))
          : h("p", { class: "ruhig", text: "Keine Vorgänge." }));
    v.append(h("div", { class: "raster r-2 oben-ausr mt" }, zieleK, vorgK));

    const protos = Array.isArray(st.protokolle) ? st.protokolle : [];
    // Im Notaus lehnt der Server jedes Protokoll ab (423): Knöpfe gesperrt (aria-disabled behält den Fokus), Grund sichtbar
    const angehalten = Boolean(st.pausiert);
    const sperrGrund = "Im Notaus laufen keine Protokolle, Sir. Erst «Weiter» mit PIN.";
    const protoKnopf = (p) => {
      const b = h("button", { class: "knopf", type: "button", "data-aktion": "protokoll", "data-name": p.name, "aria-label": "Protokoll " + p.name + " ausführen" }, "Ausführen");
      if (angehalten) { b.title = sperrGrund; b.setAttribute("aria-description", sperrGrund); }
      return besetzt(b, inArbeit.has("p:" + p.name) || angehalten);
    };
    v.append(h("div", { class: "karte mt" }, h("h2", { class: "etikett" }, "Protokolle", h("span", { class: "rest t3", text: "laufen über die Freigabe" })),
      protos.length > 0 && angehalten ? h("p", { class: "ruhig", text: sperrGrund }) : null,
      protos.length ? h("div", { class: "protos" }, protos.map((p) => h("div", { class: "proto" },
        h("div", { class: "kopfz" }, h("b", { text: p.name }), stufeEl(p.stufe)),
        h("p", { text: p.beschreibung }),
        protoKnopf(p))))
        : h("p", { class: "ruhig", text: "Keine Protokolle in protokolle.json." })));
  }

  function naechstKarte() {
    const k = h("div", { class: "karte naechst" }, h("h2", { class: "etikett" }, "Als Nächstes", h("a", { class: "rest", href: "#zeitplaene", "data-merk": "u-zeitplaene", text: "Zeitpläne ›" })));
    const zq = Q.zeitplaene, wq = Q.wachen;
    if (Q.status.pausiert) k.append(h("p", { class: "ruhig", text: "Während des Notaus läuft nichts davon." }));
    const zeilen = [];
    if (zq && zq.daten && zq.daten.unlesbar) zeilen.push(h("li", null, h("div", { class: "haupt" }, h("span", { text: "data/zeitplaene.json ist unlesbar." }))));
    else if (zq && zq.daten) {
      const plaene = zq.daten.zeitplaene.filter((z) => z.naechsterLauf).sort((a, b) => String(a.naechsterLauf).localeCompare(String(b.naechsterLauf))).slice(0, 3);
      for (const z of plaene) zeilen.push(h("li", null, h("span", { class: "uhrz", text: zeit(z.naechsterLauf) }), h("div", { class: "haupt" }, h("b", { text: planName(z) })), h("span", { class: "wann", text: wannTag(z.naechsterLauf) })));
    } else if (!zq) zeilen.push(h("li", null, h("div", { class: "haupt" }, h("span", { text: "Ich hole die Zeitpläne …" }))));
    if (wq && wq.daten && Array.isArray(wq.daten.wachen) && wq.daten.wachen.length) {
      // Nur Wachen, die wirklich laufen: ohne gültiges Intervall oder Kamera (laeuft false) schaut keine hin
      const w = wq.daten.wachen.filter((x) => x.laeuft !== false); const kams = [...new Set(w.map((x) => x.kamera))];
      if (w.length) zeilen.push(h("li", { class: "wachen" }, h("span", { class: "uhrz" }, ikon("auge")), h("div", { class: "haupt" }, h("b", { text: w.length === 1 ? "Eine Wache aktiv" : w.length + " Wachen aktiv" }), h("span", { text: kams.join(", ") }))));
    }
    if (!zeilen.length) k.append(h("p", { class: "ruhig", text: "Nichts geplant, Sir. Ich warte, bis Sie mich brauchen." }));
    else k.append(h("ul", { class: "liste" }, zeilen));
    return k;
  }

  /* ---------- Freigaben ---------- */
  const AUFTR_UNLESBAR_TEXT = "Frühere Freigaben kenne ich nicht, und neue lege ich erst an, wenn die Datei repariert ist und ich neu gestartet bin, Sir.";
  const filterF = { status: "alle", stufe: "alle" };
  const F_STATUS = [["alle", "Alle"], ["offen", "Offen"], ["erledigt", "Erledigt"], ["abgelehnt", "Abgelehnt"], ["fehler", "Fehler"]];
  const F_STUFE = [["alle", "Alle Stufen"], ["extern", "extern"], ["sensibel", "sensibel"]];
  function renderFreigaben(v) {
    v.append(kopf("freigaben", "Freigaben", "Alles, was ich nach aussen tun wollte – und was daraus wurde."));
    const q = Q.auftraege;
    if (Q.status && Q.status.notfall) { v.append(gesperrtKarte()); return; }
    if (!q) { v.append(h("div", { class: "karte" }, h("p", { class: "ruhig", text: "Einen Moment, Sir. Ich hole die Historie." }))); return; }
    if (!q.daten) { v.append(h("div", { class: "karte" }, leer("warn", "Die Historie ist gerade nicht verfügbar.", fehlerText({ status: q.fehler, daten: { text: q.text } })))); return; }
    // Unlesbare data/auftraege.json: die leere Liste heisst nicht «noch keine Freigaben»
    if (q.daten.unlesbar) { v.append(h("div", { class: "karte" }, leer("warn", "data/auftraege.json ist unlesbar.", ohneSymbol(q.daten.text || AUFTR_UNLESBAR_TEXT)))); return; }
    const alle = Array.isArray(q.daten.auftraege) ? q.daten.auftraege : [];
    const passtStufe = (a) => filterF.stufe === "alle" || a.stufe === filterF.stufe;
    const anz = (k) => alle.filter((a) => (k === "alle" || a.status === k) && passtStufe(a)).length;
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Status" },
      F_STATUS.map(([k, l]) => h("button", { type: "button", role: "radio", "aria-checked": String(filterF.status === k), "data-fstatus": k }, l, h("span", { class: "n", text: anz(k) }))));
    const stufeOpt = () => F_STUFE.map(([k, l]) => h("option", { value: k, selected: filterF.stufe === k }, l));
    v.append(
      h("div", { class: "filter filter-breit" }, seg, h("select", { class: "wahl", "aria-label": "Stufe", "data-filter": "stufe", "data-merk": "f-stufe" }, stufeOpt())),
      h("div", { class: "filter filter-mobil" },
        h("select", { class: "wahl", "aria-label": "Status", "data-filter": "status", "data-merk": "fm-status" }, F_STATUS.map(([k, l]) => h("option", { value: k, selected: filterF.status === k }, l + " (" + anz(k) + ")"))),
        h("select", { class: "wahl", "aria-label": "Stufe", "data-filter": "stufe", "data-merk": "fm-stufe" }, stufeOpt())));
    const box = h("div", { class: "karte" }); v.append(box);

    const liste = alle.filter((a) => (filterF.status === "alle" || a.status === filterF.status) && passtStufe(a));
    if (!liste.length) {
      box.append(alle.length ? leer("leer", "Nichts dergleichen, Sir.", "Für diese Auswahl gibt es keine Einträge.") : leer("leer", "Noch keine Freigaben, Sir.", "Sobald ich etwas nach aussen tun will, steht es hier."));
      return;
    }
    const st = (a) => (a.status === "offen" && a.gestartetAm ? "laeuft" : a.status);
    const ergebnis = (a, wo) => (typeof a.result === "string" && a.result
      ? h("details", { "data-merk": wo + "-erg:" + a.id }, h("summary", { "data-merk": wo + "-erg-s:" + a.id, "aria-label": "Ergebnis von #" + a.id }, "Ergebnis"), h("p", { text: a.result }))
      : null);
    const gruppen = [];
    for (const a of liste) { const t = tagName(a.createdAt); const g = gruppen[gruppen.length - 1]; if (g && g.t === t) g.l.push(a); else gruppen.push({ t, l: [a] }); }
    const tbl = h("table", { class: "tbl verlauf" }, h("caption", { class: "sr", text: "Freigabe-Historie, neueste zuerst" }),
      h("thead", null, h("tr", null, ["Zeit", "#", "Werkzeug", "Stufe", "Zusammenfassung", "Status", "Ergebnis"].map((t) => h("th", { scope: "col", text: t })))),
      gruppen.map((g) => h("tbody", null, h("tr", { class: "tag" }, h("th", { colspan: 7, scope: "colgroup", text: g.t })),
        g.l.map((a) => h("tr", null,
          h("td", { class: "mono t3", text: zeit(a.createdAt) }), h("td", { class: "mono t3", text: a.id }), h("td", { class: "mono", text: a.tool }),
          h("td", null, stufeEl(a.stufe)), h("td", { class: "zus", text: a.summary }), h("td", null, statusEl(st(a))),
          h("td", null, ergebnis(a, "t") || h("span", { class: "t3", text: a.status === "offen" ? "–" : "kein Ergebnis" })))))));
    const karten = h("div", { class: "vkarten" }, gruppen.map((g) => [h("div", { class: "vtag", text: g.t }), g.l.map((a) => h("article", { class: "vkarte" },
      h("div", { class: "oben" }, stufeEl(a.stufe), h("span", { class: "mono", text: "#" + a.id }), h("span", { class: "mono", text: a.tool }), h("span", { class: "mono zeit-r", text: zeit(a.createdAt) })),
      h("div", { class: "was", text: a.summary }),
      h("div", { class: "unten" }, statusEl(st(a)), ergebnis(a, "k"))))]));
    const mehr = q.daten.gesamt > alle.length ? ` · die ältesten ${q.daten.gesamt - alle.length} nicht geladen` : "";
    box.append(h("div", { class: "tbl-wrap" }, tbl), karten,
      h("p", { class: "kfuss" }, ikon("lock", true), `${liste.length} ${liste.length === 1 ? "Eintrag" : "Einträge"}${mehr} · Ergebnisse gekürzt und geschwärzt · Eingaben zeige ich hier bewusst nicht.`));
  }

  /* ---------- Sicherheit ---------- */
  function renderSicherheit(v) {
    v.append(kopf("sicherheit", "Sicherheit", "Anhalten, weitermachen, im Ernstfall abriegeln. Die Entwarnung gibt es bewusst nur in Telegram."));
    const st = Q.status || {};
    const pausiert = Boolean(st.pausiert);
    const notfall = Boolean(st.notfall);
    v.append(h("div", { class: "raster r-3" },
      h("div", { class: "karte sicher-karte" }, h("div", { class: "sym" }, ikon("pause")), h("h2", { text: "Notaus" }),
        h("p", { text: "Ich halte sofort alles an: keine Werkzeuge, keine Zeitpläne, keine Wachen. Wirkt wie /pause in Telegram." }),
        h("button", { class: "knopf gefahr", type: "button", "data-aktion": "notaus", "data-merk": "s-notaus", disabled: pausiert }, ikon("pause", true), pausiert ? "Bereits angehalten" : "Notaus")),
      h("div", { class: "karte sicher-karte" }, h("div", { class: "sym" }, ikon("play")), h("h2", { text: "Weiter" }),
        h("p", { text: notfall ? "Im Notfall hebe ich den Notaus hier nicht auf. Erst /entwarnung in Telegram." : "Hebt den Notaus auf. Nur mit Ihrer PIN – wie bei sensiblen Freigaben." }),
        h("button", { class: "knopf", type: "button", "data-aktion": "weiter", "data-merk": "s-weiter", disabled: !pausiert || notfall }, ikon("lock", true), "Mit PIN fortsetzen")),
      h("div", { class: "karte sicher-karte" }, h("div", { class: "sym" }, ikon("alarm")), h("h2", { text: "Notfall auslösen" }),
        h("p", { text: "Isolieren, sperren, alarmieren. Entwarnung danach per /entwarnung in Telegram, mit Checkliste." }),
        h("button", { class: "knopf gefahr", type: "button", "data-aktion": "notfall", "data-merk": "s-notfall", disabled: notfall }, ikon("alarm", true), notfall ? "Notfall läuft" : "Notfall auslösen"))));
    v.append(h("div", { class: "hinweis sicher-hinweis" }, ikon("info"),
      "Eine Entwarnung gibt es hier nicht: Sie geht nur per /entwarnung in Telegram, mit Checkliste. So hebt niemand im Heimnetz einen Notfall mit einem Klick auf."));
    v.append(h("div", { class: "karte sitzung mt" }, h("p", { text: "Angemeldet aus dem Heimnetz. Der Token bleibt nur in diesem Browser." }),
      h("button", { class: "knopf", type: "button", "data-aktion": "abmelden", "data-merk": "s-abmelden" }, ikon("ab", true), "Abmelden")));
  }

  /** Ladezustand oder Fehler einer Quelle als Karte; null, wenn Daten da sind */
  function quelleHinweis(q, laden, titel) {
    if (!q) return h("div", { class: "karte" }, h("p", { class: "ruhig", text: laden }));
    if (!q.daten) return h("div", { class: "karte" }, leer("warn", titel, fehlerText({ status: q.fehler, daten: { text: q.text } })));
    return null;
  }
  const summe = (liste, k) => liste.reduce((acc, t) => acc + (istZahl(t[k]) ? t[k] : 0), 0);
  const anzahlRechnungen = (n) => (n === 1 ? "1 Rechnung" : n + " Rechnungen");
  const zeitSek = (d) => d.toLocaleTimeString("de-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  /** «heute 18:40», «gestern 18:40» oder «09.10. 18:40» */
  function wannLang(x) {
    const d = alsDatum(x); if (!d) return "–";
    const t = isoTag(d);
    const heute = heuteTag();
    if (t === heute) return "heute " + zeit(d);
    if (t === nachbar(heute, -1)) return "gestern " + zeit(d);
    return datumKurz(d) + " " + zeit(d);
  }

  /* ---------- Kosten ---------- */
  let kostenLaedt = false;
  function renderKosten(v) {
    v.append(kopf("kosten", "Kosten", "Claude-Verbrauch nach den Preisen in .env. Eine Schätzung, keine Rechnung."));
    if (Q.status && Q.status.notfall) { v.append(gesperrtKarte()); return; }
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Zeitraum" },
      [7, 30, 90].map((t) => h("button", { type: "button", role: "radio", "aria-checked": String(kTage === t), "data-tage": t, "data-merk": "k-tage-" + t }, t + " Tage")));
    v.append(h("div", { class: "filter" }, h("span", { class: "kl", text: "Zeitraum" }), seg, h("span", { class: "anzahl nur-breit", text: "gilt für Kacheln, Diagramm und Tabellen" })));
    const q = Q.kosten;
    const hinweis = quelleHinweis(q, "Einen Moment, Sir. Ich rechne nach.", "Die Kosten sind gerade nicht verfügbar.");
    if (hinweis) { v.append(hinweis); return; }
    const d = q.daten;
    const tage = Array.isArray(d.tage) ? d.tage : [];
    const n = Math.max(1, tage.length);
    // Während ein anderer Zeitraum lädt, bleibt die alte Darstellung gedimmt stehen
    const inhalt = h("div", { class: kostenLaedt || tage.length !== kTage ? "laedt" : null, "aria-busy": kostenLaedt ? "true" : null });
    v.append(inhalt);

    /* Hero: Monat bis heute, mit Hochrechnung und Monatsskala */
    const heuteIso = isoTag(jetzt());
    const jahr = Number(heuteIso.slice(0, 4)), mo = Number(heuteIso.slice(5, 7)), tagHeute = Number(heuteIso.slice(8, 10));
    const tageImMonat = new Date(Date.UTC(jahr, mo, 0)).getUTCDate();
    const hm = zeit(jetzt());
    const vergangen = tagHeute - 1 + (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))) / 1440;
    const monatUsd = d.monat && istZahl(d.monat.kostenUsd) ? d.monat.kostenUsd : null;
    const hoch = monatUsd !== null && vergangen >= 1 ? `Hochrechnung Monatsende ≈ ${f2.format((monatUsd / vergangen) * tageImMonat)} USD` : "Hochrechnung ab dem zweiten Tag des Monats";
    const marke2 = h("span", { class: "heute-marke", text: "heute, " + tagHeute + "." });
    const pos = tageImMonat > 1 ? (tagHeute - 1) / (tageImMonat - 1) : 0;
    if (pos < 0.5) { marke2.style.left = pos * 100 + "%"; marke2.style.transform = "translateX(-1px)"; } else marke2.style.right = (1 - pos) * 100 + "%";
    const skala = h("div", { class: "monatsskala", "aria-hidden": "true" }, marke2,
      h("div", { class: "ticks" }, Array.from({ length: tageImMonat }, (_, k) => h("i", { class: [k + 1 < tagHeute ? "an" : "", k + 1 === tagHeute ? "heute" : "", (k + 1) % 7 === 1 ? "w" : ""].join(" ").trim() || null }))),
      h("div", { class: "beschr" }, h("span", { text: "1. " + MONATE[mo - 1] }), h("span", { text: tageImMonat + ". " + MONATE[mo - 1] })));
    const hero = h("div", { class: "karte hero" }, h("p", { class: "lab" }, MONATE_LANG[mo - 1] + " bis heute", marke("Schätzung")),
      h("div", { class: "zahl" }, monatUsd === null ? "–" : f2.format(monatUsd), h("small", { text: "USD" })),
      h("div", { class: "fuss", text: "nach den Preisen in .env" }), h("div", { class: "hoch", text: hoch }), skala);

    const sumUsd = summe(tage, "kostenUsd");
    const cache = istZahl(d.cacheAnteil) ? d.cacheAnteil : null;
    const kacheln = h("div", { class: "raster r-2 kacheln" },
      kpi("Heute", d.heute && istZahl(d.heute.kostenUsd) ? f2.format(d.heute.kostenUsd) : "–", "USD", "seit Mitternacht"),
      kpi("Aufrufe", ganz(summe(tage, "calls")), null, tage.length + " Tage"),
      kpi("Cache-Anteil", cache === null ? "–" : f0.format(cache * 100), cache === null ? null : "%", "aus dem Cache gelesen"),
      kpi("Ø pro Tag", f2.format(sumUsd / n), "USD", `Summe ${f2.format(sumUsd)} USD`));
    inhalt.append(h("div", { class: "raster r-2" }, hero, kacheln));

    /* Diagramm «Kosten pro Tag» (eine Reihe, Slot 1) oder Tabelle */
    const zeilen = tage.map((t) => {
      const dd = alsDatum(t.datum);
      const kurz = tage.length <= 7
        ? dd.toLocaleDateString("de-CH", { timeZone: TZ, weekday: "short" }).replace(".", "") + " " + dd.getUTCDate() + "."
        : dd.getUTCDate() + "." + (dd.getUTCMonth() + 1) + ".";
      return { label: kurz, lang: dd.toLocaleDateString("de-CH", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }) + (t.datum === heuteIso ? " (bis jetzt)" : ""),
        werte: { k: istZahl(t.kostenUsd) ? t.kostenUsd : 0 }, calls: istZahl(t.calls) ? t.calls : 0, datum: t.datum };
    });
    const maxI = zeilen.reduce((m, z, i) => (z.werte.k > zeilen[m].werte.k ? i : m), 0);
    let flaeche;
    if (ansicht.kosten) {
      flaeche = h("div", { class: "tbl-wrap hoch" }, h("table", { class: "tbl" }, h("caption", { class: "sr", text: "Kosten pro Tag, neueste zuerst" }),
        h("thead", null, h("tr", null, h("th", { scope: "col", text: "Datum" }), h("th", { scope: "col", class: "r", text: "Aufrufe" }), h("th", { scope: "col", class: "r", text: "Kosten (USD)" }))),
        h("tbody", null, [...zeilen].reverse().map((z) => h("tr", null, h("td", { class: "num", text: datum(z.datum) + (z.datum === heuteIso ? " (bis jetzt)" : "") }), h("td", { class: "r", text: f0.format(z.calls) }), h("td", { class: "r", text: f2.format(z.werte.k) }))))));
    } else if (!(sumUsd > 0)) {
      flaeche = leer("diag", "Kein Verbrauch in diesem Zeitraum.", "Sobald ich Claude frage, steht es hier.");
    } else {
      flaeche = diagramm({ merk: "kd", titel: `Kosten pro Tag in USD, letzte ${tage.length} Tage`, zeilen, reihen: [{ key: "k", label: "USD", klasse: "s1" }],
        fmt: (x) => f2.format(x), extra: (z) => [f0.format(z.calls) + (z.calls === 1 ? " Aufruf" : " Aufrufe")], direkt: [{ i: maxI, key: "k" }] });
    }
    inhalt.append(h("div", { class: "karte mt" },
      h("div", { class: "diag-kopf" }, h("div", null, h("h2", { text: "Kosten pro Tag" }), h("p", { text: `USD, letzte ${tage.length} Tage · höchster Tag beschriftet` })), ansichtKnopf("kosten")),
      flaeche));

    /* Token-Aufteilung */
    const P = d.preise || {};
    const arten = [["input", "Eingabe"], ["output", "Ausgabe"], ["cacheRead", "Cache gelesen"], ["cacheWrite", "Cache geschrieben"]];
    const preisVon = (k) => (istZahl(P[k]) ? P[k] : null);
    const kostenVon = (k) => (preisVon(k) === null ? null : (summe(tage, k) / 1e6) * preisVon(k));
    const gesamt = arten.reduce((acc, [k]) => acc + (kostenVon(k) || 0), 0);
    const tokTab = h("table", { class: "tbl" }, h("caption", { class: "sr", text: "Token-Aufteilung" }),
      h("thead", null, h("tr", null, h("th", { scope: "col", text: "Art" }), h("th", { scope: "col", class: "r", text: "Tokens" }), h("th", { scope: "col", class: "r spalte-preis", text: "USD / Mio" }), h("th", { scope: "col", class: "r", text: "Kosten (USD)" }))),
      h("tbody", null, arten.map(([k, l]) => h("tr", null, h("td", { text: l }), h("td", { class: "r", text: ganz(summe(tage, k)) }),
        h("td", { class: "r t3 spalte-preis", text: preisVon(k) === null ? "–" : f2.format(preisVon(k)) }), h("td", { class: "r", text: kostenVon(k) === null ? "–" : f2.format(kostenVon(k)) })))),
      h("tfoot", null, h("tr", null, h("td", { text: "Summe" }), h("td", { class: "r", text: ganz(arten.reduce((acc, [k]) => acc + summe(tage, k), 0)) }), h("td", { class: "spalte-preis" }), h("td", { class: "r", text: f2.format(gesamt) }))));
    inhalt.append(h("div", { class: "karte mt" }, h("h2", { class: "etikett" }, "Token-Aufteilung", h("span", { class: "rest t3", text: `letzte ${tage.length} Tage` })), h("div", { class: "tbl-wrap" }, tokTab)));
  }
  async function zeitraumSetzen(t) {
    if (t === kTage || ![7, 30, 90].includes(t)) return;
    kTage = t; kostenLaedt = true; rendern();
    await holeQuelle("kosten");
    if (t !== kTage) return;
    kostenLaedt = false; stoerungZeigen(); rendern();
  }

  /* ---------- Finanzen ---------- */
  /** CHF, sonst die Währung mit dem grössten Volumen; weitere Währungen nur in der Tabelle */
  function hauptWaehrung(d) {
    const vol = {};
    const add = (o) => { for (const [w, b] of Object.entries(o || {})) if (istZahl(b)) vol[w] = (vol[w] || 0) + Math.abs(b); };
    add(d.offen && d.offen.summe);
    for (const m of d.proMonat || []) { add(m.bezahlt); add(m.offen); }
    if (vol.CHF) return "CHF";
    return Object.keys(vol).sort((a, b) => vol[b] - vol[a])[0] || "CHF";
  }
  const summeJe = (l) => l.reduce((acc, r) => { if (istZahl(r.betrag)) acc[r.waehrung] = (acc[r.waehrung] || 0) + r.betrag; return acc; }, {});
  function renderFinanzen(v) {
    const q = Q.finanzen; const d = q && q.daten;
    v.append(kopf("finanzen", "Finanzen", d && d.stand ? "Rechnungen nach Fälligkeit. Stand " + datum(d.stand) + "." : "Rechnungen nach Fälligkeit. Zahlungen bereite ich nur vor."));
    if (Q.status && Q.status.notfall) { v.append(gesperrtKarte()); return; }
    if (q && !d && q.fehler === 503) {
      v.append(h("div", { class: "karte" }, leer("warn", "data/rechnungen.json ist unlesbar.", ohneSymbol(q.text || "Ich zeige keine Zahlen, bis die Datei repariert ist, Sir."))));
      return;
    }
    const hinweis = quelleHinweis(q, "Einen Moment, Sir. Ich gehe die Rechnungen durch.", "Die Finanzen sind gerade nicht verfügbar.");
    if (hinweis) { v.append(hinweis); return; }
    const hw = hauptWaehrung(d);
    const ueL = Array.isArray(d.ueberfaellig) ? d.ueberfaellig : [];
    const fbL = Array.isArray(d.faelligBald) ? d.faelligBald : [];
    const bzL = Array.isArray(d.bezahltLetzteWoche) ? d.bezahltLetzteWoche : [];
    const offenSumme = (d.offen && d.offen.summe) || {};
    const anz = (d.offen && istZahl(d.offen.anzahl)) ? d.offen.anzahl : 0;
    const fremd = (o) => { const e = Object.entries(o).filter(([w, b]) => w !== hw && istZahl(b)); return e.length ? h("div", { class: "fremd", text: e.map(([w, b]) => "+ " + geld(b, w)).join(" · ") }) : null; };
    const ue = summeJe(ueL), fb = summeJe(fbL), bz = summeJe(bzL);
    const offenUnter = [anzahlRechnungen(anz), d.ohneFrist ? d.ohneFrist + " ohne Frist" : "", d.unklar ? d.unklar + " ohne Betrag" : ""].filter(Boolean).join(" · ");
    const ueKpi = h("div", { class: "karte kpi" }, h("p", { class: "lab", text: "Überfällig" }), h("div", { class: "val" }, f2.format(ue[hw] || 0), h("small", { text: hw })), fremd(ue),
      ueL.length ? h("div", { class: "unter zustand z-ernst" }, ikon("warn", true), anzahlRechnungen(ueL.length) + " · seit " + datumKurz(ueL[0].faellig)) : h("div", { class: "unter", text: "nichts überfällig" }));
    v.append(h("div", { class: "kpis fin" },
      kpi("Offen", f2.format(offenSumme[hw] || 0), hw, offenUnter, fremd(offenSumme)),
      ueKpi,
      kpi("Fällig in 7 Tagen", f2.format(fb[hw] || 0), hw, anzahlRechnungen(fbL.length), fremd(fb)),
      kpi("Bezahlt letzte Woche", f2.format(bz[hw] || 0), hw, anzahlRechnungen(bzL.length), fremd(bz))));

    /* Diagramm «Bezahlt und offen pro Monat»: Hauptwährung, bezahlt Slot 1, offen Slot 2 */
    const pm = Array.isArray(d.proMonat) ? d.proMonat : [];
    const zeilen = pm.map((m) => {
      const [j, mo] = String(m.monat).split("-").map(Number);
      const b = (m.bezahlt && istZahl(m.bezahlt[hw])) ? m.bezahlt[hw] : 0, o = (m.offen && istZahl(m.offen[hw])) ? m.offen[hw] : 0;
      return { label: MONATE[mo - 1] || String(m.monat), lang: (MONATE_LANG[mo - 1] || "") + " " + j, werte: { b, o }, m };
    });
    const andere = [...new Set(pm.flatMap((m) => [...Object.keys(m.bezahlt || {}), ...Object.keys(m.offen || {})]))].filter((w) => w !== hw).sort();
    const leerDiag = zeilen.every((z) => !(z.werte.b > 0) && !(z.werte.o > 0));
    // Die Anzahl gehört zur Hauptwährung: je Währung, sobald der Server sie liefert (anzahlJe); sonst gilt sie für alle
    // Währungen des Monats und steht dann auch so da, statt neben dem CHF-Betrag eine falsche Zahl zu behaupten.
    const anzahlIn = (m) => {
      const je = m.anzahlJe;
      if (je && typeof je === "object") {
        const n = (o) => (o && istZahl(o[hw]) ? o[hw] : 0);
        return { b: n(je.bezahlt), o: n(je.offen), alle: false };
      }
      const fremdeW = [...Object.keys(m.bezahlt || {}), ...Object.keys(m.offen || {})].some((w) => w !== hw);
      return { b: istZahl(m.anzahlBezahlt) ? m.anzahlBezahlt : 0, o: istZahl(m.anzahlOffen) ? m.anzahlOffen : 0, alle: fremdeW };
    };
    const anzahl = (m) => { const a = anzahlIn(m); return `${a.b} bezahlt · ${a.o} offen` + (a.alle ? " (alle Währungen)" : ""); };
    const anzahlKurz = (m) => { const a = anzahlIn(m); return `${a.b} / ${a.o}` + (a.alle ? " (alle Währungen)" : ""); };
    let flaeche;
    if (ansicht.finanzen) {
      const betragIn = (o, w) => (o && istZahl(o[w]) ? geld(o[w], w) : "–");
      const weitereZeilen = zeilen.flatMap((z) => andere.filter((w) => istZahl((z.m.bezahlt || {})[w]) || istZahl((z.m.offen || {})[w]))
        .map((w) => h("tr", null, h("td", { text: z.lang }), h("td", { class: "r", text: betragIn(z.m.bezahlt, w) }), h("td", { class: "r", text: betragIn(z.m.offen, w) }))));
      const weitere = weitereZeilen.length ? [h("h3", { class: "etikett mt", text: "Weitere Währungen" }),
        h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("caption", { class: "sr", text: "Weitere Währungen pro Monat" }),
          h("thead", null, h("tr", null, h("th", { scope: "col", text: "Monat" }), h("th", { scope: "col", class: "r", text: "Bezahlt" }), h("th", { scope: "col", class: "r", text: "Offen" }))),
          h("tbody", null, weitereZeilen)))] : [];
      flaeche = h("div", null, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("caption", { class: "sr", text: "Bezahlt und offen pro Monat, " + hw }),
        h("thead", null, h("tr", null, h("th", { scope: "col", text: "Monat" }), h("th", { scope: "col", class: "r", text: "Bezahlt " + hw }), h("th", { scope: "col", class: "r", text: "Offen " + hw }), h("th", { scope: "col", class: "r", text: "Anzahl" }))),
        h("tbody", null, zeilen.map((z) => h("tr", null, h("td", { text: z.lang }), h("td", { class: "r", text: f2.format(z.werte.b) }), h("td", { class: "r", text: f2.format(z.werte.o) }),
          h("td", { class: "r t3", text: anzahlKurz(z.m) })))))), weitere);
    } else if (leerDiag) {
      flaeche = leer("diag", "Keine Rechnungen in den letzten sechs Monaten.", "Sobald ich eine erkenne, steht sie hier.");
    } else {
      const maxB = zeilen.reduce((m, z, i) => (z.werte.b > zeilen[m].werte.b ? i : m), 0);
      flaeche = [h("div", { class: "legende" }, h("span", null, h("i", { class: "k1" }), "Bezahlt"), h("span", null, h("i", { class: "k2" }), "Offen")),
        diagramm({ merk: "fd", titel: "Bezahlt und offen pro Monat in " + hw, zeilen, fuellen: true,
          reihen: [{ key: "b", label: "bezahlt", klasse: "s1" }, { key: "o", label: "offen", klasse: "s2" }],
          fmt: (x) => f2.format(x) + " " + hw, extra: (z) => [anzahl(z.m)],
          direkt: [{ i: maxB, key: "b", text: f0.format(zeilen[maxB].werte.b) }, { i: zeilen.length - 1, key: "o", text: f0.format(zeilen[zeilen.length - 1].werte.o) }] }, "fuellen")];
    }
    const unter = `${hw}, ${zeilen.length} Monate · offen nach Fälligkeit` + (andere.length ? ` · ${andere.join(", ")} in der Tabelle` : "");
    const diagKarte = h("div", { class: "karte diag-fuellt" },
      h("div", { class: "diag-kopf" }, h("div", null, h("h2", { text: "Bezahlt und offen pro Monat" }), h("p", { text: unter })), ansichtKnopf("finanzen")), flaeche);

    const liste = (titel, l, leerSatz, ueb) => h("div", { class: "karte" }, h("h2", { class: "etikett" }, titel, h("span", { class: "rest t3", text: anzahlRechnungen(l.length) })),
      l.length ? h("ul", { class: "liste" }, l.map((r) => h("li", null,
        h("div", { class: "haupt" }, h("b", { text: r.empfaenger || "Unbekannter Empfänger" }),
          h("span", null, ueb ? h("span", { class: "zustand z-ernst" }, ikon("warn", true), "fällig seit " + datum(r.faellig)) : "fällig " + datum(r.faellig))),
        h("span", { class: "betrag", text: istZahl(r.betrag) ? geld(r.betrag, r.waehrung) : "Betrag unklar" }))))
        : h("p", { class: "ruhig", text: leerSatz }));
    v.append(h("div", { class: "raster r-2-1 mt" }, diagKarte,
      h("div", { class: "spalte" }, liste("Überfällig", ueL, "Nichts überfällig, Sir.", true), liste("Fällig in 7 Tagen", fbL, "Diese Woche ist nichts fällig."))));
    v.append(h("div", { class: "hinweis mt" }, ikon("info"), "Zahlungen bereite ich nur vor; auslösen tun Sie in der Bank-App, Sir."));
  }

  /* ---------- Zeitpläne & Wachen ---------- */
  const TAGE = [["mo", "Mo", "Montag"], ["di", "Di", "Dienstag"], ["mi", "Mi", "Mittwoch"], ["do", "Do", "Donnerstag"], ["fr", "Fr", "Freitag"], ["sa", "Sa", "Samstag"], ["so", "So", "Sonntag"]];
  /**
   * Wie normaleTage im Server: Zeitpläne vor 0.22 tragen «täglich», «Mo,Mi» oder «mo, mi» (der Scheduler nimmt sie an).
   * Liefert taeglich, werktags oder die Liste in Wochenreihenfolge; null, wenn nichts davon passt.
   */
  function normTage(roh) {
    const t = String(roh ?? "").toLowerCase().replace(/\s/g, "");
    if (t === "taeglich" || t === "täglich") return "taeglich";
    if (t === "werktags") return "werktags";
    const teile = t.split(",");
    if (teile.some((x) => !TAGE.some(([k]) => k === x)) || new Set(teile).size !== teile.length) return null;
    return TAGE.map(([k]) => k).filter((k) => teile.includes(k)).join(",");
  }
  function tageText(roh) {
    const t = normTage(roh);
    if (t === null) return String(roh ?? "");
    if (t === "taeglich") return "Täglich";
    if (t === "werktags") return "Werktags";
    const m = Object.fromEntries(TAGE.map(([k, l]) => [k, l]));
    return t.split(",").map((x) => m[x]).join(", ");
  }
  const NUR_WENN = { immer: "immer", abwesend: "wenn Sie abwesend sind", nacht: "nachts" };
  const HERKUNFT = { chat: "angelegt im Chat", dashboard: "angelegt hier" };
  /** lastRun ist ein Tag (YYYY-MM-DD) wie im Scheduler; ältere Einträge können eine volle Zeit tragen */
  function zuletzt(x) {
    if (!x) return "noch nie gelaufen";
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) {
      const heute = heuteTag();
      if (x === heute) return "zuletzt heute";
      if (x === nachbar(heute, -1)) return "zuletzt gestern";
      return "zuletzt " + datumKurz(x);
    }
    return "zuletzt " + wannLang(x);
  }
  function naechsterText(z) {
    const d = alsDatum(z.naechsterLauf);
    if (!d) return "–";
    return d - jetzt() < MIN ? "jetzt" : wannTag(d) + " " + zeit(d);
  }
  const kamerasListe = () => (Q.status && Array.isArray(Q.status.kameras) ? Q.status.kameras.map((k) => String(k.name)) : []);
  /**
   * Anzeigename eines Zeitplans: von Hand bearbeitete Einträge ohne «name» liefert der Server mit name "" (textAnzeige).
   * Dann «Zeitplan #2» statt einer leeren Stelle in Liste, «Als Nächstes», Knöpfen und Löschfrage; ohne brauchbare ID
   * «Zeitplan ohne Namen». Der Bearbeiten-Dialog nimmt weiter den echten Wert (leeres Feld, die Prüfung verlangt einen).
   */
  function planName(z) {
    if (z && typeof z.name === "string" && z.name.trim()) return z.name.trim();
    const id = z ? z.id : undefined;
    return istZahl(id) || (typeof id === "string" && id.trim()) ? "Zeitplan #" + String(id).trim() : "Zeitplan ohne Namen";
  }
  function knoepfe(art, id, name) {
    const wort = art === "plan" ? "Zeitplan " : "Wache ";
    // Rückfallnamen wie «Zeitplan #2» tragen das Wort schon: nicht «Zeitplan Zeitplan #2 bearbeiten»
    const n = String(name ?? "");
    const ziel = n.startsWith(wort) ? n : wort + n;
    const belegt = inArbeit.has(art + ":" + id);
    return h("div", { class: "akt" },
      besetzt(h("button", { class: "knopf leise", type: "button", "data-aktion": art + "-edit", "data-id": id, "aria-label": ziel + " bearbeiten" }, ikon("stift", true), h("span", { text: "Bearbeiten" })), belegt),
      besetzt(h("button", { class: "knopf leise", type: "button", "data-aktion": art + "-weg", "data-id": id, "aria-label": ziel + " löschen" }, ikon("weg", true), h("span", { text: "Löschen" })), belegt));
  }
  function renderZeitplaene(v) {
    v.append(kopf("zeitplaene", "Zeitpläne & Wachen", "Was ich regelmässig tue – und wo ich hinschaue."));
    if (Q.status && Q.status.notfall) { v.append(gesperrtKarte()); return; }
    const pausiert = Boolean(Q.status && Q.status.pausiert);

    /* Zeitpläne */
    const zq = Q.zeitplaene; const zd = zq && zq.daten;
    const plaene = zd && Array.isArray(zd.zeitplaene) ? [...zd.zeitplaene].sort((a, b) => String(a.zeit).localeCompare(String(b.zeit)) || a.id - b.id) : [];
    const zUnter = !zd ? "Zeiten in Europe/Zurich" : (plaene.length === 1 ? "1 Zeitplan" : plaene.length + " Zeitpläne") + " · Zeiten in Europe/Zurich" + (pausiert ? " · während des Notaus läuft keiner" : "");
    const neuP = h("button", { class: "knopf prim", type: "button", "data-aktion": "plan-neu", disabled: !zd || zd.unlesbar }, ikon("plus", true), "Neuer Zeitplan");
    let zInhalt;
    if (!zq) zInhalt = h("p", { class: "ruhig", text: "Einen Moment, Sir. Ich hole die Zeitpläne." });
    else if (!zd) zInhalt = leer("warn", "Die Zeitpläne sind gerade nicht verfügbar.", fehlerText({ status: zq.fehler, daten: { text: zq.text } }));
    else if (zd.unlesbar) zInhalt = leer("warn", "data/zeitplaene.json ist unlesbar.", ohneSymbol(zd.text || "Ich ändere nichts, bis die Datei repariert ist, Sir."));
    else if (!plaene.length) zInhalt = leer("leer", "Keine Zeitpläne, Sir.", "Ich warte, bis Sie mich brauchen.");
    else zInhalt = h("div", null, plaene.map((z) => h("div", { class: "plan" },
      h("div", { class: "zeit" }, String(z.zeit), h("small", { text: tageText(z.tage) })),
      h("div", { class: "name", text: planName(z) }),
      h("div", { class: "det", text: z.auftrag }),
      // Ohne Auftrag (von Hand bearbeitet) läuft er nie: den Grund des Servers nennen statt «nächster –»
      h("div", { class: "lauf" }, typeof z.grund === "string" && z.grund ? h("span", null, "läuft nicht: ", h("b", { text: z.grund })) : h("span", null, "nächster ", h("b", { text: naechsterText(z) })), h("span", { text: zuletzt(z.lastRun) })),
      knoepfe("plan", z.id, planName(z)))));
    v.append(h("div", { class: "karte" }, h("div", { class: "diag-kopf" }, h("div", null, h("h2", { text: "Zeitpläne" }), h("p", { text: zUnter })), neuP), zInhalt));

    /* Wachen */
    const wq = Q.wachen; const wd = wq && wq.daten;
    const wachen = wd && Array.isArray(wd.wachen) ? wd.wachen : [];
    const ohneKamera = !kamerasListe().length;
    const neuW = h("button", { class: "knopf", type: "button", "data-aktion": "wache-neu", disabled: !wd || wd.unlesbar || ohneKamera }, ikon("plus", true), "Neue Wache");
    let wInhalt;
    if (!wq) wInhalt = h("p", { class: "ruhig", text: "Einen Moment, Sir. Ich hole die Wachen." });
    else if (!wd) wInhalt = leer("warn", "Die Wachen sind gerade nicht verfügbar.", fehlerText({ status: wq.fehler, daten: { text: wq.text } }));
    else if (wd.unlesbar) wInhalt = leer("warn", "data/wachen.json ist unlesbar.", ohneSymbol(wd.text || "Ich ändere nichts, bis die Datei repariert ist, Sir."));
    else if (!wachen.length) wInhalt = leer("auge", "Keine Wachen, Sir.", ohneKamera ? "Ohne Kamera in cameras.json gibt es nichts zu bewachen." : "Ich schaue nur hin, wenn Sie es wollen.");
    else wInhalt = h("div", null, wachen.map((w) => {
      // Ohne gültiges Intervall (von Hand bearbeitet) läuft die Wache nicht: «?» statt «undefined Minuten». Fehlt nur die
      // Kamera, bleibt das eingetragene Intervall stehen; den Grund nennt der Server (grund), sonst «Intervall fehlt»
      const mitTakt = istZahl(w.alle_minuten) && w.alle_minuten > 0;
      const laeuft = w.laeuft !== false && mitTakt;
      const grund = typeof w.grund === "string" && w.grund ? w.grund : "Intervall fehlt";
      return h("div", { class: "plan wache" },
      h("div", { class: "zeit" }, mitTakt ? String(w.alle_minuten) : "?", h("small", { text: "Minuten" })),
      h("div", { class: "name" }, h("span", { class: "mono", text: w.kamera }), " · ", w.frage),
      // Ungültige Bedingung (nur_wenn null): nie «immer» oder «null» zeigen; der Grund steht schon vorne
      h("div", { class: "det", text: (laeuft ? "" : "läuft nicht: " + grund + " · ") + (Object.hasOwn(NUR_WENN, w.nur_wenn) ? NUR_WENN[w.nur_wenn] + " · " : grund === "Bedingung ungültig" ? "" : "Bedingung ungültig · ") + `Ruhe ${istZahl(w.ruhe_minuten) ? w.ruhe_minuten : 30} Min nach einer Meldung` + (w.bearbeitbar ? " · " + (HERKUNFT[w.quelle] || "angelegt im Chat") : "") }),
      w.bearbeitbar && w.id != null ? knoepfe("wache", w.id, w.kamera) : h("div", { class: "akt" }, h("span", { class: "vermerk" }, ikon("lock", true), "cameras.json · nur lesend")));
    }));
    const wUnter = !wd ? "Kamera-Fragen in festen Abständen" : (wachen.length === 1 ? "1 Wache" : wachen.length + " Wachen") + " · Kamera-Fragen in festen Abständen" + (pausiert ? " · während des Notaus ruhen sie" : "");
    v.append(h("div", { class: "karte mt" }, h("div", { class: "diag-kopf" }, h("div", null, h("h2", { text: "Wachen" }), h("p", { text: wUnter })), neuW),
      h("div", { class: "hinweis wachen-hinweis" }, ikon("info"), wd && wd.hinweis ? ohneSymbol(wd.hinweis) : "Wachen schicken regelmässig Standbilder an die Claude-API (Haiku). Nur dort, wo Sie das wollen."),
      wInhalt));
  }

  /* Zeitplan-Dialog: dieselben Regeln wie pruefeZeitplan im Server; Feldfehler vom Server werden übernommen */
  let planId = null;
  const tageBox = $("pTage");
  TAGE.forEach(([k, l, lang]) => tageBox.append(h("label", { class: "chip" }, h("input", { type: "checkbox", value: k, "aria-label": lang }), h("span", { text: l }))));
  function tageArtSync() {
    const art = (document.querySelector('input[name="tageArt"]:checked') || {}).value;
    tageBox.querySelectorAll("input").forEach((i) => {
      i.disabled = art !== "liste";
      if (art === "taeglich") i.checked = true;
      if (art === "werktags") i.checked = ["mo", "di", "mi", "do", "fr"].includes(i.value);
    });
  }
  function zaehler() { $("pZaehler").textContent = $("pAuftrag").value.length + " / 2000"; }
  function fehlerZeigen(form, f) { form.querySelectorAll(".feldgr[data-feld]").forEach((gr) => feldFehler(gr, (f && typeof f[gr.dataset.feld] === "string") ? f[gr.dataset.feld] : "")); }
  function ersterFehlerFokus(form) {
    const gr = form.querySelector(".feldgr.ungueltig");
    const ziel = gr && (gr.querySelector("input:not([disabled]):not([type=radio]), textarea, select") || gr.querySelector("input:checked") || gr.querySelector("input"));
    if (ziel) ziel.focus();
  }
  function planWerte() {
    const art = (document.querySelector('input[name="tageArt"]:checked') || {}).value || "";
    const tage = art === "liste" ? [...tageBox.querySelectorAll("input:checked")].map((i) => i.value).join(",") : art;
    let zeitW = $("pZeit").value.trim();
    // Bequemlichkeit: «730», «0730» und «7:30» werden zu 07:30; die Prüfung bleibt streng
    if (/^\d{3,4}$/.test(zeitW)) zeitW = zeitW.padStart(4, "0").replace(/^(\d\d)(\d\d)$/, "$1:$2");
    if (/^\d:\d\d$/.test(zeitW)) zeitW = "0" + zeitW;
    return { name: $("pName").value.trim(), zeit: zeitW, tage, auftrag: $("pAuftrag").value.trim() };
  }
  function pruefePlan(e) {
    const f = {};
    if (e.name.length < 1 || e.name.length > 60) f.name = "Name: 1 bis 60 Zeichen, Sir.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.zeit)) f.zeit = "Uhrzeit als HH:MM zwischen 00:00 und 23:59, Sir.";
    const liste = e.tage.split(",");
    const gueltig = e.tage === "taeglich" || e.tage === "werktags" || (liste.every((x) => TAGE.some(([k]) => k === x)) && new Set(liste).size === liste.length);
    if (!e.tage || !gueltig) f.tage = "Mindestens einen Wochentag wählen, Sir.";
    if (e.auftrag.length < 1 || e.auftrag.length > 2000) f.auftrag = "Auftrag: 1 bis 2000 Zeichen, Sir.";
    return f;
  }
  function planOeffnen(z) {
    if (z === undefined) { toast("Diesen Zeitplan gibt es nicht mehr, Sir."); return; }
    planId = z ? z.id : null;
    $("planTitel").textContent = z ? "Zeitplan ändern" : "Neuer Zeitplan";
    // Zweite Absicherung (der Server liefert Texte): ältere Antworten ohne name/auftrag nie als «undefined» ins Feld
    $("pName").value = z ? (z.name ?? "") : "";
    $("pZeit").value = z ? z.zeit : "07:00";
    // Unbekannte Schreibweisen: so viele Tage wie erkennbar ankreuzen, die Prüfung meldet den Rest
    const tage = z ? normTage(z.tage) ?? String(z.tage ?? "").toLowerCase().replace(/\s/g, "") : "werktags";
    const art = tage === "taeglich" || tage === "werktags" ? tage : "liste";
    document.querySelectorAll('input[name="tageArt"]').forEach((r) => { r.checked = r.value === art; });
    tageArtSync();
    if (art === "liste") tageBox.querySelectorAll("input").forEach((i) => { i.checked = tage.split(",").includes(i.value); });
    $("pAuftrag").value = z ? (z.auftrag ?? "") : "";
    zaehler();
    fehlerZeigen($("planForm"), {});
    zeigeDialog($("dlgPlan"), $("pName"));
  }
  const findePlan = (id) => { const zd = Q.zeitplaene && Q.zeitplaene.daten; return zd && Array.isArray(zd.zeitplaene) ? zd.zeitplaene.find((z) => String(z.id) === String(id)) : undefined; };
  const findeWache = (id) => { const wd = Q.wachen && Q.wachen.daten; return wd && Array.isArray(wd.wachen) ? wd.wachen.find((w) => w.bearbeitbar && String(w.id) === String(id)) : undefined; };
  /** Gemeinsame Antwortbehandlung für Zeitplan- und Wache-Formular */
  async function formularSenden(o) {
    const ok = $(o.knopf);
    const hatteFokus = document.activeElement === ok;
    ok.disabled = true;
    const r = await api(o.pfad, { methode: o.methode, body: o.body });
    ok.disabled = false;
    if (!angemeldet) return;
    // disabled hat dem Knopf den Fokus genommen: im offenen Dialog zurückgeben (sonst liegt er auf dem Dialog selbst)
    const jetztFokus = document.activeElement;
    if (hatteFokus && $(o.dialog).open && (!jetztFokus || jetztFokus === document.body || jetztFokus === $(o.dialog))) ok.focus();
    if ((r.status === 200 || r.status === 201) && r.daten && r.daten.ok) {
      $(o.dialog).close("ok");
      toast(o.erfolg(r.daten));
      await holeQuelle(o.quelle);
      neuZeichnen();
      return;
    }
    if (r.status === 400 && r.daten && r.daten.fehler && typeof r.daten.fehler === "object") { fehlerZeigen($(o.form), r.daten.fehler); ersterFehlerFokus($(o.form)); return; }
    toast(fehlerText(r, o.fehlschlag));
    if (r.status === 404 || r.status === 423 || r.status === 503) { $(o.dialog).close("abbruch"); await holeQuelle(o.quelle); neuZeichnen(); }
  }
  $("planForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const w = planWerte(); const f = pruefePlan(w);
    fehlerZeigen($("planForm"), f);
    if (Object.keys(f).length) { ersterFehlerFokus($("planForm")); return; }
    const id = planId;
    await formularSenden({ knopf: "planOk", dialog: "dlgPlan", form: "planForm", quelle: "zeitplaene", fehlschlag: "Der Zeitplan kam nicht an",
      pfad: id == null ? "/api/zeitplaene" : "/api/zeitplaene/" + encodeURIComponent(id), methode: id == null ? "POST" : "PUT", body: w,
      erfolg: (d) => { const n = d.zeitplan && alsDatum(d.zeitplan.naechsterLauf); return ohneSymbol(d.text || "Gespeichert, Sir.") + (n ? " Nächster Lauf " + wannTag(n) + " " + zeit(n) + "." : ""); } });
  });

  /* Wache-Dialog: Kamera aus /status.json, Regeln wie pruefeWache im Server */
  let wacheId = null;
  const ganzOder = (t) => { const x = String(t).trim(); return /^\d+$/.test(x) ? Number(x) : x; };
  function wacheOeffnen(w) {
    if (w === undefined) { toast("Diese Wache gibt es hier nicht mehr, Sir."); return; }
    wacheId = w ? w.id : null;
    $("wacheTitel").textContent = w ? "Wache ändern" : "Neue Wache";
    const namen = kamerasListe();
    if (w && !namen.includes(w.kamera)) namen.push(w.kamera);
    $("wKamera").replaceChildren(...namen.map((k) => h("option", { value: k, selected: w ? w.kamera === k : null }, k)));
    $("wFrage").value = w ? w.frage : "";
    // Ohne gültiges Intervall (alle_minuten null) bleibt das Feld leer: die Prüfung verlangt dann einen Wert
    $("wAlle").value = w ? (istZahl(w.alle_minuten) ? String(w.alle_minuten) : "") : "30";
    $("wRuhe").value = String(w && istZahl(w.ruhe_minuten) ? w.ruhe_minuten : 30);
    // Ungültige Bedingung (nur_wenn null): keine Auswahl statt stillschweigend «immer» – die Prüfung verlangt eine Wahl
    $("wWenn").value = w ? (Object.hasOwn(NUR_WENN, w.nur_wenn) ? w.nur_wenn : "") : "abwesend";
    fehlerZeigen($("wacheForm"), {});
    zeigeDialog($("dlgWache"), $("wKamera"));
  }
  $("wacheForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const w = { kamera: $("wKamera").value, frage: $("wFrage").value.trim(), alle_minuten: ganzOder($("wAlle").value), nur_wenn: $("wWenn").value };
    if ($("wRuhe").value.trim() !== "") w.ruhe_minuten = ganzOder($("wRuhe").value);
    const f = {};
    const ganzIn = (n, a, b) => Number.isInteger(n) && n >= a && n <= b;
    if (!kamerasListe().includes(w.kamera)) f.kamera = "Diese Kamera kenne ich nicht, Sir.";
    if (w.frage.length < 1 || w.frage.length > 300) f.frage = "Frage: 1 bis 300 Zeichen, Sir.";
    if (!ganzIn(w.alle_minuten, 5, 1440)) f.alle_minuten = "Intervall: ganze Minuten von 5 bis 1440, Sir.";
    if (!Object.hasOwn(NUR_WENN, w.nur_wenn)) f.nur_wenn = "Bedingung: immer, abwesend oder nacht, Sir.";
    if ("ruhe_minuten" in w && !ganzIn(w.ruhe_minuten, 0, 1440)) f.ruhe_minuten = "Ruhezeit: ganze Minuten von 0 bis 1440, Sir.";
    fehlerZeigen($("wacheForm"), f);
    if (Object.keys(f).length) { ersterFehlerFokus($("wacheForm")); return; }
    const id = wacheId;
    await formularSenden({ knopf: "wacheOk", dialog: "dlgWache", form: "wacheForm", quelle: "wachen", fehlschlag: "Die Wache kam nicht an",
      pfad: id == null ? "/api/wachen" : "/api/wachen/" + encodeURIComponent(id), methode: id == null ? "POST" : "PUT", body: w,
      erfolg: (d) => ohneSymbol(d.text || "Gespeichert, Sir.") });
  });

  async function loeschen(art, id) {
    const plan = art === "plan";
    const x = plan ? findePlan(id) : findeWache(id);
    if (!x) { toast(plan ? "Diesen Zeitplan gibt es nicht mehr, Sir." : "Diese Wache gibt es hier nicht mehr, Sir."); return; }
    const ok = plan
      ? await frage("Zeitplan löschen?", `«${planName(x)}» läuft danach nicht mehr. Das lässt sich nicht rückgängig machen.`, "Löschen", true)
      : await frage("Wache löschen?", `Ich schaue dann nicht mehr auf «${x.kamera}». Das lässt sich nicht rückgängig machen.`, "Löschen", true);
    if (!ok) return;
    const key = art + ":" + id;
    if (inArbeit.has(key)) return;
    inArbeit.add(key); neuZeichnen();
    const r = await api((plan ? "/api/zeitplaene/" : "/api/wachen/") + encodeURIComponent(id), { methode: "DELETE" });
    inArbeit.delete(key);
    if (!angemeldet) return;
    toast(r.status === 200 && r.daten && r.daten.ok ? ohneSymbol(r.daten.text || "Gelöscht, Sir.") : fehlerText(r, "Das Löschen kam nicht an"));
    await holeQuelle(plan ? "zeitplaene" : "wachen");
    neuZeichnen();
  }

  /* ---------- Kameras: Standbilder alle 15 s, nur bei offenem Bereich und Tab im Vordergrund ---------- */
  /** name → { url (Object-URL), stand (Date), fehler (Text), ohneFrigate } */
  const bilder = new Map();
  function bilderLeeren() {
    for (const b of bilder.values()) if (b.url) URL.revokeObjectURL(b.url);
    bilder.clear();
    const gross = $("bildGross");
    if (gross) gross.removeAttribute("src");
  }
  /** Neues Bild an Ort und Stelle einsetzen (ohne Neuaufbau, kein Flackern), danach die alte Object-URL freigeben */
  function bildEinsetzen(name, b) {
    for (const img of document.querySelectorAll("img[data-kam]")) if (img.dataset.kam === name) img.src = b.url;
    for (const el of document.querySelectorAll(".live[data-kam]")) if (el.dataset.kam === name) el.replaceChildren(h("i"), zeitSek(b.stand));
    for (const el of document.querySelectorAll("button.kam[data-name]")) if (el.dataset.name === name) el.setAttribute("aria-label", "Kamera " + name + " vergrössern, Stand " + zeitSek(b.stand));
    const d = $("dlgBild");
    if (d.open && d.dataset.kam === name) { $("bildGross").src = b.url; $("bildStand").textContent = "· Stand " + zeitSek(b.stand); }
  }
  async function kameraRunde() {
    if (!angemeldet || document.hidden || aktuell !== "kameras" || !Q.status || Q.status.notfall) return;
    const namen = kamerasListe();
    await Promise.all(namen.map(async (name) => {
      const r = await api("/api/kamera/" + encodeURIComponent(name), { bild: true });
      if (!angemeldet || !Q.status || Q.status.notfall || aktuell !== "kameras") return;
      const alt = bilder.get(name);
      if (r.bild) {
        const neu = { url: URL.createObjectURL(r.bild), stand: jetzt(), fehler: null, ohneFrigate: false };
        bilder.set(name, neu);
        bildEinsetzen(name, neu);
        if (alt && alt.url) URL.revokeObjectURL(alt.url);
        return;
      }
      const roh = r.daten && typeof r.daten.error === "string" ? r.daten.error : "";
      const t = r.status === 404 ? "Diese Kamera steht nicht in cameras.json." : r.status === 0 ? "Ich erreiche den Dienst nicht." : roh ? ohneSymbol(roh, 140) : "Kein Bild (HTTP " + r.status + ").";
      bilder.set(name, { url: alt ? alt.url : null, stand: alt ? alt.stand : null, fehler: t, ohneFrigate: /FRIGATE_URL/.test(roh) });
    }));
    // Kameras, die nicht mehr in cameras.json stehen: Bild freigeben
    for (const [k, b] of [...bilder]) if (!namen.includes(k)) { if (b.url) URL.revokeObjectURL(b.url); bilder.delete(k); }
    rendern();
  }
  function renderKameras(v) {
    v.append(kopf("kameras", "Kameras", "Standbilder alle 15 Sekunden, solange dieser Bereich sichtbar ist."));
    const st = Q.status;
    if (st && st.notfall) { v.append(gesperrtKarte()); return; }
    if (!st) { v.append(h("div", { class: "karte" }, h("p", { class: "ruhig", text: "Einen Moment, Sir." }))); return; }
    if (st.camerasUnlesbar) { v.append(h("div", { class: "karte" }, leer("warn", "cameras.json ist unlesbar.", "Reparieren und Jarvis neu starten, Sir."))); return; }
    const kams = Array.isArray(st.kameras) ? st.kameras : [];
    if (!kams.length) { v.append(h("div", { class: "karte" }, leer("leer", "Keine Kameras eingerichtet, Sir.", ["Kameras trage ich aus ", h("code", { class: "cmd", text: "cameras.json" }), " ein."]))); return; }
    const zust = kams.map((k) => bilder.get(String(k.name)));
    if (zust.every((b) => b && !b.url && b.ohneFrigate)) {
      v.append(h("div", { class: "karte" }, leer("leer", "Frigate ist nicht eingerichtet, Sir.", ["Ohne ", h("code", { class: "cmd", text: "FRIGATE_URL" }), " in .env zeige ich keine Bilder."])));
      return;
    }
    v.append(h("div", { class: "kams" }, kams.map((k) => {
      const name = String(k.name); const b = bilder.get(name);
      const bild = b && b.url
        ? [h("img", { alt: "", src: b.url, "data-kam": name }), h("span", { class: "live", "aria-hidden": "true", "data-kam": name }, h("i"), zeitSek(b.stand))]
        : [h("span", { class: "kam-platz" }, b && b.fehler ? [ikon("warn"), h("span", { text: b.fehler })] : h("span", { text: "Ich hole das Bild …" }))];
      if (b && b.url && b.fehler) bild.push(h("span", { class: "kam-stoer" }, ikon("warn", true), "letztes Bild"));
      return h("button", { class: "karte kam", type: "button", "data-aktion": "kamera", "data-name": name, "aria-label": "Kamera " + name + " vergrössern" + (b && b.stand ? ", Stand " + zeitSek(b.stand) : "") },
        bild, h("span", { class: "unter" }, h("b", { text: name }), k.beschreibung ? h("span", { text: k.beschreibung }) : null));
    })));
  }
  function kameraGross(name) {
    const b = bilder.get(name);
    if (!b || !b.url) { toast("Noch kein Bild von «" + name + "», Sir."); return; }
    const d = $("dlgBild");
    d.dataset.kam = name;
    $("bildGross").src = b.url;
    $("bildGross").alt = "Standbild " + name;
    $("bildTitel").textContent = name;
    $("bildStand").textContent = "· Stand " + zeitSek(b.stand);
    zeigeDialog(d);
  }
  $("dlgBild").addEventListener("close", () => { delete $("dlgBild").dataset.kam; $("bildGross").removeAttribute("src"); });

  /* ---------- Gespräch: Verlauf nur im Speicher dieser Seite (beim Abmelden und im Notfall weg) ---------- */
  const gespraech = { verlauf: [], laeuft: false, entwurf: "", gen: 0 };
  function nachricht(m) {
    const ich = m.wer === "ich";
    return h("div", { class: "msg " + (ich ? "ich" : "jv") + (m.fehler ? " fehler" : "") },
      h("span", { class: "wer", text: (ich ? "Sie" : "Jarvis") + " · " + zeit(m.zeit) }), h("div", { class: "txt", text: m.text }),
      m.hinweis ? h("p", { class: "msg-hinweis" }, ikon("info", true), m.hinweis) : null);
  }
  function renderGespraech(v) {
    v.append(kopf("gespraech", "Gespräch", "Dasselbe Gedächtnis wie in Telegram."));
    if (Q.status && Q.status.notfall) { v.append(gesperrtKarte()); return; }
    const g = gespraech;
    const log = h("div", { class: "chat", id: "chatLog" },
      g.verlauf.length ? g.verlauf.map(nachricht) : h("p", { class: "ruhig chat-leer", text: "Fragen Sie, Sir. Ich antworte hier als Text; was länger dauert, schicke ich per Telegram." }),
      g.laeuft ? h("div", { class: "msg jv laeuft" }, h("span", { class: "wer", text: "Jarvis" }), h("div", { class: "txt" }, ikon("lauf", true), "läuft …"), h("div", { class: "laufband", "aria-hidden": "true" }, h("i"))) : null);
    const inp = h("input", { class: "feld", id: "chatIn", placeholder: "Sagen Sie es mir, Sir …", "aria-label": "Nachricht an Jarvis", autocomplete: "off", maxlength: 4000 });
    inp.value = g.entwurf;
    const form = h("form", { class: "eingabe", id: "chatForm" }, inp,
      h("button", { class: "knopf prim", type: "submit", id: "chatSenden", "aria-label": "Senden", disabled: g.laeuft }, ikon("senden", true), h("span", { class: "wort", text: "Senden" })));
    v.append(log, form);
  }
  function ansage(text) { const a = $("ansage"); a.textContent = ""; a.textContent = text; }
  async function chatSenden() {
    const g = gespraech;
    const text = g.entwurf.trim();
    if (!text || g.laeuft) return;
    const gen = g.gen;
    g.verlauf.push({ wer: "ich", text, zeit: jetzt().toISOString() });
    g.entwurf = ""; g.laeuft = true;
    // «Senden» ist während der Antwort gesperrt und hält keinen Fokus (Tab+Enter, in Chromium auch ein Klick):
    // der Fokus geht ins Eingabefeld, dort bleibt er über beide Neuaufbauten – nie auf <body>
    const knopf = $("chatSenden");
    if (knopf && document.activeElement === knopf && $("chatIn")) $("chatIn").focus({ preventScroll: true });
    rendern();
    const r = await api("/api/chat", { methode: "POST", body: { text }, frist: 75000 }); // der Server wartet bis 60 s
    if (!angemeldet || gen !== g.gen) return; // abgemeldet oder Notfall: nichts mehr anhängen
    // Ansage über ansageAktiv: das Gespräch wartet bis 60 s, ein Dialog (Notaus, Weiter mit PIN) macht #ansage inert
    g.laeuft = false;
    if (r.status === 200 && r.daten && r.daten.ok) {
      if (r.daten.queued) {
        g.verlauf.push({ wer: "jv", text: "Das braucht länger, Sir.", zeit: jetzt().toISOString(), hinweis: "Die Antwort kommt per Telegram." });
        ansageAktiv("Jarvis: Das braucht länger. Die Antwort kommt per Telegram.");
      } else {
        const antwort = typeof r.daten.reply === "string" && r.daten.reply ? r.daten.reply : "…";
        g.verlauf.push({ wer: "jv", text: antwort, zeit: jetzt().toISOString() });
        ansageAktiv("Jarvis: " + antwort);
      }
    } else {
      const t = fehlerText(r, "Das kam nicht an");
      g.verlauf.push({ wer: "jv", text: t, zeit: jetzt().toISOString(), fehler: true });
      ansageAktiv(t);
    }
    rendern();
  }

  /* ---------- Protokoll: Audit lesbar, nach Tagen gruppiert, Filter nach Ereignis ---------- */
  const filterP = { ereignis: "alle" };
  function renderProtokoll(v) {
    v.append(kopf("protokoll", "Protokoll", "Was geschehen ist, in lesbarer Form. Rohdaten liegen in data/audit.log."));
    if (Q.status && Q.status.notfall) { v.append(gesperrtKarte()); return; }
    const q = Q.audit;
    const hinweis = quelleHinweis(q, "Einen Moment, Sir. Ich lese das Protokoll.", "Das Protokoll ist gerade nicht verfügbar.");
    if (hinweis) { v.append(hinweis); return; }
    const alle = (Array.isArray(q.daten.eintraege) ? q.daten.eintraege : []).filter((e) => e && typeof e.ereignis === "string");
    if (!alle.length) { v.append(h("div", { class: "karte" }, leer("leer", "Noch nichts protokolliert, Sir.", "Sobald etwas geschieht, steht es hier."))); return; }
    const zahl = {};
    for (const e of alle) zahl[e.ereignis] = (zahl[e.ereignis] || 0) + 1;
    const evs = Object.keys(zahl).sort((a, b) => a.localeCompare(b, "de"));
    const wahl = filterP.ereignis === "alle" || Object.hasOwn(zahl, filterP.ereignis) ? filterP.ereignis : "alle";
    const liste = alle.filter((e) => wahl === "alle" || e.ereignis === wahl);
    v.append(h("div", { class: "filter" }, h("label", { class: "kl", for: "protFilter" }, "Ereignis"),
      h("select", { class: "wahl", id: "protFilter", "data-filter": "ereignis", "data-merk": "p-ereignis" },
        h("option", { value: "alle", selected: wahl === "alle" }, `Alle Ereignisse (${alle.length})`),
        evs.map((e) => h("option", { value: e, selected: wahl === e }, `${e} (${zahl[e]})`))),
      h("span", { class: "anzahl", text: liste.length === 1 ? "1 Zeile" : liste.length + " Zeilen" })));
    const gruppen = [];
    for (const e of liste) { const t = tagName(e.zeit); const g = gruppen[gruppen.length - 1]; if (g && g.t === t) g.l.push(e); else gruppen.push({ t, l: [e] }); }
    v.append(h("div", { class: "karte prot" }, gruppen.map((g) => [h("h2", { class: "vtag", text: g.t }),
      h("ul", { class: "liste audit" }, g.l.map((e) => h("li", null, h("span", { class: "zeitm", text: zeit(e.zeit) }), h("span", { class: "ev", text: e.ereignis }), h("span", { class: "info", text: e.info || "–" }))))]),
      h("p", { class: "kfuss" }, ikon("lock", true), "Die letzten 60 Zeilen · Werte geschwärzt und gekürzt · Rohdaten in data/audit.log.")));
  }

  const nurNotfall = (st) => Boolean(st && st.notfall);
  const BEREICHE = {
    uebersicht: { titel: "Übersicht", quellen: ["kosten14", "finanzen", "zeitplaene", "wachen"], render: renderUebersicht },
    freigaben: { titel: "Freigaben", quellen: ["auftraege"], render: renderFreigaben, zustand: () => filterF },
    kosten: { titel: "Kosten", quellen: ["kosten"], render: renderKosten, zustand: () => [kTage, kostenLaedt, ansicht.kosten], status: nurNotfall, takt: STD },
    finanzen: { titel: "Finanzen", quellen: ["finanzen"], render: renderFinanzen, zustand: () => ansicht.finanzen, status: nurNotfall, takt: STD },
    zeitplaene: { titel: "Zeitpläne & Wachen", quellen: ["zeitplaene", "wachen"], render: renderZeitplaene, status: (st) => st && [st.notfall, st.pausiert, st.kameras], takt: STD },
    kameras: { titel: "Kameras", quellen: [], render: renderKameras, zustand: () => [...bilder].map(([k, b]) => [k, Boolean(b.url), b.fehler]),
      status: (st) => st && [st.notfall, st.kameras, st.camerasUnlesbar], takt: STD },
    gespraech: { titel: "Gespräch", quellen: [], render: renderGespraech, zustand: () => [gespraech.verlauf.length, gespraech.laeuft, gespraech.gen], status: nurNotfall, takt: STD },
    protokoll: { titel: "Protokoll", quellen: ["audit"], render: renderProtokoll, zustand: () => filterP, status: nurNotfall, takt: STD },
    sicherheit: { titel: "Sicherheit", quellen: [], render: renderSicherheit },
  };

  /* ---------- Darstellen: nur bei geänderten Daten, Fokus und offene Details bleiben ---------- */
  function statusSig() {
    const st = Q.status; if (!st) return null;
    const { zeit: _z, gesundheit, ...rest } = st;
    const g = {};
    for (const [k, z] of Object.entries(gesundheit || {})) { const { letzterOk: _o, ...r } = z || {}; g[k] = r; }
    return [rest, g];
  }
  function rendern() {
    if (!angemeldet) return;
    leiste();
    const b = BEREICHE[aktuell];
    const v = V(aktuell);
    // Bereiche ohne Minutenanzeige (takt) und mit eigenem Statusausschnitt zeichnen seltener neu: Tooltip und Eingabe bleiben ruhig
    const st = b.status ? b.status(Q.status) : statusSig();
    const sig = JSON.stringify([st, b.quellen.map((q) => Q[q] || null), Q.finanzen || null, Math.floor(jetzt() / (b.takt || MIN)), b.zustand ? b.zustand() : null, [...inArbeit]]);
    if (sig === letzteSig[aktuell]) return;
    letzteSig[aktuell] = sig;
    const aktiv = document.activeElement;
    const fokusKey = v.contains(aktiv) ? schluessel(aktiv) : null;
    const ersatz = fokusKey ? ersatzSchluessel(aktiv) : [];
    const auswahl = fokusKey && (aktiv instanceof HTMLInputElement || aktiv instanceof HTMLTextAreaElement) && aktiv.type !== "number" ? [aktiv.selectionStart, aktiv.selectionEnd] : null;
    const offenKeys = [...v.querySelectorAll("details[data-merk][open]")].map((d) => d.dataset.merk);
    v.querySelectorAll(".diagramm").forEach((el) => ro.unobserve(el));
    nachher = [];
    const neu = document.createDocumentFragment();
    const huelleEl = h("div");
    b.render(huelleEl);
    neu.append(...huelleEl.childNodes);
    v.replaceChildren(neu);
    const fertig = nachher; nachher = [];
    for (const f of fertig) f();
    for (const k of offenKeys) { const d = v.querySelector(`details[data-merk="${CSS.escape(k)}"]`); if (d) d.open = true; }
    if (fokusKey) {
      const z = findeSchluessel(v, fokusKey);
      if (z) { z.focus({ preventScroll: true }); if (auswahl && typeof z.setSelectionRange === "function") try { z.setSelectionRange(auswahl[0], auswahl[1]); } catch { /* Feldtyp ohne Auswahl */ } }
      // Element weg (Auftrag erledigt, Zeitplan gelöscht) oder nicht fokussierbar: Nachbar in derselben Karte, sonst main – nie <body>
      if (!z || document.activeElement !== z) {
        const ziel = ersatz.map((k) => findeSchluessel(v, k)).find((el) => { if (!el) return false; el.focus({ preventScroll: true }); return document.activeElement === el; });
        if (!ziel) $("main").focus({ preventScroll: true });
        // Der Nachbar liegt oft anderswo als das alte Element (und die Seite wurde kürzer): sichtbar machen, nie unter der Leiste
        insBild(ziel || $("main"));
      }
    }
  }
  /** Ersatz-Fokus ins Bild: liegt er (ganz oder teilweise) unter der Sticky-Leiste oder unterhalb, scrollt scroll-padding-top ihn frei */
  function insBild(el) {
    const kopf = document.querySelector("header.top");
    const oben = kopf ? kopf.getBoundingClientRect().bottom : 0;
    const r = el.getBoundingClientRect();
    const passt = r.height <= innerHeight - oben;
    // Grösser als der freie Platz (etwa main): nur holen, wenn nichts davon zu sehen ist
    const aussen = passt ? r.top < oben || r.bottom > innerHeight : r.bottom <= oben || r.top >= innerHeight;
    if (aussen) el.scrollIntoView({ block: "nearest" });
  }
  const FOKUSSIERBAR = "a[href], button, select, input, textarea, summary, [tabindex]";
  /** Schlüssel der Nachbarn von el in seiner Karte (erst die folgenden, dann die vorherigen), zuletzt der Anker der Karte */
  function ersatzSchluessel(el) {
    const karte = el.closest(".karte") || el.closest(".view");
    if (!karte) return [];
    const alle = [...karte.querySelectorAll(FOKUSSIERBAR)].filter((x) => x !== el);
    const nach = alle.filter((x) => el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
    const vor = alle.filter((x) => el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING).reverse();
    const keys = [...nach, ...vor].map(schluessel);
    if (karte.id && karte.getAttribute("tabindex") === "-1") keys.push("#" + karte.id);
    return keys.filter(Boolean);
  }

  /* ---------- Obere Leiste ---------- */
  let notausZustand = null;
  // Genaue Leistenhöhe für scroll-padding (die CSS-Werte sind nur grosszügige Schätzungen); per CSSOM, CSP-konform
  function kopfHoehe() {
    const kopf = document.querySelector("header.top");
    if (kopf) document.documentElement.style.setProperty("--kopf-h", kopf.offsetHeight + "px");
  }
  window.addEventListener("resize", kopfHoehe);
  function leiste() {
    const st = Q.status;
    if (!st) return;
    const z = $("zustand");
    z.classList.toggle("pausiert", Boolean(st.pausiert) && !st.notfall);
    z.classList.toggle("notfall", Boolean(st.notfall));
    const wort = st.notfall ? "Notfall" : st.pausiert ? "Pausiert" : "Bereit";
    if ($("zustandText").textContent !== wort) $("zustandText").textContent = wort;
    $("bandNotfall").hidden = !st.notfall;
    kopfHoehe();
    document.querySelectorAll("[data-modus]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.modus === st.modus)));
    const angehalten = Boolean(st.pausiert || st.notfall);
    // Im Notfall ist «Weiter» gesperrt (erst /entwarnung in Telegram): sichtbar, aber nicht bedienbar
    const knopfZustand = st.notfall ? "notfall" : angehalten ? "pause" : "an";
    if (notausZustand !== knopfZustand) {
      notausZustand = knopfZustand;
      const nk = $("notausKnopf");
      nk.dataset.aktion = angehalten ? "weiter" : "notaus";
      nk.className = "knopf notaus" + (angehalten ? "" : " gefahr");
      // Gesperrt per aria-disabled wie besetzt(): disabled nähme einem fokussierten Knopf den Fokus (Notfall aus Telegram,
      // anderem Tab oder beim Schliessen des PIN-Dialogs, der ihn zurückgibt) – er fiele auf <body>. Klick und weiter() prüfen selbst.
      nk.disabled = false;
      if (st.notfall) besetzt(nk, true);
      else { nk.removeAttribute("aria-disabled"); nk.style.opacity = ""; nk.style.cursor = ""; }
      nk.replaceChildren(ikon(angehalten ? "lock" : "pause", true), h("span", { text: angehalten ? "Weiter" : "Notaus" }));
      nk.setAttribute("aria-label", st.notfall ? "Weiter erst nach /entwarnung in Telegram" : angehalten ? "Weiter mit PIN" : "Notaus: sofort alles anhalten");
    }
    const zahl = (el, n, wortZ) => {
      const t = String(n) + "|" + wortZ;
      if (el.dataset.stand === t) return;
      el.dataset.stand = t;
      el.replaceChildren(String(n), h("span", { class: "sr", text: " " + wortZ }));
      el.hidden = !n;
    };
    if (st.notfall) zahl($("zahlFreigaben"), istZahl(st.offeneAuftraege) ? st.offeneAuftraege : 0, "offen");
    else zahl($("zahlFreigaben"), wartende().length, "warten");
    const fd = !st.notfall && Q.finanzen && Q.finanzen.daten;
    zahl($("zahlFinanzen"), fd && Array.isArray(fd.ueberfaellig) ? fd.ueberfaellig.length : 0, "überfällig");
  }
  function uhr() {
    if (!angemeldet) return;
    const d = jetzt();
    $("uhr").replaceChildren(h("span", { class: "datum", text: d.toLocaleDateString("de-CH", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" }) + " " }),
      h("b", { text: zeit(d) }));
  }
  setInterval(uhr, 10000);

  /* ---------- Hash-Routing ---------- */
  function route() {
    const id = (location.hash || "#uebersicht").slice(1);
    aktuell = Object.hasOwn(BEREICHE, id) ? id : "uebersicht";
    for (const k of Object.keys(BEREICHE)) V(k).hidden = k !== aktuell;
    const nav = $("tabs");
    nav.querySelectorAll("a").forEach((a) => {
      if (a.getAttribute("href") === "#" + aktuell) {
        a.setAttribute("aria-current", "page");
        // Reiter in Sicht holen, ohne scrollIntoView (verschöbe die Seite); der Rand bleibt frei
        const pad = parseFloat(getComputedStyle(nav).paddingLeft) || 0;
        const x = a.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
        if (x - pad < nav.scrollLeft) nav.scrollLeft = Math.max(0, x - pad);
        else if (x + a.offsetWidth + pad > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = x + a.offsetWidth + pad - nav.clientWidth;
      } else a.removeAttribute("aria-current");
    });
    document.title = "JARVIS · " + BEREICHE[aktuell].titel;
    letzteSig[aktuell] = null;
    fremdeFehlerWeg();
    stoerungZeigen(true);
    rendern();
    zyklen();
  }
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

  /* ---------- Thema: ohne Wahl gilt prefers-color-scheme; der Umschalter setzt data-theme und merkt es ---------- */
  const mqHell = matchMedia("(prefers-color-scheme: light)");
  const effektiv = () => document.documentElement.getAttribute("data-theme") || (mqHell.matches ? "light" : "dark");
  function themaKnopf() {
    const t = effektiv(); const b = $("thema");
    b.replaceChildren(ikon(t === "dark" ? "sonne" : "mond"));
    b.setAttribute("aria-label", t === "dark" ? "Helles Thema" : "Dunkles Thema");
  }
  {
    const t = lies("localStorage", "jarvis.thema");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    themaKnopf();
  }
  mqHell.addEventListener("change", themaKnopf);
  $("thema").addEventListener("click", () => {
    const t = effektiv() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    schreib("localStorage", "jarvis.thema", t);
    themaKnopf();
  });

  /* ---------- Aktionen ---------- */
  function neuZeichnen() { letzteSig = {}; rendern(); }

  async function modusSetzen(m) {
    const st = Q.status; if (!st || st.modus === m) return;
    if (st.notfall) { toast("Im Notfall ändere ich den Modus nicht, Sir."); return; }
    const alt = st.modus;
    st.modus = m; neuZeichnen();
    const r = await api("/api/modus", { methode: "POST", body: { modus: m } });
    if (r.status === 200 && r.daten && r.daten.ok) toast("Modus " + ({ normal: "Normal", fokus: "Fokus", nacht: "Nacht" }[m] || m) + ", Sir.");
    else { if (Q.status === st) st.modus = alt; neuZeichnen(); toast(fehlerText(r, "Den Modus konnte ich nicht setzen")); }
    void holeStatus();
  }

  const auftragText = (d) => ohneSymbol(d && d.text ? d.text : "Erledigt, Sir.");
  /** Text des Auftrags bei einem Zeitlimit: der Dienst führt ihn weiter aus und meldet das Ergebnis in Telegram */
  const AUFTRAG_LANG = "Das dauert länger, Sir. Der Auftrag läuft weiter, das Ergebnis kommt per Telegram.";
  /** stumm: der Aufrufer sagt die Rückmeldung selbst an (PIN-Dialog, nach dem Schliessen) */
  async function nachAuftrag(d, stumm) {
    if (!stumm) toast(auftragText(d));
    await holeStatus();
    if (Q.auftraege) { await holeQuelle("auftraege"); rendern(); }
  }
  async function freigeben(id) {
    const a = offene().find((x) => String(x.id) === id);
    if (!a || inArbeit.has(id)) return;
    if (a.stufe === "sensibel") {
      pinAbfrage({
        titel: "PIN, bitte", text: `Auftrag #${a.id}: ${a.summary}`, ok: "Freigeben",
        hilfe: "Eine falsche PIN lehnt den Auftrag ab – wie in Telegram. Nach drei Fehlversuchen nehme ich hier zehn Minuten lang keine PIN an.",
        senden: async (pin) => {
          const r = await api("/api/auftrag", { methode: "POST", body: { id: a.id, aktion: "ok", pin } });
          if (r.status === 200 && r.daten && r.daten.ok) { void nachAuftrag(r.daten, true); return { fertig: true, meldung: auftragText(r.daten) }; }
          if (r.status === 429 || r.status === 400) return { fehler: fehlerText(r) };
          void holeStatus();
          return { fertig: true, meldung: fehlerText(r, "Die Freigabe kam nicht an", AUFTRAG_LANG) };
        },
      });
      return;
    }
    inArbeit.add(id); neuZeichnen();
    const r = await api("/api/auftrag", { methode: "POST", body: { id: a.id, aktion: "ok" } });
    inArbeit.delete(id);
    if (r.status === 200 && r.daten && r.daten.ok) await nachAuftrag(r.daten);
    else { toast(fehlerText(r, "Die Freigabe kam nicht an", AUFTRAG_LANG)); neuZeichnen(); if (r.zeitlimit) void holeStatus(); }
  }
  async function ablehnen(id) {
    const a = offene().find((x) => String(x.id) === id);
    if (!a || inArbeit.has(id)) return;
    inArbeit.add(id); neuZeichnen();
    const r = await api("/api/auftrag", { methode: "POST", body: { id: a.id, aktion: "nein" } });
    inArbeit.delete(id);
    if (r.status === 200 && r.daten && r.daten.ok) await nachAuftrag(r.daten);
    else { toast(fehlerText(r, "Die Ablehnung kam nicht an")); neuZeichnen(); }
  }
  async function protokoll(name) {
    const key = "p:" + name;
    if (inArbeit.has(key)) return;
    inArbeit.add(key); neuZeichnen();
    const gen = quellenGen;
    const r = await api("/api/protokoll", { methode: "POST", body: { name } });
    inArbeit.delete(key);
    // Inzwischen Notfall (oder geleert): kein Protokolltext mehr in Toast und Ansage, ein 423 zeigt nur den Sperrtext
    const verworfen = gen !== quellenGen || Boolean(Q.status && Q.status.notfall);
    if (!verworfen || r.status === 423) toast(r.status === 200 && r.daten && r.daten.ok ? ohneSymbol(r.daten.text || "Erledigt, Sir.") : fehlerText(r, "Das Protokoll kam nicht an", "Das dauert länger, Sir. Das Protokoll läuft weiter; den Stand sehen Sie gleich hier."));
    await holeStatus();
    neuZeichnen();
  }
  async function notausAn() {
    if (!(await frage("Notaus?", "Ich halte sofort alles an: keine Werkzeuge, keine Zeitpläne, keine Wachen. Fortsetzen nur mit Ihrer PIN.", "Notaus", true))) return;
    const r = await api("/api/notaus", { methode: "POST", body: { an: true } });
    if (r.status === 200 && r.daten && r.daten.ok) { if (Q.status) Q.status.pausiert = true; toast("Angehalten, Sir. Nichts läuft, bis Sie mit PIN fortsetzen."); }
    else toast(fehlerText(r, "Der Notaus kam nicht an"));
    neuZeichnen();
    void holeStatus();
  }
  function weiter() {
    if (Q.status && Q.status.notfall) { toast("Erst /entwarnung in Telegram, Sir."); return; }
    pinAbfrage({
      titel: "Weiter mit PIN", text: "Hebt den Notaus auf. Danach laufen Werkzeuge, Zeitpläne und Wachen wieder.", ok: "Fortsetzen",
      hilfe: "Nach drei Fehlversuchen nehme ich hier zehn Minuten lang keine PIN an.",
      senden: async (pin) => {
        const r = await api("/api/notaus", { methode: "POST", body: { an: false, pin } });
        if (r.status === 200 && r.daten && r.daten.ok) {
          if (Q.status && r.daten.pausiert === false) Q.status.pausiert = false;
          neuZeichnen(); void holeStatus();
          return { fertig: true, meldung: ohneSymbol(r.daten.text || "Weiter, Sir.") };
        }
        if (r.status === 403 || r.status === 429 || r.status === 400) return { fehler: fehlerText(r) };
        void holeStatus();
        return { fertig: true, meldung: fehlerText(r, "Das Fortsetzen kam nicht an") };
      },
    });
  }
  async function notfallAusloesen() {
    if (!(await frage("Notfall auslösen?", "Ich isoliere, sperre und alarmiere. Nur im Ernstfall.", "Weiter", true))) return;
    if (!(await frage("Sicher, Sir?", "Zweite Bestätigung. Die Entwarnung geht danach nur per /entwarnung in Telegram.", "Notfall auslösen", true))) return;
    const r = await api("/api/notfall", { methode: "POST", body: { bestaetigt: true } });
    // Erst den Status holen: der Wechsel in den Notfall leert Ansage und Toast, die Bestätigung kommt danach
    await holeStatus();
    if (!angemeldet) return;
    toast(r.status === 200 && r.daten && r.daten.ok ? ohneSymbol(r.daten.text || "Notfall ausgelöst, Sir.") : fehlerText(r, "Der Notfall kam nicht an"));
  }

  /** Aktionen über data-aktion (Event-Delegation, keine Inline-Handler). */
  const AKTIONEN = {
    freigeben: (b) => freigeben(b.dataset.id),
    ablehnen: (b) => ablehnen(b.dataset.id),
    protokoll: (b) => protokoll(b.dataset.name),
    notaus: () => notausAn(),
    weiter: () => weiter(),
    notfall: () => notfallAusloesen(),
    abmelden: () => abmelden(),
    ansicht: (b) => { if (Object.hasOwn(ansicht, b.dataset.id)) { ansicht[b.dataset.id] = !ansicht[b.dataset.id]; rendern(); } },
    "plan-neu": () => planOeffnen(null),
    "plan-edit": (b) => planOeffnen(findePlan(b.dataset.id)),
    "plan-weg": (b) => loeschen("plan", b.dataset.id),
    "wache-neu": () => wacheOeffnen(null),
    "wache-edit": (b) => wacheOeffnen(findeWache(b.dataset.id)),
    "wache-weg": (b) => loeschen("wache", b.dataset.id),
    kamera: (b) => kameraGross(b.dataset.name),
  };

  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const zu = t.closest("[data-schliessen]");
    if (zu) { zu.closest("dialog").close("abbruch"); return; }
    const skip = t.closest("a.skip");
    if (skip) { e.preventDefault(); $("main").focus(); return; }
    const sprung = t.closest("a[data-ziel]");
    if (sprung) {
      e.preventDefault();
      const z = $(sprung.dataset.ziel);
      if (z) {
        z.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
        z.setAttribute("tabindex", "-1");
        z.focus({ preventScroll: true });
      }
      return;
    }
    if (!angemeldet) return;
    const m = t.closest("[data-modus]");
    if (m) { void modusSetzen(m.dataset.modus); return; }
    const fs = t.closest("[data-fstatus]");
    if (fs) { filterF.status = fs.dataset.fstatus; rendern(); return; }
    const kt = t.closest("[data-tage]");
    if (kt) { void zeitraumSetzen(Number(kt.dataset.tage)); return; }
    const b = t.closest("[data-aktion]");
    if (b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && Object.hasOwn(AKTIONEN, b.dataset.aktion)) void AKTIONEN[b.dataset.aktion](b);
  });
  document.addEventListener("change", (e) => {
    const sel = e.target instanceof Element ? e.target.closest("select[data-filter]") : null;
    if (!sel) return;
    if (sel.dataset.filter === "stufe") filterF.stufe = sel.value;
    else if (sel.dataset.filter === "status") filterF.status = sel.value;
    else if (sel.dataset.filter === "ereignis") filterP.ereignis = sel.value;
    rendern();
  });
  document.addEventListener("change", (e) => { if (e.target instanceof HTMLInputElement && e.target.name === "tageArt") tageArtSync(); });
  document.addEventListener("input", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.id === "chatIn") gespraech.entwurf = t.value;
    else if (t.id === "pAuftrag") zaehler();
  });
  document.addEventListener("submit", (e) => {
    if (!(e.target instanceof HTMLFormElement) || e.target.id !== "chatForm") return;
    e.preventDefault();
    if (angemeldet) void chatSenden();
  });
  // Segmente als Radiogruppe: Pfeiltasten wählen den Nachbarn
  document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const knopf = e.target instanceof Element ? e.target.closest('.seg[role="radiogroup"] > button') : null;
    if (!knopf) return;
    const alle = [...knopf.parentElement.querySelectorAll(":scope > button")];
    const i = alle.indexOf(knopf);
    const n = alle[(i + (e.key === "ArrowRight" ? 1 : alle.length - 1)) % alle.length];
    e.preventDefault();
    n.click();
    const key = schluessel(n);
    const ziel = findeSchluessel(n.closest("section") || document, key) || n;
    if (ziel.isConnected) ziel.focus();
  });

  /* ---------- Start ---------- */
  (async () => {
    entferne("localStorage", "jarvis.dash");
    entferne("sessionStorage", ALT_SITZUNG);
    token = lies("sessionStorage", TOKEN_KEY) || lies("localStorage", TOKEN_KEY);
    if (!token) { anmeldenZeigen(""); return; }
    const r = await api("/status.json");
    if (r.status === 200 && r.daten && r.daten.ok) { schreib("sessionStorage", TOKEN_KEY, token); starten(r.daten); return; }
    if (r.status === 401) { tokenVergessen(); anmeldenZeigen("Der gespeicherte Token gilt nicht mehr, Sir."); return; }
    // Dienst gerade nicht erreichbar: anmelden lassen wir, die Abfragen versuchen es weiter
    fehler.status = true;
    starten(null);
    stoerungZeigen();
  })();
})();
