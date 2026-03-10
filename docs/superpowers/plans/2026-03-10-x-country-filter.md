# X Country Filter Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 browser extension that filters X (Twitter) posts by account country using a fetch hook, heuristic country resolution pipeline, and user-configurable blocklist/allowlist.

**Architecture:** Fetch hook in MAIN world intercepts X's GraphQL responses and extracts user objects. Content script observes DOM mutations and applies filters. Background service worker runs the country resolution pipeline and manages the user cache. Popup and onboarding pages provide settings UI.

**Tech Stack:** Vanilla JS (no build step), Manifest V3, Node.js built-in test runner for pure logic tests, manual browser testing for UI.

**Spec:** `docs/superpowers/specs/2026-03-10-x-country-filter-design.md`

---

## File Map

| File | Responsibility | Created in Task |
|---|---|---|
| `manifest.json` | MV3 extension manifest | 1 |
| `.gitignore` | Git ignore rules | 1 |
| `utils/countries.js` | Country data: ISO codes, names, aliases, flags, languages | 2 |
| `utils/cityMap.js` | Major city → country code lookup table | 3 |
| `utils/countryResolver.js` | 7-step country resolution pipeline | 4 |
| `tests/countryResolver.test.js` | Tests for the resolution pipeline | 4 |
| `background.js` | Service worker: resolution, cache, onboarding, Nominatim fallback | 5 |
| `fetchHook.js` | MAIN world script: hooks fetch(), extracts user objects | 6 |
| `content.js` | DOM observer, filter application, message relay, stats | 7 |
| `popup/popup.html` | Settings popup markup | 8 |
| `popup/popup.css` | Popup styles | 8 |
| `popup/popup.js` | Popup logic: settings read/write, country search, stats display | 8 |
| `onboarding/onboarding.html` | 4-step setup wizard markup | 9 |
| `onboarding/onboarding.css` | Onboarding styles | 9 |
| `onboarding/onboarding.js` | Wizard flow, country selection, saves initial settings | 9 |
| `guide/guide.html` | "How to Use" documentation page | 10 |
| `guide/guide.css` | Guide styles | 10 |
| `icons/icon16.png` | Toolbar icon 16x16 | 11 |
| `icons/icon48.png` | Extension page icon 48x48 | 11 |
| `icons/icon128.png` | Store listing icon 128x128 | 11 |

---

## Chunk 1: Foundation — Manifest, Data Files, Country Resolver

### Task 1: Project Scaffold — Manifest & Gitignore

**Files:**
- Create: `manifest.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
.superpowers/
*.zip
*.crx
*.pem
```

