# X Country Filter — Design Spec

## Overview

A Manifest V3 browser extension that filters X (Twitter) posts by account country. Uses a fetch hook to intercept X's internal GraphQL API responses, resolves user location data to ISO country codes via a multi-step heuristic pipeline, and hides or collapses tweets based on user-configured blocklist/allowlist rules.

**Goals:** Personal use first, then polish and publish to Chrome Web Store / Firefox Add-ons.

**Tech stack:** Vanilla JS, no build step, Manifest V3.

---

## Core Architecture

### Extension Components & Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  x.com Page Context (MAIN world)                                │
│                                                                 │
│  fetchHook.js                                                   │
│  ├── Monkey-patches window.fetch()                              │
│  ├── Intercepts responses matching X GraphQL endpoints:         │
│  │   • /graphql/*/HomeTimeline                                  │
│  │   • /graphql/*/SearchTimeline                                │
│  │   • /graphql/*/TweetDetail                                   │
│  │   • /graphql/*/Notifications                                 │
│  │   • /graphql/*/UserByScreenName                              │
│  │   • /graphql/*/ConnectTabTimeline (Who to Follow)            │
│  ├── Extracts user objects { id_str, location, lang, ... }      │
│  └── Posts user data to content.js via window.postMessage()     │
│      (messages tagged with type: "XCF_USER_DATA")               │
└──────────────────────┬──────────────────────────────────────────┘
                       │ postMessage
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  content.js (ISOLATED world)                                    │
│  ├── Listens for postMessage with type "XCF_USER_DATA"          │
│  │   (validates event.source === window before processing)      │
│  ├── Forwards user data to background.js for resolution         │
│  ├── Observes DOM via MutationObserver                          │
│  │   • Watches for new tweet nodes across all areas             │
│  │   • Extracts userId from tweet DOM attributes                │
│  ├── Looks up userId → country from local cache                 │
│  └── Hides/shows tweet nodes based on filter settings           │
└──────────────────────┬──────────────────────────────────────────┘
                       │ chrome.runtime.sendMessage
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  background.js (Service Worker)                                 │
│  ├── Receives raw user objects from content.js                  │
│  ├── Runs country resolution pipeline                           │
│  ├── Caches result: userId → { country, resolvedAt }            │
│  ├── Manages cache expiry (7-day TTL)                           │
│  ├── Handles onboarding (opens tab on install)                  │
│  └── Returns resolved country to content.js                     │
└─────────────────────────────────────────────────────────────────┘
```

### Manifest V3 Configuration

- **Permissions:** `storage`, `activeTab`
- **Host permissions:** `*://x.com/*`, `*://twitter.com/*`
- **Content scripts:** `content.js` (ISOLATED), `fetchHook.js` (MAIN world)
- **Background:** Service worker (`background.js`)
- **Action:** Popup (`popup/popup.html`)

### Storage Schema (chrome.storage.local)

```js
{
  "onboardingComplete": true,
  "settings": {
    "enabled": true,
    "mode": "allowlist",            // "allowlist" | "blocklist"
    "displayMode": "hidden",       // "hidden" | "collapsed"
    "countries": ["US", "GB", "CA", "AU"],
    "hideUnknown": false,
    "useApiFallback": false         // Nominatim geocoding for ambiguous locations
  },
  "userCache": {
    "123456789": { "country": "NG", "resolvedAt": 1714000000000 },
    "987654321": { "country": "unknown", "resolvedAt": 1714000000000 }
  },
  "stats": {
    "totalFiltered": 0,
    "totalProcessed": 0,
    "filteredToday": 0,
    "lastResetDate": "2026-03-10"   // resets filteredToday when date changes
  }
}
```

---

## Country Resolution Pipeline

Full heuristic stack, executed in order. First match wins.

