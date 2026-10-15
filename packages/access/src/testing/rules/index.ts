// The Rule 1-9 cases, in rule order (PRD §7.2). rules.test.ts registers them.
import type { Rule } from './case.ts'
import { RULE_1 } from './rule-1.ts'
import { RULE_2 } from './rule-2.ts'
import { RULE_3 } from './rule-3.ts'
import { RULE_4 } from './rule-4.ts'
import { RULE_5 } from './rule-5.ts'
import { RULE_6 } from './rule-6.ts'
import { RULE_7 } from './rule-7.ts'
import { RULE_8 } from './rule-8.ts'
import { RULE_9 } from './rule-9.ts'

export const RULES: readonly Rule[] = [
  { rule: 1, title: 'Mirror access', cases: RULE_1 },
  { rule: 2, title: 'Audience bound', cases: RULE_2 },
  { rule: 3, title: 'Derived content inherits restriction', cases: RULE_3 },
  { rule: 4, title: 'DMs stay private', cases: RULE_4 },
  { rule: 5, title: 'Restricted rooms are not indexed', cases: RULE_5 },
  { rule: 6, title: 'Revocation is fast', cases: RULE_6 },
  { rule: 7, title: 'Deletion propagates', cases: RULE_7 },
  { rule: 8, title: 'Content is data, not instructions', cases: RULE_8 },
  { rule: 9, title: 'Privileged access is audited and never feeds AI', cases: RULE_9 },
]
