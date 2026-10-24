# Twilio withdrawn, and no DPO signed in

## Use this when

- `sms_provider_not_cleared` is logged at error.
- `auth.code_requested` audit rows say `skipped_not_cleared`.
- Nobody gets a sign-in code, the DPO included.
- Twilio Verify's card on Transfers shows no open clearance: its clearance was withdrawn, or a plain Save changed its facts and ended it.

The break-glass re-clear restores Twilio Verify's clearance when no DPO can sign in to do it in the app (C0.9 OD-20, TECH-SPEC T22 item 44).

## Who does what

- The DPO decides, in person or by phone.
- An Owner confirms that it is the DPO deciding, in person or by video.
- The person on call for production runs the re-clear.
- A second person reviews the use, in C0.19's quarterly review of break-glass uses.

## Before you start

1. The person on call asks each DPO whether they are still signed in to Hearth on any device (the re-clear checks this itself, and refuses while one is). If one is and can use that session, that DPO opens Transfers, enters the PIN and chooses "Clear for use" on Twilio Verify. Stop here.
2. If a DPO has a live session they can't use (their PIN is locked, or they lost the phone), the re-clear refuses until that session ends. What ends it now (see [Before C0.16's console](README.md#before-c016s-console-what-exists)):
   - on a device the DPO still holds, Sign out in the avatar menu;
   - a PIN locked for 15 minutes after 5 wrong tries unlocks by itself, and the DPO then clears Twilio Verify in Hearth (step 1);
   - from another of the DPO's own signed-in devices, the devices route (`POST /api/devices/sign-out`);
   - where an Owner other than the DPO exists, that Owner resets the DPO's PIN after checking it's them (`POST /api/admin/people/reset-pin`, which ends the DPO's sessions), or an Admin signs out the DPO's devices (`POST /api/admin/people/sign-out-devices`); neither has a screen until C0.16;
   - from the bootstrap PR, its break-glass PIN reset (TECH-SPEC T14 item 21), which ends the sole Owner and DPO's sessions;
   - otherwise, time: a DPO's session is issued under the PIN rule and ends at most 7 days after it was issued, and the re-clear is allowed from then.
3. The DPO decides which branch you are in:
   - **A:** Twilio is still acceptable (a mistake, a plain Save, a short suspension);
   - **B:** it isn't (its agreement lapsed, a breach at Twilio, or its facts are no longer true).
4. For branch A, the DPO confirms that Twilio Verify's facts, as the published notice states them, are still true.
5. For branch A, the DPO gives the person on call a review date after today and at most 90 days ahead, and the reason in a sentence: what happened, who decided, and where the record is. Nobody types the facts: the recovery mode reads them.

## Steps

### Branch A: re-clear Twilio Verify

1. The person on call opens a production session under the logged break-glass role.
2. The person on call runs the bootstrap script's recovery mode, non-interactively. It connects with a 30-second transaction timeout, and in one transaction as `hearth_owner`, acting as the organisation's Hearth principal, it sets the emergency marker and the server's 2-second lock timeout, reads the facts of the Twilio Verify clearance the latest published version names (or, with none, the clearance that ended last), and calls the bootstrap's function for `twilio` with those facts, the new review date, the DPO's id and the reason. All of them are read at run time, never typed into this repository or a chat.
3. If it answers that a DPO is signed in, the person on call stops: that DPO clears Twilio Verify in Hearth (Before you start, step 1).
4. If it answers that Twilio Verify is cleared already, the person on call stops: someone else cleared it.
5. If it timed out waiting for a lock, the person on call runs it once more.

Until the bootstrap PR lands there is no recovery mode and no production (C0.11, C0.12), so this branch can't be run anywhere yet. In local development, rebuild the database with `npm run db:reset`; never call the function by hand.

### Branch B: don't re-clear

1. The DPO tells the Owners that sign-in codes have stopped. There is no other SMS route until AWS End User Messaging has its own cleared entry, egress route and secret, which is a reviewed change (TECH-SPEC T7).
2. The Owners tell people, and keep sessions alive: nobody signs anyone out.
3. The owner decides the fallback.
4. If personal data was at risk, the DPO follows [A suspected breach of personal data](breach.md).

## Check it worked

- The recovery mode prints the new clearance and the send state for `twilio`. `cleared` means everyone gets codes again. `unstated` appears only if the DPO decided a stated fact changed: then codes go to the DPO alone until a new version is published ([A stated Twilio fact changed](twilio-fact-changed.md)).
- A member signs in on their own phone and gets a code.
- Once the DPO signs in, Twilio Verify's card on Transfers says it was cleared again by the emergency re-clear.

## Afterwards

- The DPO reviews Twilio Verify's entry on Transfers and records anything that changed.
- The person on call records the use in the break-glass log, for the quarterly review.
- The DPO notes it in their log.

## Don't

- Don't reset the DPO's PIN, deactivate them or sign out their devices while Twilio Verify isn't cleared, unless that DPO can't use their session to clear it (Before you start, step 2): it ends the last session that could.
- Never call the function by hand in an interactive transaction: an open transaction holds every DPO's row and stalls their access. The function ends one left open 30 seconds after the call anyway.
- Never write to a table directly.
- Never use the Rule 9 module's credential.
- Never let a coding agent run any step.

## Prevention

- Clear Twilio Verify again in the app before your own session ends. The withdraw dialog says so.
- A second DPO, from C0.16.

## Code paths

- `bootstrap_transfer_clearance()`
- `clear_transfer_entry()`
- `withdraw_transfer_clearance()`
- `transfer_send_state()`
- `sms_provider_not_cleared`
- `skipped_not_cleared`
- `PIN_RULE_SESSION`
- `devices.sign_out_own`
- `person.reset_pin`
- `person.sign_out_devices`
- `/api/devices/sign-out`
- `/api/admin/people/reset-pin`
- `/api/admin/people/sign-out-devices`
- `/dpo/transfers`
