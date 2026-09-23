# Receipts & Subscriptions

A Sarv Inbox extension that reads receipts, invoices, renewal notices and trial
reminders as they arrive, and turns them into two things you can act on: a
panel showing what you spend and what you are subscribed to, and a warning
before a trial converts or a subscription renews.

The warning is the part that earns its place. A card saying "Netflix renewed"
is a fact you can find later; a card saying "your trial converts to Rs 649 a
month on Friday" is the one moment a mail client can still save you money.

## What it does

| | |
| --- | --- |
| Runs on | Every message, twice: on arrival (subject only) and again once the body is downloaded |
| Records | Merchant, amount, currency, kind, order reference, billing cycle and the next charge date |
| Shows | A sidebar panel: this message's receipt, what is due soon, your subscriptions ranked by monthly cost, and spend by month |
| Warns | Before a renewal or a trial conversion, once per charge |
| Tags | `receipt` on every recorded message, and `subscription` as well when the charge repeats |
| Needs | `email:read`, `email:label`, `storage:local`, `settings:read`, `ui:notify`, `ui:panel` |
| Needs no | Network access and no AI — everything is parsed locally from mail the app already has |

Four kinds are recognised: `purchase`, `subscription`, `refund` and `trial`.
Refunds subtract from the month they land in, so a month where a large order
came back does not read as the most expensive of the year.

## Finding them again

The tags are the point of tagging: they make a year of receipts answerable from
the search box, without the panel and without this extension having to build a
second search of its own.

```
tag:receipt                          every recorded receipt
tag:subscription                     only the ones that repeat
tag:receipt from:apple               that merchant's receipts
tag:subscription is:unread           renewals you have not read yet
```

`tag:` ANDs, so a second one narrows rather than widens, and it combines with
every other operator the search box takes. The tags behave like any other label
once applied — they show under the subject in the reading pane and in the
message list.

Searching them needs the `tag:` operator, which lands in the Sarv Inbox release
after 1.1.1. On an older build the tags are still applied and still shown; they
are simply not searchable yet.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `receipts-tracker.enabled` | `true` | Track receipts at all |
| `receipts-tracker.tagEmails` | `true` | Also tag messages `receipt` / `subscription` |
| `receipts-tracker.notifyRenewals` | `true` | Warn before a renewal or a trial conversion |
| `receipts-tracker.renewalLeadDays` | `3` | How many days' notice to give. `0` warns only about charges due tomorrow; the maximum is 30 |
| `receipts-tracker.minConfidence` | `0.5` | How certain the detector must be. Raise it if marketing mail is being counted, lower it if receipts are being missed |

## How detection works

Every decision is a small, pure, unit-tested function. There is no model and no
network call.

1. **Is this a receipt at all** (`src/receipt-detect.ts`). Weighted cues over
   the subject and the first 20,000 characters of the body. Past-tense proof
   that money moved ("payment received", "we charged", "your invoice") scores
   highest, because it is the one thing marketing mail rarely fakes.
   Promotional wording ("40% off", "shop now", "still in your cart") scores
   heavily negative and a failed payment scores negative enough to disqualify
   the message outright. The bar is deliberately asymmetric: a missed receipt
   leaves a gap you may never notice, while one "SALE! Everything under Rs 999"
   counted as spend puts a number in your total that is simply a lie.
2. **Which number is the total** (`src/money.ts`). Only amounts carrying a
   currency are considered — a bare number in a receipt is far more often an
   order id or a quantity. Candidates are scored on the words in front of
   them, so "Total" wins over "Subtotal", "Tax", "Shipping" and "Discount".
   Everything is integer minor units; no float ever touches a price.
3. **Who charged it** (`src/merchant.ts`). The sender's registrable domain is
   the identity, so Netflix, Netflix India and NETFLIX Billing are one
   subscription rather than three.
4. **When it charges again** (`src/billing-cycle.ts`). Dates are read only
   where a cue says one is coming — "next billing date", "renews on", "trial
   ends". When the mail states a cadence but no date, the next charge is
   projected forward from the receipt itself.
5. **What the panel draws** (`src/summary.ts`). Bucketing by month happens in
   the zone the panel reports, and every string the panel prints is formatted
   here, once.

### Known limitation

A dotted number sequence with no currency near it — a version string, an IP
address — can still be read as a grouped amount if a currency symbol happens to
precede it. Distinguishing those needs a rule about the surrounding text, not a
tighter number grammar; the test suite names this case explicitly rather than
pretending it is handled.

### Why the parsing is hand-rolled

The house rule is to prefer a maintained library, and two were considered.

- **Public suffix list** (`psl`) for the merchant domain. Not adopted: the
  registrable domain here only decides a label and a grouping, never a security
  boundary, and shipping a 250KB list into every extension bundle to get
  `co.uk` right is a poor trade. A short compound-suffix list covers it.
- **A fuzzy date parser** (`chrono-node`) for the renewal dates. Not adopted,
  and this one matters: a receipt is full of dates — ordered on, delivered by,
  invoice dated, offer valid until — and a parser run over the whole message
  will confidently return the first one it meets. Anchoring each date to the
  cue in front of it is what makes the answer mean anything. Ambiguous
  all-numeric dates (`12/10/2026`) are refused outright rather than guessed,
  because a renewal reminder two months wrong is worse than none.

## Dates and money

Everything is stored UTC and in integer minor units. The panel sends its IANA
zone and BCP 47 locale with every request, so a receipt from the evening of
30 September lands in September for a reader in Mumbai as well as one in
London, and an Indian reader sees `Rs 1,23,456.78` with lakh grouping from the
same stored integer that shows a German reader `1.234,56 EUR`.

## Developing

```sh
pnpm install
pnpm --filter @sarvinbox-ext/receipts-tracker test        # unit tests
pnpm --filter @sarvinbox-ext/receipts-tracker type-check
pnpm --filter @sarvinbox-ext/receipts-tracker build       # bundles to dist/index.js
```

The build produces a single self-contained CommonJS file. `@sarvinbox/extension-sdk` is
imported for types only, so nothing is required at runtime and the folder can
be dropped anywhere the app can read.

The panel in `panel/` is a separate origin with no bundler, so it cannot import
any of `src/`. It calls into the extension through `sarv.call()` and prints
what comes back; all the arithmetic and all the formatting stay on this side,
with tests around them.

See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md) for the extension API, the
permission model and how to publish one of your own.

## Privacy

Everything happens on your machine. The extension has no `network:fetch`
permission and no `ai:use` permission, so your spending never leaves the app
through it — the manifest is the enforcement, not a promise.

The tags go no further either. `receipt` and `subscription` are written to the
app's own database and never to your mail server, so nothing this extension
concluded about your spending is visible to the people who mail you or to the
server the mail sits on. The other side of that: the tags do not follow you to
another mail client.
