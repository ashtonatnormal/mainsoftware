# Hearth demo — build brief

Instructions for building the demo screens. Each area is built by one agent or session, which owns only the files listed for it.

## Common instructions

You are building part of a clickable DEMO of "Hearth", an internal work suite (chat, Discord-style voice rooms with universal recording + transcription + AI notes, an org-wide AI assistant and specialist agents, tasks, calendar, docs, people insights) for a fictional Singapore company, Tembusu Logistics. The demo runs on scripted example data only — nothing talks to a server. The signed-in user is Ashton Teo (founder, admin, DPO). The demo clock is fixed at Monday 12 Oct 2026, 8:42 am (Singapore).

PROJECT: demo/ in this repository (Vite + React 19 + TypeScript + Tailwind v4 + lucide-react). Run all commands from that directory. The full product spec is docs/PRD.md — read the sections named in your brief.

READ FIRST (do not skip): src/types.ts (data model + Route), src/store.tsx (state and the API you call: navigate, back, send, sendVoice, markRead, setDraft, react, joinRoom, leaveRoom, setSpeaking, acceptSuggested, dismissSuggested, addTask, setTaskStatus, dismissActionable, useDraft, rsvp, updateDoc, deleteMemory, editMemory, setMemoryOn, toast, setTheme, ask, completeOnboarding; state has route, conversations, messages, drafts, typing, rooms, myRoomId, sessions, tasks, suggested, actionables, events, docs, memories, memoryOn, theme, clock), src/ui/index.tsx and src/ui/notes.tsx (the UI kit: Avatar, AvatarStack, Button, IconButton, Pill, AgentBadge, AIMarker, RecordingIndicator, UnreadBadge, SourceChips, CitedText, Feedback, ScreenHeader, Page, SectionTitle, Card, EmptyState, Sheet, Segmented, NotesCard, cx, personName, personShort), src/index.css (colour tokens), src/App.tsx (the shell), src/time.ts (formatting helpers: clock, shortDay, longDay, listStamp, dayLabel, sameDay, duration, minutesLabel, relative, NOW, at), and the data files in src/data/ your screens use.

SHELL FACTS: Your screen renders inside <main>, which is overflow-hidden and fills the space between the top bar and the tab bar, so YOUR screen must handle its own scrolling (use <Page> for simple pages, or a full-height flex column with an overflow-y-auto region). On phones (<768px) the shell hides its top bar and tab bar for "immersive" routes: chats with a conversationId, rooms with a roomId, session, docs with a docId, calendar with an eventId — those views must render their own header with a back button (ScreenHeader back). On desktop (>=768px) the left rail is always visible and the top bar carries the global "Search or ask" box.

