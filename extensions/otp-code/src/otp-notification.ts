/**
 * Pure helpers that turn a detected code into the card the app shows.
 *
 * Kept apart from `index.ts` so the decisions that matter — is this mail fresh
 * enough to interrupt someone for, what does the card say, when does it die —
 * are plain functions over plain data and can be unit tested without an
 * extension host, a window, or a clock.
 */

import { hasTag, type EmailRecord, type ExtensionUINotification } from '@sarvinbox/extension-sdk';

import type { OtpDetection } from './otp-detect';

/** Tag applied to every mail a code was found in, so codes stay searchable. */
export const OTP_TAG = 'otp';

/** Id prefix; the host namespaces it again with the extension id. */
const CARD_PREFIX = 'code';

/**
 * UTC epoch milliseconds the mail reached the server.
 *
 * `date` is the server's INTERNALDATE, which is when the code was actually
 * delivered. `receivedDate` is when THIS app synced the row, so on a fresh
 * setup, an account re-add or a folder re-scan it is "now" for mail that is
 * hours old. Preferring it made every backlogged code look brand new, and the
 * first sync after setup put stale codes up on cards. It is only the fallback
 * for a row with no usable `date`.
 */
export function receivedAtMs(email: Pick<EmailRecord, 'date' | 'receivedDate'>): number | null {
  const seconds = [email.date, email.receivedDate].find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  );
  return seconds === undefined ? null : seconds * 1000;
}

/**
 * UTC epoch ms the code stops working: its arrival plus the validity the mail
 * states, or the default when it states none.
 *
 * Anchored to arrival, not to detection. A code found five minutes after it
 * landed has five minutes left, not ten. A future arrival (a skewed server
 * clock) counts from now, so the countdown can never run longer than the mail
 * says the code lasts. Null when the mail has no usable timestamp.
 */
export function codeExpiresAtMs(
  email: Pick<EmailRecord, 'date' | 'receivedDate'>,
  detection: Pick<OtpDetection, 'expiresInMs'>,
  now: number = Date.now()
): number | null {
  const arrived = receivedAtMs(email);
  if (arrived === null) return null;
  return Math.min(arrived, now) + detection.expiresInMs;
}

/** True when the reader has already seen the message, on this or any device. */
export function isAlreadyRead(email: Pick<EmailRecord, 'tags'>): boolean {
  return hasTag(email.tags ?? '', 'read');
}

/**
 * True when the code is worth interrupting the reader for: the message is
 * still unread and the code has not expired yet.
 *
 * A read message means the reader has already seen the code, or used it
 * somewhere else. An expired code cannot be used at all. Without this check,
 * the first sync of a large mailbox would put up a burst of cards for codes
 * that died long ago. The tag is still applied either way; only the card is
 * skipped. With no usable timestamp we cannot tell fresh mail from old, so no
 * card is shown.
 */
export function shouldNotifyForCode(
  email: Pick<EmailRecord, 'date' | 'receivedDate' | 'tags'>,
  detection: Pick<OtpDetection, 'expiresInMs'>,
  now: number = Date.now()
): boolean {
  if (isAlreadyRead(email)) return false;
  const expiresAt = codeExpiresAtMs(email, detection, now);
  return expiresAt !== null && expiresAt > now;
}

/** Who the code came from, for the supporting line on the card. */
export function senderLabel(email: Pick<EmailRecord, 'fromName' | 'fromAddress'>): string {
  const name = email.fromName?.trim();
  if (name) return name;
  const address = email.fromAddress?.trim();
  return address || 'Unknown sender';
}

/** Stable card id — one card per email, so a re-run replaces rather than stacks. */
export function notificationId(emailId: string): string {
  return `${CARD_PREFIX}:${emailId}`;
}

/**
 * Recover the email a card belongs to.
 *
 * The host reports the card's own id back with every reader action, and the id
 * is built from the email id — so the extension needs no side table mapping one
 * to the other, which would go stale the moment the process restarts while a
 * card is still on screen. Returns null for an id this extension did not make.
 */
export function emailIdFromNotificationId(id: string): string | null {
  const prefix = `${CARD_PREFIX}:`;
  if (!id.startsWith(prefix)) return null;
  const emailId = id.slice(prefix.length);
  return emailId || null;
}

/** Optional overrides for {@link buildOtpNotification}. */
export interface OtpNotificationOptions {
  /**
   * The id to raise the card under.
   *
   * Defaults to this email's own card id. It is passed explicitly when the
   * same message has already been carded from another account, so the second
   * copy folds into the first card rather than stacking beside it.
   */
  cardId?: string;
  /** Epoch ms to measure the expiry against. Defaults to now. */
  now?: number;
}

/**
 * Build the card. `expiresAt` is absolute UTC epoch ms, counted from when the
 * mail arrived, so the countdown shows the time the code really has left.
 */
export function buildOtpNotification(
  email: Pick<EmailRecord, 'id' | 'accountId' | 'fromName' | 'fromAddress' | 'date' | 'receivedDate'>,
  detection: OtpDetection,
  options: OtpNotificationOptions = {}
): ExtensionUINotification {
  const now = options.now ?? Date.now();
  return {
    id: options.cardId ?? notificationId(email.id),
    title: 'Verification code',
    body: senderLabel(email),
    fields: [{ label: 'Code', value: detection.code, copyable: true, emphasis: true }],
    expiresAt: codeExpiresAtMs(email, detection, now) ?? now + detection.expiresInMs,
    emailId: email.id,
    ...(email.accountId ? { accountId: email.accountId } : {}),
  };
}
