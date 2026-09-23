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

/** Resolve the confidence floor, ignoring a setting that is missing or out of range. */
export function resolveMinConfidence(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return MIN_CONFIDENCE;
  if (configured < 0 || configured > 1) return MIN_CONFIDENCE;
  return configured;
}


export function activate(context: ExtensionContext): void {
  const cards = createCardIndex();

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
  // Workflows are unregistered by the host; nothing else is held open.
}