```
Input: raw location string (e.g. "Lagos, Nigeria 🇳🇬")
         │
         ▼
Step 1: Normalize — trim, lowercase, strip emoji (except flags), remove special chars
         │
         ▼
Step 2: Emoji flag decode — scan for regional indicator pairs (🇧🇷 → "BR")
         Match? → return code
         │ No
         ▼
Step 3: Exact country name match — check against country names + common aliases
         ("united states", "usa", "u.s.a", "america" → "US")
         Match? → return code
         │ No
         ▼
Step 4: City lookup — check against curated major city → country map
         ("lagos" → "NG", "mumbai" → "IN", "toronto" → "CA")
         Match? → return code
         │ No
         ▼
Step 5: Partial/fuzzy match — check if string contains a country name
         ("living in Brazil" → "BR", "somewhere in India" → "IN")
         Match? → return code
         │ No
         ▼
Step 6: Language inference — use account's lang field as weak signal
         Only languages with strong single-country association:
         ("ja" → "JP", "ko" → "KR", "th" → "TH", "he" → "IL", "vi" → "VN")
         Note: ambiguous languages like "pt", "es", "en", "fr", "ar" are skipped
         Match? → return code
         │ No
         ▼
Step 7: API fallback (optional, off by default) — send ambiguous string to Nominatim
         Match? → return code
         │ No
         ▼
Output: "unknown"
```

### Bundled Data Files

- **`countries.js`** — ~250 entries: ISO code, name, aliases, flag emoji, associated languages
- **`cityMap.js`** — ~500-800 major world cities mapped to country codes

### API Fallback: Nominatim (OpenStreetMap)

- Free, no API key required
- Max 1 request/second rate limit
- Returns structured country data from location strings
- Off by default — user enables via "Use online lookup for unrecognized locations" toggle in settings
- User informed that ambiguous locations may be sent to an external service
- **Rate limiting:** background.js maintains a request queue with a minimum 1100ms gap between Nominatim calls. The last request timestamp is stored in `chrome.storage.local` (`nominatimLastRequest`) to survive service worker suspension. Requests exceeding the rate limit are queued and processed sequentially.

---

## Filter Display Modes

### Mode 1: Completely Hidden (default)

Tweet nodes get `display: none` — removed from visual flow entirely.

### Mode 2: Collapsed with Reveal

Tweet content is replaced with a subtle one-line bar:

```
🚫 Post hidden — account from Nigeria                    [Show ▾]
```

Clicking "Show" expands to reveal the original tweet content. The bar uses X's dark theme styling to blend in.

### Re-render Resilience

X's virtual DOM aggressively re-renders tweet nodes during scroll. The MutationObserver re-processes any article node that re-enters the DOM. The in-memory userId→country cache ensures instant re-application without a round-trip to background.js. Filtered state is determined by userId lookup, not DOM state, so re-renders are handled transparently.

---

## Filter Scope

Filtering applies everywhere tweets appear:

| Area | DOM Target | userId extraction |
|---|---|---|
| Home feed | `article[data-testid="tweet"]` | From user link `href` or data attributes |
| Replies/threads | Same `article` elements | Same approach |
| Search results | Same `article` elements | Same approach |
| Notifications | Notification item containers | From embedded user references |
| Who to follow | Suggestion card containers | From user link `href` |

---

## Content Script — DOM Filtering

### MutationObserver Strategy

- Single `MutationObserver` on `document.body` (or closest stable parent)
- Watches `childList` additions with `subtree: true`
- On new nodes: query for tweet `article` elements, extract userId, check cache, apply filter
- Debounced processing to avoid thrashing during rapid scroll

### Filter Application Logic

```
For each new tweet node:
  1. Extract userId from the tweet DOM
  2. Lookup userId in local cache (in-memory Map, synced from chrome.storage)
  3. If not cached → send to background for resolution, queue tweet for re-check
     (pending tweets stored in Map<userId, Set<DOMNode>>; when background returns
     a resolved country, content.js iterates the set, checks each node is still
     in the document, and applies the filter; orphaned nodes are discarded)
  4. If cached:
     a. Check country against settings (blocklist/allowlist + hideUnknown)
     b. If should filter:
        - displayMode "hidden" → node.style.display = "none"
        - displayMode "collapsed" → replace content with collapsed bar
     c. If should show → ensure visible (in case settings changed)
  5. Increment stats counter (content.js increments in-memory counters,
     flushes to chrome.storage.local periodically; on flush, checks
     lastResetDate — if date has changed, resets filteredToday to 0)
```

