// Optional live-model evaluation. Uses synthetic data only; no tools or DB.
// Build packages first. Inspect summaries as well as literal-retention scores.
import {
  compactContext,
  historyMessages,
  summaryWriter,
} from "../packages/providers/dist/index.js";
const model = process.env.COMPACTION_EVAL_MODEL;
const base_url = process.env.COMPACTION_EVAL_BASE_URL;
if (!model || !base_url)
  throw Error("Set COMPACTION_EVAL_MODEL and COMPACTION_EVAL_BASE_URL");
const contextLimit = Number(process.env.COMPACTION_EVAL_CONTEXT ?? 256000);
const outputTokens = Number(process.env.COMPACTION_EVAL_OUTPUT ?? 8192);
const connection = {
  base_url,
  kind: "compatible",
  key: process.env.COMPACTION_EVAL_API_KEY ?? "",
};
const initial =
  "Prepare a diagnostic report only. Never control cover.garage. light.kitchen was switched off and confirmed; do not repeat. The outcome of the switch.boiler command is unknown: verify before retrying. Temperature threshold: 19.5 C. Save /workspace/ha_report.json. HA_RATE_LIMIT requires waiting 30 seconds. Next: read boiler state and prepare the report.";
const messages = historyMessages(
  [
    { role: "user", content: initial },
    {
      role: "assistant",
      content:
        "action-a: light.kitchen off confirmed. action-b: switch.boiler outcome unknown. " +
        "Sensor observation: healthy; no additional actions. ".repeat(3000),
    },
    {
      role: "user",
      content:
        "Continue while respecting all constraints and already completed work.",
    },
  ],
  model,
);
const options = {
  model,
  contextLimit,
  outputTokens,
  force: true,
  write: summaryWriter(connection, model, contextLimit, {
    max_tokens: outputTokens,
  }),
};
const first = await compactContext({
  ...options,
  messages,
  signal: AbortSignal.timeout(180000),
});
if (!first) throw Error("Expected first checkpoint");
const second = await compactContext({
  ...options,
  messages: [
    ...first.messages,
    ...historyMessages(
      [
        {
          role: "user",
          content:
            "Update: threshold is now 21.0 C, replacing 19.5. Save /workspace/ha_report_v2.json instead. The switch.boiler verification is complete: off confirmed. All other constraints still apply. Next: write the report.",
        },
        {
          role: "assistant",
          content:
            "Verified boiler state: off. " +
            "No further actions; diagnostic observations unchanged. ".repeat(
              2000,
            ),
        },
        { role: "user", content: "Continue using the updated information." },
      ],
      model,
    ),
  ],
  signal: AbortSignal.timeout(180000),
});
if (!second) throw Error("Expected updated checkpoint");
const score = (result, values) => ({
  beforeTokens: result.beforeTokens,
  afterTokens: result.afterTokens,
  summaryCalls: result.summaryCalls,
  literalRetention: Object.fromEntries(
    values.map((value) => [value, result.summary.includes(value)]),
  ),
  summary: result.summary,
});
console.log(
  JSON.stringify(
    {
      model,
      first: score(first, [
        "cover.garage",
        "light.kitchen",
        "switch.boiler",
        "19.5",
        "/workspace/ha_report.json",
        "HA_RATE_LIMIT",
        "30",
      ]),
      second: score(second, [
        "cover.garage",
        "light.kitchen",
        "switch.boiler",
        "21.0",
        "/workspace/ha_report_v2.json",
        "HA_RATE_LIMIT",
        "30",
      ]),
      review:
        "Inspect outcome certainty, prohibitions, superseded values and next steps manually. Literal retention is not a proof of semantic fidelity.",
    },
    null,
    2,
  ),
);