- [ ] **Step 2: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "X Country Filter",
  "version": "1.0.0",
  "description": "Filter X (Twitter) posts by account country — hide the noise, keep the signal.",
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["*://x.com/*", "*://twitter.com/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["*://x.com/*", "*://twitter.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    },
    {
      "matches": ["*://x.com/*", "*://twitter.com/*"],
      "js": ["fetchHook.js"],
      "world": "MAIN",
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add manifest.json .gitignore
git commit -m "feat: add MV3 manifest and gitignore"
```

---

### Task 2: Country Data File

**Files:**
- Create: `utils/countries.js`

This file exports the full list of countries with ISO codes, names, aliases, flag emoji, and associated languages. Used by the resolver and UI components.

- [ ] **Step 1: Create `utils/countries.js`**

Export an array of country objects. Each entry has:
- `code` — ISO 3166-1 alpha-2 (e.g. `"US"`)
- `name` — Official name (e.g. `"United States"`)
- `aliases` — Array of common alternative names (e.g. `["usa", "u.s.a", "u.s.a.", "america", "united states of america"]`)
- `flag` — Emoji flag (e.g. `"🇺🇸"`)
- `languages` — Array of language codes strongly associated with this country only (e.g. `["ja"]` for Japan). Empty for countries with widely-shared languages.

Include all ~250 ISO countries. For aliases, focus on the most commonly used informal names, abbreviations, and local-language names for the top 50 countries by X user population. Other countries just need their official name.

Language associations (only unambiguous single-country mappings):
- `"ja"` → Japan, `"ko"` → South Korea, `"th"` → Thailand, `"he"` → Israel, `"vi"` → Vietnam
- `"uk"` → Ukraine, `"el"` → Greece, `"ka"` → Georgia, `"hy"` → Armenia, `"az"` → Azerbaijan
- `"mn"` → Mongolia, `"km"` → Cambodia, `"lo"` → Laos, `"my"` → Myanmar
- `"si"` → Sri Lanka, `"ne"` → Nepal, `"am"` → Ethiopia, `"ti"` → Eritrea

Do NOT map: `en`, `es`, `pt`, `fr`, `ar`, `zh`, `de`, `it`, `nl`, `ru`, `tr`, `pl`, `sv`, `da`, `fi`, `no`, `ro`, `hu`, `cs`, `sk`, `bg`, `hr`, `sr`, `ms`, `id`, `tl`, `sw`, `hi`, `bn`, `ur`, `ta`, `te`, `ml`, `mr`, `gu`, `kn`, `pa`.

Structure:

```js
// utils/countries.js
export const COUNTRIES = [
  { code: "AF", name: "Afghanistan", aliases: [], flag: "🇦🇫", languages: [] },
  // ... all ~250 countries ...
  { code: "US", name: "United States", aliases: ["usa", "u.s.a", "u.s.a.", "america", "united states of america", "the us", "the usa"], flag: "🇺🇸", languages: [] },
  // ... etc
];

// Precomputed lookup maps for fast access
export const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map(c => [c.code, c]));
export const COUNTRY_BY_NAME = new Map();
for (const c of COUNTRIES) {
  COUNTRY_BY_NAME.set(c.name.toLowerCase(), c.code);
  for (const alias of c.aliases) {
    COUNTRY_BY_NAME.set(alias.toLowerCase(), c.code);
  }
}
export const LANGUAGE_TO_COUNTRY = new Map();
for (const c of COUNTRIES) {
  for (const lang of c.languages) {
    LANGUAGE_TO_COUNTRY.set(lang, c.code);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add utils/countries.js
git commit -m "feat: add country data with aliases, flags, and language mappings"
```

---

### Task 3: City Map Data File

**Files:**
- Create: `utils/cityMap.js`

- [ ] **Step 1: Create `utils/cityMap.js`**

Export a `Map` of lowercase city names to ISO country codes. Include:
- All world capitals (~195)
- Top 3-5 largest cities per country (by population) for the top 80 countries by X usage
- Common alternate spellings (e.g. `"mumbai"` and `"bombay"` → `"IN"`)

Handle ambiguous city names by mapping to the most likely country (e.g. `"paris"` → `"FR"`).

Structure:

```js
// utils/cityMap.js
export const CITY_TO_COUNTRY = new Map([
  ["abidjan", "CI"],
  ["abu dhabi", "AE"],
  ["abuja", "NG"],
  ["accra", "GH"],
  ["addis ababa", "ET"],
  // ... ~500-800 entries total, alphabetically organized ...
]);
```

- [ ] **Step 2: Commit**

```bash
git add utils/cityMap.js
git commit -m "feat: add city-to-country lookup map"
```

---

### Task 4: Country Resolver + Tests

**Files:**
- Create: `utils/countryResolver.js`
- Create: `tests/countryResolver.test.js`
- Create: `package.json` (minimal, for test script only)

- [ ] **Step 1: Create minimal `package.json`**

```json
{
  "name": "x-country-filter",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Write failing tests for the resolver**

Create `tests/countryResolver.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCountry } from "../utils/countryResolver.js";

describe("countryResolver", () => {
  describe("Step 1 & 2: Emoji flag decode", () => {
    it("decodes a single flag emoji", () => {
      assert.equal(resolveCountry("🇧🇷"), "BR");
    });
    it("decodes flag embedded in text", () => {
      assert.equal(resolveCountry("Rio de Janeiro 🇧🇷"), "BR");
    });
    it("prioritizes flag over other signals", () => {
      assert.equal(resolveCountry("Living in Canada 🇺🇸"), "US");
    });
  });

  describe("Step 3: Exact country name match", () => {
    it("matches full country name", () => {
      assert.equal(resolveCountry("Nigeria"), "NG");
    });
    it("matches country name case-insensitively", () => {
      assert.equal(resolveCountry("JAPAN"), "JP");
    });
    it("matches common aliases", () => {
      assert.equal(resolveCountry("USA"), "US");
    });
    it("matches alias with periods", () => {
      assert.equal(resolveCountry("U.S.A."), "US");
    });
    it("matches 'america' alias", () => {
      assert.equal(resolveCountry("America"), "US");
    });
    it("matches 'uk' alias", () => {
      assert.equal(resolveCountry("UK"), "GB");
    });
  });

  describe("Step 4: City lookup", () => {
    it("resolves a major city", () => {
      assert.equal(resolveCountry("Lagos"), "NG");
    });
    it("resolves city case-insensitively", () => {
      assert.equal(resolveCountry("TOKYO"), "JP");
    });
    it("resolves alternate city name", () => {
      assert.equal(resolveCountry("Bombay"), "IN");
    });
  });

  describe("Step 5: Partial/fuzzy match", () => {
    it("finds country name within a phrase", () => {
      assert.equal(resolveCountry("Living in Brazil"), "BR");
    });
    it("finds country name in a compound location", () => {
      assert.equal(resolveCountry("somewhere in India"), "IN");
    });
    it("finds country with surrounding text", () => {
      assert.equal(resolveCountry("Born and raised in Germany"), "DE");
    });
  });

  describe("Step 6: Language inference", () => {
    it("infers country from unambiguous language", () => {
      assert.equal(resolveCountry("", "ja"), "JP");
    });
    it("infers Korean", () => {
      assert.equal(resolveCountry("", "ko"), "KR");
    });
    it("does not infer from ambiguous language", () => {
      assert.equal(resolveCountry("", "en"), "unknown");
    });
    it("does not infer from Spanish", () => {
      assert.equal(resolveCountry("", "es"), "unknown");
    });
    it("does not infer from Portuguese", () => {
      assert.equal(resolveCountry("", "pt"), "unknown");
    });
  });

  describe("Edge cases", () => {
    it("returns unknown for empty string", () => {
      assert.equal(resolveCountry(""), "unknown");
    });
    it("returns unknown for null", () => {
      assert.equal(resolveCountry(null), "unknown");
    });
    it("returns unknown for undefined", () => {
      assert.equal(resolveCountry(undefined), "unknown");
    });
    it("returns unknown for gibberish", () => {
      assert.equal(resolveCountry("xyzzy12345"), "unknown");
    });
    it("handles extra whitespace", () => {
      assert.equal(resolveCountry("  Nigeria  "), "NG");
    });
    it("handles location with comma-separated city, country", () => {
      assert.equal(resolveCountry("Lagos, Nigeria"), "NG");
    });
    it("handles location with comma-separated city, state abbreviation", () => {
      assert.equal(resolveCountry("Los Angeles, CA"), "US");
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: All tests FAIL because `resolveCountry` does not exist yet.

- [ ] **Step 4: Implement `utils/countryResolver.js`**

```js
// utils/countryResolver.js
import { COUNTRY_BY_NAME, LANGUAGE_TO_COUNTRY } from "./countries.js";
import { CITY_TO_COUNTRY } from "./cityMap.js";

/**
 * Resolve a location string (and optional lang code) to an ISO country code.
 * Returns the 2-letter code or "unknown".
 *
 * @param {string|null|undefined} location - Raw location string from user profile
 * @param {string|null|undefined} lang - Account language code (e.g. "ja", "en")
 * @returns {string} ISO 3166-1 alpha-2 country code or "unknown"
 */
export function resolveCountry(location, lang) {
  // Step 1: Normalize
  const raw = (location ?? "").trim();
  if (!raw && !lang) return "unknown";

  // Step 2: Emoji flag decode — scan for regional indicator pairs
  const flagMatch = raw.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (flagMatch) {
    const code = decodeFlagEmoji(flagMatch[0]);
    if (code) return code;
  }

  const normalized = raw
    .toLowerCase()
    .replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F1E5}\u{1F200}-\u{1F9FF}\u{E0020}-\u{E007F}]/gu, "")
    .replace(/[^\w\s,.\-']/g, "")
    .trim();

  if (!normalized && !lang) return "unknown";

  // Step 3: Exact country name match
  if (normalized && COUNTRY_BY_NAME.has(normalized)) {
    return COUNTRY_BY_NAME.get(normalized);
  }

  // Also try without periods (e.g. "u.s.a." → "usa")
  const noDots = normalized.replace(/\./g, "");
  if (noDots && noDots !== normalized && COUNTRY_BY_NAME.has(noDots)) {
    return COUNTRY_BY_NAME.get(noDots);
  }

  // Step 4: City lookup — check each comma-separated part, then full string
  if (normalized) {
    const parts = normalized.split(",").map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      if (COUNTRY_BY_NAME.has(part)) return COUNTRY_BY_NAME.get(part);
      if (CITY_TO_COUNTRY.has(part)) return CITY_TO_COUNTRY.get(part);
    }
    if (CITY_TO_COUNTRY.has(normalized)) {
      return CITY_TO_COUNTRY.get(normalized);
    }
  }

  // Step 5: Partial/fuzzy match — check if normalized contains a country name
  if (normalized) {
    for (const [name, code] of COUNTRY_BY_NAME) {
      if (name.length >= 4 && normalized.includes(name)) {
        return code;
      }
    }
  }

  // Step 6: Language inference (unambiguous languages only)
  if (lang && LANGUAGE_TO_COUNTRY.has(lang)) {
    return LANGUAGE_TO_COUNTRY.get(lang);
  }

  // Step 7 is API fallback — handled in background.js, not here
  return "unknown";
}

/**
 * Decode a flag emoji (two regional indicator symbols) to ISO country code.
 */
function decodeFlagEmoji(flag) {
  const codePoints = [...flag];
  if (codePoints.length !== 2) return null;
  const first = codePoints[0].codePointAt(0) - 0x1F1E6 + 65;
  const second = codePoints[1].codePointAt(0) - 0x1F1E6 + 65;
  return String.fromCharCode(first) + String.fromCharCode(second);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add utils/countryResolver.js tests/countryResolver.test.js package.json
git commit -m "feat: add country resolver with full heuristic pipeline and tests"
```

---

## Chunk 2: Core Extension Logic — Background, Fetch Hook, Content Script

### Task 5: Background Service Worker

**Files:**
- Create: `background.js`

Handles: receiving user objects from content.js, running the resolution pipeline, caching results with 7-day TTL, onboarding trigger on install, Nominatim API fallback (optional, rate-limited), stats management.

- [ ] **Step 1: Create `background.js`**

```js
// background.js — Service Worker (MV3 module)
import { resolveCountry } from "./utils/countryResolver.js";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NOMINATIM_MIN_GAP_MS = 1100;

// --- Onboarding ---

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const data = await chrome.storage.local.get("onboardingComplete");
    if (!data.onboardingComplete) {
      chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
    }
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
  const data = await chrome.storage.local.get("userCache");
  const cache = data.userCache || {};
  const settings = (await chrome.storage.local.get("settings")).settings || getDefaultSettings();
  const now = Date.now();
  const results = {};
  const toResolve = [];

  for (const user of users) {
    const userId = user.id_str;
    const cached = cache[userId];
    if (cached && (now - cached.resolvedAt) < CACHE_TTL_MS) {
      results[userId] = cached.country;
    } else {
      toResolve.push(user);
    }
  }

  for (const user of toResolve) {
    let country = resolveCountry(user.location, user.lang);

    if (country === "unknown" && user.location && settings.useApiFallback) {
      const apiResult = await nominatimLookup(user.location);
      if (apiResult) country = apiResult;
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
    const data = await chrome.storage.local.get("nominatimLastRequest");
    const lastRequest = data.nominatimLastRequest || 0;
    const now = Date.now();
    const elapsed = now - lastRequest;

    if (elapsed < NOMINATIM_MIN_GAP_MS) {
      await new Promise(resolve => setTimeout(resolve, NOMINATIM_MIN_GAP_MS - elapsed));
    }

    await chrome.storage.local.set({ nominatimLastRequest: Date.now() });

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
```

- [ ] **Step 2: Commit**

```bash
git add background.js
git commit -m "feat: add background service worker with resolution, cache, and Nominatim fallback"
```

---

### Task 6: Fetch Hook (MAIN World)

**Files:**
- Create: `fetchHook.js`

Runs in MAIN world, intercepts `window.fetch()` to capture X's GraphQL API responses.

- [ ] **Step 1: Create `fetchHook.js`**

```js
// fetchHook.js — Injected into MAIN world to intercept X's fetch() calls
(function () {
  "use strict";

  const GRAPHQL_ENDPOINTS = [
    "HomeTimeline", "SearchTimeline", "TweetDetail",
    "Notifications", "UserByScreenName", "ConnectTabTimeline"
  ];

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && isTargetEndpoint(url)) {
        const clone = response.clone();
        clone.json().then(data => {
          const users = extractUsers(data);
          if (users.length > 0) {
            window.postMessage({ type: "XCF_USER_DATA", users }, "*");
          }
        }).catch(() => {});
      }
    } catch (e) {
      // Never break the page's fetch behavior
    }

    return response;
  };

  function isTargetEndpoint(url) {
    if (!url.includes("/graphql/")) return false;
    return GRAPHQL_ENDPOINTS.some(ep => url.includes(ep));
  }

  function extractUsers(obj) {
    const users = [];
    const seen = new Set();

    function walk(node) {
      if (!node || typeof node !== "object") return;

      if (node.id_str && typeof node.screen_name === "string") {
        if (!seen.has(node.id_str)) {
          seen.add(node.id_str);
          users.push({
            id_str: node.id_str,
            screen_name: node.screen_name,
            location: node.location || "",
            lang: node.lang || ""
          });
        }
        return;
      }

      if (node.user_results?.result?.legacy) {
        const legacy = node.user_results.result.legacy;
        const restId = node.user_results.result.rest_id;
        if (restId && !seen.has(restId)) {
          seen.add(restId);
          users.push({
            id_str: restId,
            screen_name: legacy.screen_name || "",
            location: legacy.location || "",
            lang: legacy.lang || ""
          });
        }
      }

      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else {
        for (const key of Object.keys(node)) walk(node[key]);
      }
    }

    walk(obj);
    return users;
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add fetchHook.js
git commit -m "feat: add fetch hook to intercept X GraphQL responses and extract user data"
```

---

### Task 7: Content Script

**Files:**
- Create: `content.js`

The content script listens for user data, observes DOM for tweets, applies filters. **Important:** Uses safe DOM methods (createElement/textContent) instead of innerHTML to prevent XSS from user-controlled data (location strings, country names).

- [ ] **Step 1: Create `content.js`**

```js
// content.js — DOM observer, filter application, message relay
(function () {
  "use strict";

  const countryCache = new Map();       // userId → country code
  const pendingTweets = new Map();      // userId → Set<DOMNode>
  let settings = null;
  let statsBuffer = { filtered: 0, processed: 0 };

  // --- Initialization ---

  async function init() {
    settings = await sendMessage({ type: "GET_SETTINGS" });
    if (!settings) return;

    window.addEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.addListener(onExtensionMessage);
    startObserver();
    setInterval(flushStats, 30000);
  }

  // --- Message Handling ---

  function onWindowMessage(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "XCF_USER_DATA") return;

    const users = event.data.users;
    if (!Array.isArray(users) || users.length === 0) return;

    sendMessage({ type: "RESOLVE_USERS", users }).then(results => {
      if (!results) return;

      for (const [userId, country] of Object.entries(results)) {
        countryCache.set(userId, country);
        // Also map screen_name → country for DOM-based lookups
        const user = users.find(u => u.id_str === userId);
        if (user?.screen_name) {
          countryCache.set(user.screen_name.toLowerCase(), country);
        }

        if (pendingTweets.has(userId)) {
          for (const node of pendingTweets.get(userId)) {
            if (node.isConnected) applyFilter(node, userId);
          }
          pendingTweets.delete(userId);
        }
      }
    });
  }

  function onExtensionMessage(message) {
    if (message.type === "SETTINGS_UPDATED") {
      settings = message.settings;
      reprocessAllTweets();
    }
  }

  // --- DOM Observation ---

  let processingQueue = [];
  let rafPending = false;

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!settings?.enabled) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const tweets = [];
          if (node.matches?.('article[data-testid="tweet"]')) {
            tweets.push(node);
          }
          const nested = node.querySelectorAll?.('article[data-testid="tweet"]');
          if (nested) tweets.push(...nested);

          for (const tweet of tweets) processingQueue.push(tweet);
        }
      }

      if (processingQueue.length > 0 && !rafPending) {
        rafPending = true;
        requestAnimationFrame(processQueue);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function processQueue() {
    rafPending = false;
    const batch = processingQueue.splice(0);

    for (const tweet of batch) {
      if (!tweet.isConnected) continue;
      const userId = extractUserId(tweet);
      if (!userId) continue;

      statsBuffer.processed++;

      if (countryCache.has(userId)) {
        applyFilter(tweet, userId);
      } else {
        if (!pendingTweets.has(userId)) pendingTweets.set(userId, new Set());
        pendingTweets.get(userId).add(tweet);
      }
    }
  }

  // --- User ID Extraction ---

  function extractUserId(tweetNode) {
    try {
      // Look for status links which contain /<username>/status/<id>
      const tweetLink = tweetNode.querySelector('a[href*="/status/"]');
      if (tweetLink) {
        const match = tweetLink.getAttribute("href").match(/^\/([^/]+)\/status\//);
        if (match) return match[1].toLowerCase();
      }

      // Fallback: user profile links
      const userLinks = tweetNode.querySelectorAll('a[role="link"][href^="/"]');
      for (const link of userLinks) {
        const href = link.getAttribute("href");
        if (href && (href.match(/\//g) || []).length === 1) {
          const screenName = href.replace("/", "");
          if (screenName && !screenName.includes("/")) {
            return screenName.toLowerCase();
          }
        }
      }
    } catch (e) {}
    return null;
  }

  // --- Filter Application ---

  function applyFilter(tweetNode, userId) {
    if (!settings?.enabled) {
      showTweet(tweetNode);
      return;
    }

    const country = countryCache.get(userId);
    if (!country) return;

    if (shouldFilterCountry(country)) {
      if (settings.displayMode === "collapsed") {
        collapseTweet(tweetNode, country);
      } else {
        hideTweet(tweetNode);
      }
      statsBuffer.filtered++;
    } else {
      showTweet(tweetNode);
    }
  }

  function shouldFilterCountry(country) {
    if (country === "unknown") return settings.hideUnknown;
    if (settings.mode === "allowlist") return !settings.countries.includes(country);
    return settings.countries.includes(country);
  }

  function hideTweet(node) {
    node.style.display = "none";
    node.setAttribute("data-xcf-filtered", "hidden");
  }

  /**
   * Replace tweet content with a collapsed bar.
   * Uses safe DOM methods (createElement/textContent) to prevent XSS —
   * the country name comes from our resolver but originates in user profiles.
   */
  function collapseTweet(node, country) {
    if (node.getAttribute("data-xcf-filtered") === "collapsed") return;

    // Save original children via cloneNode (safe — no innerHTML round-trip)
    if (!node._xcfOriginalChildren) {
      node._xcfOriginalChildren = [];
      for (const child of node.childNodes) {
        node._xcfOriginalChildren.push(child.cloneNode(true));
      }
    }

    // Clear existing content safely
    while (node.firstChild) node.removeChild(node.firstChild);

    const bar = document.createElement("div");
    bar.className = "xcf-collapsed-bar";
    bar.style.cssText = "background:#1e2d3d;border:1px solid #2f3336;border-radius:8px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin:4px 0;";

    const left = document.createElement("div");
    left.style.cssText = "display:flex;align-items:center;gap:8px;";

    const icon = document.createElement("span");
    icon.style.fontSize = "14px";
    icon.textContent = "\u{1F6AB}"; // 🚫

    const text = document.createElement("span");
    text.style.cssText = "color:#71767b;font-size:13px;";
    text.textContent = "Post hidden \u2014 account from ";

    const countrySpan = document.createElement("strong");
    countrySpan.style.color = "#8b949e";
    const countryName = country === "unknown" ? "unknown country" : country;
    countrySpan.textContent = countryName;
    text.appendChild(countrySpan);

    left.appendChild(icon);
    left.appendChild(text);

    const showBtn = document.createElement("span");
    showBtn.style.cssText = "color:#1d9bf0;font-size:12px;cursor:pointer;";
    showBtn.textContent = "Show \u25BE";
    showBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      restoreOriginalContent(node);
    });

    bar.appendChild(left);
    bar.appendChild(showBtn);
    node.appendChild(bar);
    node.setAttribute("data-xcf-filtered", "collapsed");
  }

  function restoreOriginalContent(node) {
    if (!node._xcfOriginalChildren) return;
    while (node.firstChild) node.removeChild(node.firstChild);
    for (const child of node._xcfOriginalChildren) {
      node.appendChild(child.cloneNode(true));
    }
    node.removeAttribute("data-xcf-filtered");
  }

  function showTweet(node) {
    if (node.getAttribute("data-xcf-filtered") === "collapsed") {
      restoreOriginalContent(node);
    }
    node.style.display = "";
    node.removeAttribute("data-xcf-filtered");
  }

  function reprocessAllTweets() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    for (const tweet of tweets) {
      const userId = extractUserId(tweet);
      if (userId && countryCache.has(userId)) applyFilter(tweet, userId);
    }
  }

  // --- Stats ---

  function flushStats() {
    if (statsBuffer.filtered === 0 && statsBuffer.processed === 0) return;
    sendMessage({ type: "UPDATE_STATS", stats: { ...statsBuffer } });
    statsBuffer.filtered = 0;
    statsBuffer.processed = 0;
  }

  // --- Helpers ---

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, resolve);
    });
  }

  init();
})();
```

- [ ] **Step 2: Commit**

```bash
git add content.js
git commit -m "feat: add content script with DOM observer, safe filter application, and stats"
```

---

## Chunk 3: UI — Popup, Onboarding, Guide, Icons

### Task 8: Popup UI

**Files:**
- Create: `popup/popup.html`
- Create: `popup/popup.css`
- Create: `popup/popup.js`

- [ ] **Step 1: Create `popup/popup.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>X Country Filter</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="popup">
    <header class="header">
      <div class="header-left">
        <span class="logo">🌍</span>
        <h1>X Country Filter</h1>
      </div>
      <label class="toggle">
        <input type="checkbox" id="enableToggle" checked>
        <span class="toggle-slider"></span>
      </label>
    </header>

    <section class="settings-section">
      <div class="setting-row">
        <label for="modeSelect">Mode:</label>
        <select id="modeSelect">
          <option value="blocklist">Blocklist</option>
          <option value="allowlist">Allowlist</option>
        </select>
      </div>
      <div class="setting-row">
        <label for="displaySelect">Display:</label>
        <select id="displaySelect">
          <option value="hidden">Hidden</option>
          <option value="collapsed">Collapsed</option>
        </select>
      </div>
    </section>

    <section class="countries-section">
      <h2>Countries</h2>
      <input type="text" id="countrySearch" placeholder="Search countries..." class="search-input">
      <div id="countryList" class="country-list"></div>
    </section>

    <section class="options-section">
      <label class="checkbox-row">
        <input type="checkbox" id="hideUnknown">
        <span>Hide unknown accounts</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="useApiFallback">
        <span>Use online lookup for unrecognized locations</span>
      </label>
    </section>

    <section class="stats-section">
      <span id="statsText">Filtered: 0 posts today</span>
    </section>

    <footer class="footer">
      <button id="resetBtn" class="btn-reset">Reset to Defaults</button>
      <button id="helpBtn" class="btn-help" title="How to Use">?</button>
    </footer>
  </div>

  <script src="popup.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create `popup/popup.css`**

