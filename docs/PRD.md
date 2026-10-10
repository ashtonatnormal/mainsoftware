# Hearth — Product Requirements Document

> **Hearth** is the product's name (D33): a hearth is where people gather.

| | |
|---|---|
| **Status** | Draft v0.2 — for review |
| **Date** | 2026-10-10 |
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

Hearth is a complete work suite — chat, drop-in voice rooms, meetings, calendar, tasks, docs and wiki, and files — built from scratch around one idea: **AI agents are teammates.** Agents appear in the member list, have presence and status, can be @mentioned in channels, and sit in voice rooms alongside people.

Underneath the suite is the **Org Brain**: a permission-aware index of everything the organization says, writes, schedules, and decides. Every conversation in a voice room is recorded and transcribed, and substantive ones are turned into notes, so nothing said in a meeting is lost. Every person gets a private **personal assistant** that knows everything *they* are allowed to see, tells them what needs their attention, and drafts what they need — but never acts on their behalf. A **central AI team** builds a curated set of **specialist agents** that answer questions and do work in channels.

The first customer is our own organization (250–1,000 people, a mix of desk and mobile workers) moving its work communication off WhatsApp. The product is built internal-first, with architecture choices that keep the door open to selling it to other organizations later.

**v1 ships:** a phone-friendly, installable web app containing chat, voice rooms and meetings (with universal recording, transcription, and notes), the personal assistant, calendar, tasks, docs and wiki, files, a first set of specialist agents, and an admin console.

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
| **Google Docs** | Real-time co-editing, permissions, comments, version history. |
| **OpenDots** (CopilotKit) | Persistent AI coworkers with roles, tools, memory, schedules, and human approval before actions. OpenDots is single-owner; Hearth's main new work is making this model multi-user and permission-safe. |

## 3. Goals and non-goals

### 3.1 Goals (v1)

| # | Goal |
|---|---|
| G1 | **Replace WhatsApp for all work communication** across the organization. |
| G2 | **Capture every meeting**: every voice session is recorded and transcribed, and substantive sessions (D27) are summarized with decisions and action items extracted. |
| G3 | **Give every person an assistant** that knows the org's context (within their access) and tells them what needs doing. |
| G4 | **One suite** for chat, meetings, calendar, tasks, docs, and files — no other tool required for internal work. |
| G5 | **The AI never leaks**: it never shows anyone something they could not open themselves. |
| G6 | **Easy and delightful**: someone who has only used WhatsApp is productive on day one. |

### 3.2 Non-goals (v1)

| Non-goal | Why / when |
|---|---|
| External guests and shared channels | Internal only in v1 (D15). Post-v1. |
| Email | Not planned. Keep existing email. |
| Spreadsheets and slides | Docs first (D22). Post-v1. |
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
| **Desk worker** | Ops, finance, design, engineering; laptop all day | Follow several channels without drowning; find past decisions; write docs together; run and attend meetings. |
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
| **More** | Calendar · Docs · Files | Remaining modules. |

A single **Search & Ask** bar sits at the top everywhere: type to search, or ask a question in plain language.

Your avatar (phone: top bar; desktop: bottom of the rail) opens **Profile** (ACC-08), **Settings** (notifications NOTIF-03, devices ACC-04, assistant memory PA-10, privacy notice PDPA-02), and **Help** (short how-to guides, the DPO contact and question-and-complaint form from PDPA-13, and Report a problem to admins). Admins also get a link to the admin console (ADM-01).

### 6.2 Key journeys

**J1 — Morning catch-up (mobile worker).** Opens Hearth on the phone. *Today* shows: "Since yesterday: 3 things need you." A reply owed to a lead, an action item from yesterday's standup due today, and a schedule change in #north-site. Each has an *Open* button and, for the reply, a ready-made draft they can edit and send. Total time: under a minute.

**J2 — Drop-in room.** A designer sees two teammates in the *Design* room and taps in. The room shows a recording indicator; a short notice says "This room is recorded and transcribed." They share their screen, sort out a layout question in four minutes, and leave. Because it was short and had no decisions, nothing is posted — the transcript is stored and searchable.

**J3 — Scheduled meeting → notes → tasks.** A team lead schedules "Q4 launch review" from Calendar; it gets its own meeting room. Before the meeting, each attendee's assistant shows a prep brief (agenda, related threads, open action items from last time). The meeting is recorded and transcribed. Within five minutes of ending, notes with a summary, decisions, and action items are posted to the meeting's thread. Each owner sees their action items as suggested tasks in *Tasks* and accepts them with one tap.

**J4 — Asking the org.** A new joiner types "who owns the vendor onboarding process and what's the latest?" into Search & Ask. The assistant answers with the owner's name, a summary of last week's discussion, and the current wiki page — each claim linked to its source — using only content the new joiner can access.

**J5 — A specialist agent in a channel.** In #ask-hr, someone asks how many leave days carry over. The *HR Policy* agent (built by the central AI team) shows a small card: "HR Policy has an answer from the Leave Policy page · Show." The asker expands it, gets the answer with a link, and reacts 👍.

**J6 — Writing together.** Two leads co-write a proposal in Docs, see each other's cursors, leave comments, and restrict editing to the two of them while the rest of the team can comment. A week later, someone uses version history to see exactly what changed after the review meeting.

## 7. AI architecture and trust model

This section is the heart of the product. Module requirements in §8 depend on it.

### 7.1 Four layers

| Layer | What it is | Whose access it uses | Examples |
|---|---|---|---|
| **0. Org Brain** | Index and knowledge graph of messages, transcripts, notes, docs, tasks, events, files, and the people directory. Every item keeps its source permissions. | Always filtered by whoever is asking | "Project Atlas" linked to its channel, decisions, owner, docs |
| **1. Built-in AI** | Features with no persona | The viewer's | Catch-up, meeting notes, voice-note transcripts, smart search |
| **2. Personal assistant** | One per person, private, suggest-only (D16) | Exactly that person's | Today view, Ask, drafts, meeting prep |
| **3. Specialist agents** | Named agents built only by the central AI team (D6) | Agent's granted scope ∩ the asker's access ∩ the audience of the space it answers in | HR Policy, IT Helpdesk, Onboarding Buddy, Weekly Digest |

The personal assistant is the default way to ask anything. Once delegation ships (PA-11), it routes questions to specialist agents so users never need to know which agent to ask; until then, people reach agents by @mention or DM.

### 7.2 Access rules

These are product requirements, stated formally so they can be tested.

**Rule 1 — Mirror access.** For any AI response to user *U*, every source used must be one *U* could open directly at that moment.

**Rule 2 — Audience bound.** When an AI response is posted into a shared space *S* (channel, thread, room side panel), every source used must also be visible to **every current member of *S***.
Allowed sources = `AgentScope ∩ Access(asker) ∩ Access(every member of S)`.
For scheduled or event-triggered runs, which have no asker: `AgentScope ∩ Access(every member of S)`. The agent owner's or an admin's access is never used.
*Example:* the CFO asks the Finance agent about Q3 numbers in #general; the agent answers at #general's level. In a DM with the CFO, it can say more.

**Rule 3 — Derived content inherits restriction.** Anything the AI produces from sources (summaries, notes, entities, digests) records its provenance and is visible only to people who can see **all** of its sources. In practice, derived content is generated per scope (e.g. a channel summary is computed from that channel only and visible to its members).

**Rule 4 — DMs stay private.** Human-to-human DMs and group DMs are indexed only for their participants' personal assistants. Specialist agents never read them. A DM *with* an agent is visible to that agent.

**Rule 5 — Restricted rooms are not indexed.** Sessions in restricted rooms (D11, e.g. HR, performance 1:1s) are still recorded, transcribed, and summarized, but are visible only to participants; the only other access is privileged access (Rule 9). They are never added to the Org Brain. A participant's assistant can use one only when the participant explicitly opens it and asks about it. Anything derived from a restricted session (notes, action items, suggested tasks, decisions, entities) inherits the restriction: suggested tasks are visible only to their owner; an accepted task stays private and unindexed unless the owner shares it; meeting prep briefs (PA-06) never include restricted-session content automatically; and agents cannot be invited to restricted rooms.

