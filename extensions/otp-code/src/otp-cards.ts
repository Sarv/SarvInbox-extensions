/**
 * One card per MESSAGE, not per copy of the message.
 *
 * A mailbox read through two accounts — the same address via two servers, or a
 * personal and a work account both on a shared alias — delivers one message
 * twice, with two different email ids. The card id was built from the email
 * id, so the reader got two identical cards for one code stacked on top of
 * each other, each with its own countdown a few seconds out of step.
 *
 * The RFC 5322 `Message-ID` is what the two copies genuinely share, so it is
 * the key here: the first copy raises the card, and every later copy is folded
 * into it instead of raising another. What the extra copies contribute is
 * their own email id, remembered against the card, so that when the reader
 * copies the code there is a choice of which mailbox to file — and the one
 * they are looking at can win.
 *
 * Pure data structures over plain objects: no host, no clock, no I/O, so every
 * rule above is unit testable on its own.
 */

import type { EmailRecord, ExtensionUIAction } from '@sarvinbox/extension-sdk';

import { emailIdFromNotificationId, notificationId } from './otp-notification';

/** One copy of a message: the mailbox it landed in, and its id there. */
export interface CardTarget {
  /** The email id in that account — what `mail.*` calls take. */
  emailId: string;
  /** The account holding that copy, when the host told us. */
  accountId?: string;
}

interface TrackedCard {
  /** The id the card was raised under. */
  id: string;
  /** The code currently on screen, so a corrected one can replace it. */
  code: string;
  /** Every copy of the message seen, in arrival order. */
  targets: CardTarget[];
}

/**
 * What the extension remembers about the cards it has raised.
 *
 * Two views of the same records: by message, to answer "have I already shown
 * this?", and by card id, because that is all the host reports back when the
 * reader clicks.
 */
export interface CardIndex {
  readonly byMessage: Map<string, TrackedCard>;
  readonly byCardId: Map<string, TrackedCard>;
}

/**
 * How many cards to remember.
 *
 * The index lives for the life of the process, so it needs a ceiling. The cap
 * is far above any plausible run of verification codes and eviction is
 * oldest-first; losing the oldest entry costs nothing worse than a second card
 * for a message whose code has long since expired.
 */
export const MAX_TRACKED_CARDS = 500;

export function createCardIndex(): CardIndex {
  return { byMessage: new Map(), byCardId: new Map() };
}

/**
 * The key two copies of one message share.
 *
 * Angle brackets are stripped because whether they survive into storage is a
 * detail of the fetch, not of the message. Case is deliberately NOT folded:
 * the copies being merged carry the byte-identical header their sender wrote,
 * so folding buys nothing and could only ever merge two genuinely different
 * ids that differ by case.
 *
 * Mail with no `Message-ID` at all — rare, but a malformed sender can manage
 * it — falls back to the email id, which is exactly the old one-card-per-email
 * behaviour rather than merging every anonymous message into one card.
 */
export function messageKey(email: Pick<EmailRecord, 'id' | 'messageId'>): string {
  const bare = (email.messageId ?? '').trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  return bare ? `mid:${bare}` : `email:${email.id}`;
}

/** Whether this message needs a card, and which card id it belongs to. */
export interface CardDecision {
  /** The id to raise (or replace) the card under. */
  cardId: string;
  /** False when a card for this message is already on screen with this code. */
  show: boolean;
}

/**
 * Decide what to do with a detected code.
 *
 * A different code for a message already carded means the body stage found
 * something better than the subject stage did, so the card is replaced in
 * place. The same code means the card is already saying it — showing it again
 * would restart a countdown the reader is watching.
 */
export function decideCard(
  index: CardIndex,
  email: Pick<EmailRecord, 'id' | 'messageId'>,
  code: string
): CardDecision {
  const existing = index.byMessage.get(messageKey(email));
  if (!existing) return { cardId: notificationId(email.id), show: true };
  return { cardId: existing.id, show: existing.code !== code };
}

/**
 * Record that this copy of the message belongs to this card.
 *
 * Called for every copy, shown or folded: the folded ones are the entire point
 * — they are the other mailboxes the reader might be sitting in.
 */
export function rememberCard(
  index: CardIndex,
  email: Pick<EmailRecord, 'id' | 'accountId' | 'messageId'>,
  cardId: string,
  code: string
): void {
  const key = messageKey(email);
  const existing = index.byMessage.get(key);
  const target: CardTarget = {
    emailId: email.id,
    ...(email.accountId ? { accountId: email.accountId } : {}),
  };

  if (existing) {
    existing.code = code;
    if (!existing.targets.some((seen) => seen.emailId === email.id)) {
      existing.targets.push(target);
    }
    return;
  }

  const card: TrackedCard = { id: cardId, code, targets: [target] };
  index.byMessage.set(key, card);
  index.byCardId.set(cardId, card);
  evictOldest(index);
}

function evictOldest(index: CardIndex): void {
  while (index.byMessage.size > MAX_TRACKED_CARDS) {
    const oldest = index.byMessage.keys().next();
    if (oldest.done) break;
    const card = index.byMessage.get(oldest.value);
    index.byMessage.delete(oldest.value);
    if (card) index.byCardId.delete(card.id);
  }
}

/**
 * Which copy of the message a reader action refers to.
 *
 * In order of preference:
 *  1. the copy in the account the reader is looking at — a single card can
 *     stand for two mailboxes, and the one on screen is the one they mean;
 *  2. the copy in the account that raised the card, when the reader is
 *     somewhere else entirely (a unified view, or a third account);
 *  3. the first copy seen, so an unrecognised account still files something.
 *
 * Nothing remembered at all means the process restarted while a card was still
 * on screen. That click is still worth honouring, so it falls back to what the
 * host echoed back and then to the card id, which encodes the email it was
 * raised for. Returns null only for an id this extension did not make.
 */
export function resolveTarget(index: CardIndex, action: ExtensionUIAction): CardTarget | null {
  const targets = index.byCardId.get(action.notificationId)?.targets ?? [];

  if (targets.length > 0) {
    const active = action.activeAccountId
      ? targets.find((target) => target.accountId === action.activeAccountId)
      : undefined;
    if (active) return active;

    const owner = action.accountId
      ? targets.find((target) => target.accountId === action.accountId)
      : undefined;
    return owner ?? targets[0];
  }

  const emailId = action.emailId || emailIdFromNotificationId(action.notificationId);
  if (!emailId) return null;
  return { emailId, ...(action.accountId ? { accountId: action.accountId } : {}) };
}
