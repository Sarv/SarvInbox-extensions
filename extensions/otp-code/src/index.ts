/**
 * One-Time Passcodes — Sarv Inbox extension.
 *
 * Reads the subject and body of arriving mail, finds a verification code, and
 * asks the app to show it on a card with a copy button and a countdown. Also
 * tags the mail `otp` so the codes stay findable after the card is gone.
 *
 * This file is the wiring only. Every decision worth testing lives in
 * `otp-detect.ts` (does this text contain a code?) and `otp-notification.ts`
 * (is it worth showing, and what does the card say?).
 */

import type {
  EmailRecord,
  ExtensionContext,
  ExtensionUIAction,
  ExtensionWorkflowResult,
} from '@sarvinbox/extension-sdk';

import {
  type CardTarget,
  createCardIndex,
  decideCard,
  rememberCard,
  resolveTarget,
} from './otp-cards';
import { MIN_CONFIDENCE, detectOtpCode } from './otp-detect';
import { OTP_TAG, buildOtpNotification, isFreshEnoughToNotify } from './otp-notification';

const WORKFLOW_ID = 'detect-code';

const SETTING_ENABLED = 'otp-code.enabled';
const SETTING_TAG_EMAILS = 'otp-code.tagEmails';
const SETTING_MIN_CONFIDENCE = 'otp-code.minConfidence';
const SETTING_MARK_READ_ON_COPY = 'otp-code.markReadOnCopy';
const SETTING_DISMISS_AFTER_COPY_MS = 'otp-code.dismissAfterCopyMs';

/** How long the card stays up after the code is copied, when nothing says otherwise. */
const DEFAULT_DISMISS_AFTER_COPY_MS = 3000;

/** The longest wait worth honouring; past this the card's own countdown is the better timer. */
const MAX_DISMISS_AFTER_COPY_MS = 60_000;

/** Resolve the confidence floor, ignoring a setting that is missing or out of range. */
export function resolveMinConfidence(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return MIN_CONFIDENCE;
  if (configured < 0 || configured > 1) return MIN_CONFIDENCE;
  return configured;
}

/**
 * How long to leave the card up after its code has been copied.
 *
 * Copying is the reader saying they have what they came for, so the card has
 * done its job and standing there until the countdown runs out is just clutter
 * over their mail. But taking it down the instant they click steals the
 * "Copied!" confirmation they are still reading, and the code itself if the
 * paste did not land. A few seconds shows both and is gone before they look
 * back.
 *
 * `0` means never — leaving the card to expire on its own is a fair choice for
 * someone who copies a code and then goes hunting for the field to paste it
 * into. Anything unset, negative or not a number falls back to the default
 * instead: a typo in a settings file must not quietly turn a behaviour off.
 */
export function resolveDismissAfterCopyMs(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_DISMISS_AFTER_COPY_MS;
  }
  if (configured < 0) return DEFAULT_DISMISS_AFTER_COPY_MS;
  return Math.min(configured, MAX_DISMISS_AFTER_COPY_MS);
}

/**
 * Clear-the-timers handle for the current activation.
 *
 * `deactivate()` is handed no context, so module scope is the only way for it
 * to reach anything `activate` created. One activation is live at a time — the
 * host deactivates before it activates again — so a single handle is enough.
 */
let cancelPendingDismissals: (() => void) | null = null;

/**
 * Take the card down once the reader has had a moment with it.
 *
 * The timer is remembered so deactivation can cancel it: one left pending
 * would call into a host that has stopped listening, and across a reload it
 * would dismiss a card the new instance had only just raised.
 */
function scheduleDismiss(
  context: ExtensionContext,
  timers: Set<ReturnType<typeof setTimeout>>,
  notificationId: string
): void {
  const delay = resolveDismissAfterCopyMs(
    context.settings.get<number>(SETTING_DISMISS_AFTER_COPY_MS)
  );
  if (delay === 0) return;

  const timer = setTimeout(() => {
    timers.delete(timer);
    try {
      context.ui.dismiss(notificationId);
    } catch (error) {
      // The card expires on its own anyway; failing to take it down early is
      // worth recording and nothing more.
      context.log.warn(`Could not dismiss ${notificationId}: ${String(error)}`);
    }
  }, delay);
  timers.add(timer);
}


