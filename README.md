# X Country Filter

A Chrome extension that filters posts on X (Twitter) based on the geographic origin of each account. Use it to focus your feed on specific countries or block regions you don't want to see.

## What It Does

When you scroll through X, the extension intercepts the API data that X loads to render your feed. Every user object contains metadata — profile location, language, and for verified accounts, X's own "Account based in" region data. The extension extracts this, resolves it to a country code, and hides or collapses posts from accounts outside your preferences.

### Two Modes

- **Allowlist** — Only show posts from countries you select. Everything else is filtered.
- **Blocklist** — Hide posts from countries you select. Everything else is shown.

### Two Display Modes

- **Hidden** — Filtered posts are removed entirely from the DOM.
- **Collapsed** — A small bar replaces filtered posts with the detected country. Click to reveal.

## How It Works

The extension runs two content scripts on X:

### 1. fetchHook.js (MAIN world)

Intercepts X's API responses as they are parsed by the page:

- **JSON.parse interception** — Captures user data (screen name, location, language) from X's internal API responses as they flow through the page's JavaScript.
- **Multi-pattern extraction** — Detects user objects from timeline tweets, profile pages, search results, and other API response structures.
- **About page data** — When you visit a user's About page, captures X's "Account based in" region data (e.g., "South Asia", "Western Europe") for more accurate country detection.
- **Re-send logic** — If better location data becomes available for a previously seen user, re-sends the updated information for resolution.

### 2. content.js (ISOLATED world)

Handles DOM observation and filter application:

- **MutationObserver** watches for new tweet elements as the feed loads.
- Extracts the screen name from each tweet's links.
- Checks a local country cache. On cache hit, applies the filter immediately. On cache miss, queues the tweet as "pending" until the user's country is resolved.
- Reprocesses visible tweets when a user's country data is updated.

### 3. background.js (Service Worker)

- Receives batches of users from content.js and resolves their location strings to ISO 3166-1 alpha-2 country codes.
- Maintains a persistent cache in `chrome.storage.local` with 7-day TTL and automatic version-based invalidation.
- Re-resolves users cached as "unknown" when new location data arrives.
- Optional Nominatim API fallback for unrecognized location strings (off by default).

### Country Resolution Pipeline

The resolver tries these steps in order:

1. **Emoji flag decode** — Flags like `flag_br` → `BR`
2. **X region mapping** — "South Asia" → `IN`, "Middle East" → `AE`, etc.
3. **Exact country name** — "Nigeria" → `NG`, "united states" → `US`
4. **City/state lookup** — "Palo Alto, CA" → `US`, "Lagos" → `NG`
5. **Partial match** — "Florida, USA" matches "florida" → `US`
6. **Language fallback** — `lang: "ja"` → `JP`
7. **Unknown** — No match found. Shown by default, optionally hidden.

## Installation

### Chrome / Edge

1. Clone or download this repository
2. Go to `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repository folder
5. Pin the extension to your toolbar

## Configuration

Click the extension icon to open the popup:

- **ON/OFF toggle** — Enable or disable filtering globally.
- **Mode** — Switch between Blocklist and Allowlist.
- **Display** — Choose Hidden or Collapsed for filtered posts.
- **Country list** — Searchable checkboxes for all countries.
- **Hide unknown accounts** — Optionally filter accounts with no detectable country. Many accounts don't set a location, so this may filter a lot of posts.
- **Online lookup** — Enable Nominatim geocoding API as a last resort for unrecognized location strings.

## Project Structure

```
x-country-filter/
├── manifest.json                # Extension manifest (MV3)
├── background.js                # Service worker — resolves countries, manages cache
├── content.js                   # DOM observer — filters tweets, relays user data
├── fetchHook.js                 # MAIN world — intercepts API data for user extraction
├── popup/
│   ├── popup.html               # Settings popup
│   ├── popup.css
│   └── popup.js
├── onboarding/
│   ├── onboarding.html          # First-launch setup wizard (4 steps)
│   ├── onboarding.css
│   └── onboarding.js
├── guide/
│   ├── guide.html               # How-it-works guide page
│   └── guide.css
├── utils/
│   ├── countryResolver.js       # Location string → country code resolution
│   ├── countries.js             # Country list with codes, names, flags, language mappings
│   └── cityMap.js               # City/state → country code lookup table
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Limitations

- **Self-reported location** — Most users' countries are inferred from their profile location field, which is optional and can be anything.
- **Region granularity** — X's "Account based in" data uses broad regions (e.g., "South Asia") rather than specific countries. The extension maps these to the most likely country.
- **API changes** — X may change its internal API structure. The extension uses multiple extraction strategies and fallbacks, but may need updates when breaking changes occur.

## Disclaimer

This software is provided for **educational and personal use only**. It is an independent project and is **not affiliated with, endorsed by, or associated with X Corp (formerly Twitter, Inc.)** in any way.

This extension operates entirely within the user's own browser and modifies only the local visual rendering of content. It does not scrape, collect, store, export, or transmit any data from X's platform to any third party. All data processing occurs locally on the user's device.

By using this software, you acknowledge and agree that:

- **You are solely responsible** for ensuring your use of this extension complies with X's [Terms of Service](https://x.com/en/tos), [Developer Agreement](https://developer.x.com/en/developer-terms/agreement-and-policy), and all applicable laws in your jurisdiction.
- **Use of this extension may violate X's Terms of Service.** The author makes no representation that use of this tool is permitted under X's policies and expressly disclaims any liability arising from your use of it.
- **The author assumes no liability** for any consequences resulting from the use of this software, including but not limited to account suspension, legal action, data loss, or any other damages.
- This software is provided **"as is," without warranty of any kind**, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement.
- The author is not responsible for any changes to X's platform, API, or terms that may render this extension non-functional or non-compliant.

**If you are uncertain whether your use of this extension is permitted, do not use it.**

This project is intended as a demonstration of browser extension development techniques including content script injection, DOM observation, and client-side data processing. The source code is made available for educational purposes to illustrate these concepts.

## License

MIT
