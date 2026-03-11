import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCountry } from "../utils/countryResolver.js";

describe("countryResolver", () => {
  describe("Step 1 & 2: Emoji flag decode", () => {
    it("decodes a single flag emoji", () => {
      assert.equal(resolveCountry("🇧🇷"), "BR");
    });
    it("decodes flag embedded in text", () => {
      assert.equal(resolveCountry("Rio de Janeiro 🇧🇷"), "BR");
    });
    it("prioritizes flag over other signals", () => {
      assert.equal(resolveCountry("Living in Canada 🇺🇸"), "US");
    });
  });

  describe("Step 3: Exact country name match", () => {
    it("matches full country name", () => {
      assert.equal(resolveCountry("Nigeria"), "NG");
    });
    it("matches country name case-insensitively", () => {
      assert.equal(resolveCountry("JAPAN"), "JP");
    });
    it("matches common aliases", () => {
      assert.equal(resolveCountry("USA"), "US");
    });
    it("matches alias with periods", () => {
      assert.equal(resolveCountry("U.S.A."), "US");
    });
    it("matches america alias", () => {
      assert.equal(resolveCountry("America"), "US");
    });
    it("matches uk alias", () => {
      assert.equal(resolveCountry("UK"), "GB");
    });
  });

  describe("Step 4: City lookup", () => {
    it("resolves a major city", () => {
      assert.equal(resolveCountry("Lagos"), "NG");
    });
    it("resolves city case-insensitively", () => {
      assert.equal(resolveCountry("TOKYO"), "JP");
    });
    it("resolves alternate city name", () => {
      assert.equal(resolveCountry("Bombay"), "IN");
    });
  });

  describe("Step 5: Partial/fuzzy match", () => {
    it("finds country name within a phrase", () => {
      assert.equal(resolveCountry("Living in Brazil"), "BR");
    });
    it("finds country name in a compound location", () => {
      assert.equal(resolveCountry("somewhere in India"), "IN");
    });
    it("finds country with surrounding text", () => {
      assert.equal(resolveCountry("Born and raised in Germany"), "DE");
    });
  });

  describe("Step 6: Language inference", () => {
    it("infers country from unambiguous language", () => {
      assert.equal(resolveCountry("", "ja"), "JP");
    });
    it("infers Korean", () => {
      assert.equal(resolveCountry("", "ko"), "KR");
    });
    it("does not infer from ambiguous language", () => {
      assert.equal(resolveCountry("", "en"), "unknown");
    });
    it("does not infer from Spanish", () => {
      assert.equal(resolveCountry("", "es"), "unknown");
    });
    it("does not infer from Portuguese", () => {
      assert.equal(resolveCountry("", "pt"), "unknown");
    });
  });

  describe("Edge cases", () => {
    it("returns unknown for empty string", () => {
      assert.equal(resolveCountry(""), "unknown");
    });
    it("returns unknown for null", () => {
      assert.equal(resolveCountry(null), "unknown");
    });
    it("returns unknown for undefined", () => {
      assert.equal(resolveCountry(undefined), "unknown");
    });
    it("returns unknown for gibberish", () => {
      assert.equal(resolveCountry("xyzzy12345"), "unknown");
    });
    it("handles extra whitespace", () => {
      assert.equal(resolveCountry("  Nigeria  "), "NG");
    });
    it("handles location with comma-separated city, country", () => {
      assert.equal(resolveCountry("Lagos, Nigeria"), "NG");
    });
    it("handles location with comma-separated city, state abbreviation", () => {
      assert.equal(resolveCountry("Los Angeles, CA"), "US");
    });
  });
});
