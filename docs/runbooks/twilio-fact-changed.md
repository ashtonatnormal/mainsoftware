# A stated Twilio fact changed, and codes go to the DPO alone

## Use this when

- `sms_provider_unstated` is logged at error.
- `auth.code_requested` audit rows say `skipped_unstated`.
- People say no sign-in code arrives, while the DPO still gets one.
- Twilio Verify's card on Transfers says that until you publish, only you get sign-in codes.

Foreseeable causes: Twilio confirms a change to its retention, its countries or who carries the text onward; C0.19 opts out of Google's RCS; or someone saved a change to one of Twilio Verify's seven stated facts (services, data types, processing countries, storage countries, training, its retention, onward recipients).

## Who does what

- The DPO decides and publishes, in the app. No production access is needed.
- Owners and Admins tell people not to sign out meanwhile.

## Before you start

- Nothing is locked: open sessions keep working, PIN re-authentication works, and the DPO still gets a sign-in code. Only new sign-ins by everyone else wait.
- Only the DPO can publish. If the DPO is away, new sign-ins wait until they are back.

## Steps

1. The DPO signs in, then enters the PIN.
2. The DPO opens Transfers and compares Twilio Verify's facts with Twilio's written confirmations, then decides whether the change was right.
3. If the change was a mistake, the DPO edits Twilio Verify, records the seven stated facts exactly as the published notice states them, and chooses "Save and keep cleared". Everyone gets codes again at once, with no new version. Never choose a plain Save here: it ends the clearance, and leads to [Twilio withdrawn, and no DPO signed in](twilio-withdrawn.md).
4. If the change was right, the DPO tells the Owners that a re-acknowledgement is coming.
5. The DPO publishes a new version, as [Publishing a version of the notice](publishing-the-notice.md) says in steps 5 to 9. Its draft lists Twilio Verify under what changes.
6. The DPO acknowledges the new version.

## Check it worked

- Twilio Verify's card no longer says that only you get sign-in codes.
- `sms_provider_unstated` stops being logged.
- A colleague signs in on their own phone and gets a code.

## Afterwards

- The DPO notes the change, its date and the version published in their log.
- The DPO reviews Twilio Verify's entry again at its review date.

## Don't

- Don't save a change to a stated Twilio fact unless you plan to publish straight after. The edit dialog warns you.

## Code paths

- `transfer_send_state()`
- `record_transfer_entry()`
- `clear_transfer_entry()`
- `sms_provider_unstated`
- `skipped_unstated`
- `/dpo/transfers`
- `/dpo/notice`
