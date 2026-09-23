/*
 * Receipts panel.
 *
 * Presentation only, on purpose. Every amount, date and month heading on this
 * page arrives already formatted from the extension's background module: the
 * panel sends the two things only a browser knows — the reader's IANA zone and
 * their locale — and gets back rows it can print. Nothing here does
 * arithmetic on money and nothing here parses a date, so there is no second
 * implementation to drift from the tested one.
 *
 * Everything the page shows came out of an email, so nothing is ever assigned
 * as HTML. `text()` and `el()` below are the only ways content reaches the
 * DOM, and both go through `textContent`.
 */
(function () {
  'use strict';

  var root = document.getElementById('root');

  /** Longest bar in a spend chart, as a percentage of the track. */
  var MAX_BAR_PERCENT = 100;

  // --- Theme --------------------------------------------------------------
  //
  // The app marks dark mode with a `.dark` class on its own document, which a
  // panel in its own origin cannot read. The host defines a `theme-changed`
  // event for exactly this and does not yet emit one, so the panel listens for
  // it (free, and correct the day it starts arriving) and falls back to the OS
  // preference, which is what the app's own default follows.

  function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark', Boolean(isDark));
  }

  function watchTheme() {
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(query.matches);
    query.addEventListener('change', function (event) {
      applyTheme(event.matches);
    });

    sarv.on('theme-changed', function (payload) {
      applyTheme(payload && payload.theme === 'dark');
    });
  }

  // --- DOM helpers --------------------------------------------------------

  function el(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
    return node;
  }

  function append(parent, children) {
    children.filter(Boolean).forEach(function (child) {
      parent.appendChild(child);
    });
    return parent;
  }

  function section(title, note, body) {
    var head = append(el('div', 'section-head'), [
      el('h2', 'section-title', title),
      note ? el('span', 'section-note', note) : null,
    ]);
    return append(el('section', 'section'), [head, body]);
  }

  /**
   * A row the reader can click to reach the mail it came from.
   *
   * Every figure in this panel was read out of one specific message, and the
   * message is the only place the reader can check it. A row that cannot be
   * opened turns a wrong reading into something they can neither verify nor
   * correct.
   */
  function openableRow(emailId, children) {
    var row = append(el('button', 'row'), children);
    row.type = 'button';
    row.addEventListener('click', function () {
      sarv.call('openMessage', emailId).catch(function (error) {
        console.error('[receipts] could not open message', error);
      });
    });
    return row;
  }

  var KIND_LABELS = {
    purchase: 'Purchase',
    subscription: 'Subscription',
    refund: 'Refund',
    trial: 'Trial',
  };

  function kindBadge(kind) {
    return el('span', 'badge badge-' + kind, KIND_LABELS[kind] || kind);
  }

  // --- Sections -----------------------------------------------------------

  /** The receipt for the message the reader currently has open, if it is one. */
  function currentSection(receipt) {
    if (!receipt) return null;

    var side = append(el('div', 'row-side'), [
      receipt.amountMinor > 0 ? el('span', 'amount amount-lg', receipt.amountLabel) : null,
      kindBadge(receipt.kind),
    ]);

    var details = [receipt.cadenceLabel, receipt.occurredLabel, receipt.orderRef ? 'Ref ' + receipt.orderRef : null]
      .filter(Boolean)
      .join(' · ');

    // A trial's own end date is the one worth repeating here: it is the date
    // the reader can still act on, and it is not the same as the projected
    // renewal that follows it.
    var when = receipt.trialEndsLabel
      ? 'Trial ends ' + receipt.trialEndsLabel
      : receipt.nextChargeLabel
        ? 'Next charge ' + receipt.nextChargeLabel
        : null;

    var main = append(el('div', 'row-main'), [
      el('div', 'name', receipt.merchant),
      details ? el('div', 'meta', details) : null,
      when ? el('div', 'meta', when) : null,
    ]);

    return section('This message', null, append(el('div', 'card card-current'), [main, side]));
  }

  function upcomingSection(upcoming) {
    if (!upcoming.length) return null;

    var list = el('ul', 'list');
    upcoming.forEach(function (charge) {
      var reason = charge.reason === 'trial-ends' ? 'Trial ends' : 'Renews';
      var row = openableRow(charge.emailId, [
        append(el('div', 'row-main'), [
          el('div', 'name', charge.merchant),
          el('div', 'meta', reason + ' ' + charge.dueLabel),
        ]),
        append(el('div', 'row-side'), [
          charge.amountLabel ? el('span', 'amount', charge.amountLabel) : null,
          charge.reason === 'trial-ends' ? el('span', 'badge badge-soon', 'Act now') : null,
        ]),
      ]);
      append(list, [append(el('li'), [row])]);
    });

    return section('Coming up', String(upcoming.length), list);
  }

  function subscriptionsSection(subscriptions, recurringPerMonth) {
    if (!subscriptions.length) return null;

    var totals = el('div', 'card');
    recurringPerMonth.forEach(function (total) {
      append(totals, [
        append(el('div', 'total'), [
          el('span', 'total-label', 'Recurring, per month'),
          el('span', 'total-value', total.totalLabel),
        ]),
      ]);
    });

    var list = el('ul', 'list');
    subscriptions.forEach(function (subscription) {
      // The monthly equivalent is what makes a list of subscriptions
      // comparable: a yearly plan and a weekly one are not the same number
      // until they are both per month.
      var equivalent =
        subscription.amountLabel === subscription.monthlyEquivalentLabel
          ? null
          : subscription.monthlyEquivalentLabel + '/mo';

      var row = openableRow(subscription.emailId, [
        append(el('div', 'row-main'), [
          el('div', 'name', subscription.merchant),
          el(
            'div',
            'meta',
            subscription.nextChargeLabel
              ? 'Next ' + subscription.nextChargeLabel
              : subscription.cadenceLabel || 'Recurring'
          ),
        ]),
        append(el('div', 'row-side'), [
          el('span', 'amount', subscription.amountLabel),
          equivalent ? el('span', 'amount-sub', equivalent) : null,
        ]),
      ]);
      append(list, [append(el('li'), [row])]);
    });

    return section(
      'Subscriptions',
      String(subscriptions.length),
      append(el('div', 'section'), [totals, list])
    );
  }

  function spendSection(months) {
    if (!months.length) return null;

    // Bars are relative to the biggest month shown, not to an absolute scale:
    // the question the chart answers is "which month was heavy", and a fixed
    // ceiling would flatten every bar for a reader who spends little.
    var peak = months.reduce(function (highest, month) {
      return Math.max(highest, month.totalMinor);
    }, 0);

    var bars = el('div', 'bars');
    months.forEach(function (month) {
      var fill = el('div', 'bar-fill');
      fill.style.width = (peak > 0 ? (month.totalMinor / peak) * MAX_BAR_PERCENT : 0) + '%';

      append(bars, [
        append(el('div', 'bar'), [
          el('span', 'bar-label', month.label),
          append(el('div', 'bar-track'), [fill]),
          el('span', 'bar-value', month.totalLabel),
        ]),
      ]);
    });

    return section('Spend', null, append(el('div', 'card'), [bars]));
  }

  function emptyState() {
    var empty = el('p', 'state');
    append(empty, [
      el('strong', null, 'Nothing tracked yet'),
      document.createTextNode(
        'Receipts, invoices and renewal notices are recorded as they arrive.'
      ),
    ]);
    return empty;
  }

  // --- Rendering ----------------------------------------------------------

  function render(summary, receipt) {
    var sections = [
      currentSection(receipt),
      upcomingSection(summary.upcoming),
      subscriptionsSection(summary.subscriptions, summary.recurringPerMonth),
      spendSection(summary.months),
    ].filter(Boolean);

    root.replaceChildren();
    append(root, sections.length ? sections : [emptyState()]);
  }

  function showState(title, detail) {
    var state = el('p', 'state');
    append(state, [el('strong', null, title), document.createTextNode(detail)]);
    root.replaceChildren(state);
  }

  /**
   * The reader's zone and locale, straight from the browser.
   *
   * These are the only two facts the background module cannot know, and they
   * are what make a month boundary the reader's own rather than UTC's. Sent on
   * every call rather than stored, so nothing has to change when they travel.
   */
  function readerContext() {
    var resolved = {};
    try {
      resolved = Intl.DateTimeFormat().resolvedOptions();
    } catch (error) {
      console.warn('[receipts] no Intl context available', error);
    }
    return {
      timeZone: resolved.timeZone || 'UTC',
      locale: resolved.locale || undefined,
    };
  }

  /**
   * Single-flight refresh.
   *
   * `message-changed` can arrive while a refresh is still in the air — the
   * reader arrowing down a list fires one per message. Without this the
   * replies race and the panel can settle on the message the reader has
   * already left.
   */
  var refreshToken = 0;

  async function refresh() {
    var token = (refreshToken += 1);

    try {
      var context = readerContext();
      var message = await sarv.getCurrentMessage();
      var results = await Promise.all([
        sarv.call('getSummary', context),
        message ? sarv.call('getReceipt', message.id, context) : Promise.resolve(null),
      ]);

      if (token !== refreshToken) return;
      render(results[0], results[1]);
    } catch (error) {
      if (token !== refreshToken) return;
      console.error('[receipts] refresh failed', error);
      showState('Could not load receipts', 'Close and reopen the panel to try again.');
    }
  }

  watchTheme();
  sarv.on('message-changed', function () {
    void refresh();
  });
  void refresh();
})();
