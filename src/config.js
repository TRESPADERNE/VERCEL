const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MANUAL_REFRESH_ONLY = true;
const VERSION_POLL_MS = 45 * 1000;
const VERSION_POLL_FAST_WINDOW_MS = 5 * 60 * 1000;
const VERSION_POLL_WARM_MS = 2 * 60 * 1000;
const VERSION_POLL_COOL_MS = 5 * 60 * 1000;
const VERSION_POLL_IDLE_MS = 10 * 60 * 1000;
const EDGE_CACHE_CONTROL = "public, max-age=10, s-maxage=60, stale-while-revalidate=60";
const EDGE_CACHE_CONTROL_FORCE = "no-store";
const VERSION_CACHE_CONTROL = "public, max-age=5, s-maxage=15";
const REFRESH_SECRET_PARAM = "autorefresh";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "";
const REFRESH_DONE_PARAM = "refreshDoneAt";
const REDIS_DATA_KEY = "bcf-cup:data";
const REDIS_VERSION_KEY = "bcf-cup:version";
const TABS = ["Grupo A", "Grupo B", "Eliminatorias"];

module.exports = {
  CACHE_TTL_MS,
  MANUAL_REFRESH_ONLY,
  VERSION_POLL_MS,
  VERSION_POLL_FAST_WINDOW_MS,
  VERSION_POLL_WARM_MS,
  VERSION_POLL_COOL_MS,
  VERSION_POLL_IDLE_MS,
  EDGE_CACHE_CONTROL,
  EDGE_CACHE_CONTROL_FORCE,
  VERSION_CACHE_CONTROL,
  REFRESH_SECRET_PARAM,
  REFRESH_SECRET,
  REFRESH_DONE_PARAM,
  REDIS_DATA_KEY,
  REDIS_VERSION_KEY,
  TABS,
};
