# Publishing a version of the notice

## Use this when

- Production's first version of the privacy notice (v0) is due.
- The Notice tab says the published notice is out of date: after a change to the processing register, the transfer register or your contact details, or after an upgrade that changed the notice's wording (a new generator).

## Who does what

- The DPO records the contact and the registers, publishes, and acknowledges, alone: nobody else can publish.
- The person on call for production deploys Hearth.
- Owners tell people that a re-acknowledgement is coming.

## Before you start

- For production's v0: the first-Owner bootstrap has run; production and its break-glass role exist (C0.11, C0.12); the push services are cleared on Transfers (before C0.15); and the owner has decided whether v0 waits for C0.9 PR 3b (TECH-SPEC T22 item 48).
- Have your contact details ready: a role title and a shared mailbox or business line, never your own name or mobile number, so they still work if someone else takes on the role.
- Everyone, you included, acknowledges each new version before using Hearth again, and people using Hearth now are taken to it within half a minute. Choose a quiet time.

## Steps

1. The DPO signs in. Before v0 only the DPO gets a sign-in code. Set your PIN, or enter it.
2. The DPO opens Contact and records or checks the contact details.
3. The DPO opens Purposes and records each active purpose's legal basis and how long its data is kept.
4. The DPO opens Transfers and checks each provider's card: whether it is cleared, its facts and its review date.
5. The DPO opens Notice and reads "Before you can publish", then fixes each item through its link.
6. The DPO reads the warnings. They never block publishing, but each says something about what the notice will say.
7. The DPO reads the preview, "Your rights" above all, since it is how people reach you.
8. The DPO chooses Publish, confirms, and enters the PIN when asked.
9. The DPO acknowledges the new version on the privacy notice screen, where Hearth takes you once it is published.
10. For v0 only, the DPO publishes the same contact details outside Hearth the same day: on the organisation's website, and in ACRA's BizFile+ (PDPA-13).

### Changing your contact details

1. The DPO records the new details on Contact. The page then says they aren't in the published notice yet.
2. The DPO publishes, as steps 5 to 9 say. The notice screen tells everyone that the contact details have changed.
3. The DPO keeps the old mailbox or number answered until the Notice tab's count shows that everyone has acknowledged the new version.
4. The DPO updates the contact details published outside Hearth the same day.

### Recording an acknowledgement made outside Hearth

Only for someone who acknowledged the latest version outside Hearth, such as by signing a printed copy. Never for yourself: you acknowledge in Hearth.

1. The DPO opens Notice and chooses "Record an acknowledgement".
2. The DPO chooses who acknowledged it, the day they did, and how, such as "Signed a printed copy at induction".
3. The DPO chooses Record. They can use Hearth at once, and their Settings shows the day and how.
4. The DPO keeps the signed copy in the person's personnel file, never in Hearth.

## Check it worked

- The Notice tab says "It says what the registers say."
- The count of people who have acknowledged the version rises.
- A member's Settings › Privacy shows your contact details.

## Afterwards

- An Owner tells people once, by the organisation's usual channel, that the notice has changed. The notice screen's callout says what changed.

## Code paths

- `publish_notice()`
- `set_dpo_contact()`
- `record_notice_acknowledgement()`
- `/dpo/contact`
- `/dpo/purposes`
- `/dpo/transfers`
- `/dpo/notice`
- `/notice`
- `/settings/privacy`
