// content.js — DOM observer, filter application, message relay
(function () {
  "use strict";

  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log("[XCF content]", ...args); }

  const countryCache = new Map();
  const screenNameToId = new Map();
  const pendingTweets = new Map();
  let settings = null;
  let statsBuffer = { filtered: 0, processed: 0 };

  async function init() {
    log("init() starting");
    try {
      settings = await sendMessage({ type: "GET_SETTINGS" });
    } catch (e) {
      log("GET_SETTINGS failed:", e);
    }
    if (!settings) {
      log("No settings found, using defaults");
      settings = {
        enabled: true, mode: "blocklist", displayMode: "hidden",
        countries: [], hideUnknown: false, useApiFallback: false
      };
    }
    log("Settings loaded:", JSON.stringify(settings));

    window.addEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.addListener(onExtensionMessage);
    startObserver();
    setInterval(flushStats, 30000);

    // Request any users buffered by pageAnalyzer before we started listening
    log("Requesting buffered users from pageAnalyzer");
    window.postMessage({ type: "XCF_REQUEST_BUFFER" }, "*");

    // Initial scan of tweets already in the DOM
    setTimeout(scanExistingTweets, 500);
    log("init() complete — observer started");
  }

  function scanExistingTweets() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    log("Initial DOM scan found", tweets.length, "existing tweets");
    for (const tweet of tweets) {
      if (!tweet.getAttribute("data-xcf-filtered")) {
        processingQueue.push(tweet);
      }
    }
    if (processingQueue.length > 0 && !rafPending) {
      rafPending = true;
      requestAnimationFrame(processQueue);
    }
  }

  function onWindowMessage(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "XCF_USER_DATA") return;

    const users = event.data.users;
    if (!Array.isArray(users) || users.length === 0) return;

    log("Received", users.length, "users from pageAnalyzer:",
      users.map(u => u.screen_name + " (" + u.location + ")").join(", "));

    sendMessage({ type: "RESOLVE_USERS", users }).then(results => {
      if (!results) { log("RESOLVE_USERS returned null"); return; }

      log("Resolved users:", JSON.stringify(results));

      let countryChanged = false;
      for (const [userId, country] of Object.entries(results)) {
        const user = users.find(u => u.id_str === userId);
        const screenName = user?.screen_name?.toLowerCase();

        // Check if country changed from a previous resolution
        const prevCountry = countryCache.get(userId);
        if (prevCountry && prevCountry !== country) {
          log("Country updated:", screenName || userId, prevCountry, "→", country);
          countryChanged = true;
        }

        countryCache.set(userId, country);
        if (screenName) {
          countryCache.set(screenName, country);
          screenNameToId.set(screenName, userId);
        }

        // Check pending tweets by BOTH id_str and screen_name
        const keysToCheck = [userId];
        if (screenName) keysToCheck.push(screenName);

        for (const key of keysToCheck) {
          if (pendingTweets.has(key)) {
            log("Processing", pendingTweets.get(key).size, "pending tweets for", key);
            for (const node of pendingTweets.get(key)) {
              if (node.isConnected) applyFilter(node, key);
            }
            pendingTweets.delete(key);
          }
        }
      }

      // If any user's country changed, reprocess visible tweets
      if (countryChanged) {
        log("Country data changed, reprocessing visible tweets");
        reprocessAllTweets();
      }
    });
  }

  function onExtensionMessage(message) {
    if (message.type === "SETTINGS_UPDATED") {
      settings = message.settings;
      reprocessAllTweets();
    }
  }

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
    log("Processing batch of", batch.length, "tweets");

    for (const tweet of batch) {
      if (!tweet.isConnected) continue;
      const userId = extractUserId(tweet);
      if (!userId) { log("Could not extract userId from tweet node"); continue; }

      statsBuffer.processed++;

      if (countryCache.has(userId)) {
        const country = countryCache.get(userId);
        log("Cache hit:", userId, "→", country);
        applyFilter(tweet, userId);
      } else {
        log("Cache miss:", userId, "→ added to pending");
        if (!pendingTweets.has(userId)) pendingTweets.set(userId, new Set());
        pendingTweets.get(userId).add(tweet);
      }
    }
  }

  function extractUserId(tweetNode) {
    try {
      const tweetLink = tweetNode.querySelector('a[href*="/status/"]');
      if (tweetLink) {
        const match = tweetLink.getAttribute("href").match(/^\/([^/]+)\/status\//);
        if (match) return match[1].toLowerCase();
      }

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

  function applyFilter(tweetNode, userId) {
    if (!settings?.enabled) {
      showTweet(tweetNode);
      return;
    }

    const country = countryCache.get(userId);
    if (!country) return;

    const shouldFilter = shouldFilterCountry(country);
    log("Filter check:", userId, "country=" + country, "mode=" + settings.mode,
      "countries=" + JSON.stringify(settings.countries), "→", shouldFilter ? "FILTER" : "SHOW");

    if (shouldFilter) {
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

  // SAFE: Uses cloneNode instead of innerHTML to avoid XSS
  function collapseTweet(node, country) {
    if (node.getAttribute("data-xcf-filtered") === "collapsed") return;

    if (!node._xcfOriginalChildren) {
      node._xcfOriginalChildren = [];
      for (const child of node.childNodes) {
        node._xcfOriginalChildren.push(child.cloneNode(true));
      }
    }

    while (node.firstChild) node.removeChild(node.firstChild);

    const bar = document.createElement("div");
    bar.className = "xcf-collapsed-bar";
    bar.style.cssText = "background:#1e2d3d;border:1px solid #2f3336;border-radius:8px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin:4px 0;";

    const left = document.createElement("div");
    left.style.cssText = "display:flex;align-items:center;gap:8px;";

    const icon = document.createElement("span");
    icon.style.fontSize = "14px";
    icon.textContent = "\u{1F6AB}";

    const text = document.createElement("span");
    text.style.cssText = "color:#71767b;font-size:13px;";
    text.textContent = "Post hidden \u2014 account from ";

    const countrySpan = document.createElement("strong");
    countrySpan.style.color = "#8b949e";
    countrySpan.textContent = country === "unknown" ? "unknown country" : country;
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

  function flushStats() {
    if (statsBuffer.filtered === 0 && statsBuffer.processed === 0) return;
    sendMessage({ type: "UPDATE_STATS", stats: { ...statsBuffer } });
    statsBuffer.filtered = 0;
    statsBuffer.processed = 0;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, resolve);
    });
  }

  init();
})();
