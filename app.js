/* Stromzähler – reine Browser-App.
 * Speichert alles lokal (localStorage), rechnet alles im Browser.
 * Kein Server, kein Internet (nach dem ersten Laden) nötig.
 */

"use strict";

// Zwei getrennte Bereiche ("Reiter"): eigene Daten + Beispiel-Daten.
// Jeder Reiter hat seinen eigenen Speicher und stört den anderen nie.
const STORAGE_KEYS = {
  main: "stromzaehler.readings.v2",   // "Meine Daten" – startet leer
  demo: "stromzaehler.demo.v1",       // "Beispiel" – mit Demo-Daten gefüllt
};
const ACTIVE_TAB_KEY = "stromzaehler.activeTab";
let currentMode = "main";             // "main" | "demo"
const MONTHS_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

// ---------------------------------------------------------------------------
// Datenhaltung
// ---------------------------------------------------------------------------
let readings = [];   // [{id, date:"YYYY-MM-DD", value:Number}]
let nextId = 1;

function load() {
  const key = STORAGE_KEYS[currentMode];
  let raw = null;
  try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
  let data;
  if (raw) {
    try { data = JSON.parse(raw); } catch (e) { data = []; }
  } else if (currentMode === "demo" && window.SEED_DATA) {
    data = window.SEED_DATA;   // erster Start des Beispiel-Reiters -> Demo-Daten
  } else {
    data = [];                 // "Meine Daten" startet leer
  }
  readings = data.map((r) => ({
    id: nextId++, date: r.date, value: Number(r.value),
    comment: r.comment ? String(r.comment) : "",
  }));
  save();
}

function save() {
  try {
    const slim = readings.map((r) =>
      r.comment ? { date: r.date, value: r.value, comment: r.comment }
                : { date: r.date, value: r.value });
    localStorage.setItem(STORAGE_KEYS[currentMode], JSON.stringify(slim));
  } catch (e) { /* Speicher voll/gesperrt – ignorieren */ }
}

function sortedAsc() {
  return [...readings].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id);
}

// ---------------------------------------------------------------------------
// Datums-Helfer (alles in UTC-Millisekunden, um Zeitzonen-Probleme zu meiden)
// ---------------------------------------------------------------------------
function toMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function days(aMs, bMs) { return (bMs - aMs) / 86400000; }
function monthStart(y, m) { return Date.UTC(y, m - 1, 1); }   // m: 1-basiert
function monthEnd(y, m) { return Date.UTC(y, m, 1); }         // nächster Monat
function yearStart(y) { return Date.UTC(y, 0, 1); }
function yearEnd(y) { return Date.UTC(y + 1, 0, 1); }

// Heute (lokales Datum) als UTC-Millisekunden auf Mitternacht
function todayMs() {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

// ---------------------------------------------------------------------------
// Zahlen-Formatierung
// ---------------------------------------------------------------------------
function g(n) {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}
function f0(n) { return String(Math.round(n)); }
function f1(n) { return n.toFixed(1); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Berechnungen (1:1 wie die frühere Python-Logik)
// ---------------------------------------------------------------------------
function buildInterpolator(pointsAsc) {
  const pts = [];
  for (const r of pointsAsc) {
    const t = toMs(r.date);
    if (pts.length && pts[pts.length - 1].t === t) {
      pts[pts.length - 1].v = r.value;       // gleicher Tag -> letzten Wert
    } else {
      pts.push({ t, v: r.value });
    }
  }
  if (!pts.length) return null;
  const first = pts[0].t, last = pts[pts.length - 1].t;
  function valueAt(target) {
    if (target <= first) return pts[0].v;
    if (target >= last) return pts[pts.length - 1].v;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t >= target) {
        const a = pts[i - 1], b = pts[i];
        const frac = (target - a.t) / (b.t - a.t);
        return a.v + frac * (b.v - a.v);
      }
    }
    return pts[pts.length - 1].v;
  }
  return { valueAt, first, last };
}

function consumptionBetween(interp, a, b) {
  a = Math.max(a, interp.first);
  b = Math.min(b, interp.last);
  if (a >= b) return null;
  return interp.valueAt(b) - interp.valueAt(a);
}

