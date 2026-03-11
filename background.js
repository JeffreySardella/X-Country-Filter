// background.js — Service Worker (MV3 module)
import { resolveCountry } from "./utils/countryResolver.js";

const DEBUG = true;
function log(...args) { if (DEBUG) console.log("[XCF background]", ...args); }

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NOMINATIM_MIN_GAP_MS = 1100;
const CACHE_VERSION = 2; // bump to invalidate stale cache

log("Service worker loaded");

// --- Onboarding ---

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const data = await chrome.storage.local.get("onboardingComplete");
    if (!data.onboardingComplete) {
      chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
    }
  }

  // Clear stale cache when cache version changes
  const data = await chrome.storage.local.get("cacheVersion");
  if (data.cacheVersion !== CACHE_VERSION) {
    log("Cache version changed, clearing userCache");
    await chrome.storage.local.remove("userCache");
    await chrome.storage.local.set({ cacheVersion: CACHE_VERSION });
  }
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RESOLVE_USERS") {
    handleResolveUsers(message.users).then(sendResponse);
    return true;
  }
  if (message.type === "GET_SETTINGS") {
    chrome.storage.local.get("settings").then(data => {
      sendResponse(data.settings || getDefaultSettings());
    });
    return true;
  }
  if (message.type === "GET_STATS") {
    chrome.storage.local.get("stats").then(data => {
      sendResponse(data.stats || getDefaultStats());
    });
    return true;
  }
  if (message.type === "UPDATE_STATS") {
    handleUpdateStats(message.stats).then(sendResponse);
    return true;
  }
});

// --- User Resolution ---

async function handleResolveUsers(users) {
  log("Resolving", users.length, "users");
  const data = await chrome.storage.local.get("userCache");
  const cache = data.userCache || {};
  const settings = (await chrome.storage.local.get("settings")).settings || getDefaultSettings();
  const now = Date.now();
  const results = {};
  const toResolve = [];

  for (const user of users) {
    const userId = user.id_str;
    const cached = cache[userId];
    // Re-resolve if: no cache, cache expired, or cached as unknown but now have location
    const needsResolve = !cached
      || (now - cached.resolvedAt) >= CACHE_TTL_MS
      || (cached.country === "unknown" && user.location);
    if (needsResolve) {
      toResolve.push(user);
    } else {
      results[userId] = cached.country;
      log("Cache hit:", user.screen_name, "→", cached.country);
    }
  }

  for (const user of toResolve) {
    let country = resolveCountry(user.location, user.lang);
    log("Resolved:", user.screen_name, "location=\"" + user.location + "\" lang=" + user.lang, "→", country);

    if (country === "unknown" && user.location && settings.useApiFallback) {
      const apiResult = await nominatimLookup(user.location);
      if (apiResult) { country = apiResult; log("Nominatim fallback:", user.location, "→", country); }
    }

    cache[user.id_str] = { country, resolvedAt: now };
    results[user.id_str] = country;
  }

  if (toResolve.length > 0) {
    await chrome.storage.local.set({ userCache: cache });
  }

  return results;
}

// --- Nominatim API Fallback ---

async function nominatimLookup(locationString) {
  try {
    // Store timestamp BEFORE delay to survive service worker suspension
    const data = await chrome.storage.local.get("nominatimLastRequest");
    const lastRequest = data.nominatimLastRequest || 0;
    const now = Date.now();
    const elapsed = now - lastRequest;

    await chrome.storage.local.set({ nominatimLastRequest: now });

    if (elapsed < NOMINATIM_MIN_GAP_MS) {
      await new Promise(resolve => setTimeout(resolve, NOMINATIM_MIN_GAP_MS - elapsed));
    }

    const url = "https://nominatim.openstreetmap.org/search?q="
      + encodeURIComponent(locationString)
      + "&format=json&limit=1&addressdetails=1";
    const response = await fetch(url, {
      headers: { "User-Agent": "XCountryFilter/1.0" }
    });

    if (!response.ok) return null;

    const results = await response.json();
    if (results.length > 0 && results[0].address && results[0].address.country_code) {
      return results[0].address.country_code.toUpperCase();
    }
  } catch (e) {
    // Silently fail — best-effort
  }
  return null;
}

// --- Cache Cleanup ---

async function cleanExpiredCache() {
  const data = await chrome.storage.local.get("userCache");
  const cache = data.userCache || {};
  const now = Date.now();
  let changed = false;

  for (const userId of Object.keys(cache)) {
    if ((now - cache[userId].resolvedAt) >= CACHE_TTL_MS) {
      delete cache[userId];
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ userCache: cache });
  }
}

chrome.alarms?.create("cacheCleanup", { periodInMinutes: 60 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "cacheCleanup") cleanExpiredCache();
});

// --- Stats ---

async function handleUpdateStats(incomingStats) {
  const data = await chrome.storage.local.get("stats");
  const stats = data.stats || getDefaultStats();
  const today = new Date().toISOString().slice(0, 10);

  if (stats.lastResetDate !== today) {
    stats.filteredToday = 0;
    stats.lastResetDate = today;
  }

  stats.totalFiltered += incomingStats.filtered || 0;
  stats.totalProcessed += incomingStats.processed || 0;
  stats.filteredToday += incomingStats.filtered || 0;

  await chrome.storage.local.set({ stats });
  return stats;
}

// --- Defaults ---

function getDefaultSettings() {
  return {
    enabled: true, mode: "blocklist", displayMode: "hidden",
    countries: [], hideUnknown: false, useApiFallback: false
  };
}

function getDefaultStats() {
  return {
    totalFiltered: 0, totalProcessed: 0, filteredToday: 0,
    lastResetDate: new Date().toISOString().slice(0, 10)
  };
}
