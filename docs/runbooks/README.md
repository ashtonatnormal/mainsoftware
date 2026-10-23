# Runbooks and procedures

## What these are

The procedures the Data Protection Officer (DPO) and the people running Hearth follow when something needs doing by hand: PDPA-04's written manual procedure, the PDPA's accountability row, C0.9's Done and the C0 exit ("the breach runbook and the access and correction procedures are written"). They were written in C0.9 PR 3a (TECH-SPEC T22 item 46). C1.11 runs them as timed dry runs and updates them for the Rule 9 service, and C6.1's consoles replace the request procedures.

Every runbook but this one has the same sections, in this order: *Use this when*, *Who does what*, *Before you start*, *Steps*, *Check it worked*, *Afterwards* and *Code paths*, with *Don't* between them where a mistake would make things worse. *Code paths* lists the code each one relies on, so a change to that code shows here (`scripts/guards/runbooks.test.ts`).

## The rules

- This repository is public, so the runbooks name roles only: the DPO, an Owner, an Admin, the person on call for production (who holds C0.11's logged break-glass role) and the second reviewer. Never a person's name, a phone number, an email address, a postal address, an account or a Console user.
- Nothing here holds anyone's data. Facts are read at run time, from Secrets Manager or from the DPO's own records.
- Any output that holds people's data goes only under `local-data/` at the repository root, which git ignores, and is never committed.
- Production steps need C0.11's logged break-glass role, and each use is reviewed by a second person every quarter (C0.19). They are never a coding agent's: coding agents never connect to production.
- Nothing calls Twilio from CI. Tests use the fake provider, with fictional numbers only.

## Before C0.16's console: what exists

Hearth has no screen yet for signing out someone else's devices, resetting a PIN, deactivating an account, changing a number or correcting a roster fact. C0.16's console brings them. Until then:

- The current device's session ends with Sign out in the avatar menu.
- These api routes exist with no screen:
  - your own devices: `GET /api/devices` lists them, and `POST /api/devices/sign-out` signs out one device, or all your other devices;
  - an Owner's or Admin's: `POST /api/admin/people/sign-out-devices`, `POST /api/admin/people/reset-pin` and `POST /api/admin/people/deactivate`, and `GET /api/admin/people/:person/devices`.
- Each admin route needs a re-authentication within the last 5 minutes (for an Owner or an Admin, the PIN, through `POST /api/auth/reauth/pin`) and an actor who has acknowledged the latest version of the notice (TECH-SPEC T22 item 36). The Owner or Admin sends it from their own signed-in Hearth tab, with the person on call guiding them if needed. A coding agent never sends one.
- A PIN reset or a deactivation refuses an action on yourself, and only an Owner resets a DPO's PIN. So while one founder is the sole Owner and the DPO (D35), nobody can reset their PIN in the app. From the bootstrap PR, its break-glass PIN reset can (TECH-SPEC T14 item 21).
- Nothing changes a number or a roster fact until C0.16 (ACC-06's phone change, the roster import), and nobody writes to a table instead.

## The index

| Runbook | Use it when | Who leads |
|---|---|---|
| [Publishing a version of the notice](publishing-the-notice.md) | Production's first version, and every later one | The DPO |
| [A stated Twilio fact changed, and codes go to the DPO alone](twilio-fact-changed.md) | Sign-in codes reach only the DPO after a change to Twilio Verify's entry | The DPO |
| [Twilio withdrawn, and no DPO signed in](twilio-withdrawn.md) | Nobody gets a sign-in code, the DPO included | The DPO decides; the person on call runs it |
| [A suspected breach of personal data](breach.md) | Anyone suspects personal data was lost, disclosed, changed or reached without authority | The DPO |
| [A request for a copy of someone's personal data](access-request.md) | Someone asks for their personal data, or how it was used | The DPO |
| [A request to correct someone's personal data](correction-request.md) | Someone asks for an error or omission to be corrected | The DPO |
| [A withdrawal of consent, or an objection, carried out by hand](withdrawal-by-hand.md) | Someone withdraws deemed consent or objects; and before recording deemed consent by conduct for any purpose | The DPO |
| [A question or complaint about how personal data is handled](complaints.md) | Someone asks or complains about how their personal data is handled | The DPO |

## Working targets until PR 3b tracks them

C0.9 PR 3b brings the request form, the DPO's queue and its reply targets (C0.9 OD-08, OD-09). Until then the DPO works to the same targets by hand:

- withdrawals, objections, questions and complaints: within 10 business days, counted as weekdays in the organisation's time zone (public holidays count, so a due date is never late);
- access and correction: within 30 calendar days.

These are the DPO's working targets. Nothing in the app or the notice promises them yet.

## Records until PR 3b's queue

The DPO keeps one private request log, outside Hearth and outside this repository (C0.9 PD-85). For each request it holds:

- the day it was received, and the channel it came by;
- the kind: a question, a complaint, an access, correction or withdrawal request, or an objection;
- the requester;
- how their identity was checked: a name, one contact channel and a note of how (for example, in person or against HR records), never a copy of an ID document (C0.9 OD-16);
- the due date;
- each step, with its date;
- the outcome.

When PR 3b lands, every open entry moves into the queue.

## The daily routine until C0.14 and PR 3b's indicator

Each working day, the DPO checks the mailbox and any other channel the contact names, and opens Data protection in the avatar menu (C0.9 OD-22). Hearth sends no alert about a request yet.

## Changing a runbook

By pull request, like any other change to this repository. The DPO confirms every change to a procedure before it merges.