export function activate(context: ExtensionContext): void {
  const cards = createCardIndex();
  const dismissals = new Set<ReturnType<typeof setTimeout>>();

  cancelPendingDismissals = (): void => {
    for (const timer of dismissals) clearTimeout(timer);
    dismissals.clear();
  };

  /**
   * Copying the code is the reader saying they used it — so the mail has done
   * its job and is marked read, exactly as if they had opened it. That is the
   * whole point of the card: the code arrives, is copied, and the message never
   * has to be visited at all, which without this would leave a permanently
   * growing pile of unread one-time passcodes.
   *
   * Only 'copy' acts. A dismissal or an expiry means the reader did NOT take
   * the code, and marking that read would hide a message they may still need.
   *
   * One card can stand for the same message in two accounts, so WHICH copy
   * gets filed is a real choice — `resolveTarget` makes it, preferring the
   * mailbox the reader is looking at.
   */
  context.ui.onAction(async (action: ExtensionUIAction): Promise<void> => {
    if (action.action !== 'copy') return;

    // Two independent consequences of one click, each with its own setting:
    // the card comes down, and the message is filed. Turning the filing off
    // must not also pin a used card to the screen.
    scheduleDismiss(context, dismissals, action.notificationId);

    if (context.settings.get<boolean>(SETTING_MARK_READ_ON_COPY, true) === false) return;

    const target: CardTarget | null = resolveTarget(cards, action);
    if (!target) return;

    try {
      await context.mail.markRead(target.emailId);
      context.log.info(`Marked ${target.emailId} read after its code was copied`);
    } catch (error) {
      // The code is already on the clipboard; failing to file the mail is not
      // worth surfacing to the reader, only worth recording.
      context.log.warn(`Could not mark ${target.emailId} read: ${String(error)}`);
    }
  });

  context.registerWorkflow({
    id: WORKFLOW_ID,
    name: 'Detect one-time passcodes',
    description: 'Finds a verification code in the subject or body and surfaces it',
    priority: 10,
    // Subject-only codes surface on arrival; the rest need the body, which is
    // fetched after the message is stored.
    requiresBody: true,

    shouldProcess: (email: EmailRecord): boolean => {
      if (context.settings.get<boolean>(SETTING_ENABLED, true) === false) return false;
      // Nothing to read yet and nothing in the subject is cheap to rule out.
      return Boolean(email.subject || email.cleanBody);
    },

    process: async (email: EmailRecord): Promise<ExtensionWorkflowResult> => {
      try {
        const detection = detectOtpCode({ subject: email.subject, body: email.cleanBody });
        if (!detection) return { success: true };

        const floor = resolveMinConfidence(context.settings.get<number>(SETTING_MIN_CONFIDENCE));
        if (detection.confidence < floor) return { success: true };

        // Stale mail is left out of the index entirely: a backlogged copy must
        // not claim the card and then silence a copy that arrives fresh.
        if (isFreshEnoughToNotify(email)) {
          const decision = decideCard(cards, email, detection.code);
          if (decision.show) {
            context.ui.notify(buildOtpNotification(email, detection, { cardId: decision.cardId }));
          }
          rememberCard(cards, email, decision.cardId, detection.code);
        }

        const tagEmails = context.settings.get<boolean>(SETTING_TAG_EMAILS, true) !== false;

        return {
          success: true,
          ...(tagEmails ? { labelsToAdd: [OTP_TAG] } : {}),
          metadata: {
            confidence: detection.confidence,
            source: detection.source,
            expiryFromMail: detection.expiryFromMail,
          },
        };
      } catch (error) {
        // A detector fault must never stop the mail being stored or the rest of
        // the pipeline running — report it and let the message through.
        context.log.error('OTP detection failed', error);
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  });

  context.log.info('One-Time Passcodes activated');
}

export function deactivate(): void {
  // Workflows are unregistered by the host. The post-copy dismiss timers are
  // not, and one still pending is the only thing this extension leaves running.
  cancelPendingDismissals?.();
  cancelPendingDismissals = null;
}
