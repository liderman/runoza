import test from "node:test";
import assert from "node:assert/strict";
import { runCodingEvaluation } from "../evaluation/coding.ts";
test(
  "coding baseline: real Pi runtime, exact edits, conflicts, guard, unknown outcome, saved output and approvals",
  { timeout: 180000 },
  async () => {
    const report = await runCodingEvaluation({
      directory: `work/zcode/evaluation-${Date.now()}`,
    });
    assert.equal(report.total, 22);
    assert.equal(report.passed, report.total, JSON.stringify(report.results));
  },
);