**Rule 6 — Revocation is fast.** When someone loses access (leaves a channel, is removed from a doc, is offboarded), the AI stops using that content for them within **60 seconds**. Access is re-checked against live permissions at answer time, not only at index time.

**Rule 7 — Deletion propagates.** Deleted or edited content is removed or updated in the Org Brain within **5 minutes**, and derived content that depended on it is regenerated or withdrawn.

**Rule 8 — Content is data, not instructions.** Text found in messages, docs, files, or transcripts never changes an agent's instructions or permissions. An agent may not take a write action solely because retrieved content told it to.

**Rule 9 — Privileged access is audited and never feeds AI.** The Compliance Officer (ADM-12) and the DPO (PDPA-13) may search and read content they could not otherwise open, including DMs and restricted sessions, only through their dedicated consoles, only against a logged case (an access, correction, or withdrawal request, an incident, or an investigation), and only with a stated reason. Every read is logged. This path bypasses the Org Brain and is never available to any AI feature.

### 7.3 Who can do what

| | Read | Post in channels | Create/change tasks, docs, events | Send on a user's behalf |
|---|---|---|---|---|
| **Personal assistant** | Everything the user can see | ✗ (drafts into the user's composer) | ✗ (suggests; user accepts) | ✗ never |
| **Specialist agent** | Its scope, bounded by Rules 1–2 | ✓ where its participation level allows | Only with approval from the invoking person (or, for scheduled runs, the agent's named owner) | ✗ never |
| **Built-in AI** | Viewer's access | Only meeting notes, where REC-13 allows | Suggested tasks only (owner accepts) | ✗ never |

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
| ACC-05 | **Offboarding:** deactivating a user signs them out everywhere within 60 seconds and revokes all access. Org content they created is kept under retention (PDPA-09); ownership of their docs, files, channels, and wiki pages transfers to their manager or team; their personal memory is deleted; their assistant conversations are kept only for their retention period. Former members make PDPA requests through the DPO's published contact (PDPA-13). | P0 |
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
| CHAT-06 | **Attachments**: images, video, documents; inline previews; files are stored in Files and inherit the conversation's permissions. | P0 |
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
| ROOM-03 | In-room controls: mute, camera on/off, **screen share**, speaker/output selection, raise hand, reactions, leave. | P0 |
| ROOM-04 | **Speaking indicators** and a participant grid that adapts to phone and desktop. | P0 |
| ROOM-05 | Rooms support **up to 50 participants** (P0) and **100** (P1). | P0 |
| ROOM-06 | **Room text panel**: the attached channel (or a room thread) shown alongside the call. | P0 |
| ROOM-07 | **DM and group-DM calls**: one tap to call from a conversation; these are sessions too. | P0 |
| ROOM-08 | **Push-to-talk** option and noise suppression. | P1 |
| ROOM-09 | Join from a phone browser. On Android Chrome, room audio keeps running with the screen locked or another app open, with a notification to mute or leave. Where the platform suspends audio (expected on iOS), others see the person as disconnected within 10 seconds and the person gets a push: "You left <room> — tap to rejoin." Behaviour per browser is measured on real devices in M2 (R11). Rooms joined from a phone start muted. | P0 |
| ROOM-10 | ~~Live captions~~ — **removed** (D31). If ever wanted, a running transcript could be shown at no extra transcription cost, because speech is already transcribed passage by passage during the session (REC-10); it would lag by roughly the length of each spoken passage. | — |
| ROOM-11 | **Agents in rooms**: agents can be invited to a room (never a restricted room, Rule 5); they show cards in the side panel (related docs, answers when addressed in the room text panel) and **never speak aloud in v1** (real-time speech is ROOM-12; D7 forbids unprompted speech even then). | P1 |
| ROOM-12 | Agents and the assistant that **speak in real time** in rooms. | P2 |

#### Recording policy and notice

| ID | Requirement | Pri |
|---|---|---|
| REC-01 | A **session** begins when 2 or more humans are in a room or call. While fewer than 2 remain, recording and transcription pause; if a second person joins or reconnects within 2 minutes (configurable), the same session continues, otherwise it ends at the moment the count dropped below 2. The transcript, notes, and the 5-minute test (REC-11) cover the whole continued session, with the paused span shown as a gap. Agents do not count toward the threshold. | P0 |
| REC-02 | **Every session is recorded and transcribed** (D10). Audio always; video and screen share when on. Each participant's audio, and any camera or screen-share track, is recorded as its own file on a shared session clock (including mute and reconnect gaps). These per-track files are the only stored recording: playback (REC-16) mixes them on demand, so no stored mix keeps audio that was later redacted (REC-18) or withdrawn (PDPA-04a). Screen-share audio is not transcribed. | P0 |
| REC-03 | Recording behaviour is an **org-level policy setting** (default for our org: *all sessions, no exceptions*) so future customers can choose differently (D1, D26). | P0 |
| REC-04 | There is **no participant opt-out** under our org's policy (D11). The only carve-out is legal: if the DPO records a purpose as consent-based (PDPA-01) and a person withdraws, Hearth applies PDPA-04a to that person. | P0 |
| REC-05 | A **recording indicator is always visible** in every room and call UI. | P0 |
| REC-06 | Joining a room or call shows a **notice** ("This session is recorded and transcribed") and plays a distinct join tone. | P0 |
| REC-07 | Admins and Compliance Officers can designate **restricted rooms** (e.g. HR, performance 1:1s, legal). Restricted sessions are recorded and transcribed but follow access Rule 5 (participants only; not indexed). Restricted rooms show a distinct badge. | P0 |
| REC-08 | Calls that include anyone outside the org are out of scope for v1 (internal only, D15); external participant consent is a P2 requirement. | P2 |

#### Transcripts, notes, and action items

| ID | Requirement | Pri |
|---|---|---|
| REC-10 | **Speaker-attributed transcripts** for every session, available within 5 minutes of the session ending (typically under 1 minute, because speech is transcribed while the session is still running). Each spoken passage carries its start and end time. Word-by-word timestamps are not in v1. | P0 |
| REC-11 | **Meeting notes** are generated for sessions that are substantive: ≥5 minutes long, **or** containing a detected decision or action item (D27). Shorter sessions are transcribed and searchable but post nothing. | P0 |
| REC-12 | Notes include: a short summary, **decisions**, **action items** (owner, due date if stated), open questions, and links to transcript timestamps. | P0 |
| REC-13 | Notes are **posted only where the readers exactly match the session's audience** (REC-20): a channel's room → the session's thread in that channel; a standalone room → a session thread in the room's text panel; a scheduled meeting (including one held in a team room) → the meeting's own thread on its event page; a DM or group-DM call → the conversation if every member took part, otherwise a participants-only thread; a restricted room → never posted, only on the session page for participants. | P0 |
| REC-14 | Action items become **suggested tasks** for their owners, who accept, edit, or dismiss them (TASK-06). Items from restricted sessions stay private (Rule 5). | P0 |
| REC-15 | Participants can **correct notes and transcripts** (edits are versioned and attributed; the original machine output is kept, PDPA-07). Corrected names and terms can be proposed for the org vocabulary (REC-19) with one tap; proposals are cleaned on entry and take effect only after an admin approves them. Proposals from restricted sessions show the admin only the term and are flagged as coming from a restricted source. | P0 |
| REC-16 | **Playback** page: audio/video player synced with the transcript; click a line to jump; search within the transcript. | P0 |
| REC-17 | **Ask this meeting**: ask questions about a session from its page (answers cite timestamps). | P1 |
| REC-18 | **Transcript redaction**: Compliance Officers and the DPO can redact a passage (e.g. an accidentally spoken password). Redaction removes it from every transcript version, including the original machine output (an exception to PDPA-07), silences the same span in the stored audio/video, and propagates to notes and the Org Brain. The redaction record keeps who, when, and why, but not the redacted content. | P1 |
| REC-19 | **Org vocabulary**: transcription is given the names and terms likely to come up: participants' names, the channel and meeting title, recent transcript lines, and an admin-maintained glossary (people, products, projects, places, acronyms). This is how Hearth gets names and internal jargon right. Each request sends a capped list (cap set in the spike, e.g. 100 or fewer): participants' names, terms from the channel or meeting title, and the highest-priority glossary terms tagged to that team or channel (admins can mark terms org-wide). For voice messages: the sender plus all members of a DM or group DM; in channels, the sender, people @mentioned in the thread, and the most recent active posters, up to the cap. | P0 |

#### Access and retention

| ID | Requirement | Pri |
|---|---|---|
| REC-20 | Default **audience of a session's recording, transcript, and notes**: room session → members of the room's channel, or of a standalone room (public = whole org; the DPO confirms this under Q3/Q8); scheduled meeting, including one held in a team room → invitees + participants; DM/group call → participants; restricted room → participants only (plus Rule 9 access). | P0 |
| REC-21 | **Access log**: every view of a recording, transcript, or notes is logged. Participants can see a **"viewed by"** list for sessions they were in. Views made under privileged access (Rule 9) appear in the list only if Q10 is answered yes; until then they are recorded only in the audit log. | P0 |
| REC-22 | **Retention** (D12): audio/video kept **120 days** by default (admin-adjustable, D36); transcripts and notes kept for a finite, admin-set period (proposed 3 years, PDPA-09). Legal hold overrides deletion (ADM-08). | P0 |
| REC-23 | Participants cannot delete recordings, transcripts, or notes. They are deleted only by the retention engine (PDPA-09), by the DPO acting on a request (PDPA-04, PDPA-05), or by redaction (REC-18); every deletion is logged. | P0 |

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

| ID | Requirement | Pri |
|---|---|---|
| DOC-01 | **Rich-text documents**: headings, lists, checklists, tables, images, code blocks, links, @mentions, embeds of tasks and files. | P0 |
| DOC-02 | **Real-time co-editing** with live cursors and presence, and offline-tolerant sync. | P0 |
| DOC-03 | **Permissions per document**: Viewer, Commenter, Editor, Owner — granted to people, teams, or the whole org. **Restricted editing**: owners can limit editing to specific people while others view or comment (D19). | P0 |
| DOC-04 | **Version history**: see every change with author and time, compare any two versions, and restore an earlier version (D19). | P0 |
| DOC-05 | **Comments** anchored to text, with @mentions, replies, and resolve. | P0 |
| DOC-06 | **Suggestion mode** (tracked changes that the owner accepts or rejects). | P1 |
| DOC-07 | **Wiki spaces** per team and an org-wide space, with nested pages, a sidebar tree, and space-level permissions. | P0 |
| DOC-08 | **Templates**: meeting notes, project brief, policy page, onboarding guide. | P1 |
| DOC-09 | **Inline AI writing**: draft, rewrite, or summarize a selection (translation is post-v1, AMB-05); the user accepts each suggestion before it enters the document (D16). | P1 |
| DOC-10 | **Save to doc** from meeting notes and from assistant answers. | P1 |
| DOC-11 | Export to PDF, DOCX, and Markdown. | P1 |
| DOC-12 | Spreadsheets. | P2 |
| DOC-13 | Slides. | P2 |

### 8.7 Files

| ID | Requirement | Pri |
|---|---|---|
| FILE-01 | **Drive** with My Files, Shared with me, and team folders. | P0 |
| FILE-02 | Upload (including from phone camera/gallery), download, folders, move, rename, star. | P0 |
| FILE-03 | **Sharing permissions** matching Docs (Viewer/Commenter/Editor/Owner; people, teams, org). | P0 |
| FILE-04 | **Previews** for images, video, audio, PDF, and common office formats. | P0 |
| FILE-05 | **File versions**: upload a new version, see and restore old ones. | P1 |
| FILE-06 | Text extracted from files is **indexed** for search and the Org Brain, under the file's permissions. | P0 |
| FILE-07 | Storage quotas per user and team, configurable by admins. | P1 |
| FILE-08 | Files attached in chat appear in a per-conversation "Shared files" view. | P0 |

### 8.8 Search and Ask

| ID | Requirement | Pri |
|---|---|---|
| SRCH-01 | **One bar everywhere** for search and questions. | P0 |
| SRCH-02 | **Keyword search** across messages, transcripts, notes, docs, tasks, events, files, people, and channels, with filters (type, person, channel/space, date). | P0 |
| SRCH-03 | **Ask**: a plain-language question returns an AI answer at the top with **citations** for every claim, followed by search results. Follows Rules 1–8 through the shared retrieval layer (B.4). | P0 |
| SRCH-04 | Results and answers never include content the searcher cannot open (Rule 1). | P0 |
| SRCH-05 | "**Who knows about X**": suggests people based on content the asker can see. | P1 |
| SRCH-06 | Jump-to (quick switcher) for channels, people, docs. | P0 |

### 8.9 Org Brain

| ID | Requirement | Pri |
|---|---|---|
| BRAIN-01 | **Indexes**: messages (incl. threads), voice-message transcripts, session transcripts and notes, docs and wiki pages, tasks, calendar events, file text, and the people directory. | P0 |
| BRAIN-02 | Each indexed item stores its **access-control list**; retrieval filters by the asker's access and re-checks against live permissions before use (Rules 1, 6). | P0 |
| BRAIN-03 | Restricted-room sessions are **excluded** (Rule 5). | P0 |
| BRAIN-04 | Deletes and edits propagate within 5 minutes; derived content is regenerated or withdrawn (Rule 7). | P0 |
| BRAIN-05 | **Entities**: people, teams, projects, and decisions extracted and linked to their sources; each entity view shows only what the viewer can access. | P1 |
| BRAIN-06 | **Decision log**: decisions extracted from meetings and threads, browsable per team and project, each linked to its source. | P1 |
| BRAIN-07 | **Per-scope summaries** (channel daily/weekly, team weekly) generated within each scope (Rule 3). | P1 |
| BRAIN-08 | Provenance is recorded for every derived artifact (Rule 3). | P0 |
| BRAIN-09 | Index freshness: new content searchable within 30 seconds; available to AI within 2 minutes. | P0 |

### 8.10 Built-in AI features

| ID | Requirement | Pri |
|---|---|---|
| AMB-01 | **Catch me up** on any channel, thread, or doc since the user last looked. | P0 |
| AMB-02 | Meeting notes and action items (REC-11 – REC-14). | P0 |
| AMB-03 | Voice-message transcripts (CHAT-07). | P0 |
| AMB-04 | ~~Live captions~~ — removed (D31). | — |
| AMB-05 | **Translate** a message or doc for the reader. Post-v1, because v1 is English only (D29). | P2 |
| AMB-06 | Every AI output shows an "AI" marker, its sources, and 👍/👎 feedback. | P0 |

### 8.11 Personal assistant

| ID | Requirement | Pri |
|---|---|---|
| PA-01 | Every user has **one private assistant**, reachable from Today, Search & Ask, and as a pinned conversation in Chats. | P0 |
| PA-02 | **Reads everything the user can see** (Rule 1) including their DMs (Rule 4). | P0 |
| PA-03 | **Suggest-only (D16)**: the assistant never sends messages, edits or creates documents, creates or changes tasks or events, RSVPs, or deletes anything. Drafts go into the user's composer or editor for the user to send or save. | P0 |
| PA-04 | **Actionables** on Today, ranked by importance: replies owed, unanswered @mentions, action items assigned, tasks due, meetings needing prep, docs awaiting the user's review or comment. Each has *Open*, a ready-made *Draft* where relevant, and *Dismiss*. | P0 |
| PA-05 | **Catch-up digest**: "since you were last here" across the user's channels and meetings, with links. | P0 |
| PA-06 | **Meeting prep brief** before each scheduled meeting: agenda, related threads and docs, last meeting's notes, open action items between attendees. Restricted-session content is never included automatically (Rule 5). | P0 |
| PA-07 | **Ask** (SRCH-03) in a conversational thread with follow-ups. | P0 |
| PA-08 | **Drafting**: replies, announcements, doc sections, meeting agendas — always inserted for the user to edit and send. | P0 |
| PA-09 | **Proactive private nudges** (D7): e.g. "3 threads need your reply," "you have a meeting in 15 minutes — here's the brief." Delivered privately only; user controls frequency and quiet hours. | P0 |
| PA-10 | **Personal memory**: the user can see, edit, and delete everything the assistant remembers about them, and turn memory off. | P0 |
| PA-11 | **Delegation to specialists**: the assistant can route a question to a specialist agent and present its answer privately (Rule 2 applies with the user's DM as the audience). The assistant passes only the user's question, never content from DMs (Rule 4) or restricted sessions (Rule 5); the agent answers with `AgentScope ∩ Access(user)`. | P1 |
| PA-12 | **Share an answer** into a channel: the answer is regenerated at the channel's audience level (Rule 2), checking every source used, not only cited ones; anything that depends on sources outside the audience is removed before posting. | P1 |
| PA-13 | Users can rename their assistant and choose its avatar. | P2 |
| PA-14 | Voice conversation with the assistant. | P2 |

### 8.12 Specialist agents

| ID | Requirement | Pri |
|---|---|---|
| AGT-01 | Specialist agents are **created and published only by the central AI team** (AI Admin role) (D6). | P0 |
| AGT-02 | **Identity**: name, avatar, role description, owning team and a named owner (a person in that team), "Agent" badge, presence and a live status (e.g. "Writing weekly digest…"). | P0 |
| AGT-03 | **Playbook**: plain-language instructions describing the job, tone, and boundaries. | P0 |
| AGT-04 | **Knowledge scope**: which channels, wiki spaces, docs, and files the agent may draw from; always further bounded by Rules 1–2. | P0 |
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

### 8.13 Agent Studio (for the central AI team)

| ID | Requirement | Pri |
|---|---|---|
| STU-01 | Create and edit agents: identity, playbook, scope, tools, approval policy, schedules, triggers, default participation level. | P0 |
| STU-02 | **Test console** with **"view as user"**: run the agent as if invoked by a specific person in a specific channel, to verify Rules 1–2 before publishing. View-as runs against seeded test spaces and test users by default. When run as a real person, the AI Admin is treated as the audience (Rule 2): the answer shown uses only sources both the person and the AI Admin can open, and any other source the agent would have used is listed as withheld by type and an opaque ID, with no title or content. Each run is logged with the impersonated user (PDPA-06). | P0 |
| STU-03 | **Evaluation sets**: saved test questions with expected behaviour (including must-not-reveal cases); run before every publish. | P1 |
| STU-04 | **Versioning**: draft → published; roll back to any earlier version. | P0 |
| STU-05 | **Staged rollout**: publish to pilot channels before the whole org. | P1 |
| STU-06 | **Analytics**: invocations, 👍/👎, suggest-card open and dismiss rates, approvals, cost. | P1 |
| STU-07 | **Agent request intake**: any team can request an agent (purpose, channels, examples); requests are tracked to resolution. | P1 |

### 8.14 Admin, security, and compliance

| ID | Requirement | Pri |
|---|---|---|
| ADM-01 | **Admin console** (web) for all settings below. | P0 |
| ADM-02 | User management: roster import, add, deactivate, role assignment, device sign-out (ACC-03 – ACC-06). | P0 |
| ADM-03 | Team and channel governance: create/archive teams, transfer channel ownership, set who may create public channels. | P0 |
| ADM-04 | **Recording policy** setting (REC-03) and **restricted room** designation (REC-07). | P0 |
| ADM-05 | **AI settings**: default participation level, enable/disable AI features, model provider configuration, spend caps and alerts. Caps never stop session or voice-message transcription or meeting notes (D10); reaching a cap alerts admins and may pause only optional AI (Ask, catch-up, agents). | P0 |
| ADM-06 | **Audit log**: admin actions, sign-ins, permission changes, recording/transcript access, agent actions, privileged access (Rule 9). For each person, also AI retrievals of their content (assistant, built-in AI, agents), sends to external providers (by data type, not content), exports, and shares. Provider sends are logged once per person per session (and per voice message), per provider and data type, covering the session's speakers and participants; people only named in content, including glossary names sent as keywords, are covered by a standing entry in PDPA-10 rather than per request. AI retrievals are logged once per item retrieved. Kept at least 12 months (PDPA-09). Exportable. | P0 |
| ADM-07 | **Retention policies** per content type, using the retention engine (PDPA-09). | P0 |
| ADM-08 | **Legal hold** on users, channels, rooms, or sessions, overriding retention. The hold mechanism ships with the retention engine (M2); its management screens may follow. | P0 |
| ADM-09 | **Data export**: per user and whole org, in open formats. | P1 |
| ADM-10 | **AI kill switch**: disable one agent, all agents, or all AI features instantly. | P0 |
| ADM-11 | **Usage analytics**: active users, messages, sessions, AI usage and cost. | P1 |
| ADM-12 | **Compliance access** to restricted content follows Rule 9: a stated reason, a logged case, and an audit entry. Whether participants are notified is an open question (Q10). | P0 |
| ADM-13 | **Read receipts** and other org-wide behaviour toggles. | P1 |
| ADM-14 | **People insights** (D34). Owners, Admins, and the Leadership role see rankings and trends across the org, per person, team, and department, filterable by date range: messages sent and reactions given and received; talk time in rooms and calls (from each person's own audio track); time in rooms and meetings attended; tasks completed and meeting action items closed. Each person sees their own figures and trends in their profile, but no one else's. There are no public leaderboards, and team leads see team figures only if they also hold the Leadership role. Safeguards in PDPA-18. | P1 |

### 8.15 Notifications

| ID | Requirement | Pri |
|---|---|---|
| NOTIF-01 | **Push notifications** to the installed web app on phone and desktop (Web Push), and in-app. | P0 |
| NOTIF-02 | Defaults: DMs, @mentions, thread replies, meeting starting, task assigned/due, assistant nudges. Channels default to badge only. | P0 |
| NOTIF-03 | Per-conversation settings (all / mentions / off), **do not disturb**, and **quiet hours** tied to working hours. | P0 |
| NOTIF-04 | Smart batching: low-priority notifications grouped into the assistant's digest instead of separate pushes. | P1 |

### 8.16 Data protection (Singapore PDPA)

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
| PDPA-01 | **Processing register.** An admin page listing every purpose for which Hearth processes personal data, maintained by the DPO. Pre-filled with: recording scheduled meetings and calls; recording drop-in room sessions; transcribing sessions; AI meeting notes; showing session recordings, transcripts, and notes to people who weren't there (REC-20); Org Brain indexing; the personal assistant; specialist agents and their digests; voice-message transcription; people and expertise inference (SRCH-05, BRAIN-05); presence and read receipts; access logs and "viewed by" lists; security audit and monitoring; per-person AI cost figures; people insights (ADM-14); sensitive-data detection (PDPA-17); the transcription test set (§9.5); backups; accounts and sign-in (roster, phone numbers and one-time codes, devices, profiles); hosting and delivering messages, voice messages, docs, files, tasks, and calendar; built-in AI summaries and writing help (AMB-01, BRAIN-07, DOC-09, and CHAT-08 quick replies if AI-generated); and each overseas transfer. Each entry records its legal basis — employment exception; legitimate interests (assessment attached); business improvement (use only, not collection or disclosure); consent; deemed consent by conduct or contractual necessity; deemed consent by notification (s15A: assessment and opt-out window required); or another exception or legal requirement (provision cited) — plus its retention period and the providers involved. Hearth warns, without blocking, when a consent-type basis is chosen for a purpose the recording policy treats as no-opt-out, or business improvement for a collection or disclosure. | P0 |
| PDPA-02 | **Privacy and recording notice.** A versioned, plain-language notice generated from the register. It lists each purpose separately and covers: what is recorded (every session with 2+ people, including DM calls and drop-in rooms); what the AI does with it and who can ask about what; the legal basis for each purpose (for purposes relying on legitimate interests, a statement saying so and how to learn more); which purposes stop and which continue if someone withdraws consent; which providers receive data, in which countries they process it, and how long they keep it; retention for each data type; that providers do not train on the org's data; and the DPO's contact. Shown at onboarding and always available in Settings. | P0 |
| PDPA-03 | **Acknowledgment** (extends ACC-12). Nobody can use Hearth until they acknowledge the current notice. Hearth records who acknowledged, which version, when, and how. A change of purposes creates a new version, which everyone must acknowledge again. Records are exportable. | P0 |
| PDPA-04 | **Withdrawal and objection requests.** A self-service request form, plus requests the DPO logs from email or letter, routed to a DPO queue with a 10-business-day target (configurable). The register determines which purposes stop (consent-based) and which continue (exception-based), and Hearth drafts the reply explaining the consequences. Until PDPA-04a ships, no purpose whose withdrawal would need a per-person processing switch (recording, transcription, notes, voice-message transcription, Org Brain or AI use) may rely on consent or on deemed consent by notification (s15A); if Q3 concludes one must, PDPA-04a becomes P0. Purposes where a withdrawal is carried out by deleting the person's data, such as the transcription test set (§9.5), are exempt. The DPO handles withdrawals under a written manual procedure. | P0 |
| PDPA-04a | **Per-person processing switches**, available only to the DPO and only for purposes the register marks as consent-based, to carry out a withdrawal: stop recording the person's track; exclude their speech from transcripts and notes (shown as "not transcribed — data protection"); stop sending their voice messages to OpenAI; and exclude their content from the Org Brain and AI summaries. The effective date is logged. This is a legal carve-out, not a participant opt-out (REC-04). A withdrawn person's voice can still be picked up on colleagues' tracks (§7.5). | P1 |
| PDPA-05 | **Access requests.** A DPO console (using Rule 9 access) that verifies the requester's identity and finds personal data **about** that person: content they sent or spoke; content others sent or spoke that names or concerns them (searched by name and aliases), including DMs and restricted sessions; their assistant and agent conversations and personal memory; agent memory and Org Brain entries about them; profile, roster, device, sign-in, and acknowledgment records; and audit entries. Their own speech is exported from recordings and transcripts using their audio track, which excludes most other speakers; the DPO checks for other voices picked up on the track and for other people's data in what they said. **Nothing is released until the DPO has reviewed each item** and redacted or withheld other people's personal data (PDPA-05a), or withheld it under a PDPA exception with the provision and reason recorded. Exports are machine-readable (JSON/CSV plus media). A 30-day timer includes a template letter for when more time is needed. Works for deactivated accounts. Until PDPA-06 ships, the "how was my data used" part is answered with a general description generated from PDPA-01 and PDPA-10. | P0 |
| PDPA-05a | **Redaction and withholding** of other people's personal data in exported text, with per-item withhold and review status. | P0 |
| PDPA-05b | **Audio redaction**: silencing other people's voices in exported recordings. | P1 |
| PDPA-06 | **Use and disclosure record.** For each person, what happened to their data in the past 12 months (exports, shares, transfers to providers, AI retrievals), drawn from the audit log, to answer the "how was my data used" part of an access request. | P1 |
| PDPA-07 | **Corrections.** Anyone, including people who can't see the item, can ask for personal data about them to be corrected in transcripts, AI notes, messages, Org Brain entries, or memory. Requests go to the DPO queue with a 30-day timer and a template letter. The DPO corrects the item or, if refusing, attaches an annotation recording what was requested. Transcripts and notes keep the original machine output alongside corrections (redactions excepted, REC-18). Corrections and annotations flow to notes and the Org Brain and stop the old data resurfacing in AI answers (Rule 7). Participant edits under REC-15 are separate and don't close a request. | P0 |
| PDPA-08 | **Machine-generated labels and human review.** Transcripts and AI notes are labelled as machine-generated, with the model name and Hearth's transcription pipeline version (B.5). When anyone exports, downloads, or saves to a doc (DOC-10) a transcript or AI note, or a Compliance Officer or the DPO attaches one to a case (Rule 9), Hearth shows the machine-generated warning, asks them to confirm someone checked it against the recording while the audio is kept, and logs who, what, and the stated purpose. Use outside Hearth is governed by the org's HR policy. | P1 |
| PDPA-09 | **Retention engine.** A configurable retention period for each data type, finite by default. "Keep indefinitely" is not available for audio/video, transcripts, or AI notes (D12); for other types it needs a written justification and sends the DPO an annual review reminder. Legal holds (ADM-08) and access-request holds pause deletion; a hold after a refused access request lasts at least 30 days after the refusal, longer if the PDPC reviews it. Deletion cascades to derived content (notes, indexes, embeddings, caches, version histories, original machine output). After any backup restore, the deletion log is replayed so deleted data doesn't reappear. Every deletion is logged. **Defaults** (audio periods decided, D36; the rest are proposals for the DPO to confirm, Q13): session audio/video 120 days and voice-message audio 360 days (D36); transcripts, AI notes, messages, and voice-message transcripts 3 years; docs and files 3 years after last edit unless the owner renews; assistant and agent conversations 1 year; people-insight figures 2 years; audit and access logs 2 years; search indexes, embeddings, and version histories follow their source item; backups 35 days; a leaver's personal memory deleted at deactivation (ACC-05); tasks and calendar events 3 years; agent memory 1 year, reviewed by the central AI team; a deactivated user's phone number, devices, and sign-in records deleted with the audit logs (2 years), with their profile reduced to name and title for attribution while their content is kept; acknowledgment records kept as long as the person's data is kept; DPO case records and the breach register as set by the DPO. | P0 |
| PDPA-10 | **Transfer register.** Lists every provider that receives personal data (OpenAI for transcription, the AI model provider, the SMS provider, the cloud host) with: data types, processing and storage countries (as confirmed in writing by the provider), the transfer safeguard, how long the provider keeps data (e.g. up to 30 days of abuse-monitoring logs where zero retention isn't granted), and a review date. It feeds the notice (PDPA-02). **Before any real personal data, including pilot data, is sent to a provider:** sign a data processing agreement that binds the provider to PDPA-comparable protection, names the processing countries, and requires prompt incident notification (adding an addendum, e.g. based on the ASEAN Model Contractual Clauses, if the standard agreement falls short); turn off training on org data; apply for zero data retention; and record the result here. Certification is recorded as the safeguard only if the certificate has been verified. | P0 |
| PDPA-11 | **Breach response.** An incident record with a timeline (first aware, assessment, decision), clocks for the 30-day assessment and the 3-day PDPC deadline, notification templates for the PDPC and affected people, and a breach register. | P1 |
| PDPA-11a | **Breach scoping.** Identify the exposed items (from audit logs and the access of the compromised account or credential), then count the unique people whose personal data appears in them — authors, speakers, participants, and people named, including former employees — and the data types involved. 500 or more makes the breach notifiable on scale, unless the access stayed inside the organization. | P0 |
| PDPA-12 | **Limit the blast radius.** Storage and encryption keys are separated by team or space; no single service credential can read every transcript; bulk exports and unusual access raise alerts. | P1 |
| PDPA-13 | **DPO role and contact.** A DPO role (ACC-10) with access to the registers, request queues, incidents, retention settings, and audit logs; access to content follows Rule 9. The DPO's business contact appears in the notice, the help menu, and the AI info card (once PDPA-14 ships), **and the org publishes it outside Hearth** (e.g. on its website), as the PDPA requires. A question-and-complaint form routes to the DPO with tracking. The DPO can log requests received by email or letter from people without a Hearth account (former employees, people named in content); identity checks for them don't rely on an old Hearth phone number or PIN. | P0 |
| PDPA-14 | **AI info card.** A single page for the assistant and agents covering: what they read and under whose permissions, which providers and countries are involved, how long prompts and answers are kept, known limitations (transcription and AI errors), how to report wrong personal data, and the DPO's contact. | P1 |
| PDPA-15 | **AI conversations are personal data.** Assistant and agent conversations have a retention period (PDPA-09) and are included in access requests (PDPA-05). | P0 |
| PDPA-16 | **No training on org data.** Hearth never trains or fine-tunes models on org data. Provider settings that would allow training stay off, are checked automatically where the provider exposes the setting through an API (e.g. OpenAI's data-retention settings through its Admin API); otherwise an admin re-confirms the setting or contractual term quarterly, with the attestation recorded. Results appear in the admin console and the transfer register (PDPA-10). Any future use of org data to improve AI requires a new, specific notice first. | P0 |
| PDPA-17 | **Sensitive data warnings.** Warn people who post an NRIC number, a password, or similar in chat. Flag such content in transcripts so it can be redacted (REC-18). | P1 |
| PDPA-18 | **People insights safeguards** (ADM-14, D34). Insights use counts and durations only; the AI never scores people on what they say. Each metric is a purpose in the register (PDPA-01) and is listed in the notice (PDPA-02), including who can see it. Restricted-room sessions are excluded, and figures never reveal who someone talked to or what about. Figures carry their caveats on screen (e.g. talk time from a shared room device or background voices can be wrong, §7.5). Every view of an individual's figures is logged (ADM-06). Before insights feed a performance or disciplinary decision, a person checks them against the underlying activity, as in PDPA-08. ADM-14 can't ship without these. | P1 (with ADM-14) |

## 9. Non-functional requirements

### 9.1 Platform

| ID | Requirement | Pri |
|---|---|---|
| NFR-01 | **Web app** for current Chrome, Edge, Safari, and Firefox on desktop; Chrome on Android; Safari on iOS. | P0 |
| NFR-02 | **Phone-friendly** layouts for every screen (D14, D21); every core flow (read, reply, voice note, join room, accept task, Ask) is fully usable one-handed on a 6-inch phone. | P0 |
| NFR-03 | **Installable** to the home screen (progressive web app) with icon, splash screen, and push notifications on Android and iOS. On iOS, push works only after Hearth is added to the Home Screen, and permission must be requested from a tap inside the installed app; the first-run flow (ACC-14) handles this. The admin console shows the share of active users with push enabled, by platform. | P0 |
| NFR-04 | Usable on weak mobile connections: messages queue offline and send when back online; voice adapts bitrate. | P0 |
| NFR-05 | Native iOS and Android apps. | P2 (first post-v1 item) |

### 9.2 Performance and scale (v1 targets)

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

### 9.3 Reliability

- Availability **99.5%** monthly for v1 (single region); 99.9% target post-v1.
- Daily backups with tested restore; recordings in durable object storage.
- Graceful degradation: if AI providers are down, chat, rooms, docs, and recording continue; transcription and notes queue and complete later.

### 9.4 Security and privacy

- Encryption in transit (TLS) and at rest.
- Phone + device PIN/passkey authentication (ACC-01, ACC-02); admin actions require re-authentication.
- Least-privilege internal access; production access logged.
- AI providers under no-training business terms, with zero data retention wherever the provider grants it. Each provider's actual retention, processing countries, and safeguard are recorded in the transfer register (PDPA-10).
- **Prompt-injection resistance** per Rule 8; AI red-team testing before launch.
- Independent penetration test before the org-wide launch.
- Data stored in a single cloud region chosen by the org (Q6).

### 9.5 Accessibility and language

- WCAG 2.2 AA. Session transcripts and voice-message transcripts double as accessibility features.
- **English only** for v1 (D29): the UI, transcription, meeting notes, and the AI. UI strings are still externalized so translation stays possible later.
- Transcription must handle the accents and the mix of names and internal terms used in the org; see the org vocabulary requirement (REC-19).
- **Non-English speech.** English only doesn't stop people switching into Mandarin, Malay, Tamil, dialects, or Singlish phrases. The spike checks whether `gpt-transcribe` still reports non-English speech in its returned `languages` when English is requested; if not, a small local language-ID model runs on each passage (no data leaves Hearth). Passages detected as non-English are marked "non-English speech: may be inaccurate"; notes then say part of the session wasn't in English, and action items drawn from those passages are flagged for the owner to confirm.
- **Transcription quality gate:** no public accuracy figures exist for the org's accents. During the M2 pilot, build a test set of 1–2 hours of clips recorded specifically for it, with each speaker's consent, covering the org's accents, names and jargon. The test set is its own purpose in the register (basis: consent), is stored apart from session audio with its own retention period, and a speaker's clips are deleted if they withdraw. Measure word error rate, accuracy on names and terms, and invented words. Before the M2 pilot, the founder and the DPO set minimum bars (e.g. accuracy on names and terms, invented-word rate); the test set also includes Singlish and mixed-language clips, scored separately. A failing run blocks org-wide launch until vocabulary tuning (REC-19) or settings changes bring it above the bars, or until the founder and DPO record an accepted exception, stated in the AI info card (PDPA-14). Because `gpt-transcribe` is an alias that OpenAI can update without a version change, the set is re-run monthly, on any OpenAI changelog entry for the model, and when correction rates in production shift; later runs also fail on a regression against the pilot baseline. The pre-M1 spike is only a smoke test on a few clips.

### 9.6 Cost

- Track AI and speech-to-text spend per feature, agent, and user (§7.5).
- Transcribe only speech, so cost follows talking time rather than how long people sit in a room.
- An org-level monthly budget with alerts at 50/80/100%. No transcription budget was set (D30); the estimate below is the planning baseline. The budget for AI notes, the assistant and agents is still open (Q5).

**Transcription cost estimate** (OpenAI list price as of October 2026: `gpt-transcribe` $0.0045 per minute of audio):

| | Per user per month | 500 users | 1,000 users |
|---|---|---|---|
| Session transcripts + voice messages | ≈ $3.00 (range $2.30–$3.70) | ≈ $1,500 | ≈ $3,000 |

*Assumptions:* each person spends 2 hours a day in voice sessions, 4 people per session on average, 22 workdays a month, someone speaking about 80% of session time, and 3 minutes of voice messages per person per day. About 15% is added for the padding around each spoken passage and per-request rounding. The range covers quieter or chattier rooms.

*What changes it:* sending whole tracks including silence would multiply the cost by about 4 (≈ $12 per user per month), so speech-only sending is a hard requirement. Any OpenAI data-residency project, including Singapore (storage only), adds 10% for `gpt-transcribe` and needs abuse-monitoring or zero-retention approval; because the transcription endpoint keeps no stored data, residency adds little here, and the estimate assumes a standard project at list price. OpenAI's Batch API discount doesn't apply to transcription, and negotiated volume pricing isn't assumed. The figures exclude AI notes and assistant costs and storage. Media-server and recording compute still needs its own estimate, sized for the §9.2 peak of 200 sessions.

## 10. Success metrics

Targets are proposals for the first 90 days after org-wide launch.

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
| **Agents** | Suggest-card dismiss rate | < 50% |
| | Agent answers rated unhelpful | < 10% |
| **Trust** | Confirmed AI permission leaks | **0** |
| | "I trust Hearth with sensitive work" (survey) | ≥ 70% agree |
| **Suite** | Teams with an active wiki space | ≥ 75% |
| | Meetings scheduled in Hearth Calendar | ≥ 80% |

**Launch gate** (separate from these 90-day targets): no open leak from the access-rule test suite (M3), the AI red-team (M6), or pilot reports (M3–M5). After launch, a confirmed leak triggers the kill switch (ADM-10) for the affected feature until it is fixed.

## 11. Release plan

No fixed date (D23). The work is sequenced so that each milestone gives a real pilot group something to use. The solo builder with AI coding tools (D24) completes one milestone at a time. Pilot groups grow at each milestone.

| Milestone | Contents | Pilot |
|---|---|---|
| **M0 — Foundations** | Org/tenant data model, phone sign-in + PIN, roles (incl. DPO), teams, permission model, audit log (incl. AI retrievals and provider sends, ADM-06), admin console shell, privacy notice and acknowledgment (PDPA-01 – PDPA-03, PDPA-13), transfer register (PDPA-10) with agreements for the cloud host and SMS provider where they process data outside Singapore, DPO request intake (PDPA-04, PDPA-13) handled manually until the consoles ship, design system, installable web app shell, push notifications, first-run flow (ACC-14) | Builder only |
| **M1 — Chat** | CHAT P0s except CHAT-16 (M2) and CHAT-17/18 (M6); voice messages with transcripts; a minimal file store for chat attachments; keyword search; notifications. **Before the pilot:** OpenAI set up per B.5 (agreement signed and recorded in PDPA-10, training off, zero retention applied for) and the no-training checks (PDPA-16). AI spend tracking and alerts (ADM-05) ship here, since transcription spend starts. | One team (10–20 people) moves its WhatsApp group over |
| **M2 — Rooms and meetings** | ROOM and REC P0s except REC-14 and posting to scheduled-meeting threads (both M4): drop-in rooms, calls, universal recording, transcripts, notes, restricted rooms, "viewed by" lists; retention engine with holds (PDPA-09, ADM-08); corrections (PDPA-07); privileged access (Rule 9, ADM-12). AI kill switch for all AI and per feature (ADM-10). **Before the pilot:** agreement with the AI model provider (PDPA-10), since meeting notes start here — or before M1 if quick replies (CHAT-08) are AI-generated. | Same team plus one more |
| **M3 — Org Brain and assistant** | BRAIN P0s, SRCH-03 Ask, PA P0s (Today, actionables, catch-up, drafts, nudges, memory), AI conversation retention (PDPA-15), access-rule test suite | 3–5 teams (~100 people) |
| **M4 — Calendar and tasks** | CAL and TASK P0s, scheduled meetings with their own rooms, meeting prep briefs, suggested tasks from meetings | Same |
| **M5 — Docs, wiki, files** | DOC and FILE P0s: co-editing, permissions, version history, wiki spaces, drive | Same, plus HR and IT (to seed policy content for agents) |
| **M6 — Agents and hardening** | AGT and STU P0s, CHAT-17/18, the launch agent set, compliance (export, access-request console PDPA-05/05a, breach scoping PDPA-11a), people insights with their safeguards (ADM-14, PDPA-18), pen test, AI red-team, scale tests | **v1 org-wide launch**; set a date to stop using WhatsApp for work |

**Post-v1 roadmap (in rough order):** native mobile apps → P1 leftovers → spreadsheets → agents speaking in rooms → agent computers and external connectors → slides → guests and external consent → readiness for selling to other orgs (multi-org hosting, billing, self-serve onboarding, per-customer recording policies).

## 12. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Scope vs. a solo builder**: seven modules plus AI plus real-time voice is a very large surface | High | High | Assemble proven open-source building blocks rather than building low-level pieces (Appendix B); strict P0 discipline; ship milestone by milestone to real pilots; requirement IDs plus tests make AI coding tools effective. |
| R2 | **Universal recording**: PDPA exposure (relying on withdrawable consent alone, keeping data indefinitely, overseas transfers) and people self-censoring | Medium | High | A legal basis for each purpose (PDPA-01), confirmed by the DPO and counsel (Q3); a specific notice and acknowledgment (PDPA-02/03); finite retention (PDPA-09); data processing agreements for overseas transfers (PDPA-10); always-visible indicator; "viewed by" transparency (REC-21); restricted rooms; recording policy configurable for future customers. |
| R3 | **AI permission leak** | Medium | Critical | Rules 1–8 enforced in one shared retrieval layer, not per feature; live permission re-check; provenance on derived content; "view as" testing; leak tests in CI; zero-leak launch gate; kill switch. |
| R4 | **Agents speaking unprompted annoy people** | Medium | Medium | Suggest cards before full Active mode; confidence threshold and per-channel caps; feedback raises the threshold; channel owners can turn it down. |
| R5 | **AI and transcription cost** grows with universal recording | Medium | Medium | Send only speech to OpenAI (about 4× cheaper than whole tracks); no live captions (D31); transcripts ≈ $3/user/month (§9.6); cheaper models for routine summaries; per-feature budgets and alerts. |
| R6 | **Adoption**: people stay on WhatsApp | Medium | High | WhatsApp-level simplicity; installable app with push; voice notes; pilot champions; leadership sets a WhatsApp-for-work sunset date at launch. |
| R7 | **SMS sign-in security and delivery cost** | Medium | Medium | Device PIN/passkey; OTP rate limits; reputable SMS provider with fallback. |
| R8 | **Real-time doc editing is hard to get right** | Medium | Medium | Use a mature conflict-free sync library; heavy automated testing of merge cases. |
| R9 | **Dependency on alpha projects** (OpenDots is alpha and needs CopilotKit Intelligence for conversation storage) | Medium | Medium | Reuse OpenDots' patterns and MIT-licensed code, not its runtime dependency; store agent conversations in Hearth's own database. |
| R10 | **Bus factor of one** | High | High | This PRD, architecture notes, and tests kept in the repo; admin runbooks; consider a second maintainer before org-wide launch. |
| R11 | **iOS web app limitations** (background audio, push reliability) hurt mobile rooms | Medium | Medium | Test early in M2 on real devices; prioritize native apps immediately post-v1 if gaps are severe. |
| R12 | **Depending on OpenAI for transcription**: models get retired (four were deprecated in Aug 2026 and are scheduled to shut down in Feb 2027), features differ between models, and accuracy on the org's accents and names is unproven | Medium | Medium | Model names live in configuration behind the model layer; timestamps and speaker labels come from Hearth's own pipeline, not the model; transcription quality gate (§9.5) re-run monthly and on any OpenAI change notice; org vocabulary (REC-19); editable transcripts (REC-15). |
| R13 | **People insights feel like surveillance** on top of universal recording, so people go quiet in rooms or back to WhatsApp | Medium | Medium | Counts and durations only, no AI scoring of speech; visible only to leadership and admins; everyone sees their own figures; metrics and viewers listed in the notice; caveats shown; every view logged (PDPA-18). |

## 13. Open questions

| # | Question | Needed by |
|---|---|---|
| Q1 | Naming for the personal assistant and the specialist agents. (Product name resolved: Hearth, D33.) | M6 |
| Q2 | ~~Languages~~ — resolved: English only (D29). | — |
| Q3 | DPO and counsel confirm the legal basis for each purpose in the processing register (PDPA-01), especially org-wide AI indexing of transcripts, the recording of casual drop-in rooms, and showing recordings to people who weren't there (REC-20). | Before M1 pilot |
| Q4 | Who is on the central AI team, and how much of their time is committed? | M4 |
| Q5 | Monthly budget for AI notes, the assistant and agents. (Transcription is estimated at ≈ $3/user/month, §9.6.) | M3 |
| Q6 | Cloud provider and data region. Deferred by the founder; decide before real data is stored. | Before M1 pilot |
| Q7 | Final launch agent set (§8.12 proposal). | M5 |
| Q8 | Is whole-org visibility of public-room transcripts acceptable (REC-20 default), or should public-room transcripts be limited to participants? Depends on Q3. | M2 (with Q3) |
| Q9 | Read receipts on or off by default? | M1 |
| Q10 | When compliance accesses a restricted session, are the participants notified? | M2 |
| Q11 | Default storage quotas for files. | M5 |
| Q12 | Does leadership commit to a date to stop using WhatsApp for work? | M6 |
| Q13 | Remaining retention periods (PDPA-09 proposals). Session recordings (120 days) and voice-message audio (360 days) are decided (D36). | Before M1 pilot |
| Q14 | ~~Who is the Data Protection Officer?~~ Resolved: Ashton Teo (D35). Their business contact still has to be published outside Hearth (PDPA-13); the PDPC also encourages registering the DPO on ACRA BizFile+. | M0 |

---

## Appendix A — Decision log

| # | Decision | Notes |
|---|---|---|
| D1 | **Internal first, sell later** | Org-scoped data model from day one; no billing or self-serve in v1. |
| D2 | **Personal assistant + specialist agents** | The four-layer model in §7.1. |
| D3 | **AI mirrors each user's access** | Rules 1–8 (§7.2). Revised by D11: "AI off" for sensitive rooms now means "not indexed," not "never processed by a model." |
| D4 | **Cloud model APIs** | Behind a swappable model layer; no training on our data; zero data retention wherever granted (PDPA-10). |
| D5 | **v1 leads with voice rooms + personal assistant** | Specialist agents ship as a small curated set. |
| D6 | **Only a central AI team creates agents** | Agent Studio (§8.13) plus request intake. |
| D7 | **Agents may be active in channels** | With guardrails: participation levels, suggest cards, caps, never in DMs/restricted rooms, never speak aloud unprompted. The assistant's proactivity is private nudges. |
| D8 | **250–1,000 people** | Drives roles, admin, audit, retention. |
| D9 | **All meetings recorded, transcribed, with notes** | Added mid-discovery. Refined by D27: notes for substantive sessions. |
| D10 | **Every session with 2+ people is recorded** | Includes casual drop-ins and DM calls. |
| D11 | **No recording exceptions** | Sensitive conversations protected by access (restricted rooms), not by skipping recording. The only carve-out is legal: if the DPO records a purpose as consent-based and someone withdraws, PDPA-04a applies to them. |
| D12 | **Audio/video kept short, transcripts/notes kept long** | 120-day default for session audio/video (D36). Transcripts and notes are kept for a finite period, proposed as 3 years, not indefinitely, because PDPA retention limits apply (PDPA-09, D32). |
| D13 | **A new suite from scratch** | Supersedes an earlier "Google Workspace" answer. No dependency on another suite. |
| D14 | **Web only for v1** | Specified as phone-friendly and installable with push. |
| D15 | **Internal only for v1** | No guests or shared channels. |
| D16 | **Personal assistant is suggest-only** | Has all the user's context; suggests actionables and drafts; never edits or sends. |
| D17 | **Coming from WhatsApp** | Fresh start; WhatsApp simplicity is the bar; voice messages with transcripts. |
| D18 | **v1 includes every module** | Each at a defined depth (P0 lists in §8). |
| D19 | **Docs like Google Docs** | Restricted editing and viewable version history. |
| D20 | **Phone-number sign-in** | Hardened with device PIN/passkey and admin-only roster. |
| D21 | **Mix of desk and mobile workers** | Phone experience is P0. |
| D22 | **Docs now, Sheets and Slides later** | |
| D23 | **No fixed date** | Milestone sequencing in §11. |
| D24 | **Built by the founder with AI coding tools** | Shapes Appendix B and risk R1/R10. |
| D25 | **Warm and familiar feel** | WhatsApp-like; the "cool" comes from rooms and AI, not visual complexity. |
| D26 | **Recording policy is an org setting** | Our org: all sessions, no exceptions. Keeps D1 open. |
| D27 | **Notes only for substantive sessions** | ≥5 min or contains a decision/action item; avoids flooding channels with notes from short drop-ins. |
| D28 | **Every member agrees to the PDPA terms before joining** | Captured in onboarding as acknowledgment of the privacy and recording notice (ACC-12). It is not by itself the legal basis for recording or any other purpose: each purpose's basis is recorded in the processing register (PDPA-01) and confirmed by the DPO and counsel (Q3). |
| D29 | **English only** | UI, transcription, notes, and AI. Resolves the former language question. |
| D30 | **OpenAI for transcription** | Session transcripts and voice messages, using `gpt-transcribe` (§7.5). No transcription budget set; §9.6 gives the estimate. The budget for AI notes, the assistant and agents is open (Q5). |
| D31 | **No live captions** | Live transcription isn't needed. Removes the real-time model, its cost, and OpenAI's 30-day retention of real-time audio. ROOM-10 and AMB-04 removed. |
| D32 | **Singapore's PDPA applies** | Data protection requirements in §8.16. |
| D33 | **The product is called Hearth** | Started as a placeholder; kept. |
| D34 | **People insights for leadership; own stats for everyone** | Leadership and admins see org-wide rankings; each person sees their own figures. Metrics: messages and reactions, talk time, time in rooms and meetings, tasks completed. Counts only: no AI scoring of what people say. Replaces an earlier "no people analytics" rule. |
| D35 | **The DPO is Ashton Teo** | Founder; holds the DPO role (ACC-10, PDPA-13). |
| D36 | **Session recordings kept 120 days; voice-message audio 360 days** | Replaces the earlier 90-day proposal. Transcripts and notes follow their own periods (PDPA-09). |

## Appendix B — Build approach and suggested building blocks

### B.1 Recommendation: a fresh build on proven open-source parts

Two options were considered:

| | Extend RocketChat | Fresh build on open-source parts |
|---|---|---|
| Chat maturity on day one | High | Must be built (M1) |
| Covers the rest of the suite | No — chat is one of seven modules | Designed for the whole suite |
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
| Voice/video | **LiveKit** (open-source WebRTC media server), recording each participant's tracks separately (Track Egress, no transcoding) rather than a mixed composite | Rooms, screen share, recording; per-participant tracks give speaker attribution and support export, withdrawal, and redaction (REC-02). |
| Co-editing | **Yjs** (CRDT sync) with a TipTap/ProseMirror editor and a Yjs sync server, garbage collection on | Live co-editing without keeping deleted text in the shared state sent to clients. The sync server authenticates every connection and rejects updates from Viewers and Commenters (DOC-03). Version history (DOC-04) is kept server-side: each accepted update is tagged with author and time and compacted into stored snapshots that can be deleted or redacted (PDPA-09). Comments (DOC-05) are stored outside the shared document. |
| Files and recordings | S3-compatible object storage | Durable, cheap, lifecycle rules for retention. |
| AI | Internal model layer → cloud model APIs (e.g. Claude) | D4; swappable. |
| Speech-to-text | OpenAI `gpt-transcribe` (session transcripts, voice messages), plus Hearth's own speech detection on each track (e.g. Silero VAD) | D30; see B.5. |
| Agent UI streaming | Consider **AG-UI** (the protocol OpenDots uses) for streaming agent output and approval cards | Proven pattern for approve/decline cards. |
| SMS | Established SMS OTP provider | ACC-01. |
| Background jobs | A Postgres-backed job queue | Transcription, notes, indexing, agent schedules. |

### B.3 What to reuse from OpenDots

OpenDots is MIT-licensed. Reuse its **patterns**:
- Specialist agent definition (name, role, instructions, permitted tools) → AGT-02 – AGT-05.
- Approve/Decline cards for non-read actions → AGT-06.
- Scheduled runs in their original conversation, with an *Interrupted → retry after review* state → AGT-10.
- User-visible, user-editable memory → PA-10.

Do **not** take on its runtime dependency on CopilotKit Intelligence for conversation storage; Hearth stores all conversations in its own database so the access rules in §7.2 apply uniformly.

### B.4 The single most important technical rule

All AI features — Ask, the assistant, agents, summaries — must retrieve content through **one shared, permission-enforcing retrieval layer** that implements Rules 1–8. No feature may query the index directly. This is what makes the zero-leak target testable. The only path around it is privileged access (Rule 9), which is audited and never feeds any AI feature.

### B.5 Transcription pipeline (OpenAI)

Based on OpenAI's API as of October 2026 (its SDK source and documentation). Re-check these facts in a spike before the M1 pilot.

**Speech detector (session tracks).** For every participant track, a speech detector runs in or next to the media server. It marks where each spoken passage starts and stops on the session clock, with about 300 ms of padding, and drops passages shorter than about 300 ms. Each passage becomes `{session, speaker, start, end, audio}`. Speaker and timestamps therefore never depend on the model.

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

## Appendix C — What we take from each reference product

| From | We take | We leave |
|---|---|---|
| **RocketChat / Slack** | Channels, threads, mentions, permissions, channel browser, pinned messages | Sectioned sidebar complexity (replaced by a WhatsApp-style unified list) |
| **Discord** | Always-open voice rooms, room presence, screen share, playful liveliness | Gamer aesthetics, servers-within-servers |
| **WhatsApp** | Unified chat list, voice notes, read ticks, phone-first simplicity | Personal-account mixing, no org control |
| **Google Docs / Drive** | Co-editing, permission levels, comments, version history, drive sharing | Spreadsheets and slides (post-v1) |
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

## Appendix E — References

- OpenDots (CopilotKit): https://github.com/CopilotKit/OpenDots
- Rocket.Chat: https://github.com/RocketChat/Rocket.Chat
- AG-UI protocol: https://docs.ag-ui.com/introduction
- LiveKit: https://github.com/livekit/livekit
- Yjs: https://github.com/yjs/yjs
