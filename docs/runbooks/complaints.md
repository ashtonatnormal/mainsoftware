# A question or complaint about how personal data is handled

PDPA-13, and PDPA s11 and s12: the DPO's business contact and a process for receiving and answering complaints.

## Use this when

Someone writes, calls or posts a question or a complaint about how their personal data is handled. They reach the DPO through the contact the published notice and Settings › Privacy give. C0.9 PR 3b adds a form in Hearth.

## Who does what

- The DPO reads and answers it, alone (C0.9 OD-14).
- An Owner is told that a complaint exists, never what it says, and only with the complainant's agreement.

## Before you start

- The DPO logs it with the day it was received.
- The target is 10 business days (C0.9 OD-08): weekdays in the organisation's time zone, with public holidays counted.

## Steps

1. The DPO acknowledges receipt as soon as they can, saying when the person will hear back.
2. The DPO looks into it with the records the app shows: the registers, the published versions of the notice, and the audit log where it can be read.
3. The DPO answers in writing within 10 business days, or tells the person when they will.
4. In every final reply, the DPO says that the person may complain to the Personal Data Protection Commission (PDPC) if they aren't satisfied.
5. For a complaint about the DPO, there is no second reader in Hearth (C0.9 OD-14). The DPO tells the person at once that they can go to the PDPC directly, and records that they did.
6. The DPO closes it in their log.

## Check it worked

- Each complaint in the log has the day it was received, the day of the reply and its outcome.

## Afterwards

- If it shows a gap in the notice or the registers, the DPO fixes it and publishes ([Publishing a version of the notice](publishing-the-notice.md)).

## Code paths

- `/dpo/contact`
- `/dpo/notice`
- `/settings/privacy`
- `read_audit_events()`
