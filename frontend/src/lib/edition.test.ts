import { describe, expect, it } from "vitest";

import { isWebOnlyPath } from "./edition";

describe("Kortes Desktop routes", () => {
  it("turns off the web-only pages", () => {
    for (const path of ["/sign-in", "/admin", "/admin/announcements", "/settings/social", "/blog/x", "/analytics"]) {
      expect(isWebOnlyPath(path)).toBe("page");
    }
  });

  it("turns off the web-only API routes", () => {
    for (const path of ["/api/social/providers", "/api/api-keys", "/api/billing/checkout", "/api/feedback"]) {
      expect(isWebOnlyPath(path)).toBe("api");
    }
  });

  it("keeps the app itself", () => {
    for (const path of ["/", "/list", "/tasks/abc", "/settings", "/setup", "/api/tasks/x", "/api/desktop/setup",
      "/api/upload", "/api/fonts", "/api/tasks/billing-summary", "/settings-x", "/admin-like"]) {
      expect(isWebOnlyPath(path)).toBeNull();
    }
  });
});
