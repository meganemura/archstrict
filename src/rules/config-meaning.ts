// Responsibility: assess contradictions between edge rules and their reasons through one Jev batch.
// Boundary: advisory config findings only; no module ownership or todo policy.
import type { Config } from "../config.js";

type ChoiceAnswer = {
  type: "choice";
  choice: "consistent" | "contradicts";
  confidence: number;
  probabilities: { consistent: number; contradicts: number };
};

export type Prover = (request: {
  state: string;
  questions: Record<string, { type: "choice"; instructions: string; criteria: { consistent: string; contradicts: string } }>;
}) => Promise<{ answers: Record<string, ChoiceAnswer> }>;

// Like src/rules/empty-rule.ts, these findings use config.configPath and have no owning module to freeze debt against.
// isFreezable() in src/verbs/check.ts tests for todoModule; omitting that field excludes these findings from todo files.
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
type ContradictionFinding = BaseFinding & { confidence: number; skipped?: never; undecided?: never };
type SkippedFinding = BaseFinding & { skipped: true; confidence?: never; undecided?: never };
type UndecidedFinding = BaseFinding & { undecided: true; confidence?: never; skipped?: never };
export type Violation = ContradictionFinding | SkippedFinding | UndecidedFinding;

// Each entry gets one decision; no later triage of a larger candidate set filters out model noise.
// Use a conservative 0.7 bar instead of a casual 0.5 guess; weaker contradictions remain undecided because model noise can resemble a problem.
const CONTRADICTION_THRESHOLD = 0.7;
// Fixed instructions compare each entry's JSON shape with its own because text to assess the config's internal consistency.
// They do not assess design fitness against source code; empty-rule.ts checks structural applicability against real graph edges.
const STATE = "This is an architecture-linting config for a TypeScript project. " +
  "allowDeny restricts which tags may depend on which; order enforces a layer sequence; point forbids specific from/to edges. " +
  "Every entry has a mandatory, human-written because text that explains its intent. " +
  "Assess whether each rule's configured shape contradicts its own because text.";
const QUESTION = "Does this rule's configured shape agree with (consistent) or contradict (contradicts) " +
  "what its because text claims the rule restricts?";
const CRITERIA = {
  consistent: "the shape agrees with what the because text claims",
  contradicts: "the shape actually permits something the because text says must never happen",
};

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

// HTTP errors can echo request details, including credentials; proving otherwise for every failure path is costly.
// Fixed, authored reasons prevent caught request details from leaking TYPESAFE_API_KEY into evidence without repeated sanitization.
// Error categories can select a reason, but evidence must never copy error.message or error.name.
function skipped(config: Config, reason: string, next: string): Violation[] {
  return [{ rule: "config-meaning", path: config.configPath, line: 1, column: 1,
    tier: "calibrated", skipped: true, evidence: reason,
    because: "a rule that checks nothing must not look like a pass", next }];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export async function checkConfigMeaning(config: Config, prove: boolean, prover: Prover = realProver): Promise<Violation[]> {
  // Other tools can share this credential. Only --prove authorizes paid calls for this invocation.
  // A key alone must not cause paid requests during routine CI or pre-commit checks.
  if (!prove) return [];
  // Kind and index provide unique keys within one batch request and response; stable identities serve no purpose here.
  // These keys are neither persisted nor compared across checks, and this config-level check never uses todo fingerprints.
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
    type: "choice" as const,
    instructions: `${JSON.stringify({ kind, ...rule })}\nbecause: ${rule.because}\n${QUESTION}`,
    criteria: { ...CRITERIA },
  }]));
  try {
    const response: unknown = await prover({ state: STATE, questions });
    // Every expected answer must satisfy the response contract before we report any assessment.
    // One skip marks an incomplete batch; partial findings would require guessing which answers to trust after a contract failure.
    if (!record(response) || !record(response.answers)) {
      return skipped(config, "the Jev API request failed: invalid answers", "retry archstrict check --prove after checking the service response");
    }
    const assessments: ChoiceAnswer[] = [];
    for (const { id } of entries) {
      const answer = response.answers[id];
      if (!Object.hasOwn(response.answers, id)) {
        return skipped(config, "the Jev API request failed: missing an expected answer", "retry archstrict check --prove after checking the service response");
      }
      if (!record(answer) || answer.type !== "choice" ||
        (answer.choice !== "consistent" && answer.choice !== "contradicts") || !probability(answer.confidence) ||
        !record(answer.probabilities) || !probability(answer.probabilities.consistent) || !probability(answer.probabilities.contradicts)) {
        return skipped(config, "the Jev API request failed: invalid choice answer", "retry archstrict check --prove after checking the service response");
      }
      assessments.push({ type: "choice", choice: answer.choice, confidence: answer.confidence,
        probabilities: { consistent: answer.probabilities.consistent, contradicts: answer.probabilities.contradicts } });
    }
    return entries.flatMap(({ rule, label }, i): Violation[] => {
      const { choice, confidence, probabilities } = assessments[i]!;
      if (choice === "consistent") return [];
      // A skip means the request never ran or failed to yield a valid assessment; it cannot establish agreement with the reason.
      // Here Jev answered contradicts successfully, but its confidence does not justify a finding.
      // A separate undecided category preserves this inconclusive assessment instead of hiding it among request failures.
      if (confidence < CONTRADICTION_THRESHOLD) {
        return [{ rule: "config-meaning", path: config.configPath, line: 1, column: 1,
          evidence: `${label}: Jev returned contradicts but could not decide with sufficient confidence (confidence ${confidence}; probabilities ${JSON.stringify(probabilities)})`,
          because: rule.because,
          next: `request a human review of the ${label} in archstrict.config.ts: the automated check could not decide`,
          undecided: true, tier: "calibrated" }];
      }
      return [{ rule: "config-meaning", path: config.configPath, line: 1, column: 1,
        evidence: `${label}: Jev assessed that its configured shape contradicts its 'because' text (confidence ${confidence})`,
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
