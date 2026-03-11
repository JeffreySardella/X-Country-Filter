// fetchHook.js — Injected into MAIN world to intercept X's API data
(function () {
  "use strict";

  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log("[XCF fetchHook]", ...args); }

  const userBuffer = [];
  const sentUsers = new Map(); // restId → location (empty string if no location)

  const lookedUp = new Set(); // screen_names already looked up
  const lookupQueue = [];
  let lookupRunning = false;
  let lookupDelayMs = 200;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "XCF_REQUEST_BUFFER") {
      log("Buffer requested, sending", userBuffer.length, "buffered users");
      if (userBuffer.length > 0) {
        window.postMessage({ type: "XCF_USER_DATA", users: [...userBuffer] }, "*");
      }
    }
    if (event.data?.type === "XCF_SETTINGS") {
      if (typeof event.data.lookupDelay === "number") {
        lookupDelayMs = event.data.lookupDelay;
        log("Lookup delay set to:", lookupDelayMs, "ms");
      }
    }
    if (event.data?.type === "XCF_LOOKUP_USERS") {
      const names = event.data.screenNames;
      if (Array.isArray(names)) {
        for (const sn of names) {
          if (!lookedUp.has(sn.toLowerCase())) {
            lookedUp.add(sn.toLowerCase());
            lookupQueue.push(sn);
          }
        }
        processLookupQueue();
      }
    }
  });

  function sendUsers(users, source) {
    if (users.length === 0) return;
    log("(" + source + ") Found", users.length, "users:",
      users.map(u => u.screen_name + " [" + (u.location || "no loc") + "]").join(", "));
    userBuffer.push(...users);
    window.postMessage({ type: "XCF_USER_DATA", users }, "*");
  }

  // ========== JSON.parse hook ==========
  const originalJSONParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const result = originalJSONParse.call(this, text, reviver);
    try {
      if (result && typeof result === "object" && (result.data || result.globalObjects)) {
        const users = extractUsers(result);
        sendUsers(users, "JSON.parse");
      }
      // Extract "Account based in" from AboutAccountQuery responses
      const aboutResult = result?.data?.user_result_by_screen_name?.result;
      if (aboutResult?.about_profile?.account_based_in) {
        const basedIn = aboutResult.about_profile.account_based_in;
        const sn = aboutResult.core?.screen_name
          || deepFindString(aboutResult, "screen_name", 4) || "";
        const restId = aboutResult.rest_id
          || (aboutResult.id ? atob(aboutResult.id).replace(/\D/g, "") : "");
        log("About page: " + sn + " based in " + basedIn);
        if (sn || restId) {
          sentUsers.set(restId, basedIn);
          sendUsers([{
            id_str: restId,
            screen_name: sn,
            location: basedIn,
            lang: ""
          }], "about_profile");
        }
      }
    } catch (e) {}
    return result;
  };

  // ========== Intercept XHR to capture GraphQL patterns ==========
  const capturedHeaders = {};
  let userByScreenNameUrl = null;
  let aboutAccountQueryUrl = null;

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSetReqHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._xcfUrl = typeof url === "string" ? url : "";
    return _xhrOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Capture auth headers from any GraphQL request
    if (this._xcfUrl.includes("/graphql/")) {
      const lname = name.toLowerCase();
      if (lname === "authorization" || lname === "x-csrf-token"
          || lname === "x-twitter-auth-type" || lname === "x-twitter-active-user"
          || lname === "x-twitter-client-language") {
        capturedHeaders[name] = value;
      }
      // Capture UserByScreenName URL template
      if (this._xcfUrl.includes("UserByScreenName") && !userByScreenNameUrl) {
        userByScreenNameUrl = this._xcfUrl;
        log("Captured UserByScreenName endpoint");
      }
      // Capture AboutAccountQuery URL
      if (this._xcfUrl.includes("AboutAccountQuery") && !aboutAccountQueryUrl) {
        aboutAccountQueryUrl = this._xcfUrl;
        log("Captured AboutAccountQuery endpoint");
      }
    }
    return _xhrSetReqHeader.call(this, name, value);
  };

  log("Hooks installed");

  // Fallback query IDs (updated from X's current bundles)
  const FALLBACK_ABOUT_QUERY_ID = "zs_jFPFT78rBpXv9Z3U2YQ";

  // Extract query IDs from X's bundled JavaScript
  setTimeout(async () => {
    try {
      // Search main bundles first, then all other scripts
      const allScripts = [...document.querySelectorAll('script[src]')];
      const mainFirst = allScripts.sort((a, b) => {
        const aMain = a.src.includes("main.") ? 0 : 1;
        const bMain = b.src.includes("main.") ? 0 : 1;
        return aMain - bMain;
      });

      for (const script of mainFirst) {
        if (userByScreenNameUrl && aboutAccountQueryUrl) break;
        try {
          const resp = await fetch(script.src);
          const text = await resp.text();
          if (!userByScreenNameUrl) {
            const match = text.match(/queryId:"([^"]+)",operationName:"UserByScreenName"/);
            if (match) {
              userByScreenNameUrl = "https://x.com/i/api/graphql/" + match[1] + "/UserByScreenName";
              log("Extracted UserByScreenName query ID:", match[1]);
            }
          }
          if (!aboutAccountQueryUrl) {
            const match = text.match(/queryId:"([^"]+)",operationName:"AboutAccountQuery"/);
            if (match) {
              aboutAccountQueryUrl = "https://x.com/i/api/graphql/" + match[1] + "/AboutAccountQuery";
              log("Extracted AboutAccountQuery query ID:", match[1]);
            }
          }
        } catch (e) { /* skip inaccessible scripts */ }
      }

      // Use fallback for AboutAccountQuery if not found in any script
      if (!aboutAccountQueryUrl) {
        aboutAccountQueryUrl = "https://x.com/i/api/graphql/" + FALLBACK_ABOUT_QUERY_ID + "/AboutAccountQuery";
        log("Using fallback AboutAccountQuery query ID:", FALLBACK_ABOUT_QUERY_ID);
      }

      if (userByScreenNameUrl || aboutAccountQueryUrl) processLookupQueue();
      if (!userByScreenNameUrl) log("Could not find UserByScreenName query ID");
    } catch (e) {
      log("Script scan error:", e.message);
    }
  }, 2000);

  // ========== Deep field search (depth-limited) ==========
  function deepFindString(obj, key, maxDepth) {
    if (maxDepth <= 0 || !obj || typeof obj !== "object") return null;
    if (typeof obj[key] === "string" && obj[key]) return obj[key];
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = deepFindString(item, key, maxDepth - 1);
        if (found) return found;
      }
    } else {
      for (const k of Object.keys(obj)) {
        if (k === key) continue;
        const child = obj[k];
        if (child && typeof child === "object") {
          const found = deepFindString(child, key, maxDepth - 1);
          if (found) return found;
        }
      }
    }
    return null;
  }

  // ========== Structure dump for diagnostics ==========
  function dumpKeys(obj, prefix, depth) {
    if (depth <= 0 || !obj || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const path = prefix + "." + k;
      if (v === null || v === undefined) { log("DIAG", path, "= null"); continue; }
      if (typeof v === "string") { log("DIAG", path, '= "' + v.substring(0, 60) + '"'); continue; }
      if (typeof v === "number" || typeof v === "boolean") { log("DIAG", path, "=", v); continue; }
      if (Array.isArray(v)) { log("DIAG", path, "= Array[" + v.length + "]"); continue; }
      if (typeof v === "object") {
        log("DIAG", path, "= {" + Object.keys(v).join(", ") + "}");
        dumpKeys(v, path, depth - 1);
      }
    }
  }

  // ========== User extraction ==========
  function extractUsers(obj) {
    // Pass 1: Build id → screen_name map from any object with an id + screen_name
    const idToScreenName = new Map();
    // Pass 2: Collect user data from user objects
    const userDataById = new Map();

    function processUserObject(ur) {
      const restId = ur.rest_id;
      if (!restId || userDataById.has(restId)) return;

      // Location: try nested object first, then direct string, then legacy
      const locationStr = ur.location?.location
        || (typeof ur.location === "string" ? ur.location : "")
        || ur.legacy?.location || "";

      // screen_name: try known paths first
      let screenName = "";
      if (ur.legacy?.screen_name) screenName = ur.legacy.screen_name;
      if (!screenName && typeof ur.screen_name === "string") screenName = ur.screen_name;

      // Deep search within core (common nested location)
      if (!screenName && ur.core) {
        screenName = deepFindString(ur.core, "screen_name", 4) || "";
      }

      // Deep search within entire ur object as last resort
      if (!screenName) {
        screenName = deepFindString(ur, "screen_name", 5) || "";
      }

      // DIAGNOSTIC: dump full structure for first user where screen_name not found
      if (!screenName && !window._xcfStructureDiag) {
        window._xcfStructureDiag = true;
        log("DIAG: No screen_name anywhere in user object for rest_id:", restId);
        log("DIAG: Top-level keys:", Object.keys(ur).sort().join(", "));
        dumpKeys(ur, "ur", 2);
      }

      userDataById.set(restId, {
        location: locationStr,
        lang: ur.legacy?.lang || "",
        screenName: screenName
      });
    }

    function walk(node) {
      if (!node || typeof node !== "object") return;

      // Collect screen_name from ANY object that has (id_str OR rest_id) + screen_name
      const nodeId = node.id_str || (typeof node.rest_id === "string" ? node.rest_id : null);
      if (nodeId && typeof node.screen_name === "string" && node.screen_name) {
        idToScreenName.set(String(nodeId), node.screen_name);
      }

      // Detect user objects from various API response structures:
      // Timeline tweets: node.user_results.result
      // Profile pages:   node.user.result
      // Other patterns:  node.user_result.result
      const ur = node.user_results?.result
        || node.user?.result
        || node.user_result?.result;
      if (ur?.rest_id) {
        processUserObject(ur);
      }

      // Direct detection: any object with rest_id that looks like a user (not a tweet)
      // Users have location object or legacy.followers_count; tweets don't have location object
      if (node.rest_id && typeof node.rest_id === "string"
          && !userDataById.has(node.rest_id)
          && (node.__typename === "User"
              || (node.location && typeof node.location === "object")
              || node.legacy?.followers_count !== undefined)) {
        processUserObject(node);
      }

      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else {
        for (const key of Object.keys(node)) {
          const child = node[key];
          if (child && typeof child === "object") walk(child);
        }
      }
    }

    walk(obj);

    // Merge: combine screen_names from all sources
    const users = [];
    const noScreenName = [];
    for (const [restId, data] of userDataById) {
      // Skip if we already sent this user with the same or better data
      const prevLocation = sentUsers.get(restId);
      if (prevLocation !== undefined) {
        // Re-send only if we now have a location but didn't before
        if (!data.location || prevLocation) continue;
        log("Re-sending user", restId, "with new location:", data.location);
      }

      let screenName = data.screenName || idToScreenName.get(restId) || "";

      if (!screenName) {
        noScreenName.push(restId);
        continue;
      }

      sentUsers.set(restId, data.location);
      users.push({
        id_str: restId,
        screen_name: screenName,
        location: data.location,
        lang: data.lang
      });
    }

    if (noScreenName.length > 0) {
      log("Skipped", noScreenName.length, "users with no screen_name (rest_ids:", noScreenName.slice(0, 5).join(", ") + ")");
    }

    return users;
  }

  // ========== Proactive user lookup via X's API ==========
  function getCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function processLookupQueue() {
    if (lookupRunning || lookupQueue.length === 0) return;
    lookupRunning = true;

    while (lookupQueue.length > 0) {
      const screenName = lookupQueue.shift();
      const success = await lookupUser(screenName);
      if (success === "rate_limited") {
        lookupDelayMs += 5;
        log("Rate limited! Delay →", lookupDelayMs, "ms. Pausing 60s");
        window.postMessage({ type: "XCF_DELAY_UPDATED", lookupDelay: lookupDelayMs }, "*");
        await new Promise(r => setTimeout(r, 60000));
      } else {
        await new Promise(r => setTimeout(r, lookupDelayMs));
      }
    }

    lookupRunning = false;
  }

  // Default features for UserByScreenName (fallback if not captured from XHR)
  const DEFAULT_FEATURES = JSON.stringify({
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  });

  function buildHeaders() {
    const headers = {};
    if (capturedHeaders["authorization"]) {
      Object.assign(headers, capturedHeaders);
    } else {
      headers["authorization"] = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
      headers["x-twitter-auth-type"] = "OAuth2Session";
      headers["x-twitter-active-user"] = "yes";
    }
    headers["x-csrf-token"] = getCookie("ct0");
    return headers;
  }

  async function lookupUser(screenName) {
    if (!userByScreenNameUrl && !aboutAccountQueryUrl) {
      log("Lookup: no endpoints yet, requeueing", screenName);
      lookupQueue.unshift(screenName);
      lookedUp.delete(screenName.toLowerCase());
      return;
    }

    const headers = buildHeaders();
    if (!headers["x-csrf-token"]) { log("Lookup: no CSRF token"); return; }

    let loc = "";
    let sn = screenName;
    let restId = "";

    // Step 1: Try UserByScreenName for self-set location
    if (userByScreenNameUrl) {
      try {
        const parsed = new URL(userByScreenNameUrl, location.origin);
        const basePath = parsed.origin + parsed.pathname;
        const features = parsed.searchParams.get("features") || DEFAULT_FEATURES;
        const variables = JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true });
        const url = basePath + "?variables=" + encodeURIComponent(variables)
          + "&features=" + encodeURIComponent(features);

        log("Looking up profile:", screenName);
        const response = await fetch(url, { headers, credentials: "include" });

        if (response.status === 429) {
          log("Lookup rate limited:", screenName);
          return "rate_limited";
        }
        if (response.ok) {
          const lookupData = originalJSONParse(await response.text());
          const ur = lookupData?.data?.user?.result;
          if (ur?.rest_id) {
            restId = ur.rest_id;
            sn = ur.legacy?.screen_name || screenName;
            loc = ur.location?.location
              || (typeof ur.location === "string" ? ur.location : "")
              || ur.legacy?.location || "";
          }
        }
      } catch (e) { log("UserByScreenName error:", e.message); }
    }

    // Step 2: If no location found, try AboutAccountQuery for "Account based in"
    if (!loc && aboutAccountQueryUrl) {
      try {
        const parsed = new URL(aboutAccountQueryUrl, location.origin);
        const basePath = parsed.origin + parsed.pathname;
        const variables = JSON.stringify({ screenName: screenName });
        const url = basePath + "?variables=" + encodeURIComponent(variables);

        log("Looking up about:", screenName);
        const response = await fetch(url, { headers, credentials: "include" });

        if (response.status === 429) {
          log("About lookup rate limited:", screenName);
          return "rate_limited";
        }
        if (response.ok) {
          const aboutData = originalJSONParse(await response.text());
          const aboutResult = aboutData?.data?.user_result_by_screen_name?.result;
          if (aboutResult?.about_profile?.account_based_in) {
            loc = aboutResult.about_profile.account_based_in;
            log("About lookup:", screenName, "based in", loc);
          }
          if (!restId && aboutResult) {
            restId = aboutResult.rest_id
              || (aboutResult.id ? atob(aboutResult.id).replace(/\D/g, "") : "");
            sn = aboutResult.core?.screen_name || sn;
          }
        }
      } catch (e) { log("AboutAccountQuery error:", e.message); }
    }

    // Send result
    if (restId) {
      log("Lookup result:", sn, "rest_id:", restId, "location:", loc || "(none)");
      sentUsers.set(restId, loc);
      sendUsers([{
        id_str: restId,
        screen_name: sn,
        location: loc,
        lang: ""
      }], "lookup");
    } else {
      log("Lookup: could not extract user data for", screenName);
    }
  }
})();