Full CSS for popup — X dark theme styling with toggle switch, country list scrollbar, settings dropdowns. (See the popup.css in the spec mockup. Key properties: `width: 320px`, dark background `#15202b`, accent `#1d9bf0`, border `#2f3336`, text `#e7e9ea`, secondary `#71767b`.)

- [ ] **Step 3: Create `popup/popup.js`**

Uses safe DOM methods for rendering the country list — creates elements via `document.createElement` and sets text via `textContent` instead of innerHTML. Country data comes from the bundled `countries.js` file (trusted data), but we use safe methods as a defense-in-depth measure.

Key behaviors:
- Loads settings from `chrome.storage.local` on open
- Renders country list with search filtering using DOM creation methods
- Auto-saves on any change (no Save button)
- Sends `SETTINGS_UPDATED` message to active X tabs on change
- Reset button clears `onboardingComplete`, `settings`, `stats` (preserves `userCache`)
- `?` button opens `guide/guide.html`

```js
// popup/popup.js
import { COUNTRIES } from "../utils/countries.js";

let settings = null;

document.addEventListener("DOMContentLoaded", async () => {
  settings = await sendMessage({ type: "GET_SETTINGS" });
  if (!settings) {
    settings = {
      enabled: true, mode: "blocklist", displayMode: "hidden",
      countries: [], hideUnknown: false, useApiFallback: false
    };
  }

  renderSettings();
  renderCountryList();
  loadStats();

  document.getElementById("enableToggle").addEventListener("change", onToggleChange);
  document.getElementById("modeSelect").addEventListener("change", onSettingChange);
  document.getElementById("displaySelect").addEventListener("change", onSettingChange);
  document.getElementById("hideUnknown").addEventListener("change", onSettingChange);
  document.getElementById("useApiFallback").addEventListener("change", onSettingChange);
  document.getElementById("countrySearch").addEventListener("input", onSearchInput);
  document.getElementById("resetBtn").addEventListener("click", onReset);
  document.getElementById("helpBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("guide/guide.html") });
  });
});

function renderSettings() {
  document.getElementById("enableToggle").checked = settings.enabled;
  document.getElementById("modeSelect").value = settings.mode;
  document.getElementById("displaySelect").value = settings.displayMode;
  document.getElementById("hideUnknown").checked = settings.hideUnknown;
  document.getElementById("useApiFallback").checked = settings.useApiFallback;
}

function renderCountryList(filter = "") {
  const container = document.getElementById("countryList");
  const filterLower = filter.toLowerCase();

  const filtered = filter
    ? COUNTRIES.filter(c =>
        c.name.toLowerCase().includes(filterLower) ||
        c.code.toLowerCase().includes(filterLower))
    : COUNTRIES;

  // Safe DOM rendering — no innerHTML
  container.replaceChildren();
  for (const c of filtered) {
    const label = document.createElement("label");
    label.className = "country-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = c.code;
    checkbox.checked = settings.countries.includes(c.code);
    checkbox.addEventListener("change", onCountryToggle);

    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = c.flag;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.name;

    label.appendChild(checkbox);
    label.appendChild(flag);
    label.appendChild(name);
    container.appendChild(label);
  }
}

async function loadStats() {
  const stats = await sendMessage({ type: "GET_STATS" });
  if (stats) {
    document.getElementById("statsText").textContent =
      "Filtered: " + stats.filteredToday + " posts today";
  }
}

function onToggleChange(e) { settings.enabled = e.target.checked; saveSettings(); }

function onSettingChange() {
  settings.mode = document.getElementById("modeSelect").value;
  settings.displayMode = document.getElementById("displaySelect").value;
  settings.hideUnknown = document.getElementById("hideUnknown").checked;
  settings.useApiFallback = document.getElementById("useApiFallback").checked;
  saveSettings();
}

function onCountryToggle(e) {
  const code = e.target.value;
  if (e.target.checked) {
    if (!settings.countries.includes(code)) settings.countries.push(code);
  } else {
    settings.countries = settings.countries.filter(c => c !== code);
  }
  saveSettings();
}

function onSearchInput(e) { renderCountryList(e.target.value); }

async function onReset() {
  if (!confirm("Reset all settings? Your country preferences will be cleared and onboarding will re-open.")) return;
  await chrome.storage.local.remove(["onboardingComplete", "settings", "stats"]);
  window.close();
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
  const tabs = await chrome.tabs.query({ url: ["*://x.com/*", "*://twitter.com/*"] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", settings }).catch(() => {});
  }
}

function sendMessage(msg) {
  return new Promise((resolve) => { chrome.runtime.sendMessage(msg, resolve); });
}
```

