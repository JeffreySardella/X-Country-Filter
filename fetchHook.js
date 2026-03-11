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