HARD RULES:
- Only create or edit the files assigned to you. Do NOT modify store.tsx, types.ts, data/*, ui/*, App.tsx, index.css, package.json or other screens. Need extra example data or helpers? Define them inside your own file(s). If a shared change is truly essential, describe it in your final report instead of making it.
- Visual design: "warm and familiar" (WhatsApp-level simplicity), phone-first (390px wide) and good on desktop (1440px). Colours ONLY through the Tailwind token classes (bg-bg, bg-surface, bg-surface-2, text-fg, text-muted, border-line, bg-accent, text-accent-fg, bg-accent-soft, text-accent-ink, bg-agent, text-agent, bg-agent-soft, bg-rec, text-rec, bg-rec-soft, text-ok, bg-ok-soft, text-warn, bg-warn-soft, bg-wall) so light and dark both work — never raw hex/rgb or Tailwind palette colours like gray-500 (white text on bg-rec/bg-agent is fine). Headings use font-display. Use the UI-kit components instead of re-inventing them. Ember (accent) is the one bold colour; agents/AI use teal (agent); recording/live uses rec (red). Cards are used sparingly; prefer clean lists with hairline dividers. No emoji as section markers. Consistent spacing via flex/grid gap. Text must never overflow its container (min-w-0 + truncate/wrap). No horizontal page scroll at 390px.
- AI rules from the PRD: every AI output shows <AIMarker/> and its sources (SourceChips/CitedText); the personal assistant only suggests and drafts (it never sends); agents carry <AgentBadge/>; recording is always visibly indicated in rooms (<RecordingIndicator/>).
- Copy: plain, short, active voice, written from the user's side, British spelling (organisation, colour). No lorem ipsum. Don't claim something happened unless the demo did it (use toasts like "Request sent to the DPO" only for simulated actions, and keep them honest).
- Accessibility: buttons have text or aria-label (IconButton has label), inputs have id + label (sr-only is fine), visible focus, respect reduced motion (use the anim-* classes from index.css, which already do).
- Icons: lucide-react only; tsc will tell you if an icon name doesn't exist.

VERIFY YOUR WORK (required, iterate up to 3 rounds):
1. npx tsc --noEmit — fix every error in YOUR files. Another agent may be editing other screens at the same time; ignore errors that are only in files you don't own (wait ~30 s and retry if the build is blocked by them).
2. npx vite build
3. Screenshots: node scripts/screenshots.mjs --name <name> --route '<route json>' [--before '<js using h = window.__hearth, e.g. h.joinRoom("r_ops")>'] [--after '<js run after navigation, e.g. document.querySelector("button[aria-label=Send]").click()>'] [--wait ms] [--viewport phone|desktop] [--scheme light|dark] — default is phone+desktop × light+dark. It prints files under shots/ and flags console errors and horizontal overflow (exit code 1). LOOK at the PNGs with the Read tool (phone shots are 780×1688) and fix what looks wrong: alignment, clipping, cramped or bloated spacing, unreadable dark mode, empty-looking states.
FINAL ANSWER: list the files you created/changed, what each screen shows, the interactions that work, the screenshot commands you used (so a reviewer can re-run them), and known gaps.

## Area: today-ask

**Files you own:** src/screens/Today.tsx and src/screens/Ask.tsx (you may add src/screens/today/* or src/screens/ask/* helper files)

**PRD sections to read:** §6.2 J1 and J4, §7 (AI rules), §8.8 SRCH-01..06, §8.11 PA-01..PA-12

**Spec:**

TODAY (Today.tsx) — the home screen, the assistant's morning view:
- Greeting: "Good morning, Ashton" (font-display, large) + longDay(NOW) + one line from the assistant: "N things need you" (count of state.actionables) with <AIMarker/>.
- "Needs you" list from state.actionables: each item shows a kind icon (reply / action item / prep / review), title, detail, SourceChips if sources, and actions: Open (navigate(item.route)), "Reply with draft" when item.draft exists (useDraft(item.id) — this puts the assistant's draft into the chat composer; the assistant never sends), Dismiss (dismissActionable). Optionally reveal the draft text in a quoted preview before using it.
- "Since you were last here" catch-up digest from src/data/work.ts digest: each row → the conversation (navigate chats conversationId), with channel name and count; mark it as AI-summarised.
- "Up next": today's remaining events from state.events (start >= today; show the live Ops standup 8:30–8:45 as "Now"), each with time, title, attendee avatars, a Join button when it has a roomId and is live or within 5 minutes (joinRoom then navigate rooms roomId), and "Prep brief" linking to calendar eventId when event.prep exists.
- "Live now": rooms with 2+ participants (state.rooms) with avatars, RecordingIndicator compact, Join.
- "Suggested tasks" from state.suggested with Accept (acceptSuggested) / Dismiss, and "Due today" tasks (state.tasks for ME not done whose due includes "Today").
- Layout: phone single column; desktop two columns (wide main column: greeting, needs you, digest; side column: up next, live now, tasks). When everything is dismissed show a calm empty state ("You're all caught up").
ASK (Ask.tsx) — Search & Ask (route { name: 'ask', q? }):
- A large input with id, placeholder "Ask a question or search…", autofocus; if route.q is set, run it immediately. Suggestion chips from askSuggestions (src/data/work.ts) that run the question.
- Running a question: show the question, then the answer revealed progressively (word-by-word over ~1–1.5 s, respecting reduced motion), with <AIMarker label="Answer"/>, <CitedText/> for the text, <SourceChips/>, <Feedback/>, and a small note with a lock icon: "Answered only from what you can open." Use the store's ask(q) to get {answer, sources, matched}. Non-matched questions show the fallback answer; the restricted question ("performance review") shows the refusal — both are good demo moments.
- Below the answer: plain keyword search results over messages (text and voice transcripts), docs (title and blocks), tasks, events and people, grouped with filter chips (All, Messages, Docs, Meetings, Tasks, People), each result clickable to its place (messages → chats conversationId, docs → docs docId, events → calendar eventId, sessions → session, tasks → tasks, people → chats DM if one exists). Highlight the matched words.
- Keep a history of questions asked this visit (local state) the user can tap to re-open.
- Phone and desktop layouts; on phone it's a normal (non-immersive) page.

**Suggested screenshot runs:** today: --route '{"name":"today"}' ; ask idle: --route '{"name":"ask"}' ; ask answered: --route '{"name":"ask","q":"What did we decide about Q4 pricing?"}' --wait 2500 ; ask restricted: --route '{"name":"ask","q":"What was said in Marcus performance review?"}' --wait 2500

## Area: chats

**Files you own:** src/screens/Chats.tsx (you may add src/screens/chats/* helper files)

**PRD sections to read:** §2.3, §6.1, §6.2 J5, §8.2 CHAT-01..19, §8.11 PA-01/PA-03/PA-08, §8.12 AGT-07..09, REC-13

**Spec:**

CHATS — the WhatsApp-style heart of the demo (route { name: 'chats', conversationId? }).
- Layout: phone shows EITHER the list OR the open conversation (immersive, own header with back). Desktop shows two panes: the list (about 360px) and the conversation; with nothing selected show a friendly placeholder in the right pane.
- LIST (CHAT-04): a search box (id) filtering by name, filter chips All / Unread / Channels / People / Agents, the pinned Assistant first, then by lastActivity desc. Each row: avatar (channel → a rounded-square tile with a "#" or lock glyph tinted with surface-2/ink; DM → person Avatar with status dot; group → small AvatarStack; agent/assistant → their Avatar), name ("#" prefix for channels, lock icon for private), last message preview ("Priya: …", voice → mic icon + "Voice message 0:42", notes → "Meeting notes · Ops standup", file → paperclip + filename, suggest → "HR Policy has an answer"), listStamp time, UnreadBadge, an @ marker when mentions > 0, a muted icon, and a red "Live · 3" pill when the conversation's room has 2+ people.
- CONVERSATION: header (ScreenHeader with back on phone) with title, subtitle (channel topic / "N members" / person title + status / "Agent · owned by Chua Hui Min" with AgentBadge / "Private to you" for the assistant). Actions: for channels with a roomId, a "Join room" button showing live avatars (joinRoom then navigate rooms roomId); an info button opening a Sheet with members, topic and the channel's AI participation level (Off / Mention only / Suggest / Active — read-only display explaining what it means, AGT-08).
- Messages on bg-wall: day separators (dayLabel), consecutive messages from the same author grouped (name + avatar once), my messages right-aligned in accent-soft bubbles, others left in surface bubbles with author name in channels/groups (not in DMs). Render @mentions as accent-ink text. Kinds:
  • text; • voice: play/pause button, waveform bars (from message.voice.waveform) that fill as a simulated playback progresses, duration, and the transcript below in smaller text labelled "Auto-transcribed"; • file: a card with icon, name, size; • notes: <NotesCard sessionId compact/>; • suggest (J5): a compact teal card "<agent avatar> HR Policy has an answer from the Leave Policy page · Show" that expands to the answer (CitedText) + SourceChips + Feedback + AgentBadge; • system: centred small muted text (with a red pulsing dot when it mentions recording).
  Reactions row (tap toggles via react()), "3 replies" thread link with avatars that opens a Sheet showing a short scripted thread (define 2–3 plausible replies locally per message id), read ticks on my DM messages (readBy), "edited" label. On desktop, hovering a message shows quick actions: 👍 ❤️ 😂 🙏 reactions and "Create task" (addTask(text) + toast, TASK-04).
- Typing indicator from state.typing[conversationId] ("Priya is typing…" with animated dots).
- COMPOSER: autosizing textarea (id), Enter sends (Shift+Enter newline), value bound to state.drafts[conversationId] via setDraft so drafts survive navigation; when the draft equals an actionable's draft text show a small banner "Your assistant drafted this. Edit it, then send." (PA-08). A mic button starts a simulated voice recording (red timer, Cancel / Send) → sendVoice(cid, seconds, transcript) with a short plausible transcript. Attach button → toast that attachments come later in the demo. Send → send(cid, text). In the Assistant conversation the placeholder is "Ask your assistant…" and replies arrive via the store (assistant messages show AIMarker).
- Call markRead(conversationId) when a conversation opens. Scroll to the newest message on open and when messages arrive.

**Suggested screenshot runs:** list: --route '{"name":"chats"}' ; ops channel: --route '{"name":"chats","conversationId":"c_ops"}' ; ask-hr with suggest card: --route '{"name":"chats","conversationId":"c_askhr"}' ; DM with voice note: --route '{"name":"chats","conversationId":"dm_marcus"}' ; draft in composer: --before 'h.setDraft("dm_priya","Thanks Priya. Let’s go with Kranji Movers if they can match our current insurance cover. Can you confirm that with them on tomorrow’s call?")' --route '{"name":"chats","conversationId":"dm_priya"}' ; sales with notes card: --route '{"name":"chats","conversationId":"c_sales"}'

## Area: rooms-session

**Files you own:** src/screens/Rooms.tsx and src/screens/Session.tsx (you may add src/screens/rooms/* or src/screens/session/* helper files)

**PRD sections to read:** §6.2 J2/J3, §8.3 ROOM-01..12, REC-01..23 (note ROOM-10 live captions are REMOVED, D31), §8.16 PDPA-08, Rule 5

**Spec:**

ROOMS (route { name: 'rooms', roomId? }) — Discord-style drop-in voice rooms.
- LIST: "Live now" (rooms with 2+ participants): name, owning channel (#…), avatars of who's inside with the speaking person ringed, elapsed time since sessionStartedAt (use state.clock), RecordingIndicator compact, a screen-share pill if screenShareBy, and Join. "Quiet rooms": Lounge (only Kelvin inside → explain "Recording starts when a second person joins", REC-01), Sales floor (empty), People 1:1s (restricted: a "Restricted" pill and one line: "Sessions are visible only to the people in them and never added to search or AI", REC-07/Rule 5). "Recent sessions" from state.sessions → session page (title, day/time, duration, notes or "Short session · no notes").
- IN-ROOM (roomId set; immersive on phone): if state.myRoomId !== roomId, show a pre-join panel: room name, who's inside, and the recording notice (REC-06): "This room is recorded and transcribed. Session recordings are kept for 120 days and transcripts for 3 years. Everyone in #<channel> can open them." (restricted rooms: "Only the people in the session can open them."), with a big Join button → joinRoom(roomId) — plus a "Not now" back. Once joined: header with back, room name, RecordingIndicator (label "Recording · Transcribing") ALWAYS visible, elapsed timer; a participant grid of tiles (Avatar lg/xl, name, muted mic icon for someone muted, speaking ring/animated bars for the speaker; a screen-share tile when screenShareBy — show a simple mock of a shared screen built from shapes, no images); simulate speaking by cycling setSpeaking(roomId, id) through participants every ~2.5 s (only while you are in the room; clean up the interval). Controls bar at the bottom: mute (local toggle, starts muted on phone per ROOM-09), camera (local toggle), screen share (toast), raise hand (toggle), reactions popover (👍 👏 😂 🎉 — floating briefly over your tile), and a red Leave button → leaveRoom() then navigate({ name: 'rooms' }) (for the Ops standup the store then posts notes and toasts). Show "Recording paused — waiting for someone else to join" when fewer than 2 humans are present. Desktop: a side panel with "Room chat" — the room's channel's last few messages and a link to open the channel; phone: a "Room chat" button that navigates to the channel. Do NOT show live captions (removed, D31).
SESSION (route { name: 'session', sessionId, t? }) — recording, transcript and notes (REC-16, J3):
- Header (back) with title, shortDay + clock, duration, participant avatars, a Restricted pill if restricted, and "Recording kept until <date 120 days after start>" (compute with time.ts).
- Player: play/pause, scrubber showing current time / total (duration()), speed 1× / 1.5× / 2×; playing advances a local currentSec (simulated, interval). Start at route.t when given. The transcript passage containing currentSec is highlighted and kept in view.
- Transcript: passages with speaker avatar + name, a timestamp button (seeks), text; a search box (id) that highlights matches; passages with nonEnglish show "Non-English speech — may be inaccurate"; a "Machine-generated · gpt-transcribe" label for the transcript; per-passage "Suggest a correction" opening a Sheet with a textarea; saving toasts "Correction saved. The original is kept." (REC-15).
- Notes: <NotesCard sessionId={id} /> (not compact). Sessions without notes show "Short session · transcript saved, no notes" (D27).
- "Viewed by" (REC-21): avatars, names and times from session.viewedBy, plus a line "Every view is logged."
- "Ask this meeting" (REC-17): a small input answering 2–3 canned questions locally from this session's notes (e.g. who owns what) with AIMarker; otherwise "I can only answer from this meeting's transcript."
- Layout: desktop = transcript/player left, notes + viewed-by + ask right; phone = player on top and Segmented tabs Notes / Transcript / Details.

**Suggested screenshot runs:** rooms list: --route '{"name":"rooms"}' ; pre-join: --route '{"name":"rooms","roomId":"r_ops"}' ; in room: --before 'h.joinRoom("r_ops")' --route '{"name":"rooms","roomId":"r_ops"}' --wait 3000 ; design room with screen share: --before 'h.joinRoom("r_design")' --route '{"name":"rooms","roomId":"r_design"}' --wait 1500 ; session: --route '{"name":"session","sessionId":"s_pricing"}' ; session at a time: --route '{"name":"session","sessionId":"s_pricing","t":229}' ; leave flow: --before 'h.joinRoom("r_ops")' --route '{"name":"rooms","roomId":"r_ops"}' --after 'h.leaveRoom()' --wait 4500

## Area: tasks-calendar-docs

**Files you own:** src/screens/Tasks.tsx, src/screens/Calendar.tsx and src/screens/Docs.tsx (you may add src/screens/tasks/*, calendar/*, docs/* helper files)

**PRD sections to read:** §6.2 J3/J6, §8.4 CAL-01..10, §8.5 TASK-01..09, §8.6 DOC-01..13, PA-06

**Spec:**

TASKS (route { name: 'tasks' }):
- Segmented: My tasks / Team. A quick-add input (id) "Add a task…" → addTask(text).
- "Suggested for you" (state.suggested, TASK-06): each with title, due, source link (navigate source.route), and Accept / Edit / Dismiss. Edit opens inline fields (title, due) then accepts with edits (acceptSuggested(id, {title, due})). Explain in one line: "From meetings and your assistant. Nothing becomes a task until you accept it."
- My tasks: tasks assigned to ME grouped Today / This week / Later / Done (collapsed), each row with a round checkbox (setTaskStatus done/todo), title (strike-through when done), due (red when overdue / ember when due today), "In progress" pill for doing, high-priority marker, source chip (meeting/message/manual) that navigates, comment count, other assignees' avatars.
- Team: all tasks grouped by team with assignee avatars and status. On desktop offer a Board toggle (To do / In progress / Done columns) for the team view.
CALENDAR (route { name: 'calendar', eventId? }):
- Agenda view for Mon 12 – Fri 16 Oct with day headers (Today highlighted): time range, title, attendee AvatarStack, a "Now" marker for the live Ops standup (8:30–8:45 am) with Join (joinRoom + navigate rooms roomId), RSVP chips for pending events (rsvp), leave events shown as a quiet all-day band. Desktop: a 5-day week grid (time rows 8 am–6 pm) next to or instead of the agenda — your choice, but make it clean.
- Event detail (eventId; immersive on phone with back): title, time, attendees with RSVP state, agenda list, meeting room with Join (only enabled when live or within 5 minutes; otherwise "Join opens 5 minutes before"), and the assistant's PREP BRIEF when event.prep exists (AIMarker; related SourceChips, "Open items between attendees", "Last time" summary). For past events with sessionId: a card linking to the session ("Recording, transcript and notes").
- "New event" button → toast "Event creation comes later in the demo". "Find a time" (CAL-04) opens a Sheet listing 3 suggested free slots for the attendees (static, plausible).
DOCS (route { name: 'docs', docId? }) — J6:
- Home: spaces (Q4 launch, HR wiki, Ops wiki, People) and "Recent" docs (state.docs): emoji, title, space, owner, updated time, presence avatars.
- Doc view (immersive on phone): header with back, emoji + title, space breadcrumb, live presence AvatarStack ("Priya and Daniel are here"), a permissions pill — for d_q4: "Only Priya and you can edit · team can comment" (DOC-03) — opening a Sheet that explains the roles (Owner, Editor, Commenter, Viewer). Body: render blocks (h1 font-display, h2, p, li bullets, todo checkboxes that toggle via updateDoc when ME is an editor, quote) in a comfortable reading column (~65ch). Show a simulated live cursor label (e.g. "Priya" tag in her colour at the end of one block) for docs with presence.
- Comments (DOC-05): desktop side panel / phone Sheet: anchored quote, author, time, text, replies, Resolve; highlight anchored text in the body.
- Version history (DOC-04): a panel/Sheet listing versions (author avatar, time, summary); selecting one shows a diff (added lines in ok-soft, removed lines struck through in rec-soft) and "Restore this version" (toast "Restored as a new version").
- AI writing (DOC-09): an "Ask AI to draft" button for editors that shows a suggested paragraph (AIMarker) with Insert / Discard; Insert appends it via updateDoc and toasts. Never inserts without the user accepting.

**Suggested screenshot runs:** tasks: --route '{"name":"tasks"}' ; calendar: --route '{"name":"calendar"}' ; event with prep: --route '{"name":"calendar","eventId":"e_q4"}' ; past event: --route '{"name":"calendar","eventId":"e_pricing"}' ; docs home: --route '{"name":"docs"}' ; doc: --route '{"name":"docs","docId":"d_q4"}' ; leave policy: --route '{"name":"docs","docId":"d_leave"}'

## Area: onboarding-settings-insights

**Files you own:** src/screens/Onboarding.tsx, src/screens/Settings.tsx and src/screens/Insights.tsx (you may add src/screens/onboarding/*, settings/*, insights/* helper files)

**PRD sections to read:** §6.1 (avatar menu), §8.1 ACC-01..14, §8.11 PA-10, §8.14 ADM-14, §8.16 PDPA-02/03/04/05/07/13/18, Appendix B.6 (providers), D34, D36

**Spec:**

ONBOARDING (rendered by the shell instead of the app until completeOnboarding() is called; full-screen; centred card on desktop, full screen on phone; progress dots; Back on each step; a small "Skip intro" link on every step → completeOnboarding()):
1) Welcome: Hearth flame mark, "Tembusu Logistics uses Hearth for chat, voice rooms and meetings." Continue.
2) Phone number (ACC-01): +65 prefix and a number input (id) prefilled "9123 4567"; "Send code".
3) Code: six boxes that auto-fill "482913" after a moment (simulated SMS), "Resend in 0:28", Continue.
4) PIN (ACC-02): set a 6-digit PIN on an on-screen keypad (with dots), then confirm it; explain "You'll need your PIN on a new device. Hearth won't ask for it every time you open the app."
5) Privacy and recording notice (PDPA-02/03): a scrollable notice with short sections — What's recorded (every voice session with 2 or more people, including calls and drop-in rooms; a red recording indicator is always on screen); What the AI does (transcripts, meeting notes, your private assistant; it only uses what you can open; providers never train on your data); Who can see recordings (the room's channel members; restricted rooms only participants; every view is logged); Where data goes (AWS Singapore for storage and Claude via Amazon Bedrock in Singapore; OpenAI for transcription, processed outside Singapore; LiveKit for voice rooms, with logs in the US or EU); How long we keep it (session recordings 120 days, voice-message audio 360 days, transcripts and notes 3 years — proposed); Your rights (see, correct, withdraw — via the DPO); DPO: Ashton Teo. A checkbox "I've read the privacy and recording notice (version 1.0, 12 Oct 2026)" enabling "Acknowledge".
6) Install and notifications (ACC-14): an iPhone walkthrough drawn with simple shapes/icons (Share → Add to Home Screen), "Turn on notifications" (simulated: shows "Test notification received ✓"), and "Skip for now" which first warns "You may miss messages until notifications are on."
7) You're in: profile summary (Ashton Teo, Founder · Data Protection Officer), "You've been added to #announcements, #ops-north-site and #welcome", button "Open Hearth" → completeOnboarding().
SETTINGS (route { name: 'settings', section? }) — the avatar menu (§6.1):
- Profile header (Avatar xl, name, title, status, custom status). Sections as a list that opens detail views (or anchors) — route.section opens one directly:
  • Notifications (NOTIF-03): toggles for DMs, mentions, thread replies, meeting starting, assistant nudges; quiet hours 6 pm–8:30 am.
  • Devices (ACC-04): "iPhone 15 · this device", "MacBook Air · Chrome", "iPad · last used 3 Oct" with Sign out (toast).
  • Assistant memory (PA-10): list state.memories with edit (inline) / delete, "learned from" line, and a switch for memory on/off (setMemoryOn).
  • Privacy and your data (PDPA): summary of the notice and the acknowledgment record ("Version 1.0 acknowledged on 12 Oct 2026, 8:41 am"), DPO contact (Ashton Teo — show it as text), and three request buttons — "Request a copy of my data", "Correct my data", "Withdraw consent" — each opening a Sheet with a short form; submitting toasts "Request sent to the Data Protection Officer. You'll get a reply within 30 days."
  • Appearance: System / Light / Dark (setTheme, Segmented).
  • Help: short how-to list (Join a room, Ask a question, Turn a message into a task), "Report a problem" (toast).
  • "Replay the intro": clears the saved demo flag in localStorage inside try/catch and reloads the page.
INSIGHTS (route { name: 'insights' }) — People insights (ADM-14, D34, PDPA-18). Load the 'dataviz' skill via the Skill tool before drawing any bars, if that tool is available to you.
- Header "People insights" + Pill "Visible to leadership and admins". Controls: date range Segmented (This week / Last week / Last 30 days; the data in src/data/work.ts insights is "Last week 5–9 Oct" — scale it plausibly for the others and label honestly as example data), team filter (All teams + teams from people), metric selector (Messages & reactions, Talk time, Time in rooms & meetings, Tasks completed).
- Ranked list for the selected metric: rank, Avatar, name, team, value (tabular-nums, units: min / h) and a horizontal bar drawn to scale (accent colour, track in surface-2). Desktop: a table with all metrics as columns, sortable by clicking headers.
- Team totals (small summary row/cards per team for the selected metric).
- "Your own figures" card for Ashton (everyone sees their own).
- A caveat box (PDPA-18): "Counts and durations only — the AI never scores what people say. Talk time can be wrong when people share a meeting-room device or there's background noise. Restricted rooms are excluded. Every view of a person's figures is logged."

**Suggested screenshot runs:** onboarding: --onboarding --route '{"name":"today"}' ; onboarding notice step: --onboarding --route '{"name":"today"}' --after '<click through to the notice step — e.g. find and click the Continue / Send code buttons in sequence>' --wait 2000 ; settings: --route '{"name":"settings"}' ; privacy: --route '{"name":"settings","section":"privacy"}' ; memory: --route '{"name":"settings","section":"memory"}' ; insights: --route '{"name":"insights"}'