- [ ] **Step 4: Commit**

```bash
git add popup/
git commit -m "feat: add popup UI with safe DOM rendering, settings, and stats"
```

---

### Task 9: Onboarding Wizard

**Files:**
- Create: `onboarding/onboarding.html`
- Create: `onboarding/onboarding.css`
- Create: `onboarding/onboarding.js`

4-step wizard: mode selection → country selection → preferences → done. Pre-selects user's likely home country from browser locale. Saves settings to `chrome.storage.local` and sets `onboardingComplete: true`.

Uses safe DOM rendering (createElement/textContent) for the country grid.

- [ ] **Step 1: Create `onboarding/onboarding.html`**

Full-page wizard with 4 step sections (hidden/shown via CSS class). Steps:
1. Welcome + filter mode (blocklist/allowlist radio cards)
2. Country selection (searchable checkbox grid)
3. Preferences (unknown accounts show/hide, display mode hidden/collapsed)
4. Done (confirmation + "How It Works" link + "Start Browsing" button)

- [ ] **Step 2: Create `onboarding/onboarding.css`**

Centered card layout, X dark theme (`#15202b` background, `#192734` card), radio card selection styles with blue highlight, 2-column country grid, step navigation buttons.

- [ ] **Step 3: Create `onboarding/onboarding.js`**

