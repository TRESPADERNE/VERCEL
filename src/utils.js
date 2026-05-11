const crypto = require("crypto");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
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

module.exports = {
  escapeHtml,
  normalizeText,
  formatDate,
  buildEtag,
  isNotModified,
};
