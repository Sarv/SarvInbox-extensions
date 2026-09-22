# Thread Summary

A Sarv Inbox extension that summarizes a long message, or a whole thread, into a
few sentences plus the points that matter and anything that looks like it needs
doing.

It has `ai:use`, so message text does go to whichever AI provider the app is
configured with — that is the whole job. It has no `network:fetch` permission,
so it cannot send that text anywhere else, and every summary it produces is
stored locally.

## What it does

| Where | What happens |
| --- | --- |
| The reading pane, on request | Summarizes the open message, or the thread it belongs to |
| As mail arrives, if you turn it on | Summarizes long messages in the background so opening one is instant |

The on-demand path is the one that matters. Summarizing every long message as it
arrives costs an AI call per message, so `autoSummarize` is **off** by default;
turning it on warms the same cache the reading pane reads, which is why a
pre-summarized message opens with no wait at all.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `email-summarization.enabled` | `true` | Master switch |
| `email-summarization.autoSummarize` | `false` | Summarize long mail on arrival, not just when asked |
| `email-summarization.minLength` | `1500` | Shortest message worth summarizing, in characters |

`minLength` has a floor of 400 characters however low you set it. Below that
there is nothing to summarize: the summary would be about as long as the mail,
and you would have paid an AI call to read the same words twice.

## What the model is shown

Not the raw message. Raw mail is HTML, quoted history, signatures and
disclaimers, and a model given all of that summarizes the disclaimer.

So each message is converted to plain text with the app's own converter, its
quoted tail is stripped, whitespace is collapsed, and it is truncated to 4,000
characters at a word boundary. A thread is rendered oldest-first — the order the
conversation happened in — capped at 20 messages and 24,000 characters total. If
the thread is over budget the **oldest** messages are dropped, because a long
thread is mostly about how it ended.

The prompt asks for a single JSON object and tells the model, in as many words,
never to infer or fill gaps. The parser then treats the reply as untrusted: it
scans for a balanced JSON object rather than assuming the model returned only
JSON, drops list entries that are not strings instead of coercing them, and caps
the summary and each point. A model that answers with prose and no JSON produces
no summary, not a wrong one.

## Where a summary lives

There is no `aiSummary` column on a message, and this extension does not invent
one — a workflow that returned a field nothing stores would have its output
silently dropped.

Summaries live in the extension's own local storage, keyed by a SHA-1 of the
exact text the model was shown. Content-keyed means no expiry is needed: edit
nothing and the key is stable forever, and a thread that gains a reply renders
different text, so it misses and is summarized again. That is correct by
construction rather than by a TTL someone has to tune. The cache holds 200
summaries, pruned by least-recently-used, and a read counts as a use.

Two requests for the same summary that arrive together make one AI call, not
two — concurrent callers share one in-flight request.

## A note on writes

The default extension storage backend reads and re-parses its whole JSON file on
every `get` and rewrites it on every `set`. A write per summary would be a
synchronous whole-file write on the main thread; on a first sync with
`autoSummarize` on, that is a frozen window.

So the cache is held in memory and flushed at most once every 30 seconds, only
when something changed, plus once on deactivation. A crash loses at most one
interval of cached summaries — which costs an AI call to rebuild, not data. The
flush machinery is shared with `vip-scoring` rather than copied
(`createFlushScheduler` in `@sarvinbox/extension-sdk`).

## Developing

```sh
pnpm install
pnpm --filter @sarvinbox-ext/email-summarization test
pnpm --filter @sarvinbox-ext/email-summarization type-check
pnpm --filter @sarvinbox-ext/email-summarization build
```

This is the one extension that imports `@sarvinbox/extension-sdk/text`, for
the HTML-to-text and quote-stripping helpers. That entry point is separate
because those helpers carry CommonJS dependencies no bundler can tree-shake —
which is why this bundle is ~310 KB where the other two are under 15 KB. Reuse
them anyway: a second HTML-to-text pass drifts from the one the app renders with.

See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md) for the extension API, the
permission model and how to publish one of your own.
