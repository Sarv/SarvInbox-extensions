# One-Time Passcodes

A Sarv Inbox extension that spots verification codes as they arrive and shows
them on a card with a copy button and a live countdown, so you never open the
email to read six digits.

It also tags those emails `otp`, which is what makes "where was that code from
last Tuesday" answerable afterwards, and marks a message read as soon as you
copy its code — the code is what you wanted, so the mail never has to be opened
and never sits unread.

## What it does

| | |
| --- | --- |
| Runs on | Every message except calendar invites, twice: on arrival (subject only) and again once the body is downloaded |
| Shows | A notification card: sender, the code, a copy button, and a countdown to expiry |
| Tags | `otp` on any message a code was found in |
| On copy | Marks that message read — you used the code, so the mail is done |
| Needs | `email:read`, `email:label`, `email:flag`, `storage:local`, `settings:read`, `ui:notify` |
| Needs no | Network access and no AI — detection is local, offline and free |

The countdown uses the validity the email itself states ("this code expires in
10 minutes") when it says one, and falls back to 10 minutes when it does not.

Cards are only shown for mail that arrived in the last 15 minutes. Syncing an
old mailbox tags the codes it finds but does not interrupt you with them — a
code from last March is not something you are waiting for.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `otp-code.enabled` | `true` | Surface codes at all |
| `otp-code.tagEmails` | `true` | Also tag the message `otp` |
| `otp-code.markReadOnCopy` | `true` | Mark the message read once you copy its code |
| `otp-code.dismissAfterCopyMs` | `3000` | How long the card stays on screen after you copy the code. Set it to `0` to leave the card up until its countdown runs out |
| `otp-code.minConfidence` | `0.55` | How certain the detector must be. Raise it if you see false positives, lower it if codes are being missed |

## How detection works

Detection is a set of small, pure, unit-tested functions — `src/otp-gate.ts`,
`src/otp-context.ts` and `src/otp-detect.ts` — not a model and not a network
call. In order:

1. **Gate.** A message carrying a calendar invite is never scanned at all. A
   meeting invite is dense with digits that look exactly like codes — dial-in
   numbers, PINs, meeting ids — and none of them is one.
2. **Mask.** Links, query-string values and phone numbers are blanked out of
   the text before any candidate is collected, so a code can never be sliced out
   of `+1 631-606-4341` or `?token=8842190`. The mask is length-preserving —
   the scoring below is index-based, so the text must keep its shape.
3. **Collect.** Candidates are 4-8 digit runs, grouped forms like `123 456`,
   and uppercase alphanumeric codes like `4F7K2A`, taken from the first 2,000
   characters of the subject and the body. The bound is deliberate: a
   newsletter must never be able to stall the main thread.
4. **Reject.** Anything whose neighbouring characters make it a price, a
   percentage, a URL fragment, a decimal or a version number is dropped, as is
   anything sitting near dial-in wording ("join by phone", "meeting id").
5. **Score.** Each survivor is scored on how close it sits to passcode wording
   ("verification code", "OTP", "your code is"), whether it is in the subject,
   whether the subject and body state the SAME code, whether the sender is a
   transactional address (`no-reply@`, `security@`), and its shape. Years,
   date stamps, and mail that FAILS SPF/DKIM/DMARC are penalised heavily — a
   forged "your code is" mail is the one case where a confident card is worse
   than no card.
6. **Return** the best candidate at or above the confidence floor, or nothing.

If no passcode wording appears within 60 characters of a number, that number is
not a code — this is what keeps order numbers and invoice totals off the card.

### Why this is hand-rolled

The house rule is to prefer a maintained library over bespoke regex, and it was
checked first. There is no maintained npm package for extracting OTPs from
email: the few that exist are single-regex, unmaintained and archived, and
Apple's `@`-marker convention is SMS-only. So this is kept small, pure,
documented and covered by tests instead, and every pattern is bounded and
non-nested so it cannot backtrack.

## Developing

```sh
pnpm install
pnpm --filter @sarvinbox-ext/otp-code test        # unit tests
pnpm --filter @sarvinbox-ext/otp-code type-check
pnpm --filter @sarvinbox-ext/otp-code build       # bundles to dist/index.js
```

The build produces a single self-contained CommonJS file. `@sarvinbox/extension-sdk` is
imported for types only, so nothing is required at runtime and the folder can
be dropped anywhere the app can read.

See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md) for the extension API, the
permission model and how to publish one of your own.

## Privacy

Everything happens on your machine. The extension has no `network:fetch`
permission and no `ai:use` permission, so message content cannot leave the app
through it — the manifest is the enforcement, not a promise.
