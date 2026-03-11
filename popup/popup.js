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
