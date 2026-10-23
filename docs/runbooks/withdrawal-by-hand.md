# A withdrawal of consent, or an objection, carried out by hand

C0.9 OD-18, PDPA s16 and PDPA-04: withdrawing deemed consent, or objecting to processing on legitimate interests, before Hearth can record either.

## Use this when

- Someone withdraws their deemed consent for a purpose the published notice lists on deemed consent by conduct.
- Someone objects to processing on legitimate interests.
- Before you record deemed consent by conduct as the basis of any purpose: read the table below first.

## Who does what

- The DPO decides and carries it out.
- The person on call for production helps where data must be deleted.

## Before you start

- Hearth's gates can't see one person's withdrawal until C2.11: `processing_restrictions` has no writer yet, and `isProcessingAllowed` keeps allowing the purpose for them. So a purpose may rest on deemed consent by conduct only when its row below says how to stop it for one person.
- Where it can't be stopped for one person, choose another basis, or leave the purpose planned. The purposes page warns about this (`withdrawal_by_hand`) for every basis that rests on consent.
- Hearth enforces it: the publish route holds back an active purpose on deemed consent by conduct until `CONDUCT_WITHDRAWABLE` lists it (`purpose_conduct_unstoppable`), and a purpose joins that list only in the pull request that writes its row here, with how to stop it (`scripts/guards/runbooks.test.ts`, RB-05).

| Purpose | What stops for the person | How you stop it for one person | What continues |
|---|---|---|---|
| `security_audit` | nothing yet | it can't be: the audit log is append-only and must cover every account | everything; don't choose this basis |
| `backups` | nothing yet | it can't be: backups can't be changed until C0.10's retention | everything; don't choose this basis |
| `content_delivery` | not active in C0 | the step that makes it active fills this row | n/a |
| `access_logs` | not active in C0 | as above | n/a |
| `presence_receipts` | not active in C0 | as above | n/a |
| `session_slides` | not active in C0 | as above | n/a |
| `session_sharing` | not active in C0 | as above | n/a |
| `people_insights` | not active in C0 | as above | n/a |
| `sensitive_data_detection` | not active in C0 | as above | n/a |

The pinned purposes (`accounts`, `service_operation`) never rest on consent; the recording purposes need a per-person switch, so the register refuses any consent-type basis for them until C2.11; and the AI purposes stay planned until A0. None of them is listed.

**In C0, don't record deemed consent by conduct for an active purpose.** No row above says how to stop one, so `CONDUCT_WITHDRAWABLE` is empty and publishing would be held back.

## Steps

Once a purpose's row says how to stop it:

1. The DPO logs it with the day it was received. It is due within 10 business days.
2. The DPO checks the person's identity, as for an access request ([A request for a copy of someone's personal data](access-request.md)).
3. The DPO finds the purposes it touches in the published notice and the processing register. Those on deemed consent by conduct stop for them; the others continue, and the DPO tells them so and why (the notice's "If you withdraw consent").
4. The DPO tells them in writing what withdrawing changes for them, before it takes effect (PDPA s16).
5. The DPO, with the person on call where data must be deleted, carries it out as the purpose's row says.
6. The DPO confirms to them in writing once it has taken effect.
7. For an objection, the DPO weighs it against the purpose's documented legitimate-interests assessment, decides, and replies with the reason.
8. The DPO replies within the target.

## Check it worked

- The person's data is no longer processed for that purpose, as the purpose's row says to check.

## Afterwards

- Until C2.11 the DPO's log is the record. From C2.11 the restriction is recorded in Hearth, and from C0.9 PR 3b the request is a case in the queue.

## Code paths

- `publish_notice()`
- `CONDUCT_WITHDRAWABLE`
- `purpose_conduct_unstoppable`
- `withdrawal_by_hand`
- `isProcessingAllowed`
- `apps/web/src/dpo/PurposesScreen.tsx`
- `packages/shared/src/notice-text.ts`
- `/dpo/purposes`
