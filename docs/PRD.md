# Hearth — Product Requirements Document

> **Hearth** is the product's name (D33): a hearth is where people gather.

| | |
|---|---|
| **Status** | Draft v0.4 — for review |
| **Date** | 2026-10-11 |
| **Scope** | v1 (first org-wide release) plus post-v1 roadmap |
| **Source** | Product discovery sessions; every product decision is recorded in [Appendix A](#appendix-a--decision-log) |

### How to read this document

- Requirements have stable IDs (e.g. `CHAT-04`) so they can be referenced in issues, commits, and prompts to AI coding tools.
- **Priority:** **P0** = required for the v1 org-wide launch. **P1** = targeted for v1, may slip to a v1.x release without blocking launch. **P2** = post-v1 roadmap.
- "Decision Dn" refers to the [decision log](#appendix-a--decision-log). If a requirement and a decision conflict, the decision wins and the requirement is a bug in this document.

---

## Contents

1. [Summary](#1-summary)
2. [Background and problem](#2-background-and-problem)
3. [Goals and non-goals](#3-goals-and-non-goals)
4. [Users and personas](#4-users-and-personas)
5. [Product principles](#5-product-principles)
6. [Experience overview](#6-experience-overview)
7. [AI architecture and trust model](#7-ai-architecture-and-trust-model)
8. [Functional requirements](#8-functional-requirements)
9. [Non-functional requirements](#9-non-functional-requirements)
10. [Success metrics](#10-success-metrics)
11. [Release plan](#11-release-plan)
12. [Risks and mitigations](#12-risks-and-mitigations)
13. [Open questions](#13-open-questions)
- [Appendix A — Decision log](#appendix-a--decision-log)
- [Appendix B — Build approach and suggested building blocks](#appendix-b--build-approach-and-suggested-building-blocks)
- [Appendix C — What we take from each reference product](#appendix-c--what-we-take-from-each-reference-product)
- [Appendix D — Glossary](#appendix-d--glossary)
- [Appendix E — References](#appendix-e--references)

---

## 1. Summary

Hearth is a complete work suite (chat, drop-in voice rooms, meetings, calendar, tasks, docs and wiki, sheets, slides, and files) built from scratch around one idea: **AI agents are teammates.** Agents appear in the member list, have presence and status, can be @mentioned in channels, and sit in voice rooms alongside people.

Underneath the suite is the **Org Brain**: a permission-aware index of everything the organization says, writes, schedules, and decides. Every conversation in a voice room is recorded and transcribed, and substantive ones are turned into notes, so nothing said in a meeting is lost. Every person gets a private **personal assistant** that knows everything *they* are allowed to see, tells them what needs their attention, and drafts what they need — but never acts on their behalf. A **central AI team** builds a curated set of **specialist agents** that answer questions and do work in channels.

The first customer is our own organization (250–1,000 people, a mix of desk and mobile workers) moving its work communication off WhatsApp. The product is built internal-first, with architecture choices that keep the door open to selling it to other organizations later.

**v1 ships:** a phone-friendly, installable web app containing chat, voice rooms and meetings (with universal recording, transcription, and notes), the personal assistant, calendar, tasks, docs and wiki, sheets and slides (D39), a Drive that holds them alongside uploaded files (D38), a first set of specialist agents, and an admin console.

**Two launches** (D41, D42): first a **core launch** of the whole suite without any AI, which moves the org off WhatsApp for work; then the **full v1 launch**, which adds transcription, meeting notes, the Org Brain, the personal assistant and specialist agents on top (§11).

## 2. Background and problem

### 2.1 Today

The organization runs day-to-day work on WhatsApp. That works for quick messages and voice notes, and everyone already knows how to use it, but:

- **Work and personal life are mixed** on personal phones and accounts; the org has no control over membership, offboarding, or data.
- **There is no structure.** Group chats sprawl; there are no channels, threads, or teams, and finding anything older than a few days is near impossible.
- **Meetings evaporate.** Calls happen on assorted tools; decisions and action items live in people's heads.
- **Knowledge is scattered** across chats, personal drives, and memory. New joiners cannot find out "how we do things" or "who owns what."
- **No AI can help**, because the context is fragmented across tools the org doesn't control.

### 2.2 The opportunity

Building the whole suite in one product means all context — messages, meetings, documents, tasks, calendars — lives in one place under one permission model. That makes an org-wide AI possible that is genuinely useful (it has the context) and genuinely safe (it knows exactly who may see what).

### 2.3 Inspirations

| Product | What it shows us |
|---|---|
| **RocketChat** / Slack | Team chat done properly: channels, threads, DMs, mentions, permissions. |
| **Discord** | Drop-in voice rooms you can see into and wander between; presence that makes a team feel alive. |
| **WhatsApp** | The usability bar: nothing to learn, phone-first, voice notes, read ticks. |
| **Google Docs, Sheets, and Slides** | Real-time co-editing, permissions, comments, and version history for documents, spreadsheets, and decks, all in one Drive. |
| **Excel** and **PowerPoint** | The formula behaviour, keyboard shortcuts, and file formats people already know; presenter view. |
| **OpenDots** (CopilotKit) | Persistent AI coworkers with roles, tools, memory, schedules, and human approval before actions. OpenDots is single-owner; Hearth's main new work is making this model multi-user and permission-safe. |

## 3. Goals and non-goals

### 3.1 Goals (v1)

| # | Goal |
|---|---|
| G1 | **Replace WhatsApp for all work communication** across the organization. |
| G2 | **Capture every meeting**: every voice session is recorded and transcribed, and substantive sessions (D27) are summarized with decisions and action items extracted. |
| G3 | **Give every person an assistant** that knows the org's context (within their access) and tells them what needs doing. |
| G4 | **One suite** for chat, meetings, calendar, tasks, docs, sheets, slides, and files, with no other tool required for everyday internal work. |
| G5 | **The AI never leaks**: it never shows anyone something they could not open themselves. |
| G6 | **Easy and delightful**: someone who has only used WhatsApp is productive on day one. |

### 3.2 Non-goals (v1)

| Non-goal | Why / when |
|---|---|
| External guests and shared channels | Internal only in v1 (D15). Post-v1. |
| Email | Not planned. Keep existing email. |
| Full Excel and PowerPoint parity (macros and scripts, pivot tables, external data connections, slide masters, animations and transitions, audio and video on slides) | Sheets and Slides are in v1 for everyday team work (D39), not as a replacement for every Office use. Office files can still be stored, previewed, and searched in Drive (FILE-04, FILE-06). Post-v1 items are the P2 rows and P2 parts of §8.7 and §8.8 (e.g. SHEET-12, SHEET-43, SHEET-49, SLIDE-36 – SLIDE-39); macros and scripts are not planned. |
| Native iOS/Android/desktop apps | Web only in v1 (D14), but phone-friendly and installable. Native apps are the first post-v1 item. |
| Integrations with third-party tools | The suite is self-contained (D13). Connectors are post-v1. |
| Agent computers (sandboxed browser/terminal per agent) | Post-v1; v1 agents use suite-native tools only. |
| Personal assistant acting on the user's behalf | By design, not just v1 (D16). |
| Importing WhatsApp history | Fresh start (D17). |
| Multi-org hosting, billing, self-serve sign-up | Post-v1, but the data model is org-scoped from day one (D1). |
| AI scoring of individual employees from what they say (sentiment, contribution quality), and voiceprint speaker recognition | Not planned (D34). Activity insights based on counts and durations are in scope (ADM-14). Speakers are identified from their own audio tracks. |

## 4. Users and personas

| Persona | Who | Primary jobs to be done |
|---|---|---|
| **Desk worker** | Ops, finance, design, engineering; laptop all day | Follow several channels without drowning; find past decisions; write docs, sheets, and decks together; run and attend meetings, and present in them. |
| **Mobile worker** | Field, retail, frontline; mostly on a phone | Get the messages that matter; send voice notes; join a room or meeting from the phone; see their tasks. |
| **Team lead** | Manages a team of 5–30 | Run meetings that produce decisions and owners; know what the team is blocked on; onboard new joiners. |
| **Central AI team member** | Small group that owns the AI (D6) | Build, test, publish, and monitor specialist agents; handle agent requests from teams. |
| **Org admin / IT** | Runs the deployment | Provision and offboard people; configure policy (recording, retention, AI); audit; respond to incidents. |
| **Compliance / HR officer** | Handles sensitive matters | Designate restricted rooms; access records under audit for investigations; manage legal holds. |
| **Leadership** | Execs and department heads | Know what's happening across the org without reading everything; see activity insights across people and teams (ADM-14); trust that sensitive content stays contained. |

## 5. Product principles

These resolve design arguments. When two requirements conflict, the higher principle wins.

1. **Never leak.** The AI mirrors each user's access. When it speaks in a shared space, it uses only what everyone in that space can see. Safety beats helpfulness every time.
2. **Warm and familiar.** If a WhatsApp user would hesitate, the design is wrong. One obvious way to do each thing; no setup required to get value.
3. **Agents are teammates.** Agents live where people live — the member list, channels, rooms — with names, faces, presence, and status. They are not hidden behind a separate "AI" tab.
4. **People decide.** The personal assistant suggests and drafts; people send. Specialist agents ask for approval before changing anything beyond posting where they are allowed to post.
5. **Show your sources.** Every AI answer, summary, and suggestion links to what it was based on.
6. **Capture transparently.** Recording is universal and *never hidden*: a visible indicator at all times, clear notice, and a visible record of who opened what.
7. **Phone-first web.** Every flow works one-handed on a phone browser before it is polished on a desktop.

## 6. Experience overview

### 6.1 Navigation

| Phone (bottom tabs) | Desktop (left rail) | What it is |
|---|---|---|
| **Today** | Today | Home. The assistant's catch-up and actionables, upcoming meetings, tasks due. |
| **Chats** | Chats | One WhatsApp-style list of all conversations — channels, DMs, groups, agents — sorted by recent activity with unread badges and filters (Unread, Channels, People, Agents). |
| **Rooms** | Rooms | Live voice rooms with avatars of who is inside right now; one tap to join. |
| **Tasks** | Tasks | My tasks, team tasks, suggested tasks from meetings and the assistant. |
| **More** | Calendar · Drive | Remaining modules. Drive holds docs and wiki spaces, sheets, slide decks, uploaded files, and folders in one place (D38). |

A single **Search & Ask** bar sits at the top everywhere: type to search, or ask a question in plain language.

Your avatar (phone: top bar; desktop: bottom of the rail) opens **Profile** (ACC-08), **Settings** (notifications NOTIF-03, devices ACC-04, assistant memory PA-10, privacy notice PDPA-02), and **Help** (short how-to guides, the DPO contact and question-and-complaint form from PDPA-13, and Report a problem to admins). Admins also get a link to the admin console (ADM-01).

### 6.2 Key journeys

**J1 — Morning catch-up (mobile worker).** Opens Hearth on the phone. *Today* shows: "Since yesterday: 3 things need you." A reply owed to a lead, an action item from yesterday's standup due today, and a schedule change in #north-site. Each has an *Open* button and, for the reply, a ready-made draft they can edit and send. Total time: under a minute.

**J2 — Drop-in room.** A designer sees two teammates in the *Design* room and taps in. The room shows a recording indicator; a short notice says "This room is recorded and transcribed." They share their screen, sort out a layout question in four minutes, and leave. Because it was short and had no decisions, nothing is posted — the transcript is stored and searchable.

**J3 — Scheduled meeting → notes → tasks.** A team lead schedules "Q4 launch review" from Calendar; it gets its own meeting room. Before the meeting, each attendee's assistant shows a prep brief (agenda, related threads, open action items from last time). The meeting is recorded and transcribed. Within five minutes of ending, notes with a summary, decisions, and action items are posted to the meeting's thread. Each owner sees their action items as suggested tasks in *Tasks* and accepts them with one tap.

**J4 — Asking the org.** A new joiner types "who owns the vendor onboarding process and what's the latest?" into Search & Ask. The assistant answers with the owner's name, a summary of last week's discussion, and the current wiki page — each claim linked to its source — using only content the new joiner can access.

**J5 — A specialist agent in a channel.** In #ask-hr, someone asks how many leave days carry over. The *HR Policy* agent (built by the central AI team) shows a small card: "HR Policy has an answer from the Leave Policy page · Show." The asker expands it, gets the answer with a link, and reacts 👍.

**J6 — Writing together.** Two leads co-write a proposal in Docs, see each other's cursors, leave comments, and restrict editing to the two of them while the rest of the team can comment. A week later, someone uses version history to see exactly what changed after the review meeting.

**J7 — Preparing and presenting a review.** The day before the Q4 launch review (J3), an ops lead opens the pallet forecast sheet in Drive and asks which weeks go over capacity. The answer names week 8 at 109% and highlights the cells it used. She drafts a deck from the launch proposal doc, keeps the slides she wants, adds a big-number slide for week 8, and writes speaker notes while a colleague fixes the risks slide. Each attendee's prep brief links to the deck and the sheet. In the meeting she presents the deck to the room from her laptop. Colleagues who joined from their phones see each slide sharp on their own screens, and the session keeps the slides that were shown alongside the transcript. Asking the sheet (SHEET-39) and drafting the deck from the doc (SLIDE-31) are P1, so at launch she may read the over-capacity weeks and build the deck herself; the rest of J7 uses P0 features.

## 7. AI architecture and trust model

This section is the heart of the product. Module requirements in §8 depend on it.

### 7.1 Four layers

| Layer | What it is | Whose access it uses | Examples |
|---|---|---|---|
| **0. Org Brain** | Index and knowledge graph of messages, transcripts, notes, docs, sheets, slide decks, tasks, events, files, and the people directory. Every item keeps its source permissions. | Always filtered by whoever is asking | "Project Atlas" linked to its channel, decisions, owner, docs, and budget sheet |
| **1. Built-in AI** | Features with no persona | The viewer's | Catch-up, meeting notes, voice-note transcripts, smart search, Ask about this sheet, slides drafted from a doc |
| **2. Personal assistant** | One per person, private, suggest-only (D16) | Exactly that person's | Today view, Ask, drafts, meeting prep |
| **3. Specialist agents** | Named agents built only by the central AI team (D6) | Agent's granted scope ∩ the asker's access ∩ the audience of the space it answers in | HR Policy, IT Helpdesk, Onboarding Buddy, Weekly Digest |

The personal assistant is the default way to ask anything. Once delegation ships (PA-11), it routes questions to specialist agents so users never need to know which agent to ask; until then, people reach agents by @mention or DM.

### 7.2 Access rules

These are product requirements, stated formally so they can be tested.

**Rule 1 — Mirror access.** For any AI response to user *U*, every source used must be one *U* could open directly at that moment. Everything *U* sees when they open an item counts as openable, including a sheet's hidden rows, columns, and tabs (hiding is formatting, not access control, SHEET-27), a deck's speaker notes (SLIDE-11), and comments, which everyone who can open the item sees (DOC-05). Earlier versions count only for people who can open them (SHEET-26, SLIDE-24, Q19).

**Rule 2 — Audience bound.** When an AI response is posted into a shared space *S* (channel, thread, room side panel), every source used must also be visible to **every current member of *S***.
Allowed sources = `AgentScope ∩ Access(asker) ∩ Access(every member of S)`.
For scheduled or event-triggered runs, which have no asker: `AgentScope ∩ Access(every member of S)`. The agent owner's or an admin's access is never used.
*Example:* the CFO asks the Finance agent about Q3 numbers in #general; the agent answers at #general's level. In a DM with the CFO, it can say more.

**Rule 3 — Derived content inherits restriction.** Anything the AI produces from sources (summaries, notes, entities, digests) records its provenance and is visible only to people who can see **all** of its sources. In practice, derived content is generated per scope (e.g. a channel summary is computed from that channel only and visible to its members). AI output that a person accepts into their own doc, sheet, or deck (DOC-09, DOC-10, SHEET-40, SLIDE-30) becomes their content and takes that item's permissions, as if they had typed it. Before it goes in, Hearth warns if the item is shared more widely than the sources it was drawn from, as CHAT-14 does for forwards. Slides shown in a session also become session content: they take the session's audience, not the deck's (SLIDE-19), and SLIDE-18 sets who may present a deck to an audience that can't open it.

**Rule 4 — DMs stay private.** Human-to-human DMs and group DMs are indexed only for their participants' personal assistants. Specialist agents never read them. A DM *with* an agent is visible to that agent.

**Rule 5 — Restricted rooms are not indexed.** Sessions in restricted rooms (D11, e.g. HR, performance 1:1s) are still recorded, transcribed, and summarized, but are visible only to participants; the only other access is privileged access (Rule 9). They are never added to the Org Brain. A participant's assistant can use one only when the participant explicitly opens it and asks about it. Anything derived from a restricted session (notes, action items, suggested tasks, decisions, entities) inherits the restriction: suggested tasks are visible only to their owner; an accepted task stays private and unindexed unless the owner shares it; meeting prep briefs (PA-06) never include restricted-session content automatically; and agents cannot be invited to restricted rooms. When a participant accepts AI output drawn from a restricted session (e.g. DOC-10, SLIDE-31), it goes into a new item shared only with them by default. Inserting it into an item shared beyond the session's participants needs an explicit confirmation that names the restricted source, and is logged (ADM-06).

**Rule 6 — Revocation is fast.** When someone loses access (leaves a channel, is removed from a doc, sheet, or deck, is offboarded), the AI stops using that content for them within **60 seconds**. Access is re-checked against live permissions at answer time, not only at index time.

**Rule 7 — Deletion propagates.** Deleted or edited content is removed or updated in the Org Brain within **5 minutes**, and derived content that depended on it is regenerated or withdrawn. Slide copies kept in a session record (SLIDE-19) belong to the session, not the deck: editing or deleting the deck doesn't change them. They follow the session's retention and can be removed only by redaction (REC-18) or by the DPO (SLIDE-19, REC-23).

**Rule 8 — Content is data, not instructions.** Text found in messages, docs, sheets (cell values, formulas, and comments), slide decks (including speaker notes), files, or transcripts never changes an agent's instructions or permissions. An agent may not take a write action solely because retrieved content told it to.

**Rule 9 — Privileged access is audited and never feeds AI.** The Compliance Officer (ADM-12) and the DPO (PDPA-13) may search and read content they could not otherwise open, including DMs and restricted sessions, only through their dedicated consoles, only against a logged case (an access, correction, or withdrawal request, an incident, or an investigation), and only with a stated reason. Every read is logged. This path bypasses the Org Brain and is never available to any AI feature.

### 7.3 Who can do what

| | Read | Post in channels | Create/change tasks, docs, sheets, decks, events | Send on a user's behalf |
|---|---|---|---|---|
| **Personal assistant** | Everything the user can see | ✗ (drafts into the user's composer) | ✗ (suggests; user accepts) | ✗ never |
| **Specialist agent** | Its scope, bounded by Rules 1–2 | ✓ where its participation level allows | Tasks and docs only with approval from the invoking person (or, for scheduled runs, the agent's named owner); no sheet or deck edits in v1 (SHEET-37, AGT-05) | ✗ never |
| **Built-in AI** | Viewer's access | Only meeting notes, where REC-13 allows | Suggested tasks, and suggested content in docs, sheets, and decks, which goes in only when the person accepts it (DOC-09, SHEET-40, SLIDE-30) | ✗ never |

### 7.4 Memory

| Level | Contents | Who can see and edit it |
|---|---|---|
| **Personal** | Preferences, ongoing projects, people the user works with, things the user told the assistant to remember | The user only. Fully viewable, editable, and deletable. |
| **Team** | Pinned facts, team handbook pages | Team members can read; team admins edit. |
| **Agent** | Notes a specialist agent keeps about its job | Central AI team. |
| **Org** | The Org Brain | Not edited directly; changes come from the underlying content. |

### 7.5 Models

- All model calls go through one internal **model layer** so providers can be swapped (D4). v1 uses cloud model APIs under business terms with **no training on our data** and **zero data retention wherever the provider grants it**; each provider's actual retention is recorded in the transfer register (PDPA-10) and stated in the notice.
- Different features may use different models (e.g. a cheaper model for summaries, a stronger one for Ask).
- **Speech-to-text is OpenAI** (D30), English only (D29):
  - **`gpt-transcribe`** produces the transcript of every session and transcribes voice messages.
  - **No live captions** (D31), so no real-time transcription model is used.
  - **Don't build on older OpenAI speech models.** `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` were deprecated on 2026-08-26 and are scheduled to shut down on 2027-02-26.
  - **Speaker attribution** comes from each participant's separate audio track, not from the model guessing who spoke. This assumes one person per device. Hearth drops near-duplicate passages picked up on two tracks at the same time (keeping the louder copy); a participant can mark their device as a shared room device, whose passages are labelled "<name> + others in room"; and screen-share audio isn't transcribed. Bystanders who aren't members (e.g. customers near a frontline worker) can still be picked up: rooms joined from a phone start muted, push-to-talk (ROOM-08) is recommended on the shop floor, and the DPO covers bystanders under Q3 and in the notice. No voiceprints are used.
  - **Timestamps** come from Hearth's own speech detection on each track, because the current OpenAI models return none. That gives timestamps per spoken passage, not per word.
  - **Only actual speech is sent to OpenAI**, never silence: session tracks are cut into spoken passages, and voice messages are trimmed of silence. This cuts session transcription cost by about three-quarters and stops the model inventing text on silent tracks.
  - Transcription details and setup conditions are in Appendix B.5.
- AI and transcription spend is tracked per feature and per agent, with org-level caps. Per-person AI cost figures are used only for cost control and are visible only to Owners and Admins; people insights are a separate feature (ADM-14, PDPA-18). Caps never stop session or voice-message transcription or meeting notes (ADM-05).

## 8. Functional requirements

### 8.1 Accounts, identity, and org structure

| ID | Requirement | Pri |
|---|---|---|
| ACC-01 | Sign in with **phone number + one-time SMS code** (D20). | P0 |
| ACC-02 | At first sign-in every user sets an **account-level PIN** (checked by the server; attempts rate-limited, ACC-06) and may add a **passkey** on that device as a quicker alternative. Signing in on a new device always needs the SMS code plus the PIN or a passkey available on that device (mitigates SIM-swap). Hearth doesn't ask for the PIN on every app open. | P0 |
| ACC-03 | **No self sign-up.** Only phone numbers an admin has added to the org roster can join. Admins add people individually or by CSV import; the CSV includes name, phone, department, team(s), manager, and role. | P0 |
| ACC-04 | Users can see and sign out their active devices; admins can remotely sign out any user's devices. | P0 |
| ACC-05 | **Offboarding:** deactivating a user signs them out everywhere within 60 seconds and revokes all access. Org content they created is kept under retention (PDPA-09); ownership of their docs, sheets, slide decks, files, folders, channels, and wiki pages transfers to their manager or team; their personal memory is deleted; their assistant conversations are kept only for their retention period. Former members make PDPA requests through the DPO's published contact (PDPA-13). | P0 |
| ACC-06 | PIN reset is admin-assisted with identity verification (the org's procedure, e.g. in person or by video against the roster; the check and the admin are recorded in the audit log); rate limits on OTP requests and PIN attempts. Admins can change a user's phone number after the same check: all devices are signed out and a new PIN is required, while the account, content, and memberships are kept. A lost or stolen phone is handled by remote sign-out (ACC-04), then a number change if the number is lost. | P0 |
| ACC-07 | **Org structure:** departments and teams (a person can be in several teams); each team can own channels, rooms, wiki spaces, and task lists. Each team has default channels and rooms chosen by its Team Admins; adding someone to a team adds them to those, and removing them removes them from the team's private ones. Admins set org-wide default channels (e.g. #announcements, #welcome) that every member joins. | P0 |
| ACC-08 | **Profiles:** name, photo, title, team(s), manager, working hours, time zone, custom status. | P0 |
| ACC-09 | **People directory** with org chart view. | P1 |
| ACC-10 | **Roles:** Owner, Admin, AI Admin (central AI team), Leadership (sees people insights, ADM-14), Data Protection Officer (PDPA-13), Compliance Officer, Team Admin, Member. One person may hold several roles. | P0 |
| ACC-11 | Every record in the data model belongs to an **organization** (tenant), even though v1 runs a single org (D1). | P0 |
| ACC-12 | First sign-in requires **acknowledging the current privacy and recording notice** (PDPA-02, PDPA-03). The "PDPA terms" of D28 are this notice plus the org's employee data protection policy. Any purpose the DPO records as consent-based is captured as a separate, specific consent item that can be withdrawn (PDPA-04). Stored with a timestamp and notice version. | P0 |
| ACC-13 | Email-based sign-in and single sign-on with external identity providers. | P2 |
| ACC-14 | **First-run flow.** On iOS Safari, Hearth first walks the user through adding it to the Home Screen and continues there (an installed web app may not share Safari's sign-in, and iOS push needs it). Then: SMS sign-in → set PIN (ACC-02) → acknowledge the notice (ACC-12) → enable notifications from a tap and receive a test push → confirm name and photo → land in Chats with default channels joined (ACC-07). Installing and enabling notifications can be skipped only after a warning that messages may be missed; Today shows a reminder until both are done. Once agents ship, the flow ends with a prompt to message Onboarding Buddy. | P0 |

### 8.2 Chat

| ID | Requirement | Pri |
|---|---|---|
| CHAT-01 | **Channels**: public (any org member can find and join) and private (invite only). Owned by a team or the org. Each channel has owners (the creator by default; transferable, ADM-03) who manage its membership and settings, including the AI participation level. | P0 |
| CHAT-02 | **DMs and group DMs** (up to 20 people). | P0 |
| CHAT-03 | **Threads** on any message, with "also send to channel." | P0 |
| CHAT-04 | **Unified chat list** (WhatsApp-style): all conversations in one list sorted by recent activity, with unread badges, pin-to-top, mute, and filters (Unread, Channels, People, Agents). | P0 |
| CHAT-05 | Messages support text with simple formatting, emoji, @mentions (people, agents, @channel/@here), links with previews, replies/quotes, edit, and delete. Delete removes the message for everyone (shown as "message deleted") and propagates per Rule 7; edits show "edited". If the message is under legal hold (ADM-08), the original and every earlier version are kept out of view, reachable only through privileged access (Rule 9), until the hold ends; otherwise earlier versions aren't kept. | P0 |
| CHAT-06 | **Attachments**: images, video, documents; inline previews; files are stored in the Drive (FILE-01; a minimal store until M5) and inherit the conversation's permissions. | P0 |
| CHAT-07 | **Voice messages**: hold-to-record, waveform, playback speed (1×/1.5×/2×), and an **automatic transcript** under the message that appears within seconds (D17). Maximum length 10 minutes. | P0 |
| CHAT-08 | **Reactions** and quick-reply suggestions. | P0 |
| CHAT-09 | **Read receipts**: WhatsApp-style ticks in DMs and group DMs; "seen by" list in channels up to 50 members. Admin can disable org-wide. | P1 |
| CHAT-10 | **Presence**: online, away, in a room (shows which), do not disturb; custom status with expiry. | P0 |
| CHAT-11 | **Pinned messages** and channel description/topic. | P0 |
| CHAT-12 | **Polls** in channels and groups. | P1 |
| CHAT-13 | **Scheduled messages** and **remind me about this**. | P1 |
| CHAT-14 | **Forward** a message to another conversation (with a warning if the destination audience is wider). | P1 |
| CHAT-15 | **Channel browser** to discover public channels by team and topic. | P0 |
| CHAT-16 | Each channel can have an attached **voice room** (see §8.3). | P0 |
| CHAT-17 | **Agents in chat**: agents appear in member lists with an "Agent" badge, can be @mentioned, and can be messaged directly. | P0 |
| CHAT-18 | Per-channel **AI participation level** (see AGT-08). | P0 |
| CHAT-19 | Message history is retained according to org retention policy (ADM-07). | P0 |

### 8.3 Voice rooms and meetings

#### Rooms

| ID | Requirement | Pri |
|---|---|---|
| ROOM-01 | **Persistent voice rooms**, Discord-style: always open, join and leave with one tap, no "start a call." A room can belong to a channel (CHAT-16) or stand alone; a standalone room has its own member list (public = whole org, or private). Only members of a channel can join its room (joining a public channel's room also joins the channel). A standalone room has owners (its creator by default; transferable) who manage its members and settings, as channel owners do (CHAT-01); who may create standalone rooms follows the public-channel creation setting (ADM-03). | P0 |
| ROOM-02 | **Room presence everywhere**: the Rooms tab and each channel show avatars of who is in a room right now; profiles show "in Design room." | P0 |
| ROOM-03 | In-room controls: mute, camera on/off, **screen share**, **present a deck** (SLIDE-16), speaker/output selection, raise hand, reactions, leave. | P0 |
| ROOM-04 | **Speaking indicators** and a participant grid that adapts to phone and desktop. | P0 |
| ROOM-05 | Rooms support **up to 50 participants** (P0) and **100** (P1). | P0 |
| ROOM-06 | **Room text panel**: the attached channel (or a room thread) shown alongside the call. | P0 |
| ROOM-07 | **DM and group-DM calls**: one tap to call from a conversation; these are sessions too. | P0 |
| ROOM-08 | **Push-to-talk** option and noise suppression. | P1 |
| ROOM-09 | Join from a phone browser. On Android Chrome, room audio keeps running with the screen locked or another app open, with a notification to mute or leave. Where the platform suspends audio (expected on iOS), others see the person as disconnected within 10 seconds and the person gets a push: "You left <room> — tap to rejoin." Behaviour per browser is measured on real devices in M2 (R11). Rooms joined from a phone start muted. | P0 |
| ROOM-10 | ~~Live captions~~ — **removed** (D31). If ever wanted, a running transcript could be shown at no extra transcription cost, because speech is already transcribed passage by passage during the session (REC-10); it would lag by roughly the length of each spoken passage. | — |
| ROOM-11 | **Agents in rooms**: agents can be invited to a room (never a restricted room, Rule 5); they show cards in the side panel (related docs, answers when addressed in the room text panel) and **never speak aloud in v1** (real-time speech is ROOM-12; D7 forbids unprompted speech even then). Agents don't receive a deck presented in the room live; they reach slides shown only through the session record, under Rule 2. | P1 |
| ROOM-12 | Agents and the assistant that **speak in real time** in rooms. | P2 |

#### Recording policy and notice

| ID | Requirement | Pri |
|---|---|---|
| REC-01 | A **session** begins when 2 or more humans are in a room or call. While fewer than 2 remain, recording and transcription pause; if a second person joins or reconnects within 2 minutes (configurable), the same session continues, otherwise it ends at the moment the count dropped below 2. The transcript, notes, and the 5-minute test (REC-11) cover the whole continued session, with the paused span shown as a gap. Agents do not count toward the threshold. | P0 |
| REC-02 | **Every session is recorded and transcribed** (D10). Audio always; video and screen share when on. A presented deck is recorded as slides, not video (SLIDE-19). Each participant's audio, and any camera or screen-share track, is recorded as its own file on a shared session clock (including mute and reconnect gaps). These per-track files, and the slide copies in SLIDE-19, are the only stored recording: playback (REC-16) mixes them on demand, so no stored mix keeps audio that was later redacted (REC-18) or withdrawn (PDPA-04a). Screen-share audio is not transcribed. | P0 |
| REC-03 | Recording behaviour is an **org-level policy setting** (default for our org: *all sessions, no exceptions*) so future customers can choose differently (D1, D26). | P0 |
| REC-04 | There is **no participant opt-out** under our org's policy (D11). The only carve-out is legal: if the DPO records a purpose as consent-based (PDPA-01) and a person withdraws, Hearth applies PDPA-04a to that person. | P0 |
| REC-05 | A **recording indicator is always visible** in every room and call UI. | P0 |
| REC-06 | Joining a room or call shows a **notice** ("This session is recorded and transcribed") and plays a distinct join tone. | P0 |
| REC-07 | Admins and Compliance Officers can designate **restricted rooms** (e.g. HR, performance 1:1s, legal). Restricted sessions are recorded and transcribed but follow access Rule 5 (participants only; not indexed). Restricted rooms show a distinct badge. | P0 |
| REC-08 | Calls that include anyone outside the org are out of scope for v1 (internal only, D15); external participant consent is a P2 requirement. | P2 |
| REC-09 | Not used: this ID was never assigned. | — |

#### Transcripts, notes, and action items

| ID | Requirement | Pri |
|---|---|---|
| REC-10 | **Speaker-attributed transcripts** for every session, available within 5 minutes of the session ending (typically under 1 minute, because speech is transcribed while the session is still running). Each spoken passage carries its start and end time. Word-by-word timestamps are not in v1. | P0 |
| REC-11 | **Meeting notes** are generated for sessions that are substantive: ≥5 minutes long, **or** containing a detected decision or action item (D27). Shorter sessions are transcribed and searchable but post nothing. | P0 |
| REC-12 | Notes include: a short summary, **decisions**, **action items** (owner, due date if stated), open questions, and links to transcript timestamps. Once SLIDE-20 ships, notes for sessions where a deck was presented also use the slides shown. | P0 |
| REC-13 | Notes are **posted only where the readers exactly match the session's audience** (REC-20): a channel's room → the session's thread in that channel; a standalone room → a session thread in the room's text panel; a scheduled meeting (including one held in a team room) → the meeting's own thread on its event page; a DM or group-DM call → the conversation if every member took part, otherwise a participants-only thread; a restricted room → never posted, only on the session page for participants. | P0 |
| REC-14 | Action items become **suggested tasks** for their owners, who accept, edit, or dismiss them (TASK-06). Items from restricted sessions stay private (Rule 5). | P0 |
| REC-15 | Participants can **correct notes and transcripts** (edits are versioned and attributed; the original machine output is kept, PDPA-07). Corrected names and terms can be proposed for the org vocabulary (REC-19) with one tap; proposals are cleaned on entry and take effect only after an admin approves them. Proposals from restricted sessions show the admin only the term and are flagged as coming from a restricted source. | P0 |
| REC-16 | **Playback** page: audio/video player synced with the transcript; click a line to jump; search within the transcript; slides presented in the session shown in step (SLIDE-19). | P0 |
| REC-17 | **Ask this meeting**: ask questions about a session from its page (answers cite timestamps). | P1 |
| REC-18 | **Transcript redaction**: Compliance Officers and the DPO can redact a passage (e.g. an accidentally spoken password). Redaction removes it from every transcript version, including the original machine output (an exception to PDPA-07), silences the same span in the stored audio/video, and propagates to notes and the Org Brain. They can also remove or blank a slide copy kept with the session (SLIDE-19). The redaction record keeps who, when, and why, but not the redacted content. | P1 |
| REC-19 | **Org vocabulary**: transcription is given the names and terms likely to come up: participants' names, the channel and meeting title, recent transcript lines, and an admin-maintained glossary (people, products, projects, places, acronyms). This is how Hearth gets names and internal jargon right. Each request sends a capped list (cap set in the spike, e.g. 100 or fewer): participants' names, terms from the channel or meeting title, and the highest-priority glossary terms tagged to that team or channel (admins can mark terms org-wide). For voice messages: the sender plus all members of a DM or group DM; in channels, the sender, people @mentioned in the thread, and the most recent active posters, up to the cap. | P0 |

#### Access and retention

| ID | Requirement | Pri |
|---|---|---|
| REC-20 | Default **audience of a session's recording, transcript, and notes**: room session → members of the room's channel, or of a standalone room (public = whole org; the DPO confirms this under Q3/Q8); scheduled meeting, including one held in a team room → invitees + participants; DM/group call → participants; restricted room → participants only (plus Rule 9 access). | P0 |
| REC-21 | **Access log**: every view of a recording, transcript, or notes is logged. Participants can see a **"viewed by"** list for sessions they were in. Views made under privileged access (Rule 9) appear in the list only if Q10 is answered yes; until then they are recorded only in the audit log. | P0 |
| REC-22 | **Retention** (D12): audio/video kept **120 days** by default (admin-adjustable, D36); transcripts and notes kept for a finite, admin-set period (proposed 3 years, PDPA-09); slide copies follow the transcript (SLIDE-19). Legal hold overrides deletion (ADM-08). | P0 |
| REC-23 | Participants cannot delete recordings, transcripts, notes, or slide copies (SLIDE-19). They are deleted only by the retention engine (PDPA-09), by the DPO acting on a request (PDPA-04, PDPA-05), or by redaction (REC-18); every deletion is logged. | P0 |

### 8.4 Calendar

| ID | Requirement | Pri |
|---|---|---|
| CAL-01 | Personal calendar with day, week, and agenda views; phone-friendly agenda as default on mobile. | P0 |
| CAL-02 | **Create events** with title, time, attendees, description/agenda, recurrence, and reminders. | P0 |
| CAL-03 | Every meeting event gets **its own meeting room** by default (private to invitees), or can be placed in an existing team room. Join button appears 5 minutes before start. When a meeting is placed in a team room, the session live in that room during the meeting window (from the join button to the scheduled end) is the meeting's session until it ends; a team room can be chosen only if every invitee can join it. Each occurrence of a recurring meeting has its own event page and thread. | P0 |
| CAL-04 | **Availability**: see attendees' free/busy and working hours; "find a time" suggestions. | P0 |
| CAL-05 | **RSVP** (yes/no/maybe) with optional note. | P0 |
| CAL-06 | **Time zones** handled per user. | P0 |
| CAL-07 | **Team calendars** (shared events like leave, launches, holidays). | P1 |
| CAL-08 | Meeting page links to agenda, prep brief (PA-06), recording, transcript, and notes after the session. | P0 |
| CAL-09 | Out-of-office events update presence and auto-respond in DMs. | P1 |
| CAL-10 | Export (ICS) and sync with external calendars. | P2 |

### 8.5 Tasks

| ID | Requirement | Pri |
|---|---|---|
| TASK-01 | **Tasks** with title, description, assignee(s), due date, status (To do / In progress / Done), priority, and comments. | P0 |
| TASK-02 | **My Tasks** view across all sources; **team task lists** owned by a team. | P0 |
| TASK-03 | List and board views. | P0 (list) / P1 (board) |
| TASK-04 | **Create a task from a message** (any chat message → task, linked back). | P0 |
| TASK-05 | Task notifications: assigned, due soon, overdue, comment. | P0 |
| TASK-06 | **Suggested tasks** inbox: action items from meetings (REC-14) and suggestions from the assistant (PA-04) appear as suggestions the user accepts, edits, or dismisses. Nothing becomes a real task without a person accepting it. | P0 |
| TASK-07 | Subtasks and checklists. | P1 |
| TASK-08 | Recurring tasks. | P1 |
| TASK-09 | Projects (grouping tasks across teams with milestones). | P2 |

### 8.6 Docs and wiki

Docs, sheets, and slide decks are all items in the Drive (D38, FILE-01). They share real-time co-editing (DOC-02), permissions (DOC-03), version history (DOC-04), comments (DOC-05), and sharing (FILE-03), with the differences set in §8.7 and §8.8 (e.g. version history only for people who can edit, SHEET-26 and SLIDE-24; deck comments P1, SLIDE-23). Sheets (§8.7) and Slides (§8.8) are in v1 (D39) and build on the requirements below.

| ID | Requirement | Pri |
|---|---|---|
| DOC-01 | **Rich-text documents**: headings, lists, checklists, tables, images, code blocks, links, @mentions, embeds of tasks and files. | P0 |
| DOC-02 | **Real-time co-editing** with live cursors and presence, and offline-tolerant sync. | P0 |
| DOC-03 | **Permissions per document**: Viewer, Commenter, Editor, Owner — granted to people, teams, or the whole org. **Restricted editing**: owners can limit editing to specific people while others view or comment (D19). | P0 |
| DOC-04 | **Version history**: see every change with author and time, compare any two versions, and restore an earlier version (D19). | P0 |
| DOC-05 | **Comments** anchored to text, with @mentions, replies, and resolve. Everyone who can open the item sees its comments, Viewers included; Commenters, Editors, and the Owner add, reply to, and resolve them. | P0 |
| DOC-06 | **Suggestion mode** (tracked changes that the owner accepts or rejects). | P1 |
| DOC-07 | **Wiki spaces** per team and an org-wide space, with nested pages, a sidebar tree, and space-level permissions. | P0 |
| DOC-08 | **Templates**: meeting notes, project brief, policy page, onboarding guide. | P1 |
| DOC-09 | **Inline AI writing**: draft, rewrite, or summarize a selection (translation is post-v1, AMB-05); the user accepts each suggestion before it enters the document (D16), and version history marks it "suggested by AI", with its sources (BRAIN-08). | P1 |
| DOC-10 | **Save to doc** from meeting notes and from assistant answers. Content from a restricted session follows Rule 5. | P1 |
| DOC-11 | Export to PDF, DOCX, and Markdown. | P1 |
| DOC-12 | ~~Spreadsheets~~: moved into v1 as Sheets (D39): §8.7, SHEET-01 – SHEET-49. | — |
| DOC-13 | ~~Slides~~: moved into v1 as Slides (D39): §8.8, SLIDE-01 – SLIDE-40. | — |

### 8.7 Sheets

The founder moved Sheets into v1 on 11 Oct 2026 (D39, answering Q15). This section replaces DOC-12. A sheet is a Drive item (D38) and reuses the Docs foundations: sharing roles (DOC-03), co-editing (DOC-02), version history (DOC-04) and comments (DOC-05). The v1 bar is the org's everyday spreadsheet work (rosters, budgets, trackers, forecasts, quote comparisons) with results that match Excel. It is not a full copy of Excel or Google Sheets.

#### Grid and editing

| ID | Requirement | Pri |
|---|---|---|
| SHEET-01 | **Sheets live in the Drive** (D38). Anyone can create a sheet from the Drive's New menu, from a template (SHEET-48), or by converting an uploaded XLSX or CSV file (SHEET-30). Sheets use the Drive's folders, Recent, Starred, Trash, move, rename and Make a copy (FILE-01, FILE-02). A new sheet opens with one blank tab and the title selected. | P0 |
| SHEET-02 | **Grid.** Column letters and row numbers stay in view while scrolling. People select a cell, a range, or whole rows and columns by click, Shift-click, drag or header click; a status bar shows the selection's sum, average and count. People who can edit insert and delete rows and columns (formulas that refer to them update), resize them by dragging or with Resize in the header menu, fit a column to its contents by double-clicking its edge, and hide and unhide them. Only the visible part of the grid is drawn, so large tabs scroll smoothly (SHEET-34). | P0 |
| SHEET-03 | **Keyboard** as in Excel: arrows move and Shift+arrows extend; Ctrl/⌘+arrows jump to the edge of the data; Enter and Tab move on after an entry (Shift goes back); typing replaces a cell, F2 or double-click edits it, Escape cancels and Delete clears. The usual Ctrl/⌘ shortcuts work for copy, cut, paste, undo, redo, bold, italic, underline, select all, fill down (D), fill right (R), find (F), replace (H) and today's date (;). Ctrl/⌘+/ lists every shortcut. Escape, then Tab, moves focus out of the grid, so it never traps focus (SHEET-47). | P0 |
| SHEET-04 | **Entering data.** The formula bar shows the active cell's address and what was typed (the formula, not its result), and can edit it. A name box jumps to any address or range. Hearth reads a typed entry as a number, an S$ amount, a percentage, a date or time in Singapore format (SHEET-15), TRUE or FALSE, or text; a leading apostrophe keeps it as text. Alt+Enter adds a line break. A typed web address becomes a link, and Insert link (Ctrl/⌘+K) adds one to a cell; only `https`, `http` and `mailto` links are allowed. A cell holds up to 32,767 characters, Excel's limit (SHEET-33). | P0 |
| SHEET-05 | **Copy, paste and fill.** Copying within or between Hearth sheets keeps formulas (relative references shift), formatting and validation. Pasting from Excel and Google Sheets brings in values and basic formatting. The fill handle (desktop) and Fill down and Fill right (phone, and Ctrl/⌘+D and R) copy a cell or continue a series: 1, 2, 3; Mon, Tue; dates; "Week 1, Week 2". Pasting tables from web pages and Docs, and Paste special (values only or formatting only), are P1. | P0 · P1 (other paste sources, Paste special) |
| SHEET-06 | **Undo and redo** reverse only your own changes, even while others are editing (SHEET-25), for at least your last 100 changes in the session. | P0 |

#### Formulas

| ID | Requirement | Pri |
|---|---|---|
| SHEET-07 | **Formulas.** A cell that starts with `=` holds a formula: operators `+ - * / ^ & %`, comparisons `= <> < > <= >=`, parentheses, references `A1`, `$A$1` and `$A1`, ranges `A1:C9`, `A:A` and `2:2`, and references to other tabs in the same sheet (`'Cold room'!B2:B9`), which stay correct when a tab is renamed or moved and become `#REF!` when it is deleted. Function names autocomplete with argument hints, referenced ranges are outlined in colour, and clicking cells inserts their reference. A Σ button inserts SUM, AVERAGE, MIN, MAX or COUNT for the selection or the numbers above. Recalculation is automatic and meets SHEET-34. | P0 |
| SHEET-08 | **v1 function set** (109 functions). **Maths:** SUM, SUMIF, SUMIFS, SUMPRODUCT, PRODUCT, SUBTOTAL, ROUND, ROUNDUP, ROUNDDOWN, MROUND, CEILING, FLOOR, INT, TRUNC, ABS, MOD, POWER, SQRT. **Statistics:** AVERAGE, AVERAGEIF, AVERAGEIFS, MEDIAN, MIN, MINIFS, MAX, MAXIFS, COUNT, COUNTA, COUNTBLANK, COUNTIF, COUNTIFS, LARGE, SMALL, RANK, STDEV, VAR. **Logical:** IF, IFS, IFERROR, IFNA, AND, OR, NOT, XOR, SWITCH, TRUE, FALSE. **Lookup:** VLOOKUP, HLOOKUP, XLOOKUP, LOOKUP, INDEX, MATCH, XMATCH, CHOOSE, ROW, ROWS, COLUMN, COLUMNS, HYPERLINK. **Text:** CONCAT, CONCATENATE, TEXTJOIN, LEFT, RIGHT, MID, LEN, LOWER, UPPER, PROPER, TRIM, CLEAN, SUBSTITUTE, REPLACE, FIND, SEARCH, TEXT, VALUE, EXACT, REPT. **Date and time:** TODAY, NOW, DATE, TIME, YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, WEEKDAY, WEEKNUM, ISOWEEKNUM, EDATE, EOMONTH, DAYS, DATEDIF, NETWORKDAYS, WORKDAY, DATEVALUE. **Information:** ISBLANK, ISNUMBER, ISTEXT, ISLOGICAL, ISERROR, ISNA, ISEVEN, ISODD, NA. Each function follows Excel's definition (arguments, defaults, and how blanks and text count), checked by a test suite against the values Excel saved in real workbooks. Excel's newer names also work (e.g. STDEV.S). XLOOKUP and XMATCH return one value (no spilled results, SHEET-12). RAND and RANDBETWEEN aren't in v1, because each collaborator would get different numbers (SHEET-25, SHEET-12). Formula help gives each function's arguments and an example. | P0 |
| SHEET-09 | **Further functions.** Financial: PMT, PV, FV, NPV, IRR, RATE. Statistics: MODE, PERCENTILE, QUARTILE, STDEVP, VARP, CORREL. Maths: EXP, LN, LOG, LOG10, PI, SIGN. OFFSET and INDIRECT, within the same sheet only. | P1 |
| SHEET-10 | **Errors.** A failing formula shows `#DIV/0!`, `#REF!` (deleted cell or tab), `#NAME?` (unknown function or name), `#VALUE!` (wrong kind of value), `#N/A` (lookup found nothing), `#NUM!` (number out of range), `#ERROR!` (formula can't be read) or `#CYCLE!` (circular reference; no iterative calculation in v1). Errors pass to dependent cells; IFERROR and IFNA catch them. Selecting an error cell explains it in one plain sentence and links to the cell where it started. A formula that can't be read is saved as typed, so no work is lost. | P0 |
| SHEET-11 | **Named ranges.** Name a cell or range (e.g. `OT_rate`) and use the name in formulas. Names follow their cells when rows and columns move. A panel lists every name and its range. | P1 |
| SHEET-12 | **Formula features after v1:** dynamic arrays and spilled results (FILTER, SORT, UNIQUE, SEQUENCE, TEXTSPLIT); LET and LAMBDA; legacy array formulas; regular-expression functions; RAND and RANDBETWEEN, with a seed kept in the sheet so every collaborator and the server get the same numbers; an org-maintained list of Singapore public holidays for WORKDAY and NETWORKDAYS; and references to other sheets. When they come, a referenced sheet counts as a source under Rules 1 and 3, so AI never uses its values for someone who can't open it. **Not planned:** functions that fetch outside data (D13); AI functions inside formulas, because a cell's value must never depend on a model call; macros and scripts. | P2 |

#### Formatting and structure

| ID | Requirement | Pri |
|---|---|---|
| SHEET-13 | **Cell formatting:** bold, italic, underline, strikethrough, text colour, fill colour, borders, horizontal and vertical alignment, wrap or clip, font sizes 8, 9, 10, 11, 12, 14, 18, 24 and 36 pt, merge and unmerge, and clear formatting. Paint format copies formatting from one range to another. Hearth's colour palette has light and dark variants; colours from converted files show as set. | P0 |
| SHEET-14 | **Number formats:** Automatic, Number (choice of decimals and thousands separator), Whole number, Currency, Percent, Date, Time, Date and time, Duration (`[h]:mm`, for hours worked) and Plain text, with buttons to add or remove decimals. Currency is S$ by default (`S$1,234.50`; negatives as `-S$1,234.50` or `(S$1,234.50)`), and typing `$` or `S$` before a number applies it. Custom formats in Excel's format-code syntax display correctly, so converted files keep their look. A picker for other currencies (US$, RM, RMB, €, £) and a screen for writing custom formats are P1. | P0 |
| SHEET-15 | **Singapore dates and times.** Dates are entered and shown day first: `11/10/2026` is 11 October 2026, never 10 November. Hearth also understands `11 Oct 2026`, `11 Oct` and `2026-10-11`. Dates show as `11/10/2026` by default, or in long form as `Sun 11 Oct 2026`; times show as `2:30 pm` or `14:30`. Each sheet has a time zone, the org's by default (Singapore, UTC+8), which TODAY and NOW use. Both take the time from Hearth's server, and NOW is rounded down to the minute, so every collaborator and the server compute the same value (SHEET-25). Dates are stored as Excel serial numbers, so they survive import and export unchanged. | P0 |
| SHEET-16 | **Tabs.** Add, rename, duplicate, reorder (by dragging, or with Move left and Move right), colour, hide and unhide, and delete tabs (with a confirmation, and undo). Tab names are unique within a sheet. Up to 100 tabs per sheet (SHEET-33). Hiding a tab is a layout choice, not access control (SHEET-27). | P0 |
| SHEET-17 | **Freeze** any number of top rows and left columns, so headers stay in view on desktop and phone. | P0 |

#### Working with data

| ID | Requirement | Pri |
|---|---|---|
| SHEET-18 | **Sort** a range or a whole tab by one or more columns, A to Z or Z to A, with a "has a header row" option that Hearth pre-sets and the person can change. Sorting the sheet itself is an edit, so only people who can edit can sort it (SHEET-27); anyone can sort their own filtered view (SHEET-19). It moves whole rows with their formatting, validation and comments. | P0 |
| SHEET-19 | **Filters are personal.** Anyone who can open a sheet, Viewers included, can filter a table to the rows that match values or conditions in each column (equals, contains, greater than, between, empty), and sort their own view of the filtered rows; this personal sort, like the filter, isn't saved to the sheet or seen by others. A filter hides rows only for the person who set it, so it never changes what collaborators see or any formula's result. SUBTOTAL ignores personal filters; as in Excel, function numbers 101–111 skip rows hidden with SHEET-02 and 1–11 don't. The status bar counts only the rows you can see. A filter stays on the device where it was set, and Ask (SHEET-39) is told which rows it hides. Saved, named filter views that others can open, and that follow a person across devices, are P1. | P0 |
| SHEET-20 | **Find and replace.** Find text, numbers or dates in values or formulas, in one tab or all tabs, with match case and match whole cell, and step through the matches. Everyone who can open the sheet can find. People who can edit can replace one match or all, as one change that one undo reverses. | P0 |
| SHEET-21 | **Data validation.** People who can edit can turn a range into a dropdown (items typed in or taken from a range, each with an optional colour) or into checkboxes, and set rules for numbers, dates, text length or a custom formula. Each rule either warns or rejects an entry, and can show a help message when the cell is selected. On a phone, a dropdown opens the phone's own picker. | P1 |
| SHEET-22 | **Conditional formatting.** Rules change a cell's fill or text colour when its value is greater than, less than, between or equal to a value, contains some text, is empty or not, is a date before or after a date, or makes a custom formula true (e.g. amber for any week whose pallets go over capacity). Rules apply to a range and are listed in order in a side panel, where they can be edited and reordered. Colour scales and data bars are P2. | P1 |
| SHEET-23 | **Charts:** column, bar, line and pie. Insert one from a selected range with a suggested type, and set the title, legend, axis titles and series colours. Charts update as cells change, can be moved and resized on the tab, and show on phones (view only, SHEET-35). Each chart has a text alternative for screen readers: its title and a table of the data it plots (SHEET-47). A chart can be copied into a doc or deck as a picture that links back to the sheet; Hearth warns before inserting it if some people who can open the target can't open the sheet (as CHAT-14). Live embeds are P2 (SHEET-49). | P1 |

#### Collaboration and permissions

| ID | Requirement | Pri |
|---|---|---|
| SHEET-24 | **Comments on cells** (DOC-05): anchored to a cell or range, with @mentions (which notify, NOTIF-02), replies and resolve, plus a panel of open and resolved threads. Everyone who can open the sheet sees its comments, Viewers included; Commenters, Editors and the Owner add them (DOC-05). Commented cells show a small marker. A comment stays with its cell when rows and columns are inserted, deleted or sorted. If the cell is deleted, the thread stays in the panel, marked "cell deleted". | P0 |
| SHEET-25 | **Real-time co-editing** (DOC-02). Everyone sees who else has the sheet open (avatars in the header), their selected cells outlined with a name tag, and their edits within 500 ms (p95). Rows and columns keep stable identities, so an edit made while someone else inserts, deletes or sorts lands in the right cell. If two people change one cell at once, the later change wins and both appear in version history. Every person and the server compute the same values, including TODAY and NOW (SHEET-15); v1 has no random functions (SHEET-08). Offline edits sync on reconnect (NFR-04). The sync server rejects changes from Viewers and Commenters (B.2) and to protected ranges (SHEET-28). Up to 50 people can edit one sheet at once (P0), and 100 (P1). | P0 |
| SHEET-26 | **Version history** (DOC-04). People who can edit see who changed what and when, open any version with changed cells highlighted, and restore one as a new version, so nothing is lost. Viewers and Commenters see only the current version, because history can hold values that were removed on purpose (proposed, Q19). Comparing two versions, naming a version (e.g. "Sent to finance"), a single cell's edit history, restoring one tab, and copying a range out of an old version are P1. | P0 (browse, restore) · P1 (compare, names, and the rest) |
| SHEET-27 | **Permissions** follow DOC-03 (Viewer, Commenter, Editor, Owner; for people, teams or the whole org; restricted editing) and the Drive's sharing (FILE-03). Viewers can copy, find, filter, read comments, Ask (SHEET-39) and export, and can request edit access. Commenters can also comment. Editors change cells, tabs and structure. **Access is per sheet:** everyone who can open a sheet can see every cell in it, including hidden rows, columns and tabs (Rule 1). Hiding and protection (SHEET-28) are not access controls; to keep data from someone, put it in a sheet they can't open. The first time someone hides a row, column or tab, Hearth tells them that everyone who can open the sheet can still see it. | P0 |
| SHEET-28 | **Protected tabs and ranges.** People who can edit can protect a tab or range so that only named people and the sheet's Owners can edit it, e.g. rates and formulas locked while shift leads fill in hours. Others see a lock and "Protected by Marcus". Protection limits editing only (SHEET-27). | P1 |
| SHEET-29 | **Links to tabs, cells and ranges.** Anyone can copy a link to a tab, cell or range; opening it selects them. AI citations and search results use the same links. In chat, a sheet link shows its title and a preview only to people who can open the sheet; everyone else sees "Sheet · no access" (CHAT-05). | P0 |

#### Import, export, and limits

| ID | Requirement | Pri |
|---|---|---|
| SHEET-30 | **Import.** An uploaded .xlsx, .csv or .tsv file stays a Drive file with a preview (FILE-04) and an "Open as a Hearth sheet" action, which creates a converted sheet beside it and keeps the original. CSV and TSV can also be imported into the current tab at the selected cell. Hearth detects a CSV's delimiter, encoding and header row, and reads dates day first (SHEET-15). Imported CSV and TSV fields are always values, never formulas, even when they begin with `=`. Conversion runs in the background with progress and ends with an import report (SHEET-31). Files over the limits (SHEET-33) or protected by a password stay as files, and Hearth says why. Legacy .xls and .ods files are P2. | P0 |
| SHEET-31 | **What conversion keeps and drops.** The import report lists every change, with cell addresses. **Kept:** values; formulas that use the function set (SHEET-08, and SHEET-09 once shipped); dates and times; number formats, including custom ones; text formatting, fills, borders and merged cells; column widths and row heights; frozen rows and columns; tab names, order, colours and hidden tabs; hidden rows and columns; comments and notes, as cell comments marked "Imported" with the author's name from the file; cell hyperlinks and HYPERLINK formulas, as links (SHEET-04). Excel tables become ordinary ranges that keep their formatting, and structured references (e.g. `Table1[Amount]`) are rewritten as ordinary range references. Validation, conditional formatting and named ranges are kept once SHEET-21, SHEET-22 and SHEET-11 ship; until then they are listed as dropped. **Kept as fixed values:** formulas Hearth can't compute (functions outside the set, array formulas, names before SHEET-11, links to other workbooks) keep the last value saved in the file; the cell shows a marker and the original formula until someone edits it. **Dropped:** macros (never run), charts (chart import is P2), images and shapes, pivot tables (their current values stay as plain cells), slicers, sparklines, form controls, external data connections, sheet and workbook passwords, and AutoFilter criteria (the rows they hid show again; SUBTOTAL results that depended on them are listed, since Hearth's filters are personal, SHEET-19). | P0 |
| SHEET-32 | **Export.** Download a whole sheet as XLSX, or the current tab as CSV (UTF-8 with a byte-order mark, so Excel opens it correctly) or PDF (orientation, fit to page width, repeated header rows, gridlines on or off). XLSX keeps everything SHEET-31 keeps; cells kept as fixed values (SHEET-31) are written with their original formula and the saved value, so Excel recalculates them; cells showing `#CYCLE!` or `#ERROR!`, which Excel doesn't have, are written as the formula with no saved value. Lost in export: comment replies and resolved state (comments become Excel notes, with replies as text), version history, and charts (chart export is P2). CSV holds values as displayed or, with the Plain values option, ISO dates (`2026-10-11`) and unformatted numbers; data export (ADM-09) uses plain values. Text cells that begin with `=`, `+`, `-`, `@`, a tab or a carriage return are written with a leading apostrophe, so spreadsheet apps don't run them as formulas (CSV injection). Every export and download is recorded in the audit log (ADM-06). | P0 (XLSX, CSV) · P1 (PDF) |
| SHEET-33 | **Size limits.** Per sheet: up to 100 tabs and 250,000 non-empty cells (P0), raised to 1,000,000 (P1). Per tab: up to 100,000 rows and 200 columns (A to GR). Per cell: 32,767 characters, as in Excel, so every cell survives XLSX export. Hearth warns at 80% of a limit and blocks a change that would pass it, saying what to do (split the sheet, or keep the data as an uploaded file). The limits are confirmed in the B.7 spike (Q16). | P0 |
| SHEET-34 | **Performance** (desktop on broadband, and the reference phones on the 4G profile in §9.2; p75 unless stated; checked in the B.7 spike and the M6 scale tests). A 50,000-cell sheet opens ready to edit in under 2 s on desktop and 4 s on the phones; a sheet at the cell limit, in under 5 s on desktop. After an edit, recalculated results show (p95): for a reference workbook of 100,000 cells (values, row and column totals, IF, and a few hundred lookups), in under 250 ms on desktop and 750 ms on the phones; for a lookup-heavy workbook (5,000 rows, each with one XLOOKUP and one SUMIFS over a whole column), in under 1 s on desktop and 3 s on the phones. Calculation runs off the main thread, so it never blocks typing or scrolling. While it runs, the grid keeps the last values and marks the cells still waiting with "Calculating…". Scrolling has no frame over 50 ms while flinging through 100,000 rows. Sorting or filtering 50,000 rows takes under 1 s on desktop and 3 s on the phones; converting a 5 MB XLSX file, under 30 s. On phones, sheets over 100,000 cells open in view mode, with a note that they can be edited on a computer. | P0 |

#### Phone

| ID | Requirement | Pri |
|---|---|---|
| SHEET-35 | **Phone** (Principle 7, NFR-02). The grid scrolls both ways inside its own area, with headers and frozen rows held in place and no sideways scroll of the page. Rows are at least 36 px tall. Tap selects a cell; tapping again, or tapping the formula bar, edits it; handles extend a selection. A row of formula keys (`=` `(` `)` `:` `$` `,` Σ) sits above the keyboard. Tabs switch from a bottom bar; Ask, comments and filters open as bottom sheets. On a phone, people can view, select, enter and edit values and formulas, switch tabs, comment and filter. Formatting, inserting and deleting rows, columns and tabs, sorting, and find and replace on a phone are P1. Charts, conditional formatting, validation and protection are set up on a computer; their effects still show on a phone. | P0 · P1 (formatting, structure, sort, replace) |
| SHEET-36 | **Row as a card.** On a phone, any row opens as a card that lists each header with its value, to read or edit one record without scrolling sideways (e.g. a shift lead entering hours). | P1 |

#### AI

| ID | Requirement | Pri |
|---|---|---|
| SHEET-37 | **Access rules for AI on sheets.** The unit of access is the sheet. Any AI feature uses a sheet only for people who can open it (Rule 1), re-checked for each answer (Rule 6), through the shared retrieval layer (B.4). Hidden rows, columns, tabs and comments are part of the sheet (SHEET-24, SHEET-27), and citations mark hidden cells. Version history is used only for people who can open it (SHEET-26). A sheet can't refer to other files in v1 (SHEET-12), so no computed value carries data from a file the asker can't open. Cell text is data, not instructions (Rule 8). No AI changes a cell: a suggestion goes in only when a person who can edit accepts it (D16), and history records it as their change, marked "suggested by AI". Agents read sheets only within their scope (AGT-04) and can't edit them in v1. Sharing an answer into a channel follows PA-12. Sheets AI is optional AI under the spend caps and the kill switch (ADM-05, ADM-10). | P0 |
| SHEET-38 | **Figures come from cells, not from the model's arithmetic.** When any AI feature (Ask SRCH-03, the assistant, agents, or SHEET-39) states a figure from a sheet, the figure is either a value shown in a cell it cites or the result of a calculation that Hearth's formula engine ran over cells it cites. Until engine calculations ship with SHEET-39, AI features quote and cite cell values but don't calculate with them. Hearth enforces this after generation: every number an answer attributes to a sheet or an uploaded spreadsheet (FILE-06) is checked against the displayed value of the cell it cites, or the engine result it cites. A number that doesn't match is removed, and the answer says so. The access-rule test suite and the evaluation sets check this. It ships in M5, when uploaded spreadsheets are first indexed (§11). | P0 |
| SHEET-39 | **Ask about this sheet** (suggest-only, D16). Anyone who can open the sheet asks in plain English, e.g. "What is the total OT pay and is it within budget?", and gets suggested questions based on the headers. The AI runs every calculation through the formula engine (SHEET-38). Each figure links to its cells (e.g. `Roster!F2:F9`; tapping selects them), and "Show working" displays the formula used, e.g. `=SUMIFS(F2:F9, C2:C9, "Cold room")`, which a person who can edit can insert into a cell. A figure that can't be traced to cells is left out, and the answer says what's missing. Answers cover the whole sheet and say when the asker's filter hides rows. Ask uses only the open sheet; other sources need Ask (SRCH-03). The model gets the headers, the cells a question needs and a few sample rows, never a whole large sheet. Answers follow AMB-06. The conversation is private to the asker and kept per PDPA-15. | P1 |
| SHEET-40 | **Suggest a formula.** A person who can edit describes what they want in the formula bar or the Ask panel ("total OT pay for the cold room") and gets a formula, a preview of its result, and the cells it uses. It goes in only when they accept it. | P1 |
| SHEET-41 | **Explain a formula.** Any formula cell can be explained in plain English, step by step, with the current value of each reference. The explanation flags likely mistakes: a range that stops short of the data, a reference that needed a `$` before the formula was copied, or numbers stored as text. Viewers can use it. | P1 |
| SHEET-42 | **What changed.** Opening a sheet that changed since you last looked shows who changed which tabs and ranges (from version history), with a link to each. It can include an AI summary in plain English (AMB-01). People who can edit see old and new values; Viewers and Commenters see where things changed and the current values only, because they can't open old versions (SHEET-26). | P1 |
| SHEET-43 | **AI fill and tidy-up.** Suggest values for a new column from the other columns (e.g. a category for each expense line), tidy inconsistent entries (e.g. "Cold Rm" to "Cold room"), or split a column. Results appear as a preview column that the person accepts or discards. | P2 |

#### Search, data protection, accessibility, and templates

| ID | Requirement | Pri |
|---|---|---|
| SHEET-44 | **Search and Org Brain** (FILE-06, BRAIN-01). A sheet's title, tab names, headers, typed text, computed values as displayed (e.g. `S$1,620.00`, `11/10/2026`) and comments are indexed under the sheet's permissions (BRAIN-02), since everyone who can open a sheet sees its comments (SHEET-24). Each row is indexed as header and value pairs ("Roster, row 7: Name Ahmad · Shift Cold room · Hours 6 · OT pay S$162.00"), so results and citations open the sheet at that row. Formulas aren't indexed as text; their results are. Computed values come from the server's own calculation, never from a browser (B.7). Only the current version is indexed, so a cleared value leaves the index within 5 minutes (Rule 7). Values that depend on TODAY or NOW are re-indexed daily with the time they were computed. Unconverted XLSX and CSV uploads are indexed the same way, from the values saved in the file. | P0 |
| SHEET-45 | **Data protection.** Sheets follow the rules for docs and files: retention (PDPA-09: 3 years after last edit unless the owner renews), legal hold (ADM-08), ownership transfer at offboarding (ACC-05), access-request search over cell values and comments (PDPA-05), corrections (PDPA-07), data export (ADM-09), and deletion that cascades to version history, indexes and caches (PDPA-09). Redacting a value from a sheet and all its versions, by the DPO or a Compliance Officer, is P1 (as REC-18). | P0 |
| SHEET-46 | **Sensitive data warning** (PDPA-17). When a column holds what look like NRIC or FIN numbers (checked by format and check letter), or has a header such as "NRIC", "Salary" or "Bank account", Hearth warns the person sharing before the sheet is shared with a team or the whole org, and suggests moving those columns to a sheet with narrower access. This is P0 for sheets, because SHEET-44 makes every shared row searchable from launch. | P0 |
| SHEET-47 | **Accessibility** (§9.5, WCAG 2.2 AA). The grid works fully by keyboard. Screen readers announce each cell's address, value and formula, and any comment, error or validation message. Colour is never the only signal: errors, protected cells and comments also show an icon or text. Every drag has a non-drag alternative (WCAG 2.5.7): Move left and Move right for tabs (SHEET-16), Resize for rows and columns (SHEET-02), Fill down and Fill right for the fill handle (SHEET-05), and Shift-click to extend a selection. Charts have a text alternative (SHEET-23). | P0 |
| SHEET-48 | **Templates** (DOC-08): shift roster with OT pay, budget tracker in S$, project tracker (owner, status dropdown, due date), quote comparison, and weekly capacity forecast. People pick one from the Drive's New menu or a blank sheet. Org and team templates added by admins are P2. | P1 |

#### Later

| ID | Requirement | Pri |
|---|---|---|
| SHEET-49 | **After v1:** pivot tables; grouping rows and columns; live embeds of ranges and charts in docs and decks; forms whose responses fill a sheet; "notify me when this sheet changes". | P2 |

### 8.8 Slides

Slides are in v1 (D39, answering Q15), and these requirements replace DOC-13. A deck is a Drive item like a doc or a sheet (D38). It lives in folders, uses the Docs roles, and is co-edited, commented on and versioned the way a doc is. Slides is built for presenting inside Hearth, in a room or meeting, from a laptop or a phone. It covers what most internal decks need. Slide masters, animations, and audio and video come later (SLIDE-36 – SLIDE-38).

#### Decks and editing

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-01 | **Decks live in the Drive** (D38). Anyone can create a deck from the Drive's New menu, from a template (SLIDE-13), from a doc or a meeting (SLIDE-31), or by opening a .pptx file as a deck (SLIDE-27). Decks are moved, renamed, starred, copied, shared, trashed and restored like any Drive item (FILE-01 – FILE-03). A new deck opens with one title slide in the default theme and the cursor in the title. | P0 |
| SLIDE-02 | **One slide model, one renderer.** A slide is 16:9 at a design size of 1,280 × 720 px (PowerPoint's 13.33 × 7.5 in at 96 px per inch), scaled to fit. It holds positioned elements: text boxes, images, shapes, tables and embedded sheet ranges. The editor, thumbnails, present mode, room presentations, session playback and PDF export all draw slides with the same renderer, so a slide looks the same everywhere. On the reference phones and 4G profile (§9.2), the first slide shows within 2 s for decks of up to 50 slides and 3 s for up to 250 slides (p75); other slides and full-size images load as needed. | P0 |
| SLIDE-03 | **Layouts.** A built-in set: Title, Section, Title and content, Two columns, Big number, Quote, Image with caption, Title only, and Blank. A layout places placeholders that show hint text until filled; empty placeholders don't appear when presenting. Changing a slide's layout moves its text into the new placeholders where it fits and never drops any: text with no matching placeholder stays on the slide as a text box. | P0 |
| SLIDE-04 | **Themes.** A deck has one theme for all its slides: background, text and accent colours, heading and body fonts, and the look of title and section slides. v1 ships at least three built-in themes, at least one light and one dark, plus the org theme once SLIDE-05 ships. Theme colours are slide content: a deck looks the same in the app's light and dark modes and on every screen in a room. Every text and background pair in a built-in theme passes 4.5:1 contrast (§9.5). Changing the theme restyles every slide without moving content. Slide numbers and a footer line can be turned on per deck. | P0 |
| SLIDE-05 | **Org theme.** Admins set up the org's brand once in the admin console (ADM-01): logo, colour palette, and heading and body fonts chosen from the fonts Hearth provides, which PDF exports embed (PPTX exports name them, SLIDE-28). Hearth rejects colour pairs that fail 4.5:1 contrast. The org theme becomes the default for new decks and templates. The logo can go on title slides and, if admins choose, in a corner of every slide. Decks that use the org theme follow later changes to it. Admins can hide built-in themes. | P1 |
| SLIDE-06 | **Text.** Editors type directly on the slide. Text supports bold, italic, underline, links, bulleted and numbered lists up to three levels (Tab and Shift+Tab), alignment, sizes from a fixed list (16, 20, 24, 28, 32, 40, 48, 64 and 96 px at the design size), and colours from the theme palette. Text shrinks to fit its box down to 16 px at the design size (12 pt in PowerPoint). Past that, Hearth warns that text runs off the slide and suggests splitting it across two slides. Pasting from Docs keeps headings, lists and basic formatting; pasting from elsewhere keeps plain text and lists. | P0 |
| SLIDE-07 | **Images.** Add images from the device, by paste, or by drag and drop. Editors can move and resize an image. Hearth asks for alt text when an image is added and uses it in present mode, exports and search. An image is stored with the deck and follows its permissions. **P1:** adding an image from the Drive, which copies it in so later changes to the file don't change the slide, with a warning before inserting if some people who can open the deck can't open the file (as CHAT-14); cropping; replacing an image, keeping its size and position; and the phone camera (SLIDE-26). | P0 · P1 (from the Drive, crop, replace) |
| SLIDE-08 | **Arranging elements.** Select, move, resize and delete elements, with snapping to slide edges, centre lines and other elements. Shift-click selects several; arrow keys nudge. A position and size panel sets an element's exact place and size without dragging (SLIDE-40). Cut, copy and paste work within and between decks. Undo and redo cover only the person's own changes. | P0 |
| SLIDE-09 | **Shapes and arrange tools.** Rectangles, rounded rectangles, ellipses, lines and arrows, with fill and outline colours from the theme and text inside shapes. Bring forward and send backward, align and distribute, group and ungroup, and rotate. | P1 |
| SLIDE-10 | **Tables.** Insert a table, add and remove rows and columns, type in cells, and style the header row from the theme. Calculations belong in Sheets; a sheet range can be embedded instead (SLIDE-29). | P1 |
| SLIDE-11 | **Speaker notes.** Each slide has notes with basic formatting, edited under the canvas (collapsible on phones). Notes are part of the deck: anyone who can open the deck can read them (Rule 1), and they are searchable (SLIDE-34). The audience never sees them. They show only in presenter view (SLIDE-15), never to people following a room presentation, and are not kept in the session record (SLIDE-19). The notes panel says this. | P0 |
| SLIDE-12 | **Filmstrip and slide sorter.** A filmstrip of numbered thumbnails (vertical on desktop, horizontal on phones) to select, add (with a layout picker), duplicate, delete (with undo), copy and paste, and reorder slides by drag, Alt+↑/↓, or Move up and Move down in the slide's menu. Slides pasted into another deck take on its theme. A grid sorter view shows the whole deck, and several slides can be selected to move, duplicate or delete together. Slides can be hidden, so presenting skips them. | P0 (filmstrip) · P1 (sorter, multi-select, hide) |
| SLIDE-13 | **Templates** (DOC-08). A starter gallery in the default theme: Team update, Project kickoff, Meeting (agenda, decisions, actions), Training, and All-hands. Picking a template creates a new deck in the current folder. Org and team templates published by admins are P2, as for sheets (SHEET-48). | P1 |

#### Presenting

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-14 | **Present mode.** Anyone who can open a deck can present it, from the first slide or the current one. It fills the screen where the browser allows; on iPhone, where a page can't enter full screen, it fills the installed app's window in landscape (ACC-14). The screen stays awake while presenting (Screen Wake Lock), where the browser allows. The next slide shows within 100 ms of a tap or key (p95, §9.2). Next: →, Space, Page Down, a tap on the right half, or a swipe left. Previous: ←, Page Up, a tap on the left half, or a swipe right. Home and End jump to the ends; B blanks the screen; Esc leaves. Hidden slides are skipped. A slide counter shows on the control bar, links on slides open, and screen readers announce each slide's text as it changes (§9.5). | P0 |
| SLIDE-15 | **Presenter view.** The presenter sees the current slide, the next slide, the speaker notes, a slide counter, the clock, and an elapsed timer they can pause and reset. The audience sees only the slide. On a single screen, N shows and hides the notes. Presenting to a room (SLIDE-16) always uses presenter view. On desktop, the presenter can open the audience view in a second window to move to a projector or second display. | P0 · P1 (second window) |

#### Presenting in a voice room

Presenting in a room is Hearth's alternative to sharing a screen for decks. Each person's device draws the real slides. They stay sharp on a phone, cost little on a weak connection (NFR-04), can be presented from a phone (most phone browsers can't share their screen), and are recorded as slides rather than video. Screen sharing (ROOM-03) stays for everything else. SLIDE-16 – SLIDE-19 ship together, never SLIDE-16 alone. They stay P0 because they are the only way to present from a phone and they keep presentations as searchable slides rather than unindexed video, but they are the block that moves to v1.x if M5b passes its cut line (§11).

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-16 | **Present to the room.** Anyone in a room, meeting or call (ROOM-01, ROOM-07, CAL-03) who can open a deck can present it to everyone there. They start from the in-room controls (Present a deck, beside Share screen, ROOM-03) or from the deck's Present menu while they are in the room. The deck picker lists decks linked in the meeting's agenda or the channel first, then recent decks. The slide fills the room's stage area, with participant tiles beside or below it, and the presenter moves through the deck in presenter view (SLIDE-15). Followers see each slide change within 500 ms (p95, on the 4G profile in §9.2). One presentation or screen share runs at a time; anyone else who starts one sees who is presenting. Rooms and channels show that someone is presenting (ROOM-02), without the deck's title. | P0 |
| SLIDE-17 | **Following a presentation.** Followers see the current slide fitted to their screen. On a phone, turning to landscape fills the screen (on iPhone, the installed app's window, as SLIDE-14), and they can pinch to zoom. The screen stays awake while following, where the browser allows. Images come at their screen's resolution, so a weak connection doesn't load full-size images. Screen readers announce each new slide's text. If the connection drops, the last slide stays with "Reconnecting…". People who join late or reconnect land on the current slide. If the presenter drops out, the room shows "Presenter reconnecting", and the presentation ends if they aren't back within 2 minutes. Followers can step back through slides already shown and return to the presenter with one tap. People who can open the deck can also open it from the stage. | P0 · P1 (step back) |
| SLIDE-18 | **Who sees presented slides.** Presenting shows slides to the room as sharing a screen does, but the session keeps them as searchable slides for as long as its transcript (SLIDE-19), not as video kept for 120 days. Before it starts, Hearth compares the deck's access with the session's audience (REC-20), which includes people who will see the recording later. If some of them can't open the deck, the presenter sees how many, where, and for how long, e.g. "9 members of #ops-north can't open this deck. The slides you show will be kept with the recording, and everyone in #ops-north, including future members, can find them for 3 years." People who can share the deck (its Owner and Editors, FILE-03) choose: share it with them, present anyway, or cancel. Anyone else can cancel, ask the owner for access, or share their screen (ROOM-03). Present anyway is logged as a share (ADM-06; proposed, Q20). Followers get only the slides as shown: never speaker notes, hidden slides, slides not yet shown, comments, or the deck itself. Their live access ends with the presentation. If the presenter loses access to the deck (Rule 6) or it is deleted, the presentation ends within 60 seconds. | P0 |
| SLIDE-19 | **Presentations are recorded as slides** (D10, REC-02). When a presentation runs during a session (REC-01), the session keeps a slide timeline (which slide was on screen, from when to when, and who presented) and a copy of each slide as shown, including edits made while it was on screen. The copies are slide content drawn by the same renderer (SLIDE-02), not video. The presenter is told this when they start. The copies belong to the session: they have its audience (REC-20) and access log (REC-21), follow Rule 5 in restricted rooms, are kept as long as its transcript (REC-22, PDPA-09), can be redacted (REC-18), and can't be deleted by participants (REC-23). Until REC-18 ships, the DPO can delete or blank a single slide copy, logged as REC-23 deletions are. Later edits to the deck, or deleting it, don't change them (Rule 7). Playback (REC-16) shows the slide that was on screen in step with the audio and transcript, with a list of slides shown that jumps to each one. | P0 |
| SLIDE-20 | **Meeting notes and Ask know the slides.** Notes (REC-12) are generated with the slide timeline alongside the transcript, so a decision or action item can name the slide on screen ("Slide 4: Q4 volumes") and link to that moment in playback. Notes list the decks presented, linked for people who can open them. Ask this meeting (REC-17) and the Org Brain (SLIDE-34) can answer from the slides shown. Only slides as shown are used, never speaker notes, hidden slides or slides not shown. Anything the presenter reads aloud is in the transcript in the usual way. | P1 |
| SLIDE-21 | **Hand over and pointer.** The presenter can hand over to another participant who can open the deck. A participant can ask to take over, and the presenter accepts or declines. The presenter's pointer shows on followers' screens. | P1 (hand over) · P2 (pointer) |

#### Collaboration, sharing, and phones

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-22 | **Real-time co-editing** (DOC-02). Several editors work on a deck at once. Presence shows who is in the deck, which slide each person is on (their avatar on its thumbnail), and which element they are editing (an outline in their colour, with their name). Typing in the same text box merges; when two people move or resize the same element, the last change wins. Edits made offline sync when the person reconnects (NFR-04). The sync server rejects changes from Viewers and Commenters (B.2). | P0 |
| SLIDE-23 | **Comments** (DOC-05) on a slide or on one element, with @mentions, replies and resolve. Everyone who can open the deck sees its comments, Viewers included; Commenters, Editors and the Owner add them. Thumbnails show a comment count. Comments never show when presenting and aren't exported. Until comments ship, Commenters on a deck can only view. | P1 |
| SLIDE-24 | **Version history** (DOC-04). Every change is saved with its author and time. People who can edit browse earlier versions as thumbnails and restore the whole deck to one, as a new version; Viewers and Commenters see only the current version, as in Sheets (SHEET-26; proposed, Q19). People who can edit can also compare any two versions (slides added, removed, changed or moved, with before and after for a changed slide), copy one slide from an earlier version into the current deck, and name versions. | P0 (browse, restore) · P1 (compare, copy a slide, names) |
| SLIDE-25 | **Permissions** (DOC-03). Viewer, Commenter, Editor and Owner, granted to people, teams or the whole org, with restricted editing (D19) and folder access as in the Drive (FILE-03). Every role can view and present (SLIDE-14, SLIDE-16), but only people who can share the deck can present it anyway to an audience that can't open it (SLIDE-18). Only Editors and the Owner can change slides, notes or the theme, see version history (SLIDE-24), or use AI help (SLIDE-30). | P0 |
| SLIDE-26 | **Phones** (NFR-02). On a phone, a deck opens full width with a horizontal filmstrip, collapsible notes and a compact toolbar. People can view a deck, present it, follow a room presentation, and present to a room from the phone with a compact presenter view (slide, notes, previous and next). On iPhone, presenting and following use landscape in the installed app's window (SLIDE-14). They can also edit text and notes, add slides from layouts, reorder slides, and add photos from the camera by touch. Moving and resizing elements, shapes and tables are built for desktop and tablets; a phone shows them but doesn't edit them. | P0 (view, present, follow) · P1 (edit) |

#### Import, export, and embeds

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-27 | **Import PowerPoint.** An uploaded .pptx file can be opened as a new deck from its preview (FILE-04); the original file stays in the Drive. Import keeps slide order, text and its formatting, images, simple shapes, tables, speaker notes and hidden slides. The file's backgrounds, colours and fonts become a theme for that deck, and fonts Hearth doesn't have are replaced with the closest match. **Lossy:** animations, transitions, and embedded audio and video are dropped; charts, SmartArt and WordArt become pictures where the file holds one, otherwise a labelled placeholder; gradients, shadows and other effects are simplified; 4:3 and other non-16:9 slides are scaled and centred on a 16:9 slide (SLIDE-02), with the theme background filling the sides. Hearth then shows what changed, slide by slide. Google Slides and Keynote decks are imported by saving them as .pptx first. | P1 |
| SLIDE-28 | **Export** (as DOC-11). Download a deck as PDF (one slide per page, optionally with speaker notes under each; text can be selected and links work) or as .pptx (text, images, shapes, tables and speaker notes stay editable in PowerPoint). Hidden slides are left out of PDFs unless the person includes them. Alt text (SLIDE-07) goes into both formats. PDF exports embed the theme fonts; PPTX exports name them, and PowerPoint substitutes any font that isn't installed. **Lossy:** comments and version history aren't exported; sheet embeds become plain tables. Exports are logged (ADM-06). PDF is P0 because v1 is internal only (D15), so exporting is how a deck reaches anyone outside the org. | P0 (PDF) · P1 (PPTX) |
| SLIDE-29 | **Embed from Sheets** (§8.7). Editors can insert a range of cells or a chart from a sheet they can open. The embed is a copy kept in the deck, labelled with the sheet's name and when it was last updated. Anyone who can open the deck sees the copy, so Hearth warns before inserting if some people who can open the deck can't open the sheet (as CHAT-14). When the sheet changes, Editors who can open it see "Sheet changed" and update the copy with one tap. | P1 (ranges) · P2 (charts) |

#### AI in Slides

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-30 | **AI help follows the inline-AI rules** (DOC-09, D16). Every suggestion is shown as a preview with the AI marker, its sources and feedback (AMB-06), and enters the deck only when the person accepts it. It uses only content the person can open at that moment (Rule 1), treats source text as data, never as instructions (Rule 8), and uses a restricted session only if the person took part and picks it themselves (Rule 5). If some people who can open the deck can't open a source, the preview says so before the person accepts (Rule 3, as CHAT-14). If the slide changes before they accept, the suggestion is marked out of date. Version history records an accepted suggestion as the person's edit, marked "suggested by AI", with its sources (BRAIN-08). Slides AI is optional AI under the spend caps and the kill switch (ADM-05, ADM-10). Agents read decks only within their scope (AGT-04) and can't edit them in v1. | P1 |
| SLIDE-31 | **Draft a deck from a doc or a meeting.** Offered in a deck, in the Drive's New menu, and in the More menu of a doc or a session page. The person picks a doc, or a session with notes, that they can open. Hearth suggests slides: a title slide, a slide per section or topic with shortened points, big-number slides for key figures, decisions and action items from meeting notes, and speaker notes drawn from the fuller source text. The preview shows every slide and its source. The person adds all, some or none, as a new deck or into the current one. Each added slide links to the part of the source it came from. Drafts from meeting notes carry the machine-generated warning (PDPA-08). Drafts from a restricted session follow Rule 5: they go into a new deck shared only with the person unless they confirm otherwise. | P1 |
| SLIDE-32 | **Write speaker notes** for one slide, or for every slide without notes, from what is on the slide and, for a drafted slide, the source it came from. Existing notes are kept unless the person chooses Replace. | P1 |
| SLIDE-33 | **Rewrite a slide**: shorten it, make it clearer, split it into two, or move it to a better layout (e.g. a key figure onto a Big number slide). Shown as before and after, to accept or discard. | P1 |

#### Search, data protection, and accessibility

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-34 | **Search and the Org Brain** (BRAIN-01). Deck titles, slide text, table cells, alt text and speaker notes are indexed under the deck's permissions (BRAIN-02) and searchable within 30 seconds (BRAIN-09). A search result opens the deck at the matching slide, and Ask and the assistant cite decks by slide number. Edits and deletions propagate within 5 minutes (Rule 7). Deck comments are indexed under the deck's permissions once SLIDE-23 ships, as for sheets (SHEET-44). Uploaded .pptx files that aren't opened as decks are indexed under FILE-06, notes included. Slides shown in a session are indexed as part of that session, except in restricted rooms (Rule 5). Slides from a deck that some of the session's audience couldn't open (SLIDE-18) are kept for playback only and not indexed, unless the DPO records otherwise in PDPA-01 (Q3). Text inside images isn't read in v1. | P0 |
| SLIDE-35 | **Decks are covered like docs** by retention (PDPA-09: 3 years after last edit unless the owner renews), legal hold (ADM-08), transfer of ownership at offboarding (ACC-05), access and correction requests (PDPA-05, PDPA-07) and data export (ADM-09). Deleting a deck deletes its images, embeds, comments and version history with it, but not the copies of slides kept in session records (SLIDE-19), which follow the session. Redacting text or an image from a deck and all its versions, by the DPO or a Compliance Officer, is P1 (as SHEET-45). | P0 |
| SLIDE-40 | **Accessibility** (§9.5, WCAG 2.2 AA). The editor works fully by keyboard: Tab and Shift+Tab move through a slide's elements in reading order, Enter edits the selected element, arrow keys move it and Shift+arrows resize it. People who can edit can change the reading order, which screen readers in present mode and following (SLIDE-14, SLIDE-17) and exports use. Every drag has a non-drag alternative (WCAG 2.5.7): the position and size panel for elements (SLIDE-08) and Move up and Move down for slides (SLIDE-12). Alt text goes into exports (SLIDE-07, SLIDE-28). | P0 |

#### Later

| ID | Requirement | Pri |
|---|---|---|
| SLIDE-36 | Slide transitions and build animations. | P2 |
| SLIDE-37 | Editable layouts and slide masters, team themes, and uploading custom fonts. | P2 |
| SLIDE-38 | Audio and video on slides, and sheet embeds that update themselves. | P2 |
| SLIDE-39 | **Draft a deck from a topic**: the assistant drafts slides from Org Brain content the person can open (Rule 1), citing sources on each slide. | P2 |

### 8.9 Files

| ID | Requirement | Pri |
|---|---|---|
| FILE-01 | **Drive** with My Drive, Shared with me, team folders, Recent, Starred, and Trash (D38). Docs, sheets, slide decks, uploaded files, and folders live together in it, and anyone can create a doc, sheet, or deck in the current folder from its New menu. A wiki space (DOC-07) is a team or org folder in the Drive, shown with its page tree; the folder's sharing sets the space's permissions. | P0 |
| FILE-02 | Upload (including from phone camera/gallery), download, folders, move, rename, star, make a copy (docs, sheets, and decks), and move to Trash. Trashed items can be restored for 30 days and are then deleted (Rule 7), unless under legal hold (ADM-08). | P0 |
| FILE-03 | **Sharing permissions** for every Drive item, matching DOC-03 (Viewer/Commenter/Editor/Owner; people, teams, org). One share dialog serves docs, sheets, decks, files, and folders. The Owner and Editors can share an item; Viewers and Commenters see who has access but can't change it. | P0 |
| FILE-04 | **Previews** for images, video, audio, PDF, and Office files (DOCX, XLSX, PPTX), showing every tab of a spreadsheet and every slide of a presentation, read-only. Macros never run (Q17). Opening a file as a Hearth sheet is SHEET-30; as a deck, SLIDE-27. | P0 |
| FILE-05 | **File versions**: upload a new version, see and restore old ones. | P1 |
| FILE-06 | Text extracted from files is **indexed** for search and the Org Brain, under the file's permissions. For uploaded spreadsheets this means cell values with their tab names and headers (SHEET-44); for presentations, slide text and speaker notes (SLIDE-34). | P0 |
| FILE-07 | Storage quotas per user and team, configurable by admins. | P1 |
| FILE-08 | Files attached in chat appear in a per-conversation "Shared files" view. | P0 |

### 8.10 Search and Ask

| ID | Requirement | Pri |
|---|---|---|
| SRCH-01 | **One bar everywhere** for search and questions. | P0 |
| SRCH-02 | **Keyword search** across messages, transcripts, notes, docs, sheets, slide decks, tasks, events, files, people, and channels, with filters (type, person, channel/space, date). A sheet result opens at the matching row (SHEET-44); a deck result opens at the matching slide (SLIDE-34). | P0 |
| SRCH-03 | **Ask**: a plain-language question returns an AI answer at the top with **citations** for every claim, followed by search results. Follows Rules 1–8 through the shared retrieval layer (B.4). | P0 |
| SRCH-04 | Results and answers never include content the searcher cannot open (Rule 1). | P0 |
| SRCH-05 | "**Who knows about X**": suggests people based on content the asker can see. | P1 |
| SRCH-06 | Jump-to (quick switcher) for channels, people, docs, sheets, and decks. | P0 |

### 8.11 Org Brain

| ID | Requirement | Pri |
|---|---|---|
| BRAIN-01 | **Indexes**: messages (incl. threads), voice-message transcripts, session transcripts and notes, docs and wiki pages, sheets (cell values as displayed, with their headers, SHEET-44), slide decks (slide text, alt text, and speaker notes, SLIDE-34), slides shown in sessions (SLIDE-19), tasks, calendar events, file text (FILE-06), and the people directory. | P0 |
| BRAIN-02 | Each indexed item stores its **access-control list**; retrieval filters by the asker's access and re-checks against live permissions before use (Rules 1, 6). | P0 |
| BRAIN-03 | Restricted-room sessions are **excluded** (Rule 5). | P0 |
| BRAIN-04 | Deletes and edits propagate within 5 minutes; derived content is regenerated or withdrawn (Rule 7). | P0 |
| BRAIN-05 | **Entities**: people, teams, projects, and decisions extracted and linked to their sources; each entity view shows only what the viewer can access. | P1 |
| BRAIN-06 | **Decision log**: decisions extracted from meetings and threads, browsable per team and project, each linked to its source. | P1 |
| BRAIN-07 | **Per-scope summaries** (channel daily/weekly, team weekly) generated within each scope (Rule 3). | P1 |
| BRAIN-08 | Provenance is recorded for every derived artifact (Rule 3). | P0 |
| BRAIN-09 | Index freshness: new content searchable within 30 seconds; available to AI within 2 minutes. | P0 |

### 8.12 Built-in AI features

| ID | Requirement | Pri |
|---|---|---|
| AMB-01 | **Catch me up** on any channel, thread, or doc since the user last looked. | P0 |
| AMB-02 | Meeting notes and action items (REC-11 – REC-14). | P0 |
| AMB-03 | Voice-message transcripts (CHAT-07). | P0 |
| AMB-04 | ~~Live captions~~ — removed (D31). | — |
| AMB-05 | **Translate** a message or doc for the reader. Post-v1, because v1 is English only (D29). | P2 |
| AMB-06 | Every AI output shows an "AI" marker, its sources, and 👍/👎 feedback. | P0 |
| AMB-07 | **AI in Sheets and Slides** (Ask about this sheet, suggest and explain a formula, what changed, draft a deck from a doc or meeting, write speaker notes, rewrite a slide) is specified in §8.7 (SHEET-37 – SHEET-43) and §8.8 (SLIDE-30 – SLIDE-33). The same rules apply: suggest-only (D16), sources shown (AMB-06), and figures from a sheet come from its cells or its formula engine, never from the model's arithmetic (SHEET-38). Both are optional AI under the spend caps and the kill switch (ADM-05, ADM-10). | See §8.7–8.8 |

### 8.13 Personal assistant

| ID | Requirement | Pri |
|---|---|---|
| PA-01 | Every user has **one private assistant**, reachable from Today, Search & Ask, and as a pinned conversation in Chats. | P0 |
| PA-02 | **Reads everything the user can see** (Rule 1) including their DMs (Rule 4). | P0 |
| PA-03 | **Suggest-only (D16)**: the assistant never sends messages, edits or creates documents, sheets, or decks, creates or changes tasks or events, RSVPs, or deletes anything. Drafts go into the user's composer or editor for the user to send or save. | P0 |
| PA-04 | **Actionables** on Today, ranked by importance: replies owed, unanswered @mentions, action items assigned, tasks due, meetings needing prep, docs, sheets, or decks awaiting the user's review or comment (decks once deck comments ship, SLIDE-23). Each has *Open*, a ready-made *Draft* where relevant, and *Dismiss*. | P0 |
| PA-05 | **Catch-up digest**: "since you were last here" across the user's channels and meetings, with links. | P0 |
| PA-06 | **Meeting prep brief** before each scheduled meeting: agenda, related threads, docs, sheets, and decks (e.g. the review deck and the forecast sheet it draws on), last meeting's notes, open action items between attendees. Restricted-session content is never included automatically (Rule 5). | P0 |
| PA-07 | **Ask** (SRCH-03) in a conversational thread with follow-ups. | P0 |
| PA-08 | **Drafting**: replies, announcements, doc sections, meeting agendas — always inserted for the user to edit and send. | P0 |
| PA-09 | **Proactive private nudges** (D7): e.g. "3 threads need your reply," "you have a meeting in 15 minutes — here's the brief." Delivered privately only; user controls frequency and quiet hours. | P0 |
| PA-10 | **Personal memory**: the user can see, edit, and delete everything the assistant remembers about them, and turn memory off. | P0 |
| PA-11 | **Delegation to specialists**: the assistant can route a question to a specialist agent and present its answer privately (Rule 2 applies with the user's DM as the audience). The assistant passes only the user's question, never content from DMs (Rule 4) or restricted sessions (Rule 5); the agent answers with `AgentScope ∩ Access(user)`. | P1 |
| PA-12 | **Share an answer** into a channel: the answer is regenerated at the channel's audience level (Rule 2), checking every source used, not only cited ones; anything that depends on sources outside the audience is removed before posting. | P1 |
| PA-13 | Users can rename their assistant and choose its avatar. | P2 |
| PA-14 | Voice conversation with the assistant. | P2 |

### 8.14 Specialist agents

| ID | Requirement | Pri |
|---|---|---|
| AGT-01 | Specialist agents are **created and published only by the central AI team** (AI Admin role) (D6). | P0 |
| AGT-02 | **Identity**: name, avatar, role description, owning team and a named owner (a person in that team), "Agent" badge, presence and a live status (e.g. "Writing weekly digest…"). | P0 |
| AGT-03 | **Playbook**: plain-language instructions describing the job, tone, and boundaries. | P0 |
| AGT-04 | **Knowledge scope**: which channels, wiki spaces, Drive folders, docs, sheets, slide decks, and files the agent may draw from; always further bounded by Rules 1–2. | P0 |
| AGT-05 | **Tools (suite-native)**: search/read the Org Brain within scope; post and reply where allowed; propose a task; draft a doc; read calendar availability. | P0 |
| AGT-06 | **Approvals**: any action other than posting a message where allowed (e.g. creating a task assigned to someone, creating a doc) shows an **Approve / Decline card** to the invoking person, or for scheduled and triggered runs to the agent's named owner, describing exactly what will happen. | P0 |
| AGT-07 | **Invocation**: @mention in a channel or thread, or DM the agent. Delegation from a personal assistant follows when PA-11 ships. | P0 |
| AGT-08 | **Participation levels** per channel: **Off**, **Mention only**, **Suggest** (unprompted answers appear as small dismissible cards: "HR Policy has an answer · Show"), **Active** (unprompted full messages). An agent's level in a channel is the lowest of the org default (ADM-05), the agent's default (STU-01), and the channel owners' setting (CHAT-01). An Admin or AI Admin can grant a specific agent a higher level in a specific channel; channel owners can still lower it. | P0 (Off/Mention/Suggest) · P1 (Active) |
| AGT-09 | **Unprompted guardrails**: an agent only speaks unprompted when it is confident and can cite a source; a per-channel cap on unprompted posts per hour; never in DMs or restricted rooms; 👎 and dismissals raise its threshold in that channel. | P0 |
| AGT-10 | **Schedules**: recurring jobs (e.g. "Mondays 9:00 post the team digest"). If a run is interrupted, it is marked *Interrupted* and waits for review rather than silently retrying (pattern from OpenDots). | P0 |
| AGT-11 | **Event triggers**: run when a message in a channel matches a condition, a new member joins, a meeting ends, or a task becomes overdue. | P1 |
| AGT-12 | **Agent memory** editable by the central AI team (§7.4). | P1 |
| AGT-13 | **Audit log** of every agent action, including what it read and why, viewable by AI Admins and Admins. | P0 |
| AGT-14 | **Kill switch** per agent and org-wide (ADM-10). | P0 |
| AGT-15 | **Agent computers** (sandboxed browser, terminal, files per agent, as in OpenDots). | P2 |
| AGT-16 | **External tool connectors** (e.g. via MCP) once third-party integrations are in scope. | P2 |

**Proposed launch set** (the central AI team decides the final list):

| Agent | Job | Where |
|---|---|---|
| **HR Policy** | Answers leave, benefits, and policy questions from the HR wiki space | #ask-hr, DMs |
| **IT Helpdesk** | Answers how-to questions; collects details and proposes a support task | #it-help, DMs |
| **Onboarding Buddy** | Answers "where is / who owns" and walks new joiners through a day-one checklist when they message or @mention it (the first-run flow, ACC-14, suggests doing so) | DMs, #welcome |
| **Weekly Digest** | Posts a weekly summary per team and for leadership (scheduled) | Team channels, #leadership |

### 8.15 Agent Studio (for the central AI team)

| ID | Requirement | Pri |
|---|---|---|
| STU-01 | Create and edit agents: identity, playbook, scope, tools, approval policy, schedules, triggers, default participation level. | P0 |
| STU-02 | **Test console** with **"view as user"**: run the agent as if invoked by a specific person in a specific channel, to verify Rules 1–2 before publishing. View-as runs against seeded test spaces and test users by default. When run as a real person, the AI Admin is treated as the audience (Rule 2): the answer shown uses only sources both the person and the AI Admin can open, and any other source the agent would have used is listed as withheld by type and an opaque ID, with no title or content. Each run is logged with the impersonated user (PDPA-06). | P0 |
| STU-03 | **Evaluation sets**: saved test questions with expected behaviour (including must-not-reveal cases); run before every publish. | P1 |
| STU-04 | **Versioning**: draft → published; roll back to any earlier version. | P0 |
| STU-05 | **Staged rollout**: publish to pilot channels before the whole org. | P1 |
| STU-06 | **Analytics**: invocations, 👍/👎, suggest-card open and dismiss rates, approvals, cost. | P1 |
| STU-07 | **Agent request intake**: any team can request an agent (purpose, channels, examples); requests are tracked to resolution. | P1 |

### 8.16 Admin, security, and compliance

| ID | Requirement | Pri |
|---|---|---|
| ADM-01 | **Admin console** (web) for all settings below, and for the org theme for decks (SLIDE-05). | P0 |
| ADM-02 | User management: roster import, add, deactivate, role assignment, device sign-out (ACC-03 – ACC-06). | P0 |
| ADM-03 | Team and channel governance: create/archive teams, transfer channel ownership, set who may create public channels. | P0 |
| ADM-04 | **Recording policy** setting (REC-03) and **restricted room** designation (REC-07). | P0 |
| ADM-05 | **AI settings**: default participation level, enable/disable AI features, model provider configuration, spend caps and alerts. Caps never stop session or voice-message transcription or meeting notes (D10); reaching a cap alerts admins and may pause only optional AI (Ask, catch-up, agents, and AI in Docs, Sheets, and Slides). | P0 |
| ADM-06 | **Audit log**: admin actions, sign-ins, permission changes, recording/transcript access, agent actions, privileged access (Rule 9). For each person, also AI retrievals of their content (assistant, built-in AI, agents), sends to external providers (by data type, not content), exports, and shares. Provider sends are logged once per person per session (and per voice message), per provider and data type, covering the session's speakers and participants; people only named in content, including glossary names sent as keywords, are covered by a standing entry in PDPA-10 rather than per request. AI retrievals are logged once per item retrieved. Kept at least 12 months (PDPA-09). Exportable. | P0 |
| ADM-07 | **Retention policies** per content type, using the retention engine (PDPA-09). | P0 |
| ADM-08 | **Legal hold** on users, channels, rooms, sessions, or Drive items and folders (docs, sheets, decks, files), overriding retention. A hold also stops Trash clean-up (FILE-02) and keeps every stored version of a held item (DOC-04). The hold mechanism ships with the retention engine (M2); its management screens may follow. | P0 |
| ADM-09 | **Data export**: per user and whole org, in open formats: docs as DOCX and Markdown, sheets as XLSX and CSV, decks as PPTX and PDF, and uploads in their original format. | P1 |
| ADM-10 | **AI kill switch**: disable one agent, all agents, or all AI features instantly. | P0 |
| ADM-11 | **Usage analytics**: active users, messages, sessions, docs, sheets, and decks created, Office files uploaded, AI usage and cost. | P1 |
| ADM-12 | **Compliance access** to restricted content follows Rule 9: a stated reason, a logged case, and an audit entry. Whether participants are notified is an open question (Q10). | P0 |
| ADM-13 | **Read receipts** and other org-wide behaviour toggles. | P1 |
| ADM-14 | **People insights** (D34). Owners, Admins, and the Leadership role see rankings and trends across the org, per person, team, and department, filterable by date range: messages sent and reactions given and received; talk time in rooms and calls (from each person's own audio track); time in rooms and meetings attended; tasks completed and meeting action items closed. Each person sees their own figures and trends in their profile, but no one else's. There are no public leaderboards, and team leads see team figures only if they also hold the Leadership role. Safeguards in PDPA-18. | P1 |

### 8.17 Notifications

| ID | Requirement | Pri |
|---|---|---|
| NOTIF-01 | **Push notifications** to the installed web app on phone and desktop (Web Push), and in-app. | P0 |
| NOTIF-02 | Defaults: DMs, @mentions, thread replies, meeting starting, task assigned/due, assistant nudges. Channels default to badge only. | P0 |
| NOTIF-03 | Per-conversation settings (all / mentions / off), **do not disturb**, and **quiet hours** tied to working hours. | P0 |
| NOTIF-04 | Smart batching: low-priority notifications grouped into the assistant's digest instead of separate pushes. | P1 |

### 8.18 Data protection (Singapore PDPA)

Singapore's Personal Data Protection Act (PDPA) applies (D32). Everyone agrees to the PDPA terms before joining (D28), and Hearth records that acknowledgment (ACC-12). The acknowledgment records that people were told; it is not the legal basis for every purpose. The requirements below give the org the tools for its other PDPA obligations. This section sets product requirements and is not legal advice: the org's Data Protection Officer (DPO) and counsel decide the legal positions that Hearth records.

**Why agreeing at onboarding isn't the whole answer.** Anything done on the basis of *consent* can be withdrawn at any time on reasonable notice (PDPA s16). If recording relied on consent alone, a single withdrawal would break the no-exceptions recording policy (D11). Recording and transcribing work meetings more likely rests on the PDPA exception for managing the employment relationship. That exception needs no consent, but people must still be told the purposes. Purposes that go further, such as making transcripts searchable through the org-wide AI or recording casual drop-in rooms, may need the *legitimate interests* exception, which requires a documented assessment. So Hearth records a legal basis **per purpose**, and onboarding presents a specific notice to acknowledge rather than a single blanket "I agree."

**PDPA obligations this design relies on**

| Obligation | What the PDPA requires (summary) | Where Hearth handles it |
|---|---|---|
| Notification | Tell people the purposes on or before collection when relying on consent, the employment exception, or deemed consent by notification. When relying on legitimate interests, give people reasonable access to information about that reliance. | PDPA-02, PDPA-03 |
| Withdrawal (s16) | People may withdraw consent on reasonable notice; the org must explain the consequences and stop consent-based processing. | PDPA-04 |
| Access (s21) | On request, provide a person's data and how it was used or disclosed in the past year. If this will take more than 30 days, tell them in writing within 30 days when they will get it. | PDPA-05, PDPA-06 |
| Correction (s22) | Correct personal data on request, or annotate it if not corrected. | PDPA-07 |
| Accuracy (s23) | Make reasonable efforts to keep data accurate where it is used for decisions about a person. | PDPA-08 |
| Protection (s24) | Make reasonable security arrangements. | §9.4, PDPA-12 |
| Retention (s25) | Stop keeping data once it no longer serves its purpose. There is no fixed period, and keeping data indefinitely needs a reason. | PDPA-09 |
| Transfer (s26) | Data sent overseas must keep protection comparable to the PDPA, e.g. through a contract with the recipient. | PDPA-10 |
| Breach notification (s26A–26E) | Assess a suspected breach quickly (the regulator expects within 30 days). A breach is notifiable if it is likely to cause significant harm or affects **500 or more people**. Notify the PDPC within **3 calendar days** of deciding it is notifiable, and tell affected people where significant harm is likely. | PDPA-11 |
| Accountability (s11–12) | Appoint a DPO and publish their business contact; have policies and a complaints process. | PDPA-13 |

Maximum financial penalties are 10% of annual Singapore turnover (for organizations with turnover above S$10 million) or S$1 million. The 500 count is the number of people whose personal data is in the exposed records, including people who are only mentioned in them and former employees whose data is still kept, not current headcount. So a leak of the transcript store outside the organization would almost certainly be notifiable on scale alone. Unauthorized access that stays inside the organization (e.g. an employee opening transcripts they shouldn't) is deemed not notifiable (s26B(4)), but it is still a failure of the protection obligation.

| ID | Requirement | Pri |
|---|---|---|
| PDPA-01 | **Processing register.** An admin page listing every purpose for which Hearth processes personal data, maintained by the DPO. Pre-filled with: recording scheduled meetings and calls; recording drop-in room sessions; transcribing sessions; AI meeting notes; keeping the slides presented in a session with its record (SLIDE-19), including whether slides from a deck some of the audience couldn't open are indexed (SLIDE-34); showing session recordings, transcripts, and notes to people who weren't there (REC-20); Org Brain indexing; the personal assistant; specialist agents and their digests; voice-message transcription; people and expertise inference (SRCH-05, BRAIN-05); presence and read receipts; access logs and "viewed by" lists; security audit and monitoring; per-person AI cost figures; people insights (ADM-14); sensitive-data detection (PDPA-17); the transcription test set (§9.5); backups; accounts and sign-in (roster, phone numbers and one-time codes, devices, profiles); hosting and delivering messages, voice messages, docs, sheets, slide decks, files, tasks, and calendar; built-in AI summaries and writing help (AMB-01, AMB-07, BRAIN-07, DOC-09, and CHAT-08 quick replies if AI-generated); and each overseas transfer. Each entry records its legal basis — employment exception; legitimate interests (assessment attached); business improvement (use only, not collection or disclosure); consent; deemed consent by conduct or contractual necessity; deemed consent by notification (s15A: assessment and opt-out window required); or another exception or legal requirement (provision cited) — plus its retention period and the providers involved. Hearth warns, without blocking, when a consent-type basis is chosen for a purpose the recording policy treats as no-opt-out, or business improvement for a collection or disclosure. | P0 |
| PDPA-02 | **Privacy and recording notice.** A versioned, plain-language notice generated from the register. It lists each purpose separately and covers: what is recorded (every session with 2+ people, including DM calls and drop-in rooms); what the AI does with it and who can ask about what; the legal basis for each purpose (for purposes relying on legitimate interests, a statement saying so and how to learn more); which purposes stop and which continue if someone withdraws consent; which providers receive data, in which countries they process it, and how long they keep it; retention for each data type; that providers do not train on the org's data; and the DPO's contact. Shown at onboarding and always available in Settings. | P0 |
| PDPA-03 | **Acknowledgment** (extends ACC-12). Nobody can use Hearth until they acknowledge the current notice. Hearth records who acknowledged, which version, when, and how. A change of purposes creates a new version, which everyone must acknowledge again. Records are exportable. | P0 |
| PDPA-04 | **Withdrawal and objection requests.** A self-service request form, plus requests the DPO logs from email or letter, routed to a DPO queue with a 10-business-day target (configurable). The register determines which purposes stop (consent-based) and which continue (exception-based), and Hearth drafts the reply explaining the consequences. Until PDPA-04a ships, no purpose whose withdrawal would need a per-person processing switch (recording, transcription, notes, voice-message transcription, Org Brain or AI use) may rely on consent or on deemed consent by notification (s15A); if Q3 concludes one must, PDPA-04a becomes P0. Purposes where a withdrawal is carried out by deleting the person's data, such as the transcription test set (§9.5), are exempt. The DPO handles withdrawals under a written manual procedure. | P0 |
| PDPA-04a | **Per-person processing switches**, available only to the DPO and only for purposes the register marks as consent-based, to carry out a withdrawal: stop recording the person's track; exclude their speech from transcripts and notes (shown as "not transcribed — data protection"); stop sending their voice messages to OpenAI; and exclude their content from the Org Brain and AI summaries. The effective date is logged. This is a legal carve-out, not a participant opt-out (REC-04). A withdrawn person's voice can still be picked up on colleagues' tracks (§7.5). | P1 |
| PDPA-05 | **Access requests.** A DPO console (using Rule 9 access) that verifies the requester's identity and finds personal data **about** that person: content they sent or spoke; content others sent, spoke, or wrote that names or concerns them (searched by name and aliases), including DMs, restricted sessions, docs, sheets, and decks (for a sheet, the matching rows with their column headers, and its comments), and slides shown in sessions (SLIDE-19); their assistant and agent conversations and personal memory; agent memory and Org Brain entries about them; profile, roster, device, sign-in, and acknowledgment records; and audit entries. Their own speech is exported from recordings and transcripts using their audio track, which excludes most other speakers; the DPO checks for other voices picked up on the track and for other people's data in what they said. **Nothing is released until the DPO has reviewed each item** and redacted or withheld other people's personal data (PDPA-05a), or withheld it under a PDPA exception with the provision and reason recorded. Exports are machine-readable (JSON/CSV plus media). A 30-day timer includes a template letter for when more time is needed. Works for deactivated accounts. Until PDPA-06 ships, the "how was my data used" part is answered with a general description generated from PDPA-01 and PDPA-10. | P0 |
| PDPA-05a | **Redaction and withholding** of other people's personal data in exported text, with per-item withhold and review status. | P0 |
| PDPA-05b | **Audio redaction**: silencing other people's voices in exported recordings. | P1 |
| PDPA-06 | **Use and disclosure record.** For each person, what happened to their data in the past 12 months (exports, shares, transfers to providers, AI retrievals), drawn from the audit log, to answer the "how was my data used" part of an access request. | P1 |
| PDPA-07 | **Corrections.** Anyone, including people who can't see the item, can ask for personal data about them to be corrected in transcripts, AI notes, messages, docs, sheets, slide decks, Org Brain entries, or memory. Requests go to the DPO queue with a 30-day timer and a template letter. The DPO corrects the item (in a doc, sheet, or deck, through its owner) or, if refusing, attaches an annotation recording what was requested. Transcripts and notes keep the original machine output alongside corrections (redactions excepted, REC-18). Corrections and annotations flow to notes and the Org Brain and stop the old data resurfacing in AI answers (Rule 7). Participant edits under REC-15 are separate and don't close a request. | P0 |
| PDPA-08 | **Machine-generated labels and human review.** Transcripts and AI notes are labelled as machine-generated, with the model name and Hearth's transcription pipeline version (B.5). When anyone exports, downloads, saves to a doc (DOC-10), or drafts a deck from (SLIDE-31) a transcript or AI note, or a Compliance Officer or the DPO attaches one to a case (Rule 9), Hearth shows the machine-generated warning, asks them to confirm someone checked it against the recording while the audio is kept, and logs who, what, and the stated purpose. Use outside Hearth is governed by the org's HR policy. | P1 |
| PDPA-09 | **Retention engine.** A configurable retention period for each data type, finite by default. "Keep indefinitely" is not available for audio/video, transcripts, or AI notes (D12); for other types it needs a written justification and sends the DPO an annual review reminder. Legal holds (ADM-08) and access-request holds pause deletion; a hold after a refused access request lasts at least 30 days after the refusal, longer if the PDPC reviews it. Deletion cascades to derived content (notes, indexes, embeddings, caches, version histories, original machine output). After any backup restore, the deletion log is replayed so deleted data doesn't reappear. Every deletion is logged. **Defaults** (audio periods decided, D36; the rest are proposals for the DPO to confirm, Q13): session audio/video 120 days and voice-message audio 360 days (D36); transcripts, AI notes, messages, and voice-message transcripts 3 years; docs, sheets, slide decks, and files 3 years after last edit unless the owner renews; items in Drive Trash 30 days after they are trashed (FILE-02); slides kept in a session record follow the session's transcript (SLIDE-19); assistant, agent, and built-in AI conversations 1 year; people-insight figures 2 years; audit and access logs 2 years; search indexes, embeddings, version histories, computed sheet values, and thumbnails follow their source item; backups 35 days; a leaver's personal memory deleted at deactivation (ACC-05); tasks and calendar events 3 years; agent memory 1 year, reviewed by the central AI team; a deactivated user's phone number, devices, and sign-in records deleted with the audit logs (2 years), with their profile reduced to name and title for attribution while their content is kept; acknowledgment records kept as long as the person's data is kept; DPO case records and the breach register as set by the DPO. | P0 |
| PDPA-10 | **Transfer register.** Lists every provider that receives personal data (AWS as the cloud host and, through Bedrock, the Claude model provider; LiveKit Cloud; OpenAI for transcription; the SMS provider) with: data types, processing and storage countries (as confirmed in writing by the provider), the transfer safeguard, how long the provider keeps data (e.g. up to 30 days of abuse-monitoring logs where zero retention isn't granted), and a review date. It feeds the notice (PDPA-02). **Before any real personal data, including pilot data, is sent to a provider:** sign a data processing agreement that binds the provider to PDPA-comparable protection, names the processing countries, and requires prompt incident notification (adding an addendum, e.g. based on the ASEAN Model Contractual Clauses, if the standard agreement falls short); turn off training on org data; apply for zero data retention; and record the result here. Certification is recorded as the safeguard only if the certificate has been verified. | P0 |
| PDPA-11 | **Breach response.** An incident record with a timeline (first aware, assessment, decision), clocks for the 30-day assessment and the 3-day PDPC deadline, notification templates for the PDPC and affected people, and a breach register. | P1 |
| PDPA-11a | **Breach scoping.** Identify the exposed items (from audit logs and the access of the compromised account or credential), then count the unique people whose personal data appears in them — authors, speakers, participants, and people named, including former employees — and the data types involved. 500 or more makes the breach notifiable on scale, unless the access stayed inside the organization. | P0 |
| PDPA-12 | **Limit the blast radius.** Storage and encryption keys are separated by team or space; no single service credential can read every transcript; bulk exports and unusual access raise alerts. | P1 |
| PDPA-13 | **DPO role and contact.** A DPO role (ACC-10) with access to the registers, request queues, incidents, retention settings, and audit logs; access to content follows Rule 9. The DPO's business contact appears in the notice, the help menu, and the AI info card (once PDPA-14 ships), **and the org publishes it outside Hearth** (e.g. on its website), as the PDPA requires. A question-and-complaint form routes to the DPO with tracking. The DPO can log requests received by email or letter from people without a Hearth account (former employees, people named in content); identity checks for them don't rely on an old Hearth phone number or PIN. | P0 |
| PDPA-14 | **AI info card.** A single page for the assistant and agents covering: what they read and under whose permissions, which providers and countries are involved, how long prompts and answers are kept, known limitations (transcription and AI errors), how to report wrong personal data, and the DPO's contact. | P1 |
| PDPA-15 | **AI conversations are personal data.** Assistant, agent, and built-in AI conversations (e.g. Ask about this sheet, SHEET-39; Ask this meeting, REC-17) have a retention period (PDPA-09) and are included in access requests (PDPA-05). | P0 |
| PDPA-16 | **No training on org data.** Hearth never trains or fine-tunes models on org data. Provider settings that would allow training stay off, are checked automatically where the provider exposes the setting through an API (e.g. OpenAI's data-retention settings through its Admin API); otherwise an admin re-confirms the setting or contractual term quarterly, with the attestation recorded. Results appear in the admin console and the transfer register (PDPA-10). Any future use of org data to improve AI requires a new, specific notice first. | P0 |
| PDPA-17 | **Sensitive data warnings.** Warn people who post an NRIC number, a password, or similar in chat, and people who share a doc, sheet, or deck containing them with a team or the whole org (SHEET-46 for sheets, which is P0). Flag such content in transcripts so it can be redacted (REC-18). | P1 |
| PDPA-18 | **People insights safeguards** (ADM-14, D34). Insights use counts and durations only; the AI never scores people on what they say. Each metric is a purpose in the register (PDPA-01) and is listed in the notice (PDPA-02), including who can see it. Restricted-room sessions are excluded, and figures never reveal who someone talked to or what about. Figures carry their caveats on screen (e.g. talk time from a shared room device or background voices can be wrong, §7.5). Every view of an individual's figures is logged (ADM-06). Before insights feed a performance or disciplinary decision, a person checks them against the underlying activity, as in PDPA-08. ADM-14 can't ship without these. | P1 (with ADM-14) |

## 9. Non-functional requirements

### 9.1 Platform

| ID | Requirement | Pri |
|---|---|---|
| NFR-01 | **Web app** for current Chrome, Edge, Safari, and Firefox on desktop; Chrome on Android; Safari on iOS. | P0 |
| NFR-02 | **Phone-friendly** layouts for every screen (D14, D21); every core flow (read, reply, voice note, join room, accept task, Ask, open and read a doc, sheet, or deck, follow a presented deck) is fully usable one-handed on a 6-inch phone. | P0 |
| NFR-03 | **Installable** to the home screen (progressive web app) with icon, splash screen, and push notifications on Android and iOS. On iOS, push works only after Hearth is added to the Home Screen, and permission must be requested from a tap inside the installed app; the first-run flow (ACC-14) handles this. The admin console shows the share of active users with push enabled, by platform. | P0 |
| NFR-04 | Usable on weak mobile connections: messages queue offline and send when back online; voice adapts bitrate. Edits made offline in docs, sheets, and decks sync on reconnect, with an indicator while changes are unsynced. Edits the server rejects on reconnect (because the person lost access, Rule 6, or the range is protected, SHEET-28) are shown to the person and offered as a copy, never dropped silently. Opening recently used docs, sheets, and decks while offline, with the formula engine cached, is P1. | P0 · P1 (open offline) |
| NFR-05 | Native iOS and Android apps. | P2 (first post-v1 item) |

### 9.2 Performance and scale (v1 targets)

**Reference devices and network.** Phone targets are measured on two reference phones, a 2024 Samsung Galaxy A-series phone (e.g. Galaxy A35) on Chrome and an iPhone SE (3rd generation) on Safari, over a 4G profile of 9 Mbps down and 150 ms round trip. The M2 device tests (R11) and the B.7 spike may replace them with phones the org actually uses.

| Metric | Target |
|---|---|
| Users per org | 1,000 (design for 5,000) |
| Concurrent voice participants (org-wide, peak) | 800 |
| Concurrent sessions (rooms and calls, peak) | 200 |
| Message delivery (send → visible to recipient), p95 | < 300 ms |
| App load to usable on 4G phone, p75 | < 3 s |
| Keyword search, p95 | < 1 s |
| AI answer: first words, p95 | < 3 s |
| Transcript + notes after session ends | < 5 min (transcript typically < 1 min) |
| Access revocation effective in AI | < 60 s |
| Sheet size (SHEET-33) | Up to 100 tabs and 250,000 non-empty cells per sheet (P0), 1,000,000 (P1); up to 100,000 rows and 200 columns per tab. Larger data stays an uploaded file with a preview (FILE-04). |
| Deck size (SLIDE-02) | Up to 250 slides |
| Simultaneous editors per sheet or deck | 50 (P0); 100 per sheet (P1, SHEET-25) |
| Sheet or deck edit visible to other editors, p95 | < 500 ms |
| Slide change seen by people following a room presentation, p95 (SLIDE-16) | < 500 ms |
| 50,000-cell sheet open and ready to edit, p75 (SHEET-34) | < 2 s on desktop; < 4 s on the reference phones on 4G |
| Recalculation after an edit, reference workbook (100,000 cells: values, row and column totals, IF, and a few hundred lookups), p95 (SHEET-34) | < 250 ms on desktop; < 750 ms on the reference phones. Calculation never blocks typing or scrolling. |
| Recalculation after an edit, lookup-heavy workbook (5,000 rows, each with an XLOOKUP and a SUMIFS over a whole column), p95 (SHEET-34) | < 1 s on desktop; < 3 s on the reference phones |
| Sorting or filtering 50,000 rows, p75 (SHEET-34) | < 1 s on desktop; < 3 s on the reference phones |
| Deck open on the reference phones on 4G, p75 (SLIDE-02) | First slide < 2 s for decks up to 50 slides; < 3 s up to 250 slides |
| Present mode: next slide after a tap, p95 (SLIDE-14) | < 100 ms |
| XLSX import, file up to 5 MB (SHEET-34) | < 30 s to open as a Hearth sheet |
| PDF or PPTX export of a deck of up to 50 slides | < 30 s |

*Basis for the Sheets and Slides rows:* measured on one 2.8 GHz server core in October 2026 (B.7). IronCalc in WebAssembly recalculated 100,000 cells of row totals in about 60 ms. A 100,000-cell sheet's Yjs state was 2.3 MB (about 0.6 MB compressed) and loaded in about 0.3 s; at 200,000 cells it was 4.8 MB (1.2 MB compressed). Phones are assumed to be 3–5 times slower; the spike measures them (B.7). The formula engine loads only when a sheet opens, so it doesn't count toward app load. The lookup-heavy workbook took about 9 s per evaluation on the same server core, because IronCalc 0.8 recalculates the whole workbook; meeting its target needs dependency-based recalculation (R15).

### 9.3 Reliability

- Availability **99.5%** monthly for v1 (single region); 99.9% target post-v1.
- Daily backups with tested restore; recordings in durable object storage.
- Graceful degradation: if AI providers are down, chat, rooms, docs, sheets, slides, and recording continue; transcription and notes queue and complete later.

### 9.4 Security and privacy

- Encryption in transit (TLS) and at rest.
- Phone + device PIN/passkey authentication (ACC-01, ACC-02); admin actions require re-authentication.
- Least-privilege internal access; production access logged.
- AI providers under no-training business terms, with zero data retention wherever the provider grants it. Each provider's actual retention, processing countries, and safeguard are recorded in the transfer register (PDPA-10).
- **Prompt-injection resistance** per Rule 8; AI red-team testing before launch.
- Independent penetration test before the org-wide launch.
- Uploaded Office files are parsed for previews (FILE-04) and imports (SHEET-30, SLIDE-27) in an isolated worker with no network access, and macros are never run (R17).
- Data stored in AWS Singapore (ap-southeast-1) (D37, B.6).

### 9.5 Accessibility and language

- WCAG 2.2 AA, including the Sheets grid (SHEET-47) and the Slides editor, present mode and themes (SLIDE-40, SLIDE-14, SLIDE-04). Session transcripts and voice-message transcripts double as accessibility features.
- **English only** for v1 (D29): the UI, transcription, meeting notes, and the AI. UI strings are still externalized so translation stays possible later. Sheets use English function names and Singapore formats: S$ and day-first dates (SHEET-14, SHEET-15).
- Transcription must handle the accents and the mix of names and internal terms used in the org; see the org vocabulary requirement (REC-19).
- **Non-English speech.** English only doesn't stop people switching into Mandarin, Malay, Tamil, dialects, or Singlish phrases. The spike checks whether `gpt-transcribe` still reports non-English speech in its returned `languages` when English is requested; if not, a small local language-ID model runs on each passage (no data leaves Hearth). Passages detected as non-English are marked "non-English speech: may be inaccurate"; notes then say part of the session wasn't in English, and action items drawn from those passages are flagged for the owner to confirm.
- **Transcription quality gate:** no public accuracy figures exist for the org's accents. During the M2 pilot, build a test set of 1–2 hours of clips recorded specifically for it, with each speaker's consent, covering the org's accents, names and jargon. The test set is its own purpose in the register (basis: consent), is stored apart from session audio with its own retention period, and a speaker's clips are deleted if they withdraw. Measure word error rate, accuracy on names and terms, and invented words. Before the M2 pilot, the founder and the DPO set minimum bars (e.g. accuracy on names and terms, invented-word rate); the test set also includes Singlish and mixed-language clips, scored separately. A failing run blocks org-wide launch until vocabulary tuning (REC-19) or settings changes bring it above the bars, or until the founder and DPO record an accepted exception, stated in the AI info card (PDPA-14). Because `gpt-transcribe` is an alias that OpenAI can update without a version change, the set is re-run monthly, on any OpenAI changelog entry for the model, and when correction rates in production shift; later runs also fail on a regression against the pilot baseline. The pre-M1 spike is only a smoke test on a few clips.

### 9.6 Cost

- Track AI and speech-to-text spend per feature, agent, and user (§7.5).
- Transcribe only speech, so cost follows talking time rather than how long people sit in a room.
- An org-level monthly budget with alerts at 50/80/100%. No transcription budget was set (D30); the estimate below is the planning baseline. The budget for AI notes, the assistant and agents is still open (Q5).
- Sheets and Slides add no licence fees, because every library recommended in B.7 is under MIT, Apache-2.0 or both. Univer Pro or a commercial HyperFormula licence would add one, and neither publishes its prices.
- The sheet calculation worker and the document conversion service add about $115–160 a month at 1,000 users (B.6). Most of the conversion service is needed anyway, for Office previews (FILE-04) and PDF export of docs (DOC-11). The figure assumes the B.7 limits on calculation and indexing; the spike measures the worker's throughput and the cost of embedding sheet rows, which this figure doesn't yet include.
- An AI question about a sheet sends the model a capped extract (e.g. at most 2,000 cells), and the formula engine does the arithmetic (SHEET-38, SHEET-39). So the cost per question doesn't grow with sheet size. This spend comes out of the assistant budget (Q5).

**Transcription cost estimate** (OpenAI list price as of October 2026: `gpt-transcribe` $0.0045 per minute of audio):

| | Per user per month | 500 users | 1,000 users |
|---|---|---|---|
| Session transcripts + voice messages | ≈ $3.00 (range $2.30–$3.70) | ≈ $1,500 | ≈ $3,000 |

*Assumptions:* each person spends 2 hours a day in voice sessions, 4 people per session on average, 22 workdays a month, someone speaking about 80% of session time, and 3 minutes of voice messages per person per day. About 15% is added for the padding around each spoken passage and per-request rounding. The range covers quieter or chattier rooms.

*What changes it:* sending whole tracks including silence would multiply the cost by about 4 (≈ $12 per user per month), so speech-only sending is a hard requirement. Any OpenAI data-residency project, including Singapore (storage only), adds 10% for `gpt-transcribe` and needs abuse-monitoring or zero-retention approval; because the transcription endpoint keeps no stored data, residency adds little here, and the estimate assumes a standard project at list price. OpenAI's Batch API discount doesn't apply to transcription, and negotiated volume pricing isn't assumed. The figures exclude AI notes and assistant costs and storage. Hosting, voice rooms, and recording compute are estimated in B.6 (total running cost ≈ $6 per user per month at 1,000 users).

## 10. Success metrics

Targets are proposals for the first 90 days after launch: adoption and suite metrics from the core launch, and meetings, assistant, agent and trust metrics from the full v1 launch (D42).

| Area | Metric | Target |
|---|---|---|
| **Adoption** | Employees active weekly | ≥ 90% |
| | Work conversation still on WhatsApp (survey) | ≤ 10% of respondents say "most of my work chat" |
| | Mobile workers active weekly | ≥ 80% |
| **Meetings** | Substantive sessions with notes posted within 5 min | ≥ 95% |
| | Meeting action items accepted as tasks | ≥ 50% |
| | Notes rated accurate by participants (👍 rate) | ≥ 85% |
| **Assistant** | Users who act on at least one actionable per week | ≥ 60% |
| | Ask answers rated helpful | ≥ 80% |
| | Citation accuracy (sampled evaluation) | ≥ 95% |
| | Sheet figures in AI answers that match the cited cells or an engine calculation (sampled, SHEET-38) | 100% |
| **Agents** | Suggest-card dismiss rate | < 50% |
| | Agent answers rated unhelpful | < 10% |
| **Trust** | Confirmed AI permission leaks | **0** |
| | "I trust Hearth with sensitive work" (survey) | ≥ 70% agree |
| **Suite** | Teams with an active wiki space | ≥ 75% |
| | Meetings scheduled in Hearth Calendar | ≥ 80% |
| | New spreadsheets and decks made in Hearth (Hearth sheets and decks created, as a share of those plus XLSX and PPTX uploads; from ADM-11) | ≥ 60% (depends on Q18) |

**Launch gates** (separate from these 90-day targets). *Core launch* (after C6, D42): no open leak from the non-AI cases of the access-rule test suite, a clean penetration test, a passed restore drill and scale tests, the DPO consoles live, and a WhatsApp-for-work sunset date set (Q12). *Full v1 launch* (after A6): no open leak from the access-rule test suite including its AI cases (A2), the AI red-team (A6), or pilot reports (A1–A5). After the full v1 launch, a confirmed AI leak triggers the kill switch (ADM-10) for the affected feature until it is fixed.

## 11. Release plan

No fixed date (D23). The solo builder with AI coding tools (D24) completes one stage at a time, and pilot groups grow at each stage. The build is sequenced **core first, AI second** (D41): stages C0–C6 build the whole suite without any model call and leave seams for the AI layer; stages A0–A6 then add it. Hearth launches twice (D42): the **core launch** after C6, when the org moves off WhatsApp for work on the non-AI suite, and the **full v1 launch** after A6. The detailed plan, with ordered steps, exit criteria and every requirement placed in a stage, is `docs/BUILD-PLAN.md`.

| Stage | Contents | Pilot |
|---|---|---|
| **C0 — Foundations** | Org/tenant data model, phone sign-in with PIN and passkeys, roles (incl. DPO), teams, permission model with the access-rule test suite, audit log, event outbox, job queue and feature flags (AI flags present and off), realtime gateway, privacy notice and acknowledgment (PDPA-01 – PDPA-03, PDPA-13), transfer register (PDPA-10) with agreements for AWS, the SMS provider and the push services, DPO request intake handled manually, design system, installable web app shell, push notifications, first-run flow (ACC-14), admin console shell, AWS setup, backups and observability | Builder plus 2–3 testers |
| **C1 — Chat** | CHAT P0s except a channel's attached voice room (CHAT-16, C2), AI quick replies (CHAT-08, A3) and agents in chat (CHAT-17/18, A5); voice messages as audio, without transcripts (A1); attachments in a minimal file store; keyword search; notifications; a rule-based Today. **Before the pilot:** the notice covers chat, Q3 and Q13 are answered for it, and the breach runbook and DPO procedures are written. | One team (10–20 people) moves its WhatsApp group over |
| **C2 — Tasks, rooms and recording** | TASK P0s; ROOM and REC P0s without transcription or notes, and without presenting a deck with its slide record (Present a deck in ROOM-03, and the slide parts of REC-02, REC-16, REC-22 and REC-23; C5): drop-in rooms, calls, universal per-track recording, session pages with playback, restricted rooms, "viewed by" lists; retention engine with holds (PDPA-09, ADM-08); privileged access (Rule 9, ADM-12); audio redaction. **Before the pilot:** the LiveKit agreement (PDPA-10), and no session is recorded until retention, holds, privileged access and redaction are live. | Same team plus a call-heavy team |
| **C3 — Calendar** | CAL P0s, scheduled meetings with their own rooms and event threads; the Sheets spike (B.7) | 3–5 teams (~100 people) |
| **C4 — Docs, wiki, Drive** | DOC and FILE P0s: Drive, previews, co-editing, permissions, version history, wiki spaces, templates. Uploaded spreadsheets are keyword-indexed by row (FILE-06, SHEET-44); the check on AI figures (SHEET-38) comes with AI answers in A3. The New menu offers sheets and decks from C5. | Same, plus HR and IT |
| **C5 — Sheets and Slides** | SHEET and SLIDE P0s without AI, reusing C4's sync server, sharing, comments, version history and Drive: the grid, formulas, formatting, XLSX and CSV import and export, decks, present mode, and presenting to a room with slides kept in the session record (SLIDE-16 – SLIDE-19). Timeboxed by the cut line below. | Same, plus finance and ops; part of the core launch (D43) |
| **C6 — Core hardening and core launch** | Compliance consoles (export, access requests PDPA-05/05a, corrections PDPA-07, breach scoping PDPA-11a), scale tests, penetration test, restore drill, accessibility audit, rollout in waves; then people insights with their safeguards (ADM-14, PDPA-18) | **Core launch** org-wide; WhatsApp-for-work sunset (D42) |
| **A0 — AI platform** | Model layer (D4), AI provider agreements (PDPA-10), AI purposes added to the notice and re-acknowledged, AI kill switch (ADM-10), spend tracking and caps (ADM-05), AI markers and feedback (AMB-06) | Founder, DPO and the central AI team |
| **A1 — Speech-to-text** | Session and voice-message transcripts (REC-10, CHAT-07, B.5), org vocabulary (REC-19), corrections (REC-15), transcript redaction (REC-18), the quality gate (§9.5), back-fill of earlier recordings still within retention (D44) | The C1 and C2 pilot teams first |
| **A2 — Org Brain and retrieval** | BRAIN P0s, the shared retrieval layer (B.4), the access-rule suite's AI cases | No user-facing feature; shadow indexing |
| **A3 — Built-in AI** | Meeting notes and suggested tasks (REC-11 – REC-14, TASK-06), Ask (SRCH-03), catch-up (AMB-01), AI in Docs, Sheets and Slides (AMB-07), AI conversation retention (PDPA-15) | 3–5 teams, then wider |
| **A4 — Personal assistant** | PA P0s: AI actionables, digest, drafts, prep briefs, nudges, memory | Pilot teams, then wider |
| **A5 — Agents** | AGT and STU P0s, CHAT-17/18, the launch agent set | HR Policy and IT Helpdesk first |
| **A6 — AI hardening** | AI red-team, the zero-leak gate, retrieval scale tests | **Full v1 launch** |

Sheets and Slides are part of the core launch (D43): C5 comes before C6, and C6 hardens and launches the whole non-AI suite, Sheets and Slides included, before any AI.

**C5 cut line** (cited elsewhere as the M5b cut line). The spike's estimate (B.7, item (e)) sets C5's length. If C5 runs more than 50% over that estimate, present to the room (SLIDE-16 – SLIDE-19) moves to v1.x as a block and C6 starts; screen share (ROOM-03) stays the way to present at the core launch. Cutting any other P0 needs a new decision.

**Older milestone names.** Rows elsewhere in this document still cite milestones M0 to M6. Read them as: M0 → C0; M1 → C1, with voice-message transcripts in A1; M2 → C2, with transcripts in A1 and notes in A3; M3 → A2 (Org Brain), A3 (Ask) and A4 (assistant), with the non-AI cases of the access-rule suite from C0; M4 → C3, with tasks in C2 and suggested tasks in A3; M5 → C4, with the check on AI figures (SHEET-38) in A3; M5b → C5, with the spike in C3 and the other AI rules for sheets (SHEET-37, and SHEET-44's Org Brain part) in A2; M6 → C6 (compliance consoles, people insights, hardening) and A5–A6 (agents, AI hardening). Agreements a row required before the M1 or M2 pilot for OpenAI or the AI model provider are now required before A0, and for OpenAI before A1.

**Post-v1 roadmap (in rough order):** native mobile apps → P1 leftovers → agents speaking in rooms → agent computers and external connectors → guests and external consent → readiness for selling to other orgs (multi-org hosting, billing, self-serve onboarding, per-customer recording policies).

## 12. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Scope vs. a solo builder**: nine modules (including Sheets and Slides, D39, R14) plus AI plus real-time voice is a very large surface | High | High | Assemble proven open-source building blocks rather than building low-level pieces (Appendix B); strict P0 discipline; ship milestone by milestone to real pilots; requirement IDs plus tests make AI coding tools effective. |
| R2 | **Universal recording**: PDPA exposure (relying on withdrawable consent alone, keeping data indefinitely, overseas transfers) and people self-censoring | Medium | High | A legal basis for each purpose (PDPA-01), confirmed by the DPO and counsel (Q3); a specific notice and acknowledgment (PDPA-02/03); finite retention (PDPA-09); data processing agreements for overseas transfers (PDPA-10); always-visible indicator; "viewed by" transparency (REC-21); restricted rooms; recording policy configurable for future customers. |
| R3 | **AI permission leak** | Medium | Critical | Rules 1–8 enforced in one shared retrieval layer, not per feature; live permission re-check; provenance on derived content; "view as" testing; leak tests in CI; zero-leak launch gate; kill switch. |
| R4 | **Agents speaking unprompted annoy people** | Medium | Medium | Suggest cards before full Active mode; confidence threshold and per-channel caps; feedback raises the threshold; channel owners can turn it down. |
| R5 | **AI and transcription cost** grows with universal recording | Medium | Medium | Send only speech to OpenAI (about 4× cheaper than whole tracks); no live captions (D31); transcripts ≈ $3/user/month (§9.6); cheaper models for routine summaries; per-feature budgets and alerts. |
| R6 | **Adoption**: people stay on WhatsApp | Medium | High | WhatsApp-level simplicity; installable app with push; voice notes; pilot champions; leadership sets a WhatsApp-for-work sunset date at launch. |
| R7 | **SMS sign-in security and delivery cost** | Medium | Medium | Device PIN/passkey; OTP rate limits; reputable SMS provider with fallback. |
| R8 | **Real-time editing of docs, sheets, and decks is hard to get right** | Medium | Medium | Use a mature conflict-free sync library. Give rows, columns, and slides stable IDs, so concurrent inserts, sorts, and moves merge correctly (B.7). Test merge cases heavily and automatically. |
| R9 | **Dependency on alpha projects** (OpenDots is alpha and needs CopilotKit Intelligence for conversation storage) | Medium | Medium | Reuse OpenDots' patterns and MIT-licensed code, not its runtime dependency; store agent conversations in Hearth's own database. |
| R10 | **Bus factor of one** | High | High | This PRD, architecture notes, and tests kept in the repo; admin runbooks; consider a second maintainer before org-wide launch. |
| R11 | **iOS web app limitations** (background audio, push reliability) hurt mobile rooms | Medium | Medium | Test early in M2 on real devices; prioritize native apps immediately post-v1 if gaps are severe. |
| R12 | **Depending on OpenAI for transcription**: models get retired (four were deprecated in Aug 2026 and are scheduled to shut down in Feb 2027), features differ between models, and accuracy on the org's accents and names is unproven | Medium | Medium | Model names live in configuration behind the model layer; timestamps and speaker labels come from Hearth's own pipeline, not the model; transcription quality gate (§9.5) re-run monthly and on any OpenAI change notice; org vocabulary (REC-19); editable transcripts (REC-15). |
| R13 | **People insights feel like surveillance** on top of universal recording, so people go quiet in rooms or back to WhatsApp | Medium | Medium | Counts and durations only, no AI scoring of speech; visible only to leadership and admins; everyone sees their own figures; metrics and viewers listed in the notice; caveats shown; every view logged (PDPA-18). |
| R14 | **Sheets and Slides add two editors** to a solo build that is already large (R1) | High | High | Reuse the Docs stack (Yjs sync server, permissions, version history, comments, Drive). Adopt a formula engine rather than write one (B.7). Build in M5b after the Docs P0s, behind a spike with pass bars (B.7). Keep the P0 rows in §8.7 and §8.8 to what launch needs: comparing versions, the change list, editing structure and formatting on phones, extra paste sources, and image cropping are P1. P1 features slip to v1.x without blocking launch, and the M5b cut line (§11) moves present to the room to v1.x if M5b overruns. |
| R15 | **Formula results or speed differ from Excel**: people check numbers against Excel, and the recommended engine (IronCalc) is pre-1.0. In a quick test, one dynamic-array formula returned #VALUE!, and lookup-heavy sheets recalculated slowly (B.7). | Medium | Medium | Keep the engine behind an adapter, with HyperFormula and Univer as fallbacks. Test the fixed SHEET-08 function set against the values Excel saved in the org's real workbooks, in CI and on every engine upgrade. Unsupported functions show a clear error and appear in the import report (SHEET-31). Run calculation off the main thread, with a time budget on the server. If the spike misses the lookup-heavy target (SHEET-34), add dependency-based recalculation, so an edit recomputes only the cells that depend on it: contribute it to IronCalc upstream, or build a dependency graph in Hearth's adapter. Neither fallback engine solves this: HyperFormula was slower on the same test. Pin the browser and server to the same engine version, built from one source tag (B.7). |
| R16 | **Office import fidelity**: converted XLSX and PPTX files lose features. IronCalc 0.8 reads and writes merged cells, frozen panes, hidden rows and columns, and conditional formatting, and reads comments, but has no charts, pivot tables, data validation, filters, protection, or images and doesn't write comments. Hearth must add the ones §8.7 keeps; PPTX effects are simplified (SLIDE-27). People may keep working in Excel and PowerPoint. | Medium | Medium | The original always stays in the Drive with a preview (FILE-04). Convert only on request, with an import report of what was kept and dropped (SHEET-31, SLIDE-27). PPTX import is P1. Measure the public workbooks in `spike/sheets-corpus/` in the spike (Q16). |
| R17 | **Server-side calculation and conversion widen the attack surface**: untrusted XLSX and PPTX files are parsed on the server, and formulas or rendered pages could try to fetch data | Low | High | No cross-file references or network functions in v1 (SHEET-12). The workers and the conversion service have no internet access. The conversion service's browser may load only Hearth's own assets: allow-list set, private and public IPs denied. Each conversion runs in isolation with time and size limits. Only server-computed values are indexed. Rule 8 tests include instructions hidden in cells, comments, and speaker notes. |

## 13. Open questions

| # | Question | Needed by |
|---|---|---|
| Q1 | Naming for the personal assistant and the specialist agents. (Product name resolved: Hearth, D33.) | M6 |
| Q2 | ~~Languages~~ — resolved: English only (D29). | — |
| Q3 | DPO and counsel confirm the legal basis for each purpose in the processing register (PDPA-01), especially org-wide AI indexing of transcripts, the recording of casual drop-in rooms, and showing recordings to people who weren't there (REC-20). | Before M1 pilot |
| Q4 | Who is on the central AI team, and how much of their time is committed? | M4 |
| Q5 | Monthly budget for AI notes, the assistant and agents. (Transcription is estimated at ≈ $3/user/month, §9.6.) | M3 |
| Q6 | ~~Cloud provider and data region~~ Resolved: AWS Singapore (D37, B.6). | — |
| Q7 | Final launch agent set (§8.14 proposal). | M5 |
| Q8 | Is whole-org visibility of public-room transcripts acceptable (REC-20 default), or should public-room transcripts be limited to participants? Depends on Q3. | M2 (with Q3) |
| Q9 | Read receipts on or off by default? | M1 |
| Q10 | When compliance accesses a restricted session, are the participants notified? | M2 |
| Q11 | Default storage quotas for files, and whether docs, sheets, and decks count toward them. | M5 |
| Q12 | Does leadership commit to a date to stop using WhatsApp for work? | M6 |
| Q13 | Remaining retention periods (PDPA-09 proposals). Session recordings (120 days) and voice-message audio (360 days) are decided (D36). | Before M1 pilot |
| Q14 | ~~Who is the Data Protection Officer?~~ Resolved: Ashton Teo (D35). Their business contact still has to be published outside Hearth (PDPA-13); the PDPC also encourages registering the DPO on ACRA BizFile+. | M0 |
| Q15 | ~~Do Sheets (DOC-12) and Slides (DOC-13) move from P2 into v1?~~ Resolved: yes, both are in v1 (D39). | — |
| Q16 | Is the conversion in SHEET-31 and SLIDE-27 good enough for the org's real files, and do the SHEET-33 size limits fit them? Answered by the B.7 spike on the 27 openly licensed public workbooks in `spike/sheets-corpus/` (the founder chose public files over the org's own, 11 Oct 2026) and a set of decks; a few anonymised internal workbooks checked the same way before the core launch would confirm it. | M5b |
| Q17 | Macro-enabled and legacy Office files (XLSM, PPTM, and XLS or PPT with VBA): allow, warn, or block on upload? Hearth never runs macros and drops them when a file is opened as a sheet or deck. Does the uploaded original stay downloadable with its macros? | M5 |
| Q18 | Do heavy Excel and PowerPoint users (e.g. finance models, customer-facing decks) keep Office after launch, with their files stored in the Drive, or is Hearth expected to replace Office for everyone? This sets the §10 target and how much import and export fidelity (Q16) matters. | M5b |
| Q19 | Who can see version history? SHEET-26 and SLIDE-24 propose limiting it to people who can edit, so old values removed on purpose never reach Viewers or the AI (Rule 1). This matches Google Docs, where only editors see version history, which fits D19 ("Docs like Google Docs"). Should DOC-04 do the same for docs (D19 says "viewable version history")? The answer is recorded as a decision before the Docs and Sheets version-history work starts. | M5 |
| Q20 | Who may present a deck to an audience that can't open it (SLIDE-18, "Present anyway")? Proposed: only people who can share the deck, because the slides shown are kept and searchable with the session for years (SLIDE-19), unlike screen-share video; anyone else can ask for access or share their screen. A deck owner can't block it in v1. | M5b |
| Q21 | Formula engine and grid: IronCalc, HyperFormula, or Univer (B.7). Recorded as a decision after the B.7 spike. | Before C4's sync server |
| Q22 | ~~Should Sheets and Slides (C5) be part of the core launch?~~ Resolved: yes (D43). | — |
| Q23 | ~~May transcription process sessions and voice messages recorded before it was on?~~ Resolved: yes, with safeguards (D44). | — |

---

## Appendix A — Decision log

| # | Decision | Notes |
|---|---|---|
| D1 | **Internal first, sell later** | Org-scoped data model from day one; no billing or self-serve in v1. |
| D2 | **Personal assistant + specialist agents** | The four-layer model in §7.1. |
| D3 | **AI mirrors each user's access** | Rules 1–8 (§7.2). Revised by D11: "AI off" for sensitive rooms now means "not indexed," not "never processed by a model." |
| D4 | **Cloud model APIs** | Behind a swappable model layer; no training on our data; zero data retention wherever granted (PDPA-10). |
| D5 | **v1 leads with voice rooms + personal assistant** | Specialist agents ship as a small curated set. Build order set by D41: voice rooms in C2, the assistant in A4. |
| D6 | **Only a central AI team creates agents** | Agent Studio (§8.15) plus request intake. |
| D7 | **Agents may be active in channels** | With guardrails: participation levels, suggest cards, caps, never in DMs/restricted rooms, never speak aloud unprompted. The assistant's proactivity is private nudges. |
| D8 | **250–1,000 people** | Drives roles, admin, audit, retention. |
| D9 | **All meetings recorded, transcribed, with notes** | Added mid-discovery. Refined by D27: notes for substantive sessions. Sequenced by D41: recorded from C2, transcribed from A1, notes from A3. |
| D10 | **Every session with 2+ people is recorded** | Includes casual drop-ins and DM calls. |
| D11 | **No recording exceptions** | Sensitive conversations protected by access (restricted rooms), not by skipping recording. The only carve-out is legal: if the DPO records a purpose as consent-based and someone withdraws, PDPA-04a applies to them. |
| D12 | **Audio/video kept short, transcripts/notes kept long** | 120-day default for session audio/video (D36). Transcripts and notes are kept for a finite period, proposed as 3 years, not indefinitely, because PDPA retention limits apply (PDPA-09, D32). |
| D13 | **A new suite from scratch** | Supersedes an earlier "Google Workspace" answer. No dependency on another suite. |
| D14 | **Web only for v1** | Specified as phone-friendly and installable with push. |
| D15 | **Internal only for v1** | No guests or shared channels. |
| D16 | **Personal assistant is suggest-only** | Has all the user's context; suggests actionables and drafts; never edits or sends. |
| D17 | **Coming from WhatsApp** | Fresh start; WhatsApp simplicity is the bar; voice messages with transcripts. Voice messages are audio-only until transcription arrives in A1 (D41). |
| D18 | **v1 includes every module** | Each at a defined depth (P0 lists in §8). |
| D19 | **Docs like Google Docs** | Restricted editing and viewable version history. |
| D20 | **Phone-number sign-in** | Hardened with device PIN/passkey and admin-only roster. |
| D21 | **Mix of desk and mobile workers** | Phone experience is P0. |
| D22 | ~~**Docs now, Sheets and Slides later**~~ | Superseded by D39: Sheets and Slides are in v1. |
| D23 | **No fixed date** | Milestone sequencing in §11. |
| D24 | **Built by the founder with AI coding tools** | Shapes Appendix B and risk R1/R10. |
| D25 | **Warm and familiar feel** | WhatsApp-like; the "cool" comes from rooms and AI, not visual complexity. |
| D26 | **Recording policy is an org setting** | Our org: all sessions, no exceptions. Keeps D1 open. |
| D27 | **Notes only for substantive sessions** | ≥5 min or contains a decision/action item; avoids flooding channels with notes from short drop-ins. |
| D28 | **Every member agrees to the PDPA terms before joining** | Captured in onboarding as acknowledgment of the privacy and recording notice (ACC-12). It is not by itself the legal basis for recording or any other purpose: each purpose's basis is recorded in the processing register (PDPA-01) and confirmed by the DPO and counsel (Q3). |
| D29 | **English only** | UI, transcription, notes, and AI. Resolves the former language question. |
| D30 | **OpenAI for transcription** | Session transcripts and voice messages, using `gpt-transcribe` (§7.5). No transcription budget set; §9.6 gives the estimate. The budget for AI notes, the assistant and agents is open (Q5). |
| D31 | **No live captions** | Live transcription isn't needed. Removes the real-time model, its cost, and OpenAI's 30-day retention of real-time audio. ROOM-10 and AMB-04 removed. |
| D32 | **Singapore's PDPA applies** | Data protection requirements in §8.18. |
| D33 | **The product is called Hearth** | Started as a placeholder; kept. |
| D34 | **People insights for leadership; own stats for everyone** | Leadership and admins see org-wide rankings; each person sees their own figures. Metrics: messages and reactions, talk time, time in rooms and meetings, tasks completed. Counts only: no AI scoring of what people say. Replaces an earlier "no people analytics" rule. |
| D35 | **The DPO is Ashton Teo** | Founder; holds the DPO role (ACC-10, PDPA-13). |
| D36 | **Session recordings kept 120 days; voice-message audio 360 days** | Replaces the earlier 90-day proposal. Transcripts and notes follow their own periods (PDPA-09). |
| D37 | **Host on AWS Singapore (ap-southeast-1)** | Chosen after the cloud research in B.6. Recommended alongside it: LiveKit Cloud for rooms with Hearth's own recorder bot, and Claude through Amazon Bedrock in Singapore. |
| D38 | **Docs works like a Drive; Sheets and Slides are in the demo** | Docs, sheets, slide decks, uploaded files and folders live in one Drive (FILE-01 – FILE-05) with My Drive, Shared with me, team folders, Recent, Starred and Trash, and anyone can create a doc, sheet or deck from it. A wiki space is a team or org folder in the Drive, shown with its page tree (FILE-01). The demo includes working Sheets and Slides. D39 moves them into v1. |
| D39 | **Sheets and Slides are in v1** | Founder's decision, 11 Oct 2026, answering Q15. Supersedes D22. Requirements, with proposed priorities, are in §8.7 (SHEET-01 – SHEET-49) and §8.8 (SLIDE-01 – SLIDE-40); DOC-12 and DOC-13 point there. Sequenced as M5b, after the Docs P0s (§11). Aimed at everyday team spreadsheets and decks, not full Excel or PowerPoint parity (§3.2). The formula engine and other building blocks stay recommendations until the spike (B.7, Q21). |
| D41 | **Core first, AI second** | Founder's decision, 11 Oct 2026. The whole suite is built and piloted without any model call (stages C0–C6, §11) before the AI layer (A0–A6). "AI" means any model: LLMs, speech-to-text, embeddings, and local ML models such as speech detection or ML noise suppression. The core builds the seams the AI layer needs, so no core work is redone: an outbox event with an ACL snapshot on every write, agent and system principals, empty transcript and notes slots, AI flags present and off, and recordings stored for later transcription. Where a requirement or milestone puts AI into a core stage, the AI part moves to its A-stage (`docs/BUILD-PLAN.md`, Part 2). D40 is held for the version-history decision (Q19). |
| D42 | **Core launch before AI** | Founder's decision, 11 Oct 2026. The org launches Hearth org-wide and sets the WhatsApp-for-work sunset date on the non-AI suite, after C6 (§11), before any AI arrives. The full v1 launch follows A6. G1 and G6 are measured from the core launch; G2, G3 and G5 from the full v1 launch. The sunset date (Q12) attaches to the core launch. |
| D43 | **Sheets and Slides are part of the core launch** | Founder's decision, 11 Oct 2026, answering Q22. C5 (Sheets and Slides without AI) comes before C6, so the core launch and the WhatsApp-for-work sunset (D42) include them, and the core launch gate covers sheets and decks. Their P0 rows (§8.7, §8.8) stay as written; if C5 overruns, the C5 cut line (§11) is the fallback. |
| D44 | **Transcription may process earlier recordings** | Founder's decision, 11 Oct 2026, answering Q23. When transcription starts (A1), it may also transcribe session recordings and voice messages captured before it was on, with these safeguards: only audio still within retention (PDPA-09); the back-fill announced at least 14 days ahead in the AI notice (A0); only speakers who have acknowledged that notice, with everyone else's passages marked "not transcribed"; restricted sessions stay under Rule 5. The DPO confirms the legal basis for the back-fill under Q3. |

## Appendix B — Build approach and suggested building blocks

### B.1 Recommendation: a fresh build on proven open-source parts

Two options were considered:

| | Extend RocketChat | Fresh build on open-source parts |
|---|---|---|
| Chat maturity on day one | High | Must be built (M1) |
| Covers the rest of the suite | No — chat is one of nine modules | Designed for the whole suite |
| One stack for a solo builder | No — RocketChat runs on Meteor and MongoDB, while the rest of the suite would be built separately | Yes |
| Room for the "agents are teammates" interface | Limited by RocketChat's app framework | Full control |
| Path to selling later | RocketChat enterprise features are under a separate commercial licence; core is MIT | Own all IP |

**Recommendation:** fresh build (D13, D24), using RocketChat as a **feature checklist** for chat and OpenDots as the **reference design** for agents. Revisit only if M1 chat proves far slower than expected.

### B.2 Suggested building blocks (non-binding; confirm in the technical spec)

| Need | Suggested building block | Why |
|---|---|---|
| Language | TypeScript end to end | One language across web and server; strong AI-coding-tool support. |
| Web app | React, as an installable progressive web app (service worker, Web Push) | D14; phone install and push without native apps. |
| Server | A single modular TypeScript service to start; WebSockets for real time | Simplest to run for one person; split later if needed. |
| Database | PostgreSQL (with `pgvector` for semantic search) | One database for app data, search, and AI retrieval at v1 scale. Size for transcript volume: about 74 million words a month at 1,000 users, roughly 2.7 billion over 3 years of retention. Keyword search needs a BM25-style index (a Postgres extension or a separate engine) to meet §9.2; access-filtered vector search needs pgvector 0.8+ iterative scans or per-scope partitions. M6 scale tests include search and retrieval at 3-year volume. |
| Cache / presence | Redis | Presence, typing indicators, pub/sub. |
| Voice/video | **LiveKit Cloud** (LiveKit is an open-source WebRTC media server) plus Hearth's own recorder bot, which records each participant's tracks separately (no transcoding) rather than a mixed composite | Rooms, screen share, recording; per-participant tracks give speaker attribution and support export, withdrawal, and redaction (REC-02). Hosting choice and costs in B.6. |
| Co-editing | **Yjs** (CRDT sync) for docs, sheets, and slide decks, with one Yjs sync server for all three (e.g. Hocuspocus) and garbage collection on. Docs use a TipTap/ProseMirror editor. Sheets and Slides use Hearth's own editors over the Yjs models in B.7. | One sync, permission, and history path for every editor. Deleted content is not kept in the shared state sent to clients. The sync server authenticates every connection and rejects updates from Viewers and Commenters (DOC-03). Version history (DOC-04) is kept server-side: each accepted update is tagged with author and time, then compacted into stored snapshots that can be deleted or redacted (PDPA-09) and are kept while under legal hold (ADM-08). Comments (DOC-05), including comments on cells and slides, are stored outside the shared document. |
| Spreadsheet formulas | **IronCalc** (MIT or Apache-2.0) behind Hearth's own engine adapter. It runs as WebAssembly in a Web Worker in the browser and through its Node.js binding on the server. | About 500 Excel functions and an XLSX reader and writer in one engine, used the same way in the browser and on the server (SHEET-25, SHEET-44). The adapter keeps HyperFormula (commercial licence) and Univer as fallbacks. See B.7. |
| Spreadsheet grid | Hearth's own grid, grown from the demo's ARIA grid (`demo/src/screens/sheets/Grid.tsx`), with row and column virtualisation added | Fits the design system, the phone layout (SHEET-35) and WCAG 2.2 AA (SHEET-47). No editor licence. |
| Slide editor | Hearth's own editor over positioned elements, with layouts as presets that place placeholders (SLIDE-02, SLIDE-03). One React slide renderer, grown from the demo's (`demo/src/screens/slides/render.tsx`), draws the canvas, thumbnails, present mode, room presentations, session playback, and exports. | Slides look the same everywhere, and people following a room presentation draw real slides rather than video (SLIDE-16). No editor licence. |
| Spreadsheet files | XLSX import and export through IronCalc's reader and writer, run on the server, with Hearth's own handling for what IronCalc lacks (B.7). CSV in Hearth's own code. | One engine for both formulas and files. If .xls or .ods import is ever needed, use SheetJS Community Edition installed from the SheetJS CDN. The npm `xlsx` package (0.18.5) has unpatched vulnerabilities. |
| Presentation files | **PptxGenJS** (MIT) for PPTX export (SLIDE-28). **pptxtojson** (MIT) for opening uploaded PPTX files as decks (SLIDE-27) and extracting their text for search (FILE-06). | Speaker notes carry over in both directions. |
| PDF export and Office previews | **Gotenberg** (MIT; headless Chromium and LibreOffice) as an internal conversion service | Docs, sheets, and decks print from the same HTML people see (DOC-11, SHEET-32, SLIDE-28). Uploaded Office files get previews (FILE-04). |
| Files and recordings | S3-compatible object storage | Durable, cheap, lifecycle rules for retention. |
| AI | Internal model layer → Claude through Amazon Bedrock in Singapore (B.6) | D4; swappable. |
| Speech-to-text | OpenAI `gpt-transcribe` (session transcripts, voice messages), plus Hearth's own speech detection on each track (e.g. Silero VAD) | D30; see B.5. |
| Agent UI streaming | Consider **AG-UI** (the protocol OpenDots uses) for streaming agent output and approval cards | Proven pattern for approve/decline cards. |
| SMS | Established SMS OTP provider | ACC-01. |
| Background jobs | A Postgres-backed job queue | Transcription, notes, indexing, agent schedules, sheet calculation, and file import, export, and conversion. |

### B.3 What to reuse from OpenDots

OpenDots is MIT-licensed. Reuse its **patterns**:
- Specialist agent definition (name, role, instructions, permitted tools) → AGT-02 – AGT-05.
- Approve/Decline cards for non-read actions → AGT-06.
- Scheduled runs in their original conversation, with an *Interrupted → retry after review* state → AGT-10.
- User-visible, user-editable memory → PA-10.

Do **not** take on its runtime dependency on CopilotKit Intelligence for conversation storage; Hearth stores all conversations in its own database so the access rules in §7.2 apply uniformly.

### B.4 The single most important technical rule

All AI features (Ask, the assistant, agents, summaries, and the AI in Docs, Sheets, and Slides) must retrieve content through **one shared, permission-enforcing retrieval layer** that implements Rules 1–8. No feature may query the index directly. This is what makes the zero-leak target testable. The only path around it is privileged access (Rule 9), which is audited and never feeds any AI feature.

### B.5 Transcription pipeline (OpenAI)

Based on OpenAI's API as of October 2026 (its SDK source and documentation). Re-check these facts in a spike before the M1 pilot.

**Speech detector (session tracks).** For every participant track, a speech detector runs in Hearth's recorder bot (B.6). It marks where each spoken passage starts and stops on the session clock, with about 300 ms of padding, and drops passages shorter than about 300 ms. Each passage becomes `{session, speaker, start, end, audio}`. Speaker and timestamps therefore never depend on the model.

**1. Session transcripts (REC-10).**
- Send one passage per request to `/v1/audio/transcriptions` with model `gpt-transcribe`, `languages: ["en"]`, `keywords` from the org vocabulary (REC-19), and the meeting title plus the last few transcript lines as `prompt`.
- A passage longer than about 30 s is split at the next pause; if none comes by 60 s, it is split at the point of lowest speech probability in the last few seconds, so no word is cut in half. Very short passages (under about 2 s) from the same speaker may be grouped to reduce per-request rounding; a group is stored and shown as one passage (first start, last end) and never spans more than about 30 s.
- Transcribe passages as they finish, during the session, so the transcript is complete within about a minute of the session ending.
- Store `{session, speaker, start, end, text, model, pipeline_version, requested_at}` and merge all tracks in time order. `gpt-transcribe` is an alias and responses carry no model version, so Hearth records the model name it sent, its own pipeline and settings version, and the request time.
- Temporary failures (timeouts, 429, 5xx) retry automatically with backoff for up to 24 hours, matching §9.3. Permanent failures (other 4xx) are marked "not transcribed" at once, as are passages still failing after 24 hours, with an admin alert and a re-run action while the audio is kept (120 days). The transcript shows gaps explicitly. If temporary failures are outstanding at the 5-minute notes deadline, notes are generated with a visible "incomplete transcript" marker and regenerated in place as a new version when the late passages arrive.
- Keywords must be single-line plain text; one invalid keyword rejects the whole request, so clean the list first. Test for keywords being inserted where they weren't spoken.
- Upload limit is 25 MB per request; send Opus audio (ogg/webm) with the correct file extension.

**2. Voice messages (CHAT-07).** Run the same speech detector on the clip first. If it finds no speech, don't call OpenAI; show "No speech detected" and keep the audio. Otherwise trim leading and trailing silence and shorten long internal silences (over about 5 s) to about 1 s, then upload to `gpt-transcribe` with `languages: ["en"]` and keywords per REC-19. `stream: true` shows text as it is produced.

**Set up before the M1 pilot** (voice-message transcription starts in M1):
- Run transcription in its own OpenAI API project, with "share data for training" off.
- Sign OpenAI's data processing agreement and check it meets PDPA-10 (comparable protection, named processing countries, prompt incident notice); add an addendum if it doesn't.
- Apply for Zero Data Retention. OpenAI's documentation lists the transcription endpoint as keeping no abuse-monitoring logs by default and as eligible for Zero Data Retention, but approval comes through OpenAI and isn't self-serve.
- Rate limits: `gpt-transcribe` is listed at 5,000 requests and 2M tokens per minute on OpenAI's lowest paid tier (Build, since the tier change on 2026-10-06), about 3× the estimated peak of 1,700 requests per minute at 1,000 users. Confirm the org's tier, whether keyword and prompt text count toward the token limit, and whether an audio-duration limit applies.
- Decide on data residency when creating the transcription project; it can't be changed afterwards (§9.6).

**Verify in the spike:**
- Whether very short requests have a minimum billable duration (affects the cost estimate).
- A smoke test of accuracy on a few clips (the full quality gate runs in M2, §9.5).
- Whether Zero Data Retention and data residency cover `gpt-transcribe`.
- The maximum keyword count, how often keywords are inserted where they weren't spoken at the chosen cap, and whether billing is purely by duration.
- Whether non-English speech is reported in the returned `languages` when English is requested (§9.5).

**Data location.** OpenAI's Singapore data residency covers storage only; requests are processed outside Singapore (OpenAI offers in-region processing only in the US, EU, and UAE). Sending audio to OpenAI is therefore an overseas transfer under the PDPA (PDPA-10). The processing countries for Hearth's OpenAI project must be confirmed in writing by OpenAI, ideally named in the agreement, and recorded in PDPA-10 before they appear in the notice. Hearth's own storage of recordings and transcripts can stay in Singapore.

**If word-by-word timestamps are ever needed:** OpenAI's only models that return them are scheduled to shut down on 2027-02-26. Use a self-hosted forced aligner instead (e.g. the approach WhisperX uses), which runs locally and sends no data out.

### B.6 Hosting on AWS Singapore (D37)

Based on cloud research in October 2026 (provider documentation, price lists, and SDK sources, fact-checked). Confirm prices in the AWS console and with LiveKit before committing.

**Why AWS:**
- **Claude can be processed inside Singapore** through Amazon Bedrock (Claude Sonnet 5, in-region in ap-southeast-1 since 2026-09-30, at about a 10% premium over global routing). Meeting notes and the assistant then need no overseas transfer and fall under the same AWS agreement as hosting. No other provider could be confirmed to offer this.
- **MTCS SS 584 Level 3** (Singapore's multi-tier cloud security standard), plus SOC 2, ISO 27001/27017/27018, and a standard data processing agreement.
- **Every Hearth component has a managed service in Singapore**, at about the same cost as the alternatives considered (Google Cloud, Azure, DigitalOcean, Supabase with Railway or Vercel).

**Recommended setup (ap-southeast-1):**

| Component | Service | Notes |
|---|---|---|
| App server, Yjs sync, workers | ECS Express Mode on Fargate (ARM) behind an Application Load Balancer | App Runner stopped taking new customers in April 2026. Set the load balancer idle timeout to about an hour; clients send a heartbeat every ~25 s and reconnect automatically. One Yjs sync server serves docs, sheets, and decks. Size its memory for open sheets: about 36 MB per open 100,000-cell sheet. Documents are unloaded when their last editor leaves. |
| Database | RDS PostgreSQL 17/18, Multi-AZ, starting at db.m7g.large | pgvector 0.8.2 with iterative scans (`hnsw.iterative_scan = relaxed_order`); move to 0.8.4+ when RDS ships it (fixes for heavy HNSW deletes). RDS has no BM25 extension: use Postgres full-text search (tsvector with a GIN index) for keyword search, and add OpenSearch only if needed. |
| Cache / presence | ElastiCache for Valkey, small node plus replica | |
| Files and recordings | S3 with lifecycle rules | Standard → Standard-IA after 30 days → deleted at 120 days (session recordings) or 360 days (voice-message audio). |
| Claude | Amazon Bedrock, in-region Claude Sonnet 5 | Block global cross-region model IDs for any request containing personal data. Check in-region quotas before launch. |
| Voice rooms | LiveKit Cloud | See below. |
| Recorder and speech detection | Hearth's own recorder bot, on ECS or EC2 in Singapore | Joins each active room as a participant, writes each person's audio as segmented Opus/OGG straight to S3, runs speech detection, and feeds transcription (B.5). Replaces LiveKit's paid Track Egress. |
| Sheet calculation | Worker tasks on ECS Fargate (ARM) running IronCalc's Node.js binding | Evaluates sheets after edits, for search, the Org Brain, AI answers, thumbnails, and exports (B.7). One 1 vCPU / 4 GB task, plus a second for availability. No internet access. |
| Document conversion | Gotenberg (Chromium and LibreOffice) as an internal-only ECS service on Fargate (ARM) | PDF export of docs, sheets, and decks; previews of uploaded Office files (FILE-04). Reachable only from Hearth's workers, with no internet access. Chromium's allow-list is set to Hearth's own assets. One 2 vCPU / 4 GB task, with more added as the queue grows. |
| Infrastructure | AWS CDK or Terraform | Everything is defined in code, so AI coding tools can build and change it. |

**Voice rooms: LiveKit Cloud first, self-host later.**
- LiveKit Cloud with Hearth's recorder bot costs about **$470–500 a month at 250 users, $560 at 500, and $1,300 at 1,000**.
- Self-hosting LiveKit on AWS would save only about $70–400 a month, but adds 2–5 days of setup, 4–8 hours a month of operations, and being on call for everyone's rooms. It starts to pay off at around 1,000–1,100 users, or once Hearth serves several organisations.
- Don't record with LiveKit Cloud's Track Egress: about $3,600 a month at 1,000 users, and more simultaneous recordings than the Scale plan allows.
- Use only features that also exist in self-hosted LiveKit, so moving later is a configuration change. Use the "speech" audio preset with DTX on.
- PDPA: LiveKit Cloud carries media through its Singapore edge but keeps logs and room metadata in the US or EU. Record this in the transfer register (PDPA-10), and don't turn on LiveKit Cloud's agent observability or session recording.
- LiveKit's prices could not be checked directly in this research and must be confirmed.

**Estimated monthly running cost at 1,000 users:**

| Item | ≈ per month |
|---|---|
| AWS hosting (app, database, cache, storage, egress) | $1,100 |
| LiveKit Cloud with Hearth's recorder | $1,300 |
| Recorder and speech-detection compute | $150–300 |
| Transcription (§9.6) | $3,000 |
| Claude meeting notes (Bedrock, in-region) | $400 |
| Sheet calculation and document conversion | $115–160 |
| **Total, before assistant and agent usage (Q5)** | **≈ $6,150 (≈ $6 per user)** |

*Basis for the sheet calculation and conversion line:* Fargate ARM in ap-southeast-1 costs $0.04045 per vCPU-hour and $0.00442 per GB-hour (AWS price list, 11 Sep 2026). That makes about $42 a month per calculation task and $72 for the conversion task.

One-year commitments take about $150–250 a month off the AWS line.

**Transcription stays with OpenAI (D30)** and is processed outside Singapore. If Hearth ever needs everything processed in Singapore, Amazon Transcribe runs there (about $0.006 a minute in batch), but it charges a 15-second minimum per request, so the passage-by-passage design would have to change. Benchmark its accuracy first.

### B.7 Sheets and Slides engines

Based on package registries, project repositories, AWS's public price list and a local benchmark, all from October 2026. Re-check it in the spike before work starts. Everything here is a recommendation: D39 puts Sheets and Slides in v1 but doesn't choose an engine, and the engine choice is recorded as a decision after the spike (Q21).

**Recommendation:** build Sheets and Slides on the same Yjs stack as Docs. Use IronCalc as the formula engine, and grow Hearth's own grid and slide editor from the demo. Don't adopt Univer for all three editors in v1. Keep Univer as the fallback for the grid.

**Scope.** §8.7 and §8.8 set the scope, and they go beyond the demo in two ways that matter here:
- Sheets need merged cells, comments, personal filters, validation, conditional formatting, protected ranges, links and charts. IronCalc 0.8 reads and writes merged cells, frozen panes, hidden rows and columns, and conditional formatting, and reads comments and Excel tables (checked in the 0.8.0 source). Hearth adds validation, filters, protection, links, charts and writing comments in its own layer over the engine, and carries them through import and export (SHEET-31, SHEET-32). IronCalc 0.8.4's WebAssembly build has a conditional-formatting API that may evaluate SHEET-22's rules.
- Slides hold positioned elements (SLIDE-02), not the demo's fixed fields per layout, so imported PPTX content, shapes, tables and sheet embeds fit one model without a later data migration.

**Why not Univer for all three editors**
- Univer's open-source core (Apache-2.0, at 1.0 since 23 Sep 2026) covers editing and formulas, and its formula engine (`@univerjs/engine-formula`) can run headless in Node.js. Real-time collaboration, edit history, XLSX import and export, printing, charts and a faster Rust formula engine are in Univer Pro (`@univerjs-pro/*` packages), a commercial layer whose prices aren't published. Without a licence, Pro runs in evaluation mode: a watermark, limits on import size and caps on collaboration.
- Univer Pro collaborates by operational transformation through Univer's own server, which needs PostgreSQL, RabbitMQ, Temporal and S3-compatible storage. That would be a second sync stack beside Yjs. Document content would sit in a closed-source server that Hearth's own controls would have to reach into: permission checks (DOC-03, Rule 6), retention and deletion (PDPA-09), and legal hold (ADM-08).
- Univer Docs would replace the TipTap editor planned for Docs.
- Univer's formula engine includes WEBSERVICE, which fetches URLs. Hearth would have to turn it off (Rule 8, SHEET-12).
- Univer draws its editors on a canvas. That has to be checked against WCAG 2.2 AA (§9.5) and the demo's phone layouts. Hearth's grid starts from the demo's ARIA grid, which can be tested directly.
- Univer stays the fallback. If Hearth's grid overruns, Univer's open-source Sheets editor could be bound to Hearth's Yjs model, or a Pro licence bought.

**Why IronCalc**
- MIT or Apache-2.0, so there is no licence cost now or if Hearth is sold later (D1). HyperFormula is GPL-3.0 unless a commercial licence is bought. That is acceptable while Hearth is used only inside the org, but selling Hearth later (D1) would need the licence or a GPL release of the client code.
- About 500 function names in its function list, counting compatibility aliases, which covers the SHEET-08 set. The published 0.8 release ran XLOOKUP, FILTER, SORT, LET, LAMBDA and TEXTJOIN correctly in a quick test.
- XLSX reader and writer are in the same engine.
- The same engine runs in both places: WebAssembly in the browser (about 0.7 MB compressed, loaded only when a sheet opens) and a Node.js binding on the server.
- Measured on one 2.8 GHz server core: 100,000 cells of row totals recalculate in about 60 ms in WebAssembly. An XLSX round trip kept values and formulas.

**Trade-offs to manage**
- IronCalc is pre-1.0 with a small team, and the project is asking for contributors. Pin versions. The licence allows forking.
- Every evaluation recalculates the whole workbook, and lookup-heavy sheets scale badly. 5,000 rows, each with an XLOOKUP and a SUMIFS over the whole column, took about 9 s; 3,000 rows took 3.6 s. HyperFormula was slower on the same test: at 3,000 rows it took 34 s to load and 7.8 s per edit. So calculation runs off the main thread, and the grid shows "Calculating…" while it runs. That alone doesn't meet SHEET-34's lookup-heavy target: Hearth needs dependency-based recalculation over IronCalc, contributed upstream or built in the adapter (R15), and the spike tests it.
- Some functions still differ from Excel. In the quick test, `ROWS(UNIQUE(…))` returned #VALUE! where Excel returns a count (R15). The SHEET-08 test suite catches these.
- The features IronCalc 0.8 lacks (see Scope) are Hearth's own work, including writing them into XLSX files alongside IronCalc's writer (R16).
- The npm packages are out of step: `@ironcalc/wasm` is at 0.8.4 (1 Aug 2026), but `@ironcalc/nodejs` stops at 0.8.3. Build both bindings from the same IronCalc git tag in Hearth's CI, or pin both to 0.8.3, and fail the build when the two engine versions differ.

**Comparison: engines and editors**

| Option | Licence | Status, October 2026 | What it gives | Collaboration | Verdict |
|---|---|---|---|---|---|
| Univer (open source + Pro) | Apache-2.0 core; Pro commercial | 1.0.4, 10 Oct 2026; very active | Sheets, Docs and Slides editors; about 500 functions; Node.js headless mode | Operational transformation through Univer's own server (Pro) | Fallback for the grid |
| IronCalc | MIT or Apache-2.0 | 0.8.4 (WebAssembly), 1 Aug 2026, with the Node.js binding at 0.8.3; 0.7.0 in Jan 2026; work in progress | Engine in Rust, with WebAssembly, Node.js and Python bindings; about 500 functions; XLSX read and write; a React workbook UI | Position-based change queues; doesn't merge concurrent edits | **Recommended engine** |
| HyperFormula | GPL-3.0 or commercial | 3.5.0, 9 Oct 2026; active | Engine in TypeScript; 400+ functions; undo; named expressions; no XLSX; no UI | None | Fallback engine if a commercial licence is bought |
| Formula.js | MIT | 4.6.1, 28 Jul 2026 | Function implementations only: no parser, cell references or recalculation | None | Not enough on its own |
| FortuneSheet | MIT | 1.0.4, 6 Nov 2025; no release since | React grid and engine; XLSX through a separate plugin | JSON patches addressed by row and column position, so concurrent inserts put edits in the wrong cells | No |
| x-spreadsheet; wolf-table | MIT | 1.1.9 (May 2021); 0.0.3 (Mar 2024); inactive | Canvas grid | None | No |
| Hearth demo engine (`sheets/formula.ts`) | Hearth's own | Demo | 12 functions, cycle detection, tests | Not applicable | Replace; keep its tests as seed cases |

**Comparison: file formats and export**

| Library | Licence | Status, October 2026 | Use in Hearth |
|---|---|---|---|
| IronCalc XLSX reader and writer | MIT or Apache-2.0 | Ships with the engine | XLSX import and export, on the server |
| SheetJS Community Edition | Apache-2.0 | npm `xlsx` stuck at 0.18.5 (Mar 2022), affected by CVE-2023-30533 and CVE-2024-22363; fixed releases only on the SheetJS CDN | Only for .xls or .ods import, installed from the CDN |
| ExcelJS | MIT | 4.4.0, 19 Oct 2023; no release in three years | Don't depend on it |
| PptxGenJS | MIT | 4.0.1, 26 Jun 2025 | PPTX export |
| pptxtojson | MIT | 2.2.0, 19 Sep 2026 | Opening PPTX files as decks (best effort); extracting text for search |
| PPTist | AGPL-3.0 (Vue) | Active | Reference only: AGPL licence and a different UI framework |
| Gotenberg | MIT | 8.37.0, 11 Sep 2026; ARM64 images | PDF export; Office file previews (FILE-04) |

**Data model on Yjs**

Sheets:
- One Yjs document per sheet file. Each tab holds:
  - an ordered list of row IDs and an ordered list of column IDs;
  - a map of cell input, keyed by `rowId:colId`;
  - a separate map of cell formats;
  - row and column settings: height, width, hidden and frozen;
  - merges, validation and conditional-formatting rules, and protected ranges, stored against row and column IDs so they move with their cells.
- Formulas are stored with references to row and column IDs and shown in A1 form. Inserting, deleting, moving or sorting rows changes only the order lists, never cell keys or formulas. So concurrent edits land in the right cell (SHEET-25). A reference to a deleted row or column becomes #REF!.
- Values and formats are stored apart, so a format change never overwrites someone's concurrent edit of the value.
- Rows, columns, tabs and slides are ordered by fractional-index keys, the technique Figma and Linear use. Yjs has no move operation, and a concurrent move done as delete-and-insert can duplicate a row or slide.
- The Yjs document is the source of truth, including merges and conditional-formatting rules. The adapter writes them into IronCalc's model only for evaluation and XLSX export.
- Computed values are never written to the shared document. Each browser computes its own, and the server computes the copy used for search and AI. TODAY and NOW take the server's time (SHEET-15), so both get the same values.
- Personal filters (SHEET-19) are not in the shared document at all; they live in the person's browser. Named filter views (SHEET-19, P1) are stored on the server, outside the shared document, with the sheet's permissions.
- In v1 a formula can refer only to tabs in the same file. Cross-file references aren't supported, and nor are functions that reach outside the file (external links, WEBSERVICE, INFO) (SHEET-12).

Slides:
- One Yjs document per deck. It holds the slide order keys and, for each slide:
  - its layout;
  - a map per element: type, position, size and style;
  - a shared text (Y.Text) for each text box, table cell and the speaker notes;
  - image references.
- Theme and layout choices are single values, and the last write wins. So does moving or resizing one element (SLIDE-22).
- Images added to a deck are stored with it and inherit its permissions (SLIDE-07), as attachments do in chat (CHAT-06).
- When a deck is presented to a room (SLIDE-16), the server sends followers each slide as it is shown, over Hearth's own WebSocket connection for the room (B.2), never through LiveKit data messages and never the whole deck (SLIDE-18). Slide content therefore stays in Hearth's AWS account and doesn't reach LiveKit Cloud (PDPA-10). The recorder keeps the slide timeline and a copy of each slide shown (SLIDE-19).

**Server-side calculation (Rule 1)**
- A sheet calculation worker runs about 5 s after edits pause, and at most once every 30 s per sheet while editing continues, so computed values reach AI within BRAIN-09's 2 minutes. It loads the latest saved Yjs state, evaluates it with IronCalc's Node.js binding, and stores the computed values by cell ID.
- Indexing re-indexes only rows whose displayed values changed, and embeds at most a capped number of rows per sheet for semantic search (e.g. the first 10,000); the rest are keyword-indexed only. The spike measures the worker's throughput and the embedding cost (§9.6).
- Search, the Org Brain, the assistant, agents, Drive thumbnails and exports all read these values. Values sent by a browser are never indexed: a client could send wrong values, and Viewers can't write (SHEET-44).
- The browser and the worker run the same pinned IronCalc version, built from one source tag (see Trade-offs).
- NOW and TODAY use the file's time zone (default Asia/Singapore, SHEET-15). Sheets that use volatile functions are recalculated at least daily.
- Each run has a time and memory budget, e.g. 30 s and 2 GB. If a sheet goes over budget:
  - its last good values stay in the index;
  - AI answers about it say the values may be out of date;
  - its owner sees a notice.
- AI answers about a sheet use the engine for arithmetic. The model picks ranges and formulas, the worker evaluates them, and the answer cites the cells (Principle 5, SHEET-38). Cell text, comments and speaker notes are data, never instructions (Rule 8).
- When a sheet opens, the grid first shows the server's last computed values. It switches to live values once the local engine is ready.
- Formulas can't reach other files or the network. So a computed value never carries content from outside its own file, and needs no access check beyond the file's own (Rules 1 and 3).
- Every part of this runs inside Hearth's AWS account in Singapore, so Sheets and Slides add no provider to the transfer register (PDPA-10).

**Import and export**

| Format | v1 approach | Notes |
|---|---|---|
| XLSX import (SHEET-30, SHEET-31) | IronCalc's reader runs in the file worker and converts the file into a new Hearth sheet, with merges, comments and tables; Hearth reads validation, hyperlinks and the other features IronCalc lacks from the same file | SHEET-31 sets what is kept and dropped, and the import report lists it. The original stays in the Drive. |
| XLSX and CSV export (SHEET-32) | IronCalc's writer, plus Hearth's own features (validation, protection, links, comments as notes); CSV in Hearth's code | Exports both formulas and computed values. |
| PPTX export (SLIDE-28) | PptxGenJS in the file worker | One slide master per layout and theme; speaker notes and alt text included. PptxGenJS 4.0.1 can't embed fonts, so the file names the theme fonts and PowerPoint substitutes any that aren't installed. |
| PPTX import (SLIDE-27) | Uploaded decks get a preview (FILE-04) and searchable text (FILE-06). "Open as deck" uses pptxtojson to read each slide's elements into Hearth's slide model. | Best effort, with a slide-by-slide report of what was simplified. The original stays in the Drive. |
| PDF (SHEET-32, SLIDE-28) | Gotenberg's Chromium renders the same HTML the app shows | Decks: one page per slide, speaker notes optional. Sheets: the current tab, fitted to the page width. |

**Build sequence**
- Build Sheets and Slides in M5b, after the Docs P0s in M5. They reuse the Docs work: sync server, permissions, version history, comments and Drive.
- Run the Sheets spike first, since Sheets carries the risk. Then build Slides, the smaller job, which grows from the demo renderer. Then build Sheets. Build present to the room (SLIDE-16 – SLIDE-19) last, so it can move to v1.x under the cut line (§11) without leaving half-built work.
- The spike takes about two weeks. Each item has a pass bar:
  - (a) **Speed.** IronCalc in a Web Worker meets the SHEET-34 targets on desktop and on the reference phones and 4G profile (§9.2), for the 100,000-cell reference workbook and the lookup-heavy workbook, including dependency-based recalculation if it is needed (R15). Yjs load time and the sync server's memory per open sheet stay within the B.6 sizing at the SHEET-33 limits.
  - (b) **Fidelity** (Q16). Every SHEET-08 function matches the values Excel saved in the test suite. At least 95% of formula cells in the 27 openly licensed workbooks in `spike/sheets-corpus/` (chosen instead of the org's own files) match Excel's saved values, and the import report lists every cell that doesn't. Every slide of the spike's set of decks opens, with its text and speaker notes, and the report lists every simplification.
  - (c) **Grid.** A virtualised grid at 390 px wide passes the SHEET-47 checks for keyboard, selection, copy and paste with NVDA on Windows and VoiceOver on Mac and iPhone; the page never scrolls sideways; and scrolling meets SHEET-34.
  - (d) **Merging.** Zero lost or misplaced edits across 10,000 randomised runs of concurrent inserts, deletes, sorts and moves on the Yjs models.
  - (e) **Estimate.** A build estimate in days for the M5b P0s, including the features IronCalc lacks in import and export, the worker's throughput and the embedding cost. This sets the M5b cut line (§11).
- If (a) fails on calculation, add dependency-based recalculation (R15) and run (a) again. If (a) fails on scrolling, or (c) fails, move the grid to Univer's open-source Sheets editor bound to the Yjs model.
- If (b) shows that functions the org relies on are missing, add them to IronCalc upstream or switch the adapter to HyperFormula under a commercial licence.
- Record the engine and grid choice as a decision once the spike ends (Q21).

## Appendix C — What we take from each reference product

| From | We take | We leave |
|---|---|---|
| **RocketChat / Slack** | Channels, threads, mentions, permissions, channel browser, pinned messages | Sectioned sidebar complexity (replaced by a WhatsApp-style unified list) |
| **Discord** | Always-open voice rooms, room presence, screen share, playful liveliness | Gamer aesthetics, servers-within-servers |
| **WhatsApp** | Unified chat list, voice notes, read ticks, phone-first simplicity | Personal-account mixing, no org control |
| **Google Docs, Sheets, Slides / Drive** | Co-editing, permission levels, comments, version history, drive sharing; a familiar spreadsheet grid and formulas; simple slide layouts and present mode | Add-ons and Apps Script, and full Excel or PowerPoint parity (§3.2) |
| **Excel / PowerPoint** | Excel's function definitions, keyboard, and number formats; XLSX and PPTX import and export; presenter view | Macros and VBA, pivot tables, external data connections, slide masters and animations |
| **OpenDots** | Specialist agents, approvals, schedules, visible memory, agents as coworkers | Single-owner model, agent computers (post-v1), CopilotKit Intelligence dependency |

## Appendix D — Glossary

| Term | Meaning |
|---|---|
| **Org Brain** | The permission-aware index and knowledge graph of all org content. |
| **Room** | A persistent drop-in voice room, usually attached to a channel. |
| **Session** | A period when 2+ humans are together in a room or call; every session is recorded. |
| **Meeting** | A scheduled calendar event; it has its own room by default. |
| **Restricted room** | A room whose sessions are visible only to participants (plus audited privileged access, Rule 9) and never indexed. |
| **Personal assistant** | Each user's private, suggest-only AI. |
| **Specialist agent** | A named AI teammate built by the central AI team. |
| **Actionable** | A suggested next step on the user's Today view. |
| **Participation level** | How freely an agent may speak in a channel: Off, Mention only, Suggest, Active. |
| **Suggest card** | A small, dismissible card that offers an agent's unprompted answer. |
| **Audience** | Everyone who can see a shared space; bounds what an AI may say there (Rule 2). |
| **Agent Studio** | The central AI team's tool for building and publishing agents. |
| **People insights** | Activity rankings and trends (messages, talk time, room time, tasks) for leadership and admins; each person sees their own (ADM-14). |
| **Drive** | The one place where docs, sheets, slide decks, uploaded files, and folders live (D38). |
| **Sheet** | A Hearth spreadsheet, edited together in real time (§8.7). |
| **Deck** | A Hearth slide presentation, edited together and shown in present mode (§8.8). |
| **Presenter view** | What the person presenting a deck sees: the current and next slide, speaker notes, and a timer (SLIDE-15). |
| **Present to the room** | Showing a deck in a room or call so each participant's device draws the slides, instead of sharing a screen; the slides shown are kept with the session (SLIDE-16 – SLIDE-19). |

## Appendix E — References

- OpenDots (CopilotKit): https://github.com/CopilotKit/OpenDots
- Rocket.Chat: https://github.com/RocketChat/Rocket.Chat
- AG-UI protocol: https://docs.ag-ui.com/introduction
- LiveKit: https://github.com/livekit/livekit
- Yjs: https://github.com/yjs/yjs

**Sheets and Slides engines (B.7)**, accessed 11 Oct 2026:

- Univer: https://github.com/dream-num/univer
- Univer Pro integration notes (Pro features, evaluation mode, collaboration server): https://github.com/dream-num/univer-sdk-skills
- Univer Pro deployment: https://docs.univer.ai/guides/pro/deploy
- IronCalc: https://github.com/ironcalc/IronCalc
- HyperFormula: https://github.com/handsontable/hyperformula
- Formula.js: https://github.com/formulajs/formulajs
- FortuneSheet: https://github.com/ruilisi/fortune-sheet
- x-spreadsheet: https://github.com/myliang/x-spreadsheet
- wolf-table: https://github.com/wolf-table/table
- SheetJS Community Edition: https://git.sheetjs.com/sheetjs/sheetjs
- SheetJS advisory CVE-2023-30533: https://cdn.sheetjs.com/advisories/CVE-2023-30533.html
- ExcelJS: https://github.com/exceljs/exceljs
- PptxGenJS: https://github.com/gitbrent/PptxGenJS
- pptxtojson: https://github.com/pipipi-pikachu/pptxtojson
- PPTist: https://github.com/pipipi-pikachu/PPTist
- Gotenberg: https://github.com/gotenberg/gotenberg
- Hocuspocus: https://github.com/ueberdosis/hocuspocus
- TipTap: https://github.com/ueberdosis/tiptap
- Fractional indexing (Figma): https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
- Moving elements in Yjs lists: https://discuss.yjs.dev/t/moving-elements-in-lists/92
- AWS price list, Amazon ECS, ap-southeast-1: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-southeast-1/index.json