function computeStats(asc) {
  if (!asc.length) return null;
  const latest = asc[asc.length - 1];
  const stats = {
    count: asc.length,
    latestValue: latest.value,
    latestDate: latest.date,
    total: null,
    perDay: null,
  };
  if (asc.length >= 2) {
    const first = asc[0];
    const d = days(toMs(first.date), toMs(latest.date));
    stats.total = latest.value - first.value;
    if (d > 0) stats.perDay = stats.total / d;
  }
  return stats;
}

function computeYears(asc) {
  if (asc.length < 2) return [];
  const interp = buildInterpolator(asc);
  const years = [];
  let prevPerMonth = null;
  const y0 = new Date(interp.first).getUTCFullYear();
  const y1 = new Date(interp.last).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    const yS = yearStart(y), yE = yearEnd(y);
    const s = Math.max(yS, interp.first), e = Math.min(yE, interp.last);
    if (s >= e) continue;
    const total = interp.valueAt(e) - interp.valueAt(s);
    const months = days(s, e) / 30.4375;
    const perMonth = months > 0 ? total / months : null;
    const partial = !(yS >= interp.first && yE <= interp.last);
    let change = null;
    if (prevPerMonth && perMonth) change = (perMonth - prevPerMonth) / prevPerMonth * 100;
    years.push({ year: y, total, perMonth, partial, change });
    prevPerMonth = perMonth;
  }
  return years;
}

function computeMonthComparison(asc, refYears, recentCount) {
  const empty = { current: null, currentChange: null, sameMonthPrev: [], recent: [] };
  if (asc.length < 2) return empty;
  const interp = buildInterpolator(asc);
  const now = todayMs();
  const nd = new Date(now);
  const cy = nd.getUTCFullYear(), cm = nd.getUTCMonth() + 1;

  function box(y, m, toDate) {
    const mS = monthStart(y, m), mE = monthEnd(y, m);
    const end = toDate ? Math.min(now, mE) : mE;
    const kwh = consumptionBetween(interp, mS, end);
    if (kwh === null) return null;
    return { label: `${MONTHS_DE[m - 1]} ${y}`, kwh, ongoing: toDate && mE > now };
  }

  const current = box(cy, cm, true);

  const sameMonthPrev = [];
  for (let back = 1; back <= refYears; back++) {
    const b = box(cy - back, cm, false);
    if (b) sameMonthPrev.push(b);
  }

  const recent = [];
  let yy = cy, mm = cm;
  for (let i = 0; i < recentCount; i++) {
    if (mm === 1) { yy -= 1; mm = 12; } else { mm -= 1; }
    const b = box(yy, mm, false);
    if (b) recent.push(b);
  }

  let currentChange = null;
  if (current) {
    const cmS = monthStart(cy, cm);
    // nur so weit vergleichen, wie für den aktuellen Monat Daten vorliegen
    const effEnd = Math.min(now, monthEnd(cy, cm), interp.last);
    const elapsed = effEnd - cmS;
    const pyS = monthStart(cy - 1, cm);
    const prevMtd = consumptionBetween(interp, pyS, pyS + elapsed);
    if (prevMtd) currentChange = (current.kwh - prevMtd) / prevMtd * 100;
  }

  return { current, currentChange, sameMonthPrev, recent };
}

// ---------------------------------------------------------------------------
// Filter-Zustand
// ---------------------------------------------------------------------------
const filters = { from: null, to: null, refYears: 2, recent: 3 };

function dataBounds() {
  const asc = sortedAsc();
  if (!asc.length) {
    const t = ymd(new Date());
    return { min: t, max: t };
  }
  return { min: asc[0].date, max: asc[asc.length - 1].date };
}

