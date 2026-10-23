# A request for a copy of someone's personal data

PDPA s21 and PDPA-05: access to personal data, and how it has been used or disclosed in the past year.

## Use this when

Someone asks for a copy of their personal data, or how it has been used or disclosed in the past year: a member, someone who has left, or someone without a Hearth account.

## Who does what

- The DPO handles it, alone.
- The person on call for production reads production only as step 3 says.

## Before you start

- The DPO logs it with the day it was received. The 30 calendar days run from receipt (C0.9 OD-08).
- The DPO checks the requester's identity without relying on an old Hearth number or PIN (in person, by video, or against HR records), and notes how, never copying an ID document (C0.9 OD-16).

## Steps

1. The DPO lists what C0 holds about a person: their roster facts (name, department, manager, roles); their number; their devices and sessions (labels and times); their sign-in and code audit rows; whether they set a PIN (never the PIN); their notice acknowledgements; and the registers' general description of how data is used and who receives it.
2. The DPO gathers what the app shows: the person's own Settings › Privacy (the contact, the notice and their acknowledgements, with the day and how for any the DPO recorded). Their devices have no screen until C0.16, but the routes exist: `GET /api/devices`, from the person's own tab, and `GET /api/admin/people/:person/devices`, an Admin's view with labels and dates only (see [Before C0.16's console](README.md#before-c016s-console-what-exists)).
3. Until C1.11's Rule 9 service and C6.1's console, the person on call gathers the rest only through a read-only production query for that one requester, under the logged break-glass role, citing the request in the break-glass log, and a second person reviews it. Never through the Rule 9 module's credential, and never by a coding agent. This is CLAUDE.md's one exception to "never one person's rows" (Security and privacy). The output goes only under `local-data/`.
4. The DPO reviews every item before it is released, and withholds other people's data (PDPA-05a).
5. The DPO replies in writing, by a channel outside Hearth.
6. If the DPO needs more than 30 days, the DPO tells the requester in writing, within the 30 days, when they will have it.
7. If the DPO refuses, the DPO records why. The data the request covers is then kept for at least 30 days after the refusal (PDPA-09), so nothing deletes it meanwhile.

## Check it worked

- The reply went within 30 days, or the requester was told in writing within 30 days when it would come.
- The DPO's log records what was sent and what was withheld.

## Afterwards

- The person on call deletes every working copy under `local-data/` once the reply is sent.
- The DPO closes the log entry.

## Code paths

- `read_audit_events()`
- `apps/web/src/settings/PrivacySettings.tsx`
- `devices.list_own`
- `person.list_devices`
- `/api/devices`
- `/api/admin/people/:person/devices`
- `/dpo/purposes`
- `/dpo/transfers`
- `/settings/privacy`
