// Responsibility: verify the error identity and recovery command available to callers.
// Boundary: CLI rendering belongs to the verb tests.
import { expect, test } from "vitest";
import { ReportError } from "../src/report-error.js";

test("report failures retain their error identity and recovery command", () => {
  const error = new ReportError("Invalid configuration", "archstrict init");
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("ReportError");
  expect(error.message).toBe("Invalid configuration");
  expect(error.do).toBe("archstrict init");
  expect(String(error)).toBe("ReportError: Invalid configuration");
});
