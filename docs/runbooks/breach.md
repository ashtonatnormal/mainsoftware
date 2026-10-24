# A suspected breach of personal data

PDPA-11, and the PDPA's Part 6A: assessing a data breach and notifying it.

## Use this when

Anyone suspects that personal data in or around Hearth was lost, disclosed, changed or reached without authority. For example:

- a provider's incident notice (Twilio, AWS, LiveKit or a push service);
- a break-glass use with no case behind it;
- a lost or stolen device with a live Hearth session;
- an export or a message sent to the wrong person.

## Who does what

- The DPO leads and decides.
- The person on call for production contains it, under the break-glass role.
- An Owner is told.
- The DPO notifies the Personal Data Protection Commission (PDPC) and the people affected.

## Before you start

- The DPO writes down when they first became aware of it. Both clocks run from facts you record: 30 days to assess it from becoming aware, and 3 calendar days to notify from deciding that it is notifiable.
- The DPO opens an entry in their breach register, kept outside Hearth until PDPA-11's record arrives (C6.1).

## Steps

1. The person on call contains it:
   - ends the sessions affected, as the README's [Before C0.16's console](README.md#before-c016s-console-what-exists) says (Sign out in the avatar menu for the current device; the devices and admin routes, which have no screen, for the rest), and deactivates an account where needed, through an Owner or Admin;
   - if a provider must receive nothing more, asks the DPO to withdraw its clearance on Transfers (read [Twilio withdrawn, and no DPO signed in](twilio-withdrawn.md) before withdrawing Twilio Verify);
   - rotates a leaked secret in Secrets Manager;
   - preserves the logs.
2. The DPO assesses it, as soon as practicable and within 30 days of becoming aware: what data, whose (counts, never a list in a chat), how it happened, whether it continues, and the likely harm. The sources are the CloudWatch logs; the audit log, through `read_audit_events()` once the organisation chooses its audit-log readers (C0.16), or else a production read under the break-glass role; and the transfer register.
3. The DPO decides whether it is notifiable (significant harm to the people affected is likely, or it affects 500 people or more), and records why and when.
4. If it is notifiable, the DPO notifies the PDPC within 3 calendar days of that decision, through its online form on www.pdpc.gov.sg.
5. Where significant harm is likely, the DPO tells the people affected as soon as practicable, by a channel outside Hearth if Hearth is affected, unless an exception in the PDPA applies.
6. The person on call fixes the cause through a pull request.
7. The DPO records every step with its time and who took it.

## Check it worked

- Both clocks were met.
- Each step has a time and an owner in the breach register.

## Afterwards

- The DPO and the person on call review the cause.
- If a provider's facts changed, the DPO records them ([A stated Twilio fact changed](twilio-fact-changed.md) for Twilio Verify).
- The DPO reviews whether the registers or the notice must change.
- The DPO adds a dry run of this case to C1.11's list.

## Don't

- Don't copy people's data into a ticket, a chat or this repository.
- Don't delete evidence.
- Don't let a coding agent read production.

## Code paths

- `withdraw_transfer_clearance()`
- `read_audit_events()`
- `devices.sign_out_own`
- `person.sign_out_devices`
- `person.deactivate`
- `/api/devices/sign-out`
- `/api/admin/people/sign-out-devices`
- `/api/admin/people/deactivate`
- `apps/server/src/admin/people.ts`
- `/dpo/transfers`