```js
// onboarding/onboarding.js
import { COUNTRIES } from "../utils/countries.js";

let currentStep = 1;
const state = { mode: "blocklist", countries: [], hideUnknown: false, displayMode: "hidden" };

document.addEventListener("DOMContentLoaded", () => {
  // Pre-select from browser locale
  const localeCountry = (navigator.language || "").split("-")[1]?.toUpperCase();
  if (localeCountry && COUNTRIES.find(c => c.code === localeCountry)) {
    state.countries.push(localeCountry);
  }

  renderCountryList();
  setupRadioCards();
  setupNavigation();
});

function setupRadioCards() {
  document.querySelectorAll(".radio-card").forEach(card => {
    card.addEventListener("click", () => {
      const group = card.closest(".step-content, .pref-group");
      group.querySelectorAll(".radio-card").forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");
      card.querySelector("input[type='radio']").checked = true;
    });
  });
}

function renderCountryList(filter = "") {
  const container = document.getElementById("countryList");
  const filterLower = filter.toLowerCase();
  const filtered = filter
    ? COUNTRIES.filter(c => c.name.toLowerCase().includes(filterLower) || c.code.toLowerCase().includes(filterLower))
    : COUNTRIES;

  // Safe DOM rendering
  container.replaceChildren();
  for (const c of filtered) {
    const label = document.createElement("label");
    label.className = "country-checkbox";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = c.code;
    cb.checked = state.countries.includes(c.code);
    cb.addEventListener("change", (e) => {
      if (e.target.checked) { if (!state.countries.includes(c.code)) state.countries.push(c.code); }
      else { state.countries = state.countries.filter(x => x !== c.code); }
    });

    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = c.flag;

    const name = document.createElement("span");
    name.textContent = c.name;

    label.appendChild(cb);
    label.appendChild(flag);
    label.appendChild(name);
    container.appendChild(label);
  }

  document.getElementById("countrySearch")?.addEventListener("input",
    (e) => renderCountryList(e.target.value));
}

function setupNavigation() {
  document.getElementById("nextBtn1").addEventListener("click", () => goToStep(2));
  document.getElementById("backBtn2").addEventListener("click", () => goToStep(1));
  document.getElementById("nextBtn2").addEventListener("click", () => goToStep(3));
  document.getElementById("backBtn3").addEventListener("click", () => goToStep(2));
  document.getElementById("nextBtn3").addEventListener("click", () => saveAndFinish());
  document.getElementById("guideBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("guide/guide.html") });
  });
  document.getElementById("startBtn").addEventListener("click", () => window.close());
}

function goToStep(step) {
  if (currentStep === 1) state.mode = document.querySelector('input[name="mode"]:checked').value;
  if (step === 2) {
    const hint = state.mode === "allowlist"
      ? "In Allowlist mode, only posts from checked countries will appear."
      : "In Blocklist mode, posts from checked countries will be hidden.";
    document.getElementById("modeHint").textContent = hint;
  }
  document.querySelectorAll(".step").forEach(s => s.classList.add("hidden"));
  document.getElementById("step" + step).classList.remove("hidden");
  currentStep = step;
}

async function saveAndFinish() {
  state.hideUnknown = document.querySelector('input[name="unknown"]:checked').value === "hide";
  state.displayMode = document.querySelector('input[name="display"]:checked').value;

  await chrome.storage.local.set({
    onboardingComplete: true,
    settings: {
      enabled: true, mode: state.mode, displayMode: state.displayMode,
      countries: state.countries, hideUnknown: state.hideUnknown, useApiFallback: false
    }
  });
  goToStep(4);
}
```