### Performance

- **In-memory cache** — content script keeps a `Map<userId, country>` so DOM lookups don't hit `chrome.storage` every time
- **Batch processing** — new tweets collected in a queue, processed in batches via `requestAnimationFrame`
- **Early exit** — if filtering is disabled, observer still runs but skips all processing

---

## Onboarding Flow

4-step wizard, triggered on first install.

### Trigger

- `background.js` listens for `chrome.runtime.onInstalled`
- If `onboardingComplete` is not `true`, opens `onboarding/onboarding.html` in a new tab

### Steps

1. **Welcome + Filter Mode** — Choose Allowlist or Blocklist
2. **Country Selection** — Searchable checkbox list with flags. Pre-checks user's likely home country (from browser locale) in Allowlist mode.
3. **Preferences** — Unknown accounts (show/hide), display mode (hidden/collapsed)
4. **Done** — Confirmation screen with "How It Works" link to guide and "Start Browsing" button

### Re-triggering

"Reset to Defaults" in popup clears `onboardingComplete`, `settings`, and `stats`. The `userCache` is preserved to avoid re-resolving known users. Next activation re-opens onboarding.

---

## Popup UI

```
┌─────────────────────────────────┐
│  🌍 X Country Filter      [ON] │
├─────────────────────────────────┤
│  Mode:     [Blocklist ▼]       │
│  Display:  [Hidden ▼]          │
├─────────────────────────────────┤
│  Countries:                     │
│  🔍 Search countries...         │
│                                 │
│  [ ] 🇦🇺 Australia             │
│  [x] 🇧🇷 Brazil                │
│  [ ] 🇨🇳 China                 │
│  [x] 🇮🇳 India                 │
│  ...  (scrollable list)         │
├─────────────────────────────────┤
│  ☐ Hide unknown accounts       │
├─────────────────────────────────┤
│  Filtered: 42 posts today      │
├─────────────────────────────────┤
│  [Reset to Defaults]       [?] │
└─────────────────────────────────┘
```

- Settings auto-save on change — no Save button needed
- Changes take effect immediately on active X tab via `chrome.tabs.sendMessage`
- `?` button opens `guide/guide.html` in a new tab

---

## How to Use Guide

Standalone HTML page (`guide/guide.html`) accessible from popup `?` button and onboarding Step 4.

### Content

1. **What X Country Filter Does** — filters posts by account country, all processing local
2. **Filter Modes Explained** — Blocklist vs Allowlist with tips
3. **How Country Detection Works** — explains heuristic approach and limitations
4. **Display Modes** — Completely hidden vs Collapsed with reveal
5. **Changing Your Settings** — walkthrough of popup controls
6. **Tips & Limitations** — accuracy caveats, cache behavior, update dependency

---

## Project File Structure

```
x-country-filter/
├── manifest.json                # MV3 manifest
├── background.js                # Service worker — resolution, cache, onboarding
├── content.js                   # DOM observer, filter application, message relay
├── fetchHook.js                 # MAIN world — hooks fetch(), extracts user objects
├── onboarding/
│   ├── onboarding.html          # 4-step setup wizard
│   ├── onboarding.css
│   └── onboarding.js
├── popup/
│   ├── popup.html               # Settings popup
│   ├── popup.css
│   └── popup.js
├── guide/
│   ├── guide.html               # "How to Use" page
│   └── guide.css
├── utils/
│   ├── countryResolver.js       # Full resolution pipeline (steps 1-7)
│   ├── countries.js             # Country names, aliases, ISO codes, flags, languages
│   └── cityMap.js               # Major city → country code lookup
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── .gitignore
```