function applyRange(asc) {
  return asc.filter((r) => r.date >= filters.from && r.date <= filters.to);
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------
function chgHtml(change, suffix) {
  if (change === null || change === undefined) return "–";
  if (change > 0) return `<span class="chg up">▲ ${f0(change)} %${suffix || ""}</span>`;
  if (change < 0) return `<span class="chg down">▼ ${f0(Math.abs(change))} %${suffix || ""}</span>`;
  return `<span class="chg flat">0 %${suffix || ""}</span>`;
}

function renderStats(stats) {
  const el = document.getElementById("stats");
  if (!stats) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="stats">
      <div class="stat">
        <div class="label">Aktueller Stand</div>
        <div class="value">${g(stats.latestValue)}<span class="unit">kWh</span></div>
        <div class="sub">am ${stats.latestDate}</div>
      </div>
      <div class="stat">
        <div class="label">Gesamtverbrauch</div>
        <div class="value">${stats.total !== null ? g(stats.total) + '<span class="unit">kWh</span>' : "–"}</div>
        <div class="sub">im Zeitraum</div>
      </div>
      <div class="stat">
        <div class="label">Ø pro Tag</div>
        <div class="value">${stats.perDay !== null ? f1(stats.perDay) + '<span class="unit">kWh</span>' : "–"}</div>
        <div class="sub">Durchschnitt</div>
      </div>
      <div class="stat">
        <div class="label">Einträge</div>
        <div class="value">${stats.count}</div>
        <div class="sub">im Zeitraum</div>
      </div>
    </div>`;
}

function renderYears(years) {
  const el = document.getElementById("years");
  if (!years.length) { el.innerHTML = ""; return; }
  const rows = years.map((y) => `
    <tr>
      <td><strong>${y.year}</strong>${y.partial ? '<span class="tag">Teiljahr</span>' : ""}</td>
      <td class="num r">${f0(y.total)} kWh</td>
      <td class="num r">${y.perMonth !== null ? f0(y.perMonth) + " kWh" : "–"}</td>
      <td class="num r">${chgHtml(y.change)}</td>
    </tr>`).join("");
  el.innerHTML = `
    <div class="card">
      <h2><span class="ico">📅</span> Jahresfazit</h2>
      <table>
        <thead><tr>
          <th>Jahr</th><th class="r">Gesamtverbrauch</th>
          <th class="r">Ø pro Monat</th><th class="r">ggü. Vorjahr</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint">Vergleich „ggü. Vorjahr" basiert auf dem Ø-Verbrauch pro Monat (fair auch bei Teiljahren). Zeiträume werden an Monats-/Jahresgrenzen geschätzt (interpoliert).</p>
    </div>`;
}

function renderMonths(m) {
  const el = document.getElementById("months");
  if (!m.current) { el.innerHTML = ""; return; }
  const prevBoxes = m.sameMonthPrev.map((b) =>
    `<div class="cmp-row"><span>${b.label}</span><span class="num">${f0(b.kwh)} kWh</span></div>`).join("");
  const recentBoxes = m.recent.map((b) =>
    `<div class="cmp-row"><span>${b.label}</span><span class="num">${f0(b.kwh)} kWh</span></div>`).join("");

  let changeHtml = "";
  if (m.currentChange !== null) {
    const c = m.currentChange;
    const cls = c > 0 ? "up" : c < 0 ? "down" : "flat";
    const arrow = c > 0 ? "▲ " + f0(c) + " %" : c < 0 ? "▼ " + f0(Math.abs(c)) + " %" : "unverändert";
    changeHtml = `<div class="chg ${cls}">${arrow} ggü. Vorjahr*</div>
                  <div class="mc-note">* gleicher Zeitraum (1.–heute)</div>`;
  }

  el.innerHTML = `
    <div class="card">
      <h2><span class="ico">🔍</span> Monatsvergleich</h2>
      <div class="month-grid">
        <div class="month-current">
          <div class="mc-label">${m.current.label}${m.current.ongoing ? " · bis heute" : ""}</div>
          <div class="mc-value">${f0(m.current.kwh)}<span class="unit">kWh</span></div>
          ${changeHtml}
        </div>
        <div class="month-cmp">
          ${prevBoxes ? `<div class="cmp-box"><div class="cmp-title">Gleicher Monat, Vorjahre</div>${prevBoxes}</div>` : ""}
          ${recentBoxes ? `<div class="cmp-box"><div class="cmp-title">Letzte Monate</div>${recentBoxes}</div>` : ""}
        </div>
      </div>
    </div>`;
}

function renderList(rangeAsc) {
  const el = document.getElementById("list");
  if (!rangeAsc.length) {
    const hint = (currentMode === "main" && !readings.length)
      ? `Noch keine eigenen Einträge. Trage oben deinen ersten Zählerstand ein – oder sieh dir den Reiter <strong>„Beispiel"</strong> an, um zu sehen, wie es gefüllt aussieht.`
      : `Keine Einträge im gewählten Zeitraum.`;
    el.innerHTML = `<div class="empty"><div class="big">📭</div>${hint}</div>`;
    return;
  }
  const desc = [...rangeAsc].reverse();
  const rows = desc.map((r) => `
    <tr>
      <td>${r.date}${r.comment ? `<div class="note">💬 ${esc(r.comment)}</div>` : ""}</td>
      <td class="num">${g(r.value)}</td>
      <td class="actions"><button class="del" data-id="${r.id}">Löschen</button></td>
    </tr>`).join("");
  el.innerHTML = `
    <table>
      <thead><tr><th>Datum</th><th>Zählerstand (kWh)</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderChart(rangeAsc) {
  const el = document.getElementById("chart");
  if (!rangeAsc.length) {
    el.innerHTML = '<div class="chart-empty">Keine Daten im gewählten Zeitraum.</div>';
    return;
  }
  const trace = {
    x: rangeAsc.map((r) => r.date),
    y: rangeAsc.map((r) => r.value),
    mode: "lines+markers",
    fill: "tozeroy",
    fillcolor: "rgba(79,70,229,0.08)",
    line: { color: "#4f46e5", width: 3 },
    marker: {
      // Punkte mit Kommentar werden größer und violett hervorgehoben
      color: rangeAsc.map((r) => (r.comment ? "#7c3aed" : "#4f46e5")),
      size: rangeAsc.map((r) => (r.comment ? 12 : 8)),
      line: { color: "#fff", width: 1.5 },
    },
    customdata: rangeAsc.map((r) => (r.comment ? "<br>💬 " + r.comment : "")),
    hovertemplate: "<b>%{x|%d.%m.%Y}</b><br>%{y} kWh%{customdata}<extra></extra>",
  };
  const layout = {
    font: { family: "Inter, system-ui, sans-serif", color: "#475569" },
    margin: { t: 14, r: 14, b: 48, l: 58 },
    xaxis: { type: "date", tickformat: "%d.%m.%y", gridcolor: "#eef2f7", zeroline: false, linecolor: "#e7ebf0" },
    yaxis: { gridcolor: "#eef2f7", zeroline: false, ticksuffix: " kWh", linecolor: "#e7ebf0" },
    plot_bgcolor: "#fff",
    paper_bgcolor: "#fff",
    hoverlabel: { bgcolor: "#0f172a", font: { color: "#fff" } },
  };
  Plotly.newPlot("chart", [trace], layout, { responsive: true, displayModeBar: false });
}

// Alles neu zeichnen
function renderAll() {
  const asc = sortedAsc();
  const rangeAsc = applyRange(asc);
  renderStats(computeStats(rangeAsc));
  renderChart(rangeAsc);
  renderYears(computeYears(rangeAsc));
  renderMonths(computeMonthComparison(asc, filters.refYears, filters.recent));
  renderList(rangeAsc);
}

// ---------------------------------------------------------------------------
// Filter-Bedienung
// ---------------------------------------------------------------------------
function syncFilterInputs() {
  const b = dataBounds();
  document.getElementById("from").min = b.min;
  document.getElementById("from").max = b.max;
  document.getElementById("to").min = b.min;
  document.getElementById("to").max = b.max;
  document.getElementById("from").value = filters.from;
  document.getElementById("to").value = filters.to;
  document.getElementById("ref_years").value = filters.refYears;
  document.getElementById("recent").value = filters.recent;
}

function resetFilters() {
  const b = dataBounds();
  filters.from = b.min;
  filters.to = b.max;
  filters.refYears = 2;
  filters.recent = 3;
  syncFilterInputs();
  renderAll();
}

function readFilterInputs() {
  const b = dataBounds();
  let from = document.getElementById("from").value || b.min;
  let to = document.getElementById("to").value || b.max;
  if (from > to) { const t = from; from = to; to = t; }   // vertauscht -> korrigieren
  filters.from = from;
  filters.to = to;
  filters.refYears = clampInt(document.getElementById("ref_years").value, 2, 0, 10);
  filters.recent = clampInt(document.getElementById("recent").value, 3, 0, 24);
  syncFilterInputs();
  renderAll();
}

function clampInt(v, def, lo, hi) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function quickRange(months) {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  filters.from = ymd(from);
  filters.to = ymd(to);
  syncFilterInputs();
  renderAll();
}

// ---------------------------------------------------------------------------
// Eintragen / Löschen
// ---------------------------------------------------------------------------
function addReading(dateStr, valueStr, comment) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const value = parseFloat(String(valueStr).replace(",", "."));
  if (Number.isNaN(value)) return false;
  readings.push({ id: nextId++, date: dateStr, value, comment: (comment || "").trim() });
  save();
  // Zeitraum-Filter ggf. erweitern, damit der neue Eintrag sichtbar ist
  if (dateStr < filters.from) filters.from = dataBounds().min;
  if (dateStr > filters.to) filters.to = dataBounds().max;
  syncFilterInputs();
  renderAll();
  return true;
}

function deleteReading(id) {
  readings = readings.filter((r) => r.id !== id);
  save();
  renderAll();
}

// ---------------------------------------------------------------------------
// Export / Import (Backup)
// ---------------------------------------------------------------------------
function exportData() {
  const slim = sortedAsc().map((r) =>
    r.comment ? { date: r.date, value: r.value, comment: r.comment }
              : { date: r.date, value: r.value });
  const blob = new Blob([JSON.stringify(slim, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stromzaehler-backup-${ymd(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- CSV/Text-Import (für Export aus Google Tabellen / Excel / freie Liste) -
function pad2(n) { return String(n).padStart(2, "0"); }

// Zahl aus "12345", "12345.6", "12345,6", "12.345,6", "12,345.6" -> Number
function parseNumberLoose(s) {
  s = String(s).trim().replace(/\s/g, "");
  if (s === "") return NaN;
  const hasDot = s.includes("."), hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // das zuletzt stehende Trennzeichen ist das Dezimalkomma/-punkt
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    s = s.replace(",", ".");   // einzelnes Komma = Dezimaltrennzeichen
  }
  return parseFloat(s);
}

// Eine Zeile -> { date, value, comment } oder null.
// Versteht "TT.MM.JJ. 1234kwh Kommentar", ISO-Datum und CSV (, oder ;).
function parseReadingLine(line) {
  let s = String(line).replace(/\s+$/, "");
  if (!s.trim()) return null;
  let dd, mm, yy, after, m;
  if ((m = s.match(/^\s*"?\s*(\d{4})-(\d{1,2})-(\d{1,2})"?\.?/))) {          // 2026-01-05
    yy = +m[1]; mm = +m[2]; dd = +m[3]; after = s.slice(m[0].length);
  } else if ((m = s.match(/^\s*"?\s*(\d{1,2})[.\/-](\d{1,2})[.\/ -]+(\d{2,4})"?\.?/))) {  // 05.01.26 / 5/1/2026
    dd = +m[1]; mm = +m[2]; yy = +m[3]; if (yy < 100) yy += 2000; after = s.slice(m[0].length);
  } else {
    return null;   // keine Datumszeile (z. B. Überschrift) -> überspringen
  }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const date = `${yy}-${pad2(mm)}-${pad2(dd)}`;
  const rest = after.replace(/^[\s,;"']+/, "");
  // Wert: erste Zahl (optional gefolgt von "kwh" inkl. Tippfehler-Buchstaben)
  const vm = rest.match(/(\d[\d.,]*\d|\d)\s*(kwh\w*)?/i);
  if (!vm) return null;
  const value = parseNumberLoose(vm[1]);
  if (Number.isNaN(value)) return null;
  // Kommentar: alles nach dem Wert, von Trennzeichen/Anführungszeichen befreit
  const comment = rest.slice(vm.index + vm[0].length)
    .replace(/^[\s,;"']+/, "").replace(/[\s"']+$/, "").trim();
  return { date, value, comment };
}

// Ganzer Text -> { readings, total, skipped }
function parseReadingsText(text) {
  text = text.replace(/^﻿/, "");   // BOM entfernen
  const lines = text.split(/\r\n|\r|\n/);
  const readings = [];
  let total = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    total++;
    const r = parseReadingLine(line);
    if (r) readings.push(r);
  }
  return { readings, total, skipped: total - readings.length };
}

function looksLikeJson(text) {
  const t = text.trim();
  return t.startsWith("[") || t.startsWith("{");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = function () {
    const text = String(reader.result);
    const tabName = currentMode === "demo" ? "Beispiel" : "Meine Daten";
    const isCsv = /\.csv$/i.test(file.name) || !looksLikeJson(text);
    let data;

    if (isCsv) {
      const res = parseReadingsText(text);
      if (!res.readings.length) {
        alert("Aus der Datei konnten keine gültigen Zeilen gelesen werden.\n\n" +
          "Erwartet pro Zeile: ein Datum (z. B. 31.05.26 oder 2026-05-31) und ein " +
          "Zählerstand (z. B. 15370). Ein Kommentar dahinter ist optional.");
        return;
      }
      const skipNote = res.skipped ? ` (${res.skipped} Zeile(n) ohne erkennbares Datum übersprungen)` : "";
      const withC = res.readings.filter((r) => r.comment).length;
      const cNote = withC ? `, davon ${withC} mit Kommentar` : "";
      if (!confirm(`${res.readings.length} Einträge erkannt${cNote}${skipNote}.\n\n` +
        `Die Daten im Reiter „${tabName}" werden dadurch ersetzt. Fortfahren?`)) return;
      data = res.readings;
    } else {
      try { data = JSON.parse(text); } catch (e) {
        alert("Die Datei ist keine gültige Backup- (.json) oder CSV-Datei (.csv).");
        return;
      }
      if (!Array.isArray(data) || !data.every((r) =>
        r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && !Number.isNaN(Number(r.value)))) {
        alert("Die Datei hat nicht das erwartete Format.");
        return;
      }
      if (!confirm(`${data.length} Einträge importieren? Die Daten im Reiter „${tabName}" werden ersetzt.`)) return;
    }

    readings = data.map((r) => ({
      id: nextId++, date: r.date, value: Number(r.value),
      comment: r.comment ? String(r.comment) : "",
    }));
    save();
    resetFilters();
    alert(`Import erfolgreich: ${data.length} Einträge im Reiter „${tabName}".`);
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Reiter umschalten ("Meine Daten" / "Beispiel")
// ---------------------------------------------------------------------------
function reflectActiveTab() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.getAttribute("data-mode") === currentMode));
  const note = document.getElementById("demo-note");
  if (note) note.hidden = (currentMode !== "demo");
}

