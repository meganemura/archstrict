// Responsibility: assess the meaning of configured edge rules through one Jev batch.
// Boundary: advisory config findings only; no module ownership or todo policy.
import type { Config } from "../config.js";

export type Prover = (request: {
  state: string;
  questions: Record<string, { type: "score"; instructions: string; criteria: string[] }>;
}) => Promise<{ answers: Record<string, { score: number }> }>;

type BaseFinding = {
  rule: "config-meaning";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
  tier: "calibrated";
};
type ScoredFinding = BaseFinding & { confidence: number; skipped?: never };
type SkippedFinding = BaseFinding & { skipped: true; confidence?: never };
export type Violation = ScoredFinding | SkippedFinding;

const VACUOUS_THRESHOLD = 0.5;
const STATE = "This is an architecture-linting config for a TypeScript project. " +
  "allowDeny restricts which tags may depend on which; order enforces a layer sequence; point forbids specific from/to edges. " +
  "Every entry has a mandatory, human-written because text that explains its intent. " +
  "A rule is vacuous in practice when its allow/deny/sequence/from-to shape does not forbid anything meaningful relative to its because text. " +
  "For example, an allow list can name every value that could ever appear.";
const QUESTION = "Given this rule's configured shape and its own stated because text above, what is the probability (0 to 1) " +
  "that this rule is vacuous in practice - that its actual shape does not really forbid anything meaningful relative to what its because text claims to constrain?";
const CRITERIA = [
  "Low: the rule's shape clearly forbids something specific and consistent with its because text.",
  "Middle: the rule technically restricts something, but its relationship to the because text is unclear.",
  "High: the shape imposes no meaningful restriction relative to its because text, such as an exhaustive allow list or a sequence without an ordering constraint.",
];

export class ProverFailure extends Error {
  constructor(readonly kind: "missing-key" | "http-status" | "invalid-json") {
    super(kind);
  }
}
function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}
const realProver: Prover = async (request) => {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new ProverFailure("missing-key");
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, model: "jev-latest" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new ProverFailure("http-status");
  try { return await response.json() as Awaited<ReturnType<Prover>>; }
  catch (error) {
    if (isTimeout(error)) throw error;
    throw new ProverFailure("invalid-json");
  }
};

function skipped(config: Config, reason: string, next: string): Violation[] {
  return [{ rule: "config-meaning", path: config.configPath, line: 1, column: 1,
    tier: "calibrated", skipped: true, evidence: reason,
    because: "a rule that checks nothing must not look like a pass", next }];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function checkConfigMeaning(config: Config, prove: boolean, prover: Prover = realProver): Promise<Violation[]> {
  // Other tools can share this credential. Only --prove authorizes paid calls for this invocation.
  if (!prove) return [];
  const entries = [
    ...(config.edges?.allowDeny ?? []).map((rule, i) => ({ id: `allowDeny-${i}`, kind: "allowDeny", rule,
      label: `allowDeny rule (source '${rule.source}', targetNamespace '${rule.targetNamespace}')` })),
    ...(config.edges?.order ?? []).map((rule, i) => ({ id: `order-${i}`, kind: "order", rule,
      label: `order rule (tagNamespace '${rule.tagNamespace}', within ${JSON.stringify(rule.within ?? null)}, sequence ${JSON.stringify(rule.sequence)})` })),
    ...(config.edges?.point ?? []).map((rule, i) => ({ id: `point-${i}`, kind: "point", rule,
      label: `point rule (from ${JSON.stringify(rule.from)}, to ${JSON.stringify(rule.to)})` })),
  ];
  if (entries.length === 0) return [];
  const questions: Parameters<Prover>[0]["questions"] = Object.fromEntries(entries.map(({ id, kind, rule }) => [id, {
    type: "score" as const,
    instructions: `${JSON.stringify({ kind, ...rule })}\nbecause: ${rule.because}\n${QUESTION}`,
    criteria: [...CRITERIA],
  }]));
  try {
    const response: unknown = await prover({ state: STATE, questions });
    if (!record(response) || !record(response.answers)) {
      return skipped(config, "the Jev API request failed: invalid answers", "retry archstrict check --prove after checking the service response");
    }
    const scores: number[] = [];
    for (const { id } of entries) {
      const answer = response.answers[id];
      if (!Object.hasOwn(response.answers, id)) {
        return skipped(config, "the Jev API request failed: missing an expected answer", "retry archstrict check --prove after checking the service response");
      }
      if (!record(answer) || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 1) {
        return skipped(config, "the Jev API request failed: invalid score", "retry archstrict check --prove after checking the service response");
      }
      scores.push(answer.score);
    }
    return entries.flatMap(({ rule, label }, i): Violation[] => {
      const confidence = scores[i]!;
      if (confidence < VACUOUS_THRESHOLD) return [];
      return [{ rule: "config-meaning", path: config.configPath, line: 1, column: 1,
        evidence: `${label}: Jev assessed this as vacuous in practice (probability ${confidence}) despite its 'because' text`,
        because: rule.because,
        next: `review the ${label} in archstrict.config.ts: correct its configured shape or its because text so they describe the same restriction`,
        confidence, tier: "calibrated" }];
    });
  } catch (error) {
    if (error instanceof ProverFailure && error.kind === "missing-key") {
      return skipped(config, "TYPESAFE_API_KEY is not set", "set TYPESAFE_API_KEY and re-run archstrict check --prove");
    }
    const reason = isTimeout(error) ? "timeout" : error instanceof ProverFailure && error.kind === "http-status" ? "non-2xx HTTP status" :
      error instanceof ProverFailure && error.kind === "invalid-json" ? "invalid JSON response" : "network error";
    return skipped(config, `the Jev API request failed: ${reason}`, "check service access and retry archstrict check --prove");
  }
}
