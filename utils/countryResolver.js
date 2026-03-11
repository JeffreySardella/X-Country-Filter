import { COUNTRY_BY_NAME, LANGUAGE_TO_COUNTRY } from "./countries.js";
import { CITY_TO_COUNTRY } from "./cityMap.js";

// X's "Account based in" regions → most likely country code
const REGION_TO_COUNTRY = new Map([
  ["south asia", "IN"],
  ["southeast asia", "SG"],
  ["east asia", "JP"],
  ["middle east", "AE"],
  ["north africa", "EG"],
  ["sub-saharan africa", "NG"],
  ["west africa", "NG"],
  ["east africa", "KE"],
  ["southern africa", "ZA"],
  ["western europe", "DE"],
  ["eastern europe", "PL"],
  ["northern europe", "SE"],
  ["southern europe", "IT"],
  ["central america", "MX"],
  ["south america", "BR"],
  ["caribbean", "JM"],
  ["oceania", "AU"],
  ["central asia", "KZ"],
]);

export function resolveCountry(location, lang) {
  const raw = (location ?? "").trim();
  if (!raw && !lang) return "unknown";

  // Step 2: Emoji flag decode
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

  // Step 2b: X region match ("Account based in" data)
  if (normalized && REGION_TO_COUNTRY.has(normalized)) {
    return REGION_TO_COUNTRY.get(normalized);
  }

  // Step 3: Exact country name match
  if (normalized && COUNTRY_BY_NAME.has(normalized)) {
    return COUNTRY_BY_NAME.get(normalized);
  }

  const noDots = normalized.replace(/\./g, "");
  if (noDots && noDots !== normalized && COUNTRY_BY_NAME.has(noDots)) {
    return COUNTRY_BY_NAME.get(noDots);
  }

  // Step 4: City lookup
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

  // Step 5: Partial/fuzzy match
  if (normalized) {
    for (const [name, code] of COUNTRY_BY_NAME) {
      if (name.length >= 4 && normalized.includes(name)) {
        return code;
      }
    }
  }

  // Step 6: Language inference
  if (lang && LANGUAGE_TO_COUNTRY.has(lang)) {
    return LANGUAGE_TO_COUNTRY.get(lang);
  }

  return "unknown";
}

function decodeFlagEmoji(flag) {
  const codePoints = [...flag];
  if (codePoints.length !== 2) return null;
  const first = codePoints[0].codePointAt(0) - 0x1F1E6 + 65;
  const second = codePoints[1].codePointAt(0) - 0x1F1E6 + 65;
  return String.fromCharCode(first) + String.fromCharCode(second);
}
