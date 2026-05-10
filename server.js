const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const port = process.env.PORT || 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MANUAL_REFRESH_ONLY = true;
const VERSION_POLL_MS = 60 * 1000;
const VERSION_POLL_FAST_WINDOW_MS = 5 * 60 * 1000;
const VERSION_POLL_WARM_MS = 2 * 60 * 1000;
const VERSION_POLL_COOL_MS = 5 * 60 * 1000;
const VERSION_POLL_IDLE_MS = 10 * 60 * 1000;
// const AUTO_REFRESH_MS = 60 * 1000;
const EDGE_CACHE_CONTROL = "public, max-age=0, s-maxage=0, must-revalidate";
const EDGE_CACHE_CONTROL_FORCE = "no-store";
const VERSION_CACHE_CONTROL = "private, max-age=0, must-revalidate";
const REFRESH_SECRET_PARAM = "autorefresh";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "";
const REFRESH_DONE_PARAM = "refreshDoneAt";
const REDIS_DATA_KEY = "bcf-cup:data";
const REDIS_VERSION_KEY = "bcf-cup:version";

const TABS = ["Grupo A", "Grupo B", "Eliminatorias"];
const TEAM_ALIAS = {
  "Burgos CF": "BUR",
  "CD Parquesol": "PAR",
  "Mullier FCN": "MUL",
  "CD Palencia FF": "PAL",
  'Burgos CF "B"': "BURB",
  "Gimnastica Segoviana": "GSEG",
  "Real Valladolid CF": "RVA",
  "CD San Jose": "SJOS",
  "CD Vasconia": "VAS",
  "CD Salamanca FF": "SAL",
  "Martutene KE": "MAR",
  "Real Sociedad": "RSO",
};

const TEAM_ALIAS_NORMALIZED = Object.fromEntries(
  Object.entries(TEAM_ALIAS).map(([key, value]) => [
    key.normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
    value,
  ])
);

let cache = {
  data: null,
  fetchedAt: 0,
};
let cacheLoadingPromise = null;
let redisPromise = null;

app.use("/static", express.static(path.join(__dirname, "static")));

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rowToMatch(row = [], penaltyRow = []) {
  return {
    hora: (row[0] || "").trim(),
    campo: (row[2] || "").trim(),
    equipoLocal: (row[3] || "").trim(),
    golesLocal: (row[4] || "").trim(),
    equipoVisitante: (row[5] || "").trim(),
    golesVisitante: (row[6] || "").trim(),
    penaltisLocal: (penaltyRow[1] || "").trim(),
    penaltisVisitante: (penaltyRow[3] || "").trim(),
  };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function teamLogo(teamName) {
  switch (normalizeText(teamName)) {
    case "CD Palencia FF":
      return "/static/palencia.jpg";
    case "Mullier FCN":
      return "/static/mullier.png";
    case "CD Parquesol":
      return "/static/parquesol.png";
    case "Burgos CF":
    case 'Burgos CF "B"':
      return "/static/burgoscf.png";
    case "Real Valladolid CF":
      return "/static/valladolid.png";
    case "CD San Jose":
      return "/static/sanjose.png";
    case "Gimnastica Segoviana":
      return "/static/segoviana.png";
    case "CD Vasconia":
      return "/static/vasconia.png";
    case "CD Salamanca FF":
      return "/static/salamanca.png";
    case "Martutene KE":
      return "/static/martutene.png";
    case "Real Sociedad":
      return "/static/realsociedad.png";
    default:
      return "/static/logo_II_BCF_CUP.png";
  }
}

function getRedisEnv() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.STORAGE_REST_URL ||
    process.env.STORAGE_URL ||
    process.env.STORAGE_REDIS_REST_URL ||
    "";
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.STORAGE_REST_TOKEN ||
    process.env.STORAGE_TOKEN ||
    process.env.STORAGE_REDIS_REST_TOKEN ||
    "";

  return { url, token };
}

function hasRedisConfig() {
  const { url, token } = getRedisEnv();
  return Boolean(url && token);
}

async function getRedis() {
  const { url, token } = getRedisEnv();
  if (!url || !token) return null;

  if (!redisPromise) {
    redisPromise = import("@upstash/redis").then(({ Redis }) => {
      return new Redis({
        url,
        token,
      });
    });
  }

  return redisPromise;
}

function rememberTournamentData(data) {
  cache = {
    data,
    fetchedAt: Date.now(),
  };
}

async function loadPersistedTournamentData() {
  const redis = await getRedis();
  if (!redis) return null;

  const data = await redis.get(REDIS_DATA_KEY);
  if (!data) return null;

  rememberTournamentData(data);
  return data;
}

