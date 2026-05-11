const { google } = require("googleapis");
const {
  CACHE_TTL_MS,
  MANUAL_REFRESH_ONLY,
  REDIS_DATA_KEY,
  REDIS_VERSION_KEY,
} = require("./config");

let cache = {
  data: null,
  fetchedAt: 0,
};
let cacheLoadingPromise = null;
let redisPromise = null;

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

async function getCachedVersion() {
  const redis = await getRedis();
  if (redis) {
    return (await redis.get(REDIS_VERSION_KEY)) || "";
  }

  return cache.data ? new Date(cache.data.generatedAt).toISOString() : "";
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

module.exports = {
  getTournamentData,
  getCachedVersion,
  getMockTournamentData,
  rowToMatch,
};
