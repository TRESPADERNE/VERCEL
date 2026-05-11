const express = require("express");
const path = require("path");
const {
  EDGE_CACHE_CONTROL,
  EDGE_CACHE_CONTROL_FORCE,
  REFRESH_DONE_PARAM,
  REFRESH_SECRET,
  REFRESH_SECRET_PARAM,
  TABS,
  VERSION_CACHE_CONTROL,
} = require("./src/config");
const {
  getCachedVersion,
  getMockTournamentData,
  getTournamentData,
} = require("./src/tournamentData");
const { renderBodyByTab, renderLoadingErrorPage, renderPage } = require("./src/render");
const { buildEtag, formatDate, isNotModified } = require("./src/utils");

const app = express();
const port = process.env.PORT || 3000;

app.use("/static", express.static(path.join(__dirname, "static")));

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

function getRefreshDoneDate(req) {
  const raw = String(req.query[REFRESH_DONE_PARAM] || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMockPreview(req) {
  return process.env.NODE_ENV !== "production" && String(req.query.mock || "") === "1";
}

function dataEtag(data, currentTab) {
  return buildEtag(`${currentTab}|${new Date(data.generatedAt).toISOString()}`);
}

function rejectUnauthorizedRefresh(res, format) {
  res.set("Cache-Control", EDGE_CACHE_CONTROL_FORCE);

  if (format === "json") {
    res.status(403).json({ error: "Parametro autorefresh no autorizado" });
    return;
  }

  res.status(403).send(renderLoadingErrorPage("Parametro autorefresh no autorizado."));
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/data", async (req, res) => {
  const currentTab = getCurrentTabFromReq(req);
  const refreshSecret = getValidatedRefreshSecret(req);

  try {
    if (hasRefreshParam(req) && !refreshSecret) {
      rejectUnauthorizedRefresh(res, "json");
      return;
    }

    const data = await getTournamentData({ forceRefresh: Boolean(refreshSecret) });
    const cacheControl = refreshSecret ? EDGE_CACHE_CONTROL_FORCE : EDGE_CACHE_CONTROL;

    if (refreshSecret) {
      res.set("Cache-Control", cacheControl);
    } else if (isNotModified(req, res, dataEtag(data, currentTab), cacheControl)) {
      return;
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
      rejectUnauthorizedRefresh(res, "html");
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
    if (isNotModified(req, res, dataEtag(data, currentTab), EDGE_CACHE_CONTROL)) {
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
