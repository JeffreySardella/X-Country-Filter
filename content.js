// content.js — DOM observer, filter application, message relay
(function () {
  "use strict";

  const countryCache = new Map();
  const pendingTweets = new Map();
  let settings = null;
  let statsBuffer = { filtered: 0, processed: 0 };

  async function init() {
    settings = await sendMessage({ type: "GET_SETTINGS" });
    if (!settings) return;

    window.addEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.addListener(onExtensionMessage);
    startObserver();
    setInterval(flushStats, 30000);
  }

  function onWindowMessage(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "XCF_USER_DATA") return;

    const users = event.data.users;
    if (!Array.isArray(users) || users.length === 0) return;

    sendMessage({ type: "RESOLVE_USERS", users }).then(results => {
      if (!results) return;

      for (const [userId, country] of Object.entries(results)) {
        countryCache.set(userId, country);
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