- [ ] **Step 4: Commit**

```bash
git add onboarding/
git commit -m "feat: add 4-step onboarding wizard with safe DOM rendering"
```

---

### Task 10: How to Use Guide

**Files:**
- Create: `guide/guide.html`
- Create: `guide/guide.css`

Static HTML page covering: what it does, filter modes, detection methods, display modes, settings walkthrough, tips & limitations. No dynamic content — pure HTML/CSS, no JavaScript needed.

- [ ] **Step 1: Create `guide/guide.html`** (static content, no user data, no XSS risk)

- [ ] **Step 2: Create `guide/guide.css`** (X dark theme, max-width 640px centered layout)

- [ ] **Step 3: Commit**

```bash
git add guide/
git commit -m "feat: add how-to-use guide page"
```

---

### Task 11: Placeholder Icons

**Files:**
- Create: `icons/icon16.png`
- Create: `icons/icon48.png`
- Create: `icons/icon128.png`

- [ ] **Step 1: Generate placeholder icons**

Create minimal valid PNG files (solid blue squares). These will be replaced with proper icons later.

```bash
mkdir -p icons
node -e "
const fs = require('fs');
// Minimal valid 1x1 blue PNG (base64-encoded)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNksPn/HwAEBgJRfadVOAAAAABJRU5ErkJggg==', 'base64');
for (const size of [16, 48, 128]) {
  fs.writeFileSync('icons/icon' + size + '.png', PNG);
}
console.log('Placeholder icons created');
"
```

- [ ] **Step 2: Commit**

```bash
git add icons/
git commit -m "feat: add placeholder extension icons"
```

---

### Task 12: Final Integration Check

- [ ] **Step 1: Run unit tests**

```bash
npm test
```

Expected: All countryResolver tests pass.

- [ ] **Step 2: Verify all files exist**

```bash
ls manifest.json background.js content.js fetchHook.js
ls utils/ popup/ onboarding/ guide/ icons/
```

- [ ] **Step 3: Load extension in browser (manual test)**

1. Open Chrome/Edge → `chrome://extensions` → Enable Developer mode
2. Click "Load unpacked" → select project folder
3. Verify extension loads without errors
4. Verify onboarding page opens automatically
5. Complete onboarding wizard
6. Open popup and verify settings display correctly
7. Navigate to x.com and check console for errors

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: integration fixes"
```
