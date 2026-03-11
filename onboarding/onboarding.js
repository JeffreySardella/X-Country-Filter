import { COUNTRIES } from "../utils/countries.js";

let currentStep = 1;
const state = { mode: "blocklist", countries: [], hideUnknown: false, displayMode: "hidden" };

document.addEventListener("DOMContentLoaded", () => {
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

  container.replaceChildren();
  for (const c of filtered) {
    const label = document.createElement("label");
    label.className = "country-checkbox";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "country-" + c.code;
    cb.name = "country-" + c.code;
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
}

function setupNavigation() {
  document.getElementById("countrySearch").addEventListener("input", (e) => renderCountryList(e.target.value));
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
