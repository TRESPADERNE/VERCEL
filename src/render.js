const {
  TABS,
  VERSION_POLL_MS,
  VERSION_POLL_FAST_WINDOW_MS,
  VERSION_POLL_WARM_MS,
  VERSION_POLL_COOL_MS,
  VERSION_POLL_IDLE_MS,
} = require("./config");
const { TEAM_ALIAS_NORMALIZED, teamLogo } = require("./teams");
const { escapeHtml, formatDate, normalizeText } = require("./utils");

function buildTabHref(tab) {
  const params = new URLSearchParams({ tab });
  return `/?${params.toString()}`;
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
      <div class="match-meta">Campo ${escapeHtml(match.campo)} &middot; ${escapeHtml(match.hora)}</div>
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

function renderKnockoutPhase(title, matches = [], emptyMessage, matchLimit = null) {
  const phaseMatches = matchLimit ? matches.slice(0, matchLimit) : matches;
  const matchesHtml = phaseMatches.length
    ? phaseMatches.map((match, index) => renderMatchCard(match, index % 2 === 1)).join("")
    : `<p class="empty">${escapeHtml(emptyMessage)}</p>`;

  return `
    <section class="knockout-phase">
      <h3 class="section-title knockout-title">${escapeHtml(title)}</h3>
      <div class="matches-section knockout-matches">${matchesHtml}</div>
    </section>
  `;
}

function renderEliminatoriasPage(eliminatoriasData, quarterTitle, semiTitle, finalTitle) {
  return `
    ${renderKnockoutPhase(
      quarterTitle,
      eliminatoriasData.quarters,
      "No hay cuartos de final para mostrar."
    )}
    ${renderKnockoutPhase(
      semiTitle,
      eliminatoriasData.semis,
      "No hay semifinales para mostrar."
    )}
    ${renderKnockoutPhase(finalTitle, eliminatoriasData.finals, "No hay finales para mostrar.", 1)}
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
        "Final"
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

function renderTabScript() {
  return `
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
      })();`;
}

function renderVersionPollingScript(initialVersion = "") {
  return `
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

          if (currentVersion ? payload.version !== currentVersion : payload.version) {
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
        ${initialVersion ? "" : "checkVersion().catch(() => {}).finally(scheduleNextCheck);"}
      })();`;
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
    <title>Torneo Alevin Femenino</title>
    <link rel="stylesheet" href="/static/style.css" />
  </head>
  <body>
    <main class="page">
      <header class="header">
        <img class="header-banner" src="https://i.imgur.com/S0xSPwE.png" alt="cabecera" />
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
    <script>${renderTabScript()}

${renderVersionPollingScript(initialVersion)}
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
    <script>${renderVersionPollingScript()}</script>
  </body>
</html>`;
}

module.exports = {
  buildTabHref,
  renderBodyByTab,
  renderLoadingErrorPage,
  renderPage,
};