async function saveTournamentData(data) {
  rememberTournamentData(data);

  const redis = await getRedis();
  if (!redis) return;

  const version = new Date(data.generatedAt).toISOString();
  await redis.pipeline().set(REDIS_DATA_KEY, data).set(REDIS_VERSION_KEY, version).exec();
}

function buildGoogleClient() {
  const sheetId = process.env.GSHEETS_SPREADSHEET_ID;
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!sheetId) {
    throw new Error("Missing GSHEETS_SPREADSHEET_ID environment variable");
  }

  let credentials;
  if (serviceAccountJson) {
    credentials = JSON.parse(serviceAccountJson);
  } else {
    credentials = {
      client_email: process.env.GSHEETS_CLIENT_EMAIL,
      private_key: (process.env.GSHEETS_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    };
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error(
      "Missing credentials: set GOOGLE_SERVICE_ACCOUNT_JSON or GSHEETS_CLIENT_EMAIL + GSHEETS_PRIVATE_KEY"
    );
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });

  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, sheetId };
}

async function readRange(sheets, sheetId, range) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return response.data.values || [];
}

async function readRanges(sheets, sheetId, ranges) {
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges,
  });

  function normalizedRangeKey(a1Range) {
    const normalized = String(a1Range || "").replace(/\$/g, "");
    const [rawSheetPart, cells = ""] = normalized.split("!");
    const sheetPart = rawSheetPart
      .replace(/^'/, "")
      .replace(/'$/, "")
      .replace(/''/g, "'");
    const startCell = cells.split(":")[0] || cells;
    return `${sheetPart}!${startCell}`;
  }

  const valueRanges = response.data.valueRanges || [];
  const map = {};
  for (const valueRange of valueRanges) {
    if (!valueRange?.range) continue;
    // Google can return expanded ranges and unquoted sheet names.
    map[normalizedRangeKey(valueRange.range)] = valueRange.values || [];
  }

  return ranges.map((range) => map[normalizedRangeKey(range)] || []);
}

async function getGroupData(sheets, sheetId, sheetName) {
  const [matchesRows, penaltiesRows, tableRows] = await readRanges(sheets, sheetId, [
    `'${sheetName}'!B3:I8`,
    `'${sheetName}'!E12:I17`,
    `'${sheetName}'!K2:T6`,
  ]);

  const matches = matchesRows.map((row, index) => rowToMatch(row, penaltiesRows[index] || []));
  const headers = tableRows[0] || [];
  const rows = tableRows.slice(1);

  return { sheetName, matches, table: { headers, rows } };
}

async function getEliminatoriasData(sheets, sheetId, sheetName) {
  const [quarterRows, quarterPenaltiesRows, semiRows, semiPenaltiesRows, finalRows, finalPenaltiesRows] =
    await readRanges(sheets, sheetId, [
      `'${sheetName}'!B4:I7`,
      `'${sheetName}'!E11:I14`,
      `'${sheetName}'!B18:I19`,
      `'${sheetName}'!E23:I24`,
      `'${sheetName}'!B28:I29`,
      `'${sheetName}'!E33:I34`,
    ]);

  return {
    sheetName,
    quarters: quarterRows.map((row, index) => rowToMatch(row, quarterPenaltiesRows[index] || [])),
    semis: semiRows.map((row, index) => rowToMatch(row, semiPenaltiesRows[index] || [])),
    finals: finalRows.map((row, index) => rowToMatch(row, finalPenaltiesRows[index] || [])),
  };
}

async function getTournamentData(options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();
  if (!forceRefresh && cacheLoadingPromise) {
    return cacheLoadingPromise;
  }

  if (!forceRefresh && hasRedisConfig()) {
    const persistedData = await loadPersistedTournamentData();
    if (persistedData) {
      return persistedData;
    }
  }

  if (!forceRefresh && cache.data) {
    const ageMs = now - cache.fetchedAt;
    if (MANUAL_REFRESH_ONLY) {
      return cache.data;
    } else if (ageMs < CACHE_TTL_MS) {
      return cache.data;
    }
  }

  if (!forceRefresh && MANUAL_REFRESH_ONLY) {
    const error = new Error("No hay datos cacheados.");
    error.statusCode = 503;
    throw error;
  }

  if (cacheLoadingPromise) {
    return cacheLoadingPromise;
  }

  cacheLoadingPromise = (async () => {
    const { sheets, sheetId } = buildGoogleClient();
    const [groupA, groupB, eliminatorias] = await Promise.all([
      getGroupData(sheets, sheetId, "Grupo A"),
      getGroupData(sheets, sheetId, "Grupo B"),
      getEliminatoriasData(sheets, sheetId, "Eliminatorias"),
    ]);

    const data = {
      generatedAt: new Date(),
      groupA,
      groupB,
      eliminatorias,
    };

    await saveTournamentData(data);
    return data;
  })();

  try {
    return await cacheLoadingPromise;
  } finally {
    cacheLoadingPromise = null;
  }
}

function renderMatchCard(match, shaded = false) {
  const penalties =
    match.penaltisLocal || match.penaltisVisitante
      ? `<div class="penalty">(${escapeHtml(match.penaltisLocal || "0")} - ${escapeHtml(
          match.penaltisVisitante || "0"
        )})</div>`
      : "";

  return `
    <article class="match-card${shaded ? " shaded" : ""}">
      <div class="match-meta">Campo ${escapeHtml(match.campo)} · ${escapeHtml(match.hora)}</div>
      <div class="match-main">
        <div class="team team-left">
          <span class="team-name">${escapeHtml(match.equipoLocal)}</span>
          <img src="${teamLogo(match.equipoLocal)}" alt="${escapeHtml(match.equipoLocal)}" loading="lazy" />
        </div>
        <div class="score-wrap">
          <div class="score">${escapeHtml(match.golesLocal)} - ${escapeHtml(match.golesVisitante)}</div>
          ${penalties}
        </div>
        <div class="team team-right">
          <img src="${teamLogo(match.equipoVisitante)}" alt="${escapeHtml(match.equipoVisitante)}" loading="lazy" />
          <span class="team-name">${escapeHtml(match.equipoVisitante)}</span>
        </div>
      </div>
    </article>
  `;
}

function renderClassificationTable(table) {
  if (!table?.headers?.length || !table?.rows?.length) {
    return '<p class="empty">No hay datos de clasificacion disponibles.</p>';
  }

  const metricHeaders = new Set(["POS", "PTS", "PJ", "PG", "PE", "PP", "GF", "GC", "DG"]);
  const headersHtml = table.headers
    .map((header) => {
      const normalizedHeader = String(header || "").toUpperCase();
      const classes = [];
      if (normalizedHeader === "EQUIPO") classes.push("col-team");
      if (metricHeaders.has(normalizedHeader)) classes.push("col-metric");
      const classAttr = classes.length ? ` class="${classes.join(" ")}"` : "";
      return `<th${classAttr}>${escapeHtml(header)}</th>`;
    })
    .join("");
  const rowsHtml = table.rows
    .map((row) => {
      const cells = row
        .map((value, index) => {
          const header = (table.headers[index] || "").toUpperCase();
          if (header === "EQUIPO") {
            const teamName = String(value || "").trim();
            const teamLabel = TEAM_ALIAS_NORMALIZED[normalizeText(teamName)] || teamName;
            return `<td class="col-team"><img src="${teamLogo(teamName)}" alt="${escapeHtml(
              teamLabel
            )}" loading="lazy" /><span>${escapeHtml(teamLabel)}</span></td>`;
          }
          if (metricHeaders.has(header)) {
            return `<td class="col-metric">${escapeHtml(value)}</td>`;
          }
          return `<td>${escapeHtml(value)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `
    <div class="table-wrap">
      <table class="ranking-table">
        <thead><tr>${headersHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderGroupPage(group) {
  const matchesHtml = group.matches?.length
    ? group.matches.map((match, index) => renderMatchCard(match, index % 2 === 1)).join("")
    : '<p class="empty">No hay partidos para mostrar.</p>';

  return `
    ${renderClassificationTable(group.table)}
    <section class="matches-section">${matchesHtml}</section>
  `;
}

function renderEliminatoriasPage(eliminatoriasData, quarterTitle, semiTitle, finalTitle, thirdTitle) {
  const quarters = eliminatoriasData.quarters?.length
    ? eliminatoriasData.quarters.map((match) => renderMatchCard(match)).join("")
    : '<p class="empty">No hay cuartos de final para mostrar.</p>';
  const semis = eliminatoriasData.semis?.length
    ? eliminatoriasData.semis.map((match) => renderMatchCard(match)).join("")
    : '<p class="empty">No hay semifinales para mostrar.</p>';
  const finals = eliminatoriasData.finals?.length
    ? eliminatoriasData.finals
        .map((match, index) => {
          const title = index === 0 ? finalTitle : thirdTitle;
          return `<h3 class="section-title">${escapeHtml(title)}</h3>${renderMatchCard(match)}`;
        })
        .join("")
    : '<p class="empty">No hay finales para mostrar.</p>';

  return `
    <h3 class="section-title">${escapeHtml(quarterTitle)}</h3>
    ${quarters}
    <h3 class="section-title">${escapeHtml(semiTitle)}</h3>
    ${semis}
    ${finals}
  `;
}

function renderBodyByTab(data, tab) {
  switch (tab) {
    case "Grupo A":
      return renderGroupPage(data.groupA);
    case "Grupo B":
      return renderGroupPage(data.groupB);
    case "Eliminatorias":
      return renderEliminatoriasPage(
        data.eliminatorias,
        "Cuartos de Final",
        "Semifinales",
        "Final",
        "Tercer y Cuarto Puesto"
      );
    default:
      return renderGroupPage(data.groupA);
  }
}

function renderAllTabPanels(data, currentTab) {
  return TABS.map((tab) => {
    const active = tab === currentTab;
    const hiddenAttr = active ? "" : ' hidden="hidden"';
    return `<section class="tab-panel" data-tab-panel="${escapeHtml(tab)}"${hiddenAttr}>${renderBodyByTab(
      data,
      tab
    )}</section>`;
  }).join("");
}

function renderTabs(currentTab) {
  return TABS.map((tab) => {
    const active = tab === currentTab ? " active" : "";
    return `<a class="tab-link${active}" href="${escapeHtml(buildTabHref(tab))}" data-tab="${escapeHtml(
      tab
    )}">${escapeHtml(tab)}</a>`;
  }).join("");
}

function formatDate(date) {
  const parsedDate = new Date(date);
  if (Number.isNaN(parsedDate.getTime())) return "";

  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Madrid",
  }).format(parsedDate);
}

function buildEtag(value) {
  const hash = crypto.createHash("sha1").update(String(value)).digest("hex");
  return `"${hash}"`;
}

function isNotModified(req, res, etag, cacheControl) {
  res.set("Cache-Control", cacheControl);
  res.set("ETag", etag);

  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  if (!ifNoneMatch) return false;

  const normalized = ifNoneMatch
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (normalized.includes(etag) || normalized.includes("*")) {
    res.status(304).end();
    return true;
  }

  return false;
}

async function getCachedVersion() {
  const redis = await getRedis();
  if (redis) {
    return (await redis.get(REDIS_VERSION_KEY)) || "";
  }

  return cache.data ? new Date(cache.data.generatedAt).toISOString() : "";
}

function getCurrentTabFromReq(req) {
  const requestedTab = String(req.query.tab || "Grupo A");
  return TABS.includes(requestedTab) ? requestedTab : "Grupo A";
}

function hasRefreshParam(req) {
  return Object.prototype.hasOwnProperty.call(req.query, REFRESH_SECRET_PARAM);
}

function getValidatedRefreshSecret(req) {
  if (!hasRefreshParam(req)) return "";
  if (!REFRESH_SECRET) return "manual-refresh";

  const provided = String(req.query[REFRESH_SECRET_PARAM] || "").trim();
  return provided && provided === REFRESH_SECRET ? provided : "";
}

function buildTabHref(tab) {
  const params = new URLSearchParams({ tab });
  return `/?${params.toString()}`;
}

function getRefreshDoneDate(req) {
  const raw = String(req.query[REFRESH_DONE_PARAM] || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMockPreview(req) {
  return process.env.NODE_ENV !== "production" && String(req.query.mock || "") === "1";
}

function getMockTournamentData() {
  const table = {
    headers: ["POS", "EQUIPO", "PTS", "PJ", "PG", "PE", "PP", "GF", "GC", "DG"],
    rows: [
      ["1", "Burgos CF", "6", "2", "2", "0", "0", "5", "1", "4"],
      ["2", "CD Parquesol", "3", "2", "1", "0", "1", "3", "3", "0"],
      ["3", "Mullier FCN", "1", "2", "0", "1", "1", "2", "4", "-2"],
      ["4", "CD Palencia FF", "1", "2", "0", "1", "1", "1", "3", "-2"],
    ],
  };
  const matches = [
    rowToMatch(["10:00", "", "1", "Burgos CF", "2", "CD Parquesol", "0"]),
    rowToMatch(["10:45", "", "2", "Mullier FCN", "1", "CD Palencia FF", "1"]),
    rowToMatch(["11:30", "", "1", "Burgos CF", "3", "Mullier FCN", "1"]),
    rowToMatch(["12:15", "", "2", "CD Parquesol", "3", "CD Palencia FF", "0"]),
  ];

  return {
    generatedAt: new Date(),
    groupA: { sheetName: "Grupo A", matches, table },
    groupB: {
      sheetName: "Grupo B",
      matches: [
        rowToMatch(["10:00", "", "1", "Real Valladolid CF", "1", "CD San Jose", "0"]),
        rowToMatch(["10:45", "", "2", "CD Vasconia", "2", "CD Salamanca FF", "2"]),
      ],
      table,
    },
    eliminatorias: {
      sheetName: "Eliminatorias",
      quarters: [
        rowToMatch(["16:00", "", "1", "Burgos CF", "1", "CD Salamanca FF", "1"], ["", "4", "", "3"]),
      ],
      semis: [rowToMatch(["17:00", "", "1", "Burgos CF", "", "Real Sociedad", ""])],
      finals: [rowToMatch(["18:30", "", "1", "Burgos CF", "", "Real Valladolid CF", ""])],
    },
  };
}

function renderPage(data, currentTab, refreshDoneDate = null) {
  const currentTabHref = buildTabHref(currentTab);
  const initialVersion = new Date(data.generatedAt).toISOString();
  const refreshDoneHtml = refreshDoneDate
    ? `<div class="refresh-done">Actualizacion forzada ejecutada: ${escapeHtml(formatDate(
        refreshDoneDate
      ))}</div>`
    : "";
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BCF CUP Alevin Femenino</title>
    <style>
      :root {
        --bg: #f4f7fb;
        --surface: #ffffff;
        --text: #1a2d46;
        --muted: #5b6d82;
        --line: #dce4ef;
        --brand: #003b7a;
        --brand-soft: #e9f1ff;
        --score: #d13030;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 20% -20%, #dbe9ff 0%, transparent 45%),
          radial-gradient(circle at 120% 0%, #edf4ff 0%, transparent 50%),
          var(--bg);
      }
      .page {
        max-width: 980px;
        margin: 0 auto;
        padding: 0 0.8rem 1.4rem;
      }
      .header {
        background: transparent;
        border: 0;
        border-radius: 0;
        padding: 0;
        overflow: hidden;
        box-shadow: none;
      }
      .header-banner {
        display: block;
        width: 100%;
        height: auto;
      }
      .header-logos {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 14px;
      }
      .header-logos img {
        height: 64px;
        width: auto;
        object-fit: contain;
      }
      h1 {
        margin: 0.6rem 0 0;
        font-size: 1.15rem;
        line-height: 1.25;
        text-align: center;
        color: var(--brand);
      }
      .toolbar {
        margin-top: 0.7rem;
        display: flex;
        gap: 0.5rem;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 0.85rem;
      }
      .refresh {
        text-decoration: none;
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--text);
        border-radius: 999px;
        padding: 0.3rem 0.75rem;
        font-weight: 600;
      }
      .refresh-done {
        margin: 0.55rem 0.8rem 0.8rem;
        padding: 0.42rem 0.6rem;
        border: 1px solid #b8dfc7;
        background: #eef9f1;
        color: #1f6a39;
        border-radius: 10px;
        font-size: 0.82rem;
        font-weight: 700;
        text-align: center;
      }
      .tabs {
        display: flex;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
        gap: 0.35rem;
        margin: 0.9rem 0;
        padding-bottom: 0.1rem;
      }
      .tab-link {
        text-align: center;
        text-decoration: none;
        padding: 0.5rem 0.3rem;
        border-radius: 10px;
        border: 1px solid var(--line);
        color: var(--brand);
        background: #fff;
        font-weight: 700;
        white-space: nowrap;
        flex: 0 0 auto;
        min-width: 96px;
        font-size: 0.83rem;
      }
      .tab-link.active {
        background: var(--brand);
        color: #fff;
        border-color: var(--brand);
      }
      .tab-panel[hidden] {
        display: none;
      }
      .section-title {
        margin: 0.9rem 0 0.45rem;
        font-size: 1rem;
        color: var(--brand);
        padding: 0.35rem 0.5rem;
        border-left: 4px solid var(--brand);
        background: var(--brand-soft);
        border-radius: 6px;
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--surface);
      }
      .ranking-table {
        width: 100%;
        min-width: 520px;
        border-collapse: collapse;
      }
      .ranking-table th {
        position: sticky;
        top: 0;
        background: var(--brand);
        color: #fff;
        font-size: 0.78rem;
        padding: 0.52rem 0.4rem;
      }
      .ranking-table td {
        font-size: 0.8rem;
        padding: 0.45rem 0.4rem;
        border-top: 1px solid var(--line);
        text-align: center;
      }
      .ranking-table td.col-team {
        text-align: center;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        min-width: 112px;
      }
      .ranking-table td.col-team span {
        text-align: center;
      }
      .ranking-table th.col-metric,
      .ranking-table td.col-metric {
        width: 5.5%;
        padding-left: 0.15rem;
        padding-right: 0.15rem;
      }
      .ranking-table td.col-team img {
        width: 19px;
        height: 19px;
        object-fit: contain;
        flex-shrink: 0;
      }
      .matches-section {
        margin-top: 0.7rem;
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
        background: var(--surface);
      }
      .match-card {
        padding: 0.5rem;
        border-top: 1px solid var(--line);
      }
      .match-card:first-child { border-top: none; }
      .match-card.shaded { background: #f7fafe; }
      .match-meta {
        text-align: center;
        color: var(--muted);
        font-weight: 700;
        font-size: 0.82rem;
        margin-bottom: 0.35rem;
      }
      .match-main {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 0.35rem;
      }
      .team {
        display: flex;
        align-items: center;
        gap: 0.34rem;
        min-width: 0;
      }
      .team-left { justify-content: flex-end; }
      .team-right { justify-content: flex-start; }
      .team img {
        width: 24px;
        height: 24px;
        object-fit: contain;
        flex-shrink: 0;
      }
      .team-name {
        font-weight: 700;
        font-size: 0.82rem;
        line-height: 1.2;
      }
      .team-left .team-name { text-align: right; }
      .score-wrap { text-align: center; }
      .score {
        color: var(--score);
        font-size: 1.3rem;
        line-height: 1;
        font-weight: 800;
        white-space: nowrap;
      }
      .penalty {
        margin-top: 0.1rem;
        font-size: 0.75rem;
        color: #345f95;
      }
      .sponsors {
        margin-top: 1rem;
        padding-top: 0.8rem;
        border-top: 1px solid var(--line);
      }
      .sponsors-title {
        margin: 0 0 0.5rem;
        color: var(--muted);
        font-size: 0.92rem;
        text-align: center;
      }
      .sponsors-logos {
        display: grid;
        gap: 0.6rem;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .sponsors-logos img {
        width: 100%;
        max-height: 72px;
        object-fit: contain;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 0.4rem;
      }
      .empty {
        margin: 0.7rem 0;
        color: var(--muted);
        text-align: center;
      }
      @media (max-width: 460px) {
        .page { padding: 0 0.45rem 1.2rem; }
        .header {
          margin-left: -0.45rem;
          margin-right: -0.45rem;
          border-left: 0;
          border-right: 0;
          border-radius: 0;
        }
        .tabs {
          display: flex;
          justify-content: space-between;
          gap: 0;
          overflow: visible;
          padding-bottom: 0;
        }
        .tab-link {
          flex: 0 0 33.3333%;
          min-width: 33.3333%;
          max-width: 33.3333%;
          padding: 0.42rem 0.15rem;
          font-size: 0.72rem;
          white-space: normal;
          line-height: 1.1;
        }
        .ranking-table {
          min-width: 100%;
          table-layout: fixed;
        }
        .ranking-table th,
        .ranking-table td {
          font-size: 0.72rem;
          padding: 0.34rem 0.2rem;
        }
        .ranking-table td.col-team {
          display: table-cell;
          text-align: center;
          vertical-align: middle;
          min-width: 0;
          gap: 0;
          padding-left: 0.08rem;
          padding-right: 0.08rem;
          white-space: nowrap;
          overflow: hidden;
        }
        .ranking-table td.col-team img {
          display: inline-block;
          vertical-align: middle;
          margin: 0 0.12rem 0 0;
        }
        .ranking-table td.col-team span {
          display: inline-block;
          vertical-align: middle;
          line-height: 1.05;
          text-align: center;
          max-width: calc(100% - 17px);
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ranking-table th.col-team,
        .ranking-table td.col-team {
          width: 20%;
        }
        .ranking-table th.col-metric,
        .ranking-table td.col-metric {
          width: 8%;
          padding-left: 0.08rem;
          padding-right: 0.08rem;
        }
        .ranking-table td.col-team img {
          width: 15px;
          height: 15px;
        }
      }
      @media (min-width: 800px) {
        .page { padding: 0 1rem 1.8rem; }
        .tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          overflow: visible;
          padding-bottom: 0;
        }
        .tab-link {
          min-width: 0;
          white-space: normal;
        }
        h1 { font-size: 1.35rem; }
        .team-name { font-size: 0.95rem; }
        .score { font-size: 1.6rem; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <header class="header">
        <img class="header-banner" src="/static/cabecera_web.png" alt="II Torneo BCF CUP Alevin Femenino Fundacion Caja de Burgos" />
        <!-- <div class="header-logos">
          <img src="/static/logo_II_BCF_CUP.png" alt="Logo BCF CUP" />
          <img src="/static/logoFundacionCajaBurgos.png" alt="Fundacion Caja Burgos" />
        </div>
        <h1>II Torneo BCF CUP Alevin Femenino<br />Fundacion Caja de Burgos</h1> -->
        <!-- <div class="toolbar">
          <span id="last-updated">Ultima actualizacion: ${escapeHtml(formatDate(data.generatedAt))}</span>
          <a class="refresh" href="${escapeHtml(currentTabHref)}">Actualizar</a>
        </div> -->
        ${refreshDoneHtml}
      </header>

      <nav class="tabs" aria-label="Fases del torneo">${renderTabs(currentTab)}</nav>
      <section id="tab-content">${renderAllTabPanels(data, currentTab)}</section>

      <footer class="sponsors">
        <h2 class="sponsors-title">Con la colaboracion de:</h2>
        <div class="sponsors-logos">
          <img src="/static/frutopia.png" alt="Molino Tejada" />
          <img src="/static/ezsa.png" alt="Ezsa" />
          <img src="/static/nb.jpg" alt="Grupo NB" />
          <img src="/static/diputacion.jpg" alt="Diputacion" />
        </div>
      </footer>
    </main>
    <script>
      (function tabsNoRequestSwitch() {
        const tabLinks = Array.from(document.querySelectorAll(".tab-link[data-tab]"));
        const tabPanels = Array.from(document.querySelectorAll(".tab-panel[data-tab-panel]"));

        function activateTab(tabName) {
          tabLinks.forEach((link) => {
            link.classList.toggle("active", link.dataset.tab === tabName);
          });
          tabPanels.forEach((panel) => {
            panel.hidden = panel.dataset.tabPanel !== tabName;
          });
        }

        tabLinks.forEach((link) => {
          link.addEventListener("click", (event) => {
            event.preventDefault();
            const tabName = link.dataset.tab;
            if (!tabName) return;

            activateTab(tabName);

            const url = new URL(window.location.href);
            url.searchParams.set("tab", tabName);
            url.searchParams.delete("refreshDoneAt");
            window.history.replaceState({}, "", url.toString());
          });
        });
      })();

      (function syncWhenDataChanges() {
        const pollMs = ${VERSION_POLL_MS};
        const fastWindowMs = ${VERSION_POLL_FAST_WINDOW_MS};
        const warmPollMs = ${VERSION_POLL_WARM_MS};
        const coolPollMs = ${VERSION_POLL_COOL_MS};
        const idlePollMs = ${VERSION_POLL_IDLE_MS};
        let currentVersion = "${escapeHtml(initialVersion)}";
        let visibleSince = Date.now();
        let pollTimer = null;

        function nextPollDelay() {
          const visibleForMs = Date.now() - visibleSince;
          if (visibleForMs < fastWindowMs) return pollMs;
          if (visibleForMs < 15 * 60 * 1000) return warmPollMs;
          if (visibleForMs < 30 * 60 * 1000) return coolPollMs;
          return idlePollMs;
        }

        function scheduleNextCheck() {
          window.clearTimeout(pollTimer);
          if (document.visibilityState !== "visible") return;

          pollTimer = window.setTimeout(() => {
            checkVersion().catch(() => {}).finally(scheduleNextCheck);
          }, nextPollDelay());
        }

        async function checkVersion() {
          if (document.visibilityState !== "visible") return;

          const response = await fetch("/api/version", {
            headers: { Accept: "application/json" },
            cache: "no-cache",
          });
          if (!response.ok) return;

          const payload = await response.json();
          if (!payload || typeof payload.version !== "string") return;

          if (payload.version !== currentVersion) {
            window.location.reload();
            return;
          }
        }

        scheduleNextCheck();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            visibleSince = Date.now();
            checkVersion().catch(() => {}).finally(scheduleNextCheck);
          } else {
            window.clearTimeout(pollTimer);
          }
        });
      })();
    </script>
  </body>
</html>`;
}

function renderLoadingErrorPage(message) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BCF CUP Alevin Femenino</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1rem;
        font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: #1a2d46;
        background: #f4f7fb;
      }
      main {
        width: min(100%, 520px);
        text-align: center;
        background: #fff;
        border: 1px solid #dce4ef;
        border-radius: 12px;
        padding: 1.2rem;
      }
      h1 {
        margin: 0 0 0.65rem;
        color: #003b7a;
        font-size: 1.2rem;
      }
      p {
        margin: 0.4rem 0;
        color: #5b6d82;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Error al cargar los datos</h1>
      <p>${escapeHtml(message)}</p>
      <p>Esperando una actualizacion desde el servidor.</p>
    </main>
    <script>
      (function reloadWhenDataIsAvailable() {
        const pollMs = ${VERSION_POLL_MS};
        const fastWindowMs = ${VERSION_POLL_FAST_WINDOW_MS};
        const warmPollMs = ${VERSION_POLL_WARM_MS};
        const coolPollMs = ${VERSION_POLL_COOL_MS};
        const idlePollMs = ${VERSION_POLL_IDLE_MS};
        let visibleSince = Date.now();
        let pollTimer = null;

        function nextPollDelay() {
          const visibleForMs = Date.now() - visibleSince;
          if (visibleForMs < fastWindowMs) return pollMs;
          if (visibleForMs < 15 * 60 * 1000) return warmPollMs;
          if (visibleForMs < 30 * 60 * 1000) return coolPollMs;
          return idlePollMs;
        }

        function scheduleNextCheck() {
          window.clearTimeout(pollTimer);
          if (document.visibilityState !== "visible") return;

          pollTimer = window.setTimeout(() => {
            checkVersion().catch(() => {}).finally(scheduleNextCheck);
          }, nextPollDelay());
        }

        async function checkVersion() {
          if (document.visibilityState !== "visible") return;

          const response = await fetch("/api/version", {
            headers: { Accept: "application/json" },
            cache: "no-cache",
          });
          if (!response.ok) return;

          const payload = await response.json();
          if (payload && typeof payload.version === "string" && payload.version) {
            window.location.reload();
          }
        }

        scheduleNextCheck();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            visibleSince = Date.now();
            checkVersion().catch(() => {}).finally(scheduleNextCheck);
          } else {
            window.clearTimeout(pollTimer);
          }
        });
        checkVersion().catch(() => {}).finally(scheduleNextCheck);
      })();
    </script>
  </body>
</html>`;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/data", async (req, res) => {
  const currentTab = getCurrentTabFromReq(req);
  const refreshSecret = getValidatedRefreshSecret(req);

  try {
    if (hasRefreshParam(req) && !refreshSecret) {
      res.set("Cache-Control", EDGE_CACHE_CONTROL_FORCE);
      res.status(403).json({ error: "Parametro autorefresh no autorizado" });
      return;
    }

    const data = await getTournamentData({ forceRefresh: Boolean(refreshSecret) });
    const cacheControl = refreshSecret ? EDGE_CACHE_CONTROL_FORCE : EDGE_CACHE_CONTROL;

    if (!refreshSecret) {
      const etag = buildEtag(`${currentTab}|${new Date(data.generatedAt).toISOString()}`);
      if (isNotModified(req, res, etag, cacheControl)) {
        return;
      }
    } else {
      res.set("Cache-Control", cacheControl);
    }

    res.status(200).json({
      generatedAt: data.generatedAt,
      generatedAtFormatted: formatDate(data.generatedAt),
      currentTab,
      bodyHtml: renderBodyByTab(data, currentTab),
    });
  } catch (error) {
    console.error(error);
    res.set("Cache-Control", EDGE_CACHE_CONTROL_FORCE);
    res.status(error.statusCode || 500).json({ error: "Error al cargar datos" });
  }
});

app.get("/api/version", async (req, res) => {
  try {
    const version = await getCachedVersion();
    const etag = buildEtag(version || "no-data");
    if (isNotModified(req, res, etag, VERSION_CACHE_CONTROL)) {
      return;
    }

    res.status(200).json({
      version,
      generatedAtFormatted: version ? formatDate(version) : "",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al cargar version" });
  }
});

app.get("/", async (req, res) => {
  const currentTab = getCurrentTabFromReq(req);
  const refreshSecret = getValidatedRefreshSecret(req);
  const refreshDoneDate = getRefreshDoneDate(req);

  try {
    if (isMockPreview(req)) {
      res.set("Cache-Control", EDGE_CACHE_CONTROL_FORCE);
      res.status(200).send(renderPage(getMockTournamentData(), currentTab, refreshDoneDate));
      return;
    }

    if (hasRefreshParam(req) && !refreshSecret) {
      res.set("Cache-Control", EDGE_CACHE_CONTROL_FORCE);
      res.status(403).send(renderLoadingErrorPage("Parametro autorefresh no autorizado."));
      return;
    }

    if (refreshSecret) {
      const data = await getTournamentData({ forceRefresh: true });
      const params = new URLSearchParams({
        tab: currentTab,
        [REFRESH_DONE_PARAM]: new Date(data.generatedAt).toISOString(),
      });
      res.set("Cache-Control", EDGE_CACHE_CONTROL_FORCE);
      res.redirect(303, `/?${params.toString()}`);
      return;
    }

    const data = await getTournamentData({ forceRefresh: false });
    const cacheControl = EDGE_CACHE_CONTROL;

    const etag = buildEtag(`${currentTab}|${new Date(data.generatedAt).toISOString()}`);
    if (isNotModified(req, res, etag, cacheControl)) {
      return;
    }

    res.status(200).send(renderPage(data, currentTab, refreshDoneDate));
  } catch (error) {
    console.error(error);
    res.set("Cache-Control", EDGE_CACHE_CONTROL_FORCE);
    res.status(error.statusCode || 500).send(renderLoadingErrorPage(error.message));
  }
});

app.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
});
