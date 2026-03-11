// fetchHook.js — Injected into MAIN world to intercept X's API data
(function () {
  "use strict";

  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log("[XCF fetchHook]", ...args); }

  const userBuffer = [];
  const sentUsers = new Map(); // restId → location (empty string if no location)

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "XCF_REQUEST_BUFFER") {
      log("Buffer requested, sending", userBuffer.length, "buffered users");
      if (userBuffer.length > 0) {
        window.postMessage({ type: "XCF_USER_DATA", users: [...userBuffer] }, "*");
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
      // Extract "Account based in" from AboutAccountQuery responses (when user visits About page)
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

  log("Hooks installed");

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
})();
