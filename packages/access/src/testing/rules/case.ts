// One case of the Rule 1-9 suite (PRD §7.2; BUILD-PLAN C0.4, T10). A case either runs now (c0:
// the access core decides it, the set algebra of the AI rules included) or is a todo for the
// stage that builds what it needs: `core` for a later non-AI step, `ai` for the AI layer (A0-A6).
// The core launch needs every core todo green, and the full v1 launch every ai todo too
// (PRD §11). The type makes a c0 case without a test, or a todo with one, a typecheck error.
export type RuleNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type RuleCase = { id: string; name: string } & (
  | { status: 'c0'; run: () => void }
  | { status: 'core' | 'ai'; stage: string; run?: never }
)
export interface Rule {
  rule: RuleNumber
  title: string
  cases: readonly RuleCase[]
}

// A case that runs now.
export const c0 = (id: string, name: string, run: () => void): RuleCase => ({ id, name, status: 'c0', run })
// A non-AI case for a later step, e.g. core('R1-03', 'C1.7', '…').
export const core = (id: string, stage: string, name: string): RuleCase => ({ id, name, status: 'core', stage })
// An AI case, for the A-stage that builds it.
export const ai = (id: string, stage: string, name: string): RuleCase => ({ id, name, status: 'ai', stage })
