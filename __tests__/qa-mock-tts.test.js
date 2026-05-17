"use strict";

const { shouldServeMock, isQaEmail, buildMockResponse } = require("../lib/qa-mock-tts");

describe("qa-mock-tts kill switch", () => {
  describe("isQaEmail", () => {
    test.each([
      ["qa-day1-1234@thenetmencorp.com", true],
      ["qa-day2-abc@thenetmencorp.com", true],
      ["qa-weekly-xyz@thenetmencorp.com", true],
      ["qa-item3-9@thenetmencorp.com", true],
      ["maestro-bot@whatever.com", true],
      ["throwaway.account@x.com", true],
      ["e2e+test@alzo.app", true],
      ["someone@maestro.local", true],
      ["random@qa.alzo.app", true],
      ["qa-throwaway.foo@x.com", true],
      // Bare `qa-<timestamp>` is INTENTIONALLY NOT matched — legacy regression
      // suite uses this shape and expects the real voice path.
      ["qa-1779000000-abc@thenetmencorp.com", false],
      ["test_user@foo.com", false],
      ["nacho@thenetmencorp.com", false],
      ["joaquin@alzo.app", false],
      ["real.user@gmail.com", false],
      ["", false],
      [null, false],
      [undefined, false],
    ])("isQaEmail(%j) = %s", (email, expected) => {
      expect(isQaEmail(email)).toBe(expected);
    });
  });

  describe("shouldServeMock", () => {
    test("returns mock=true for QA email", () => {
      const req = { headers: {} };
      const user = { email: "qa-day1-99@thenetmencorp.com" };
      const out = shouldServeMock(req, user);
      expect(out.mock).toBe(true);
      expect(out.reason).toBe("qa_email_pattern");
    });

    test("returns mock=true on X-Internal-Build header", () => {
      const req = { headers: { "x-internal-build": "1" } };
      const out = shouldServeMock(req, { email: "real.user@gmail.com" });
      expect(out.mock).toBe(true);
      expect(out.reason).toBe("header_X-Internal-Build");
    });

    test("returns mock=true when QA_USE_MOCK_TTS=true env set", () => {
      const orig = process.env.QA_USE_MOCK_TTS;
      process.env.QA_USE_MOCK_TTS = "true";
      try {
        const out = shouldServeMock({ headers: {} }, { email: "real@user.com" });
        expect(out.mock).toBe(true);
        expect(out.reason).toBe("env_QA_USE_MOCK_TTS");
      } finally {
        if (orig === undefined) delete process.env.QA_USE_MOCK_TTS;
        else process.env.QA_USE_MOCK_TTS = orig;
      }
    });

    test("returns mock=false for real user, no header, no env", () => {
      const req = { headers: {} };
      const user = { email: "real.user@gmail.com" };
      const out = shouldServeMock(req, user);
      expect(out.mock).toBe(false);
      expect(out.reason).toBeNull();
    });

    test("returns mock=false when no user (unauth real path)", () => {
      const req = { headers: {} };
      const out = shouldServeMock(req, null);
      expect(out.mock).toBe(false);
    });
  });

  describe("buildMockResponse", () => {
    test("returns shape with cloneMode=mock + audioUrl", () => {
      const r = buildMockResponse({
        user: { email: "qa@foo.com" },
        reason: "qa_email_pattern",
        affirmationText: "hi",
      });
      expect(r.cloneMode).toBe("mock");
      expect(typeof r.audioUrl).toBe("string");
      expect(r.durationMs).toBe(1000);
      expect(r.affirmationText).toBe("hi");
    });
  });
});