function switchMode(mode) {
  if (mode !== "main" && mode !== "demo") return;
  if (mode === currentMode) return;
  save();                       // aktuellen Reiter sichern
  currentMode = mode;
  try { localStorage.setItem(ACTIVE_TAB_KEY, mode); } catch (e) {}
  reflectActiveTab();
  load();                       // Daten des neuen Reiters laden
  resetFilters();               // Filter neu setzen + alles neu zeichnen
  document.getElementById("date").value = ymd(new Date());
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function init() {
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY);
    if (saved === "main" || saved === "demo") currentMode = saved;
  } catch (e) { /* ignorieren */ }
  reflectActiveTab();
  load();
  resetFilters();   // setzt Filter auf vollen Datenbereich und zeichnet alles

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchMode(t.getAttribute("data-mode"))));

  document.getElementById("date").value = ymd(new Date());

  document.getElementById("filter-form").addEventListener("submit", (e) => {
    e.preventDefault();
    readFilterInputs();
  });
  document.getElementById("filter-reset").addEventListener("click", resetFilters);
  document.getElementById("quick-all").addEventListener("click", resetFilters);
  document.querySelectorAll(".chip[data-months]").forEach((btn) => {
    btn.addEventListener("click", () => quickRange(parseInt(btn.getAttribute("data-months"), 10)));
  });

  document.getElementById("add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const ok = addReading(document.getElementById("date").value,
                          document.getElementById("value").value,
                          document.getElementById("comment").value);
    if (ok) {
      document.getElementById("value").value = "";
      document.getElementById("comment").value = "";
    }
  });

  document.getElementById("list").addEventListener("click", (e) => {
    const btn = e.target.closest(".del");
    if (btn && confirm("Diesen Eintrag löschen?")) {
      deleteReading(parseInt(btn.getAttribute("data-id"), 10));
    }
  });

  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("import-btn").addEventListener("click", () =>
    document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });

  // Service Worker -> macht die App auf dem Handy installierbar
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
