'use strict';

// ../core/src/utils/tags.ts
var FLAG_TAG_NAMES = ["read", "starred", "answered", "draft", "deleted"];
var FLAG_TO_TAG = {
  "\\Seen": "read",
  "\\Flagged": "starred",
  "\\Answered": "answered",
  "\\Draft": "draft",
  "\\Deleted": "deleted"
};
var TAG_TO_FLAG = {
  read: "\\Seen",
  starred: "\\Flagged",
  answered: "\\Answered",
  draft: "\\Draft",
  deleted: "\\Deleted"
};
var TAG_DELIMITER = "|";
function sanitizeTagName(tag) {
  return (tag || "").split(TAG_DELIMITER).join("_");
}
function buildTags(tagList) {
  const safeList = tagList.map(sanitizeTagName).filter((tag) => tag.length > 0);
  if (safeList.length === 0) return "||";
  return `${TAG_DELIMITER}${safeList.join(TAG_DELIMITER)}${TAG_DELIMITER}`;
}
function parseTags(tags) {
  if (!tags || tags === "||") return [];
  return tags.split(TAG_DELIMITER).filter((t) => t.length > 0);
}
function hasTag(tags, tag) {
  const safeTag = sanitizeTagName(tag);
  if (!safeTag) return false;
  return (tags || "").includes(`${TAG_DELIMITER}${safeTag}${TAG_DELIMITER}`);
}
function addTag(tags, tag) {
  const safeTag = sanitizeTagName(tag);
  if (!safeTag || hasTag(tags, safeTag)) return tags;
  return buildTags([...parseTags(tags), safeTag]);
}
function removeTag(tags, tag) {
  const safeTag = sanitizeTagName(tag);
  return buildTags(parseTags(tags).filter((t) => t !== safeTag));
}
function imapFlagsToTags(flags) {
  const tags = [];
  for (const flag of flags) {
    const mapped = FLAG_TO_TAG[flag];
    if (mapped) tags.push(mapped);
    else if (flag.startsWith("\\")) tags.push(flag.slice(1).toLowerCase());
  }
  return tags;
}
function tagsToImapFlags(tags) {
  const flags = [];
  for (const tag of tags) {
    const flag = TAG_TO_FLAG[tag];
    if (flag) flags.push(flag);
  }
  return flags;
}

// ../core/src/config/folder-mapping.ts
var SPECIAL_USE_TO_TYPE = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "spam",
  "\\Flagged": "starred",
  "\\Archive": "archive",
  "\\All": "archive",
  "\\Important": "important"
};
var STANDARD_FOLDER_MAP = {
  inbox: ["INBOX", "Inbox"],
  sent: [
    // Gmail
    "[Gmail]/Sent Mail",
    // Outlook / Exchange
    "Sent Items",
    // iCloud
    "Sent Messages",
    // Yahoo / generic
    "Sent"
  ],
  drafts: [
    "[Gmail]/Drafts",
    "Drafts",
    "Draft"
  ],
  trash: [
    "[Gmail]/Trash",
    "[Gmail]/Bin",
    "Deleted Items",
    // Outlook
    "Deleted Messages",
    // iCloud
    "Trash",
    "Deleted"
  ],
  spam: [
    "[Gmail]/Spam",
    "Junk E-mail",
    // Outlook
    "Junk Email",
    "Bulk Mail",
    // Yahoo
    "Spam",
    "Junk"
  ],
  archive: [
    "[Gmail]/All Mail",
    "Archive",
    "All Mail",
    "Archives"
  ],
  starred: [
    "[Gmail]/Starred",
    "Starred",
    "Flagged"
  ],
  important: [
    "[Gmail]/Important",
    "Important"
  ]
};
var NAME_HEURISTICS = [
  { type: "drafts", test: (n) => n === "drafts" || n === "draft" },
  { type: "sent", test: (n) => n === "sent" || n === "sent mail" || n === "sent items" || n === "sent messages" },
  { type: "trash", test: (n) => n === "trash" || n === "bin" || n === "deleted" || n === "deleted items" || n === "deleted messages" },
  { type: "spam", test: (n) => n === "spam" || n === "junk" || n === "junk email" || n === "junk e-mail" || n === "bulk mail" },
  { type: "archive", test: (n) => n === "archive" || n === "archives" || n === "all mail" },
  { type: "starred", test: (n) => n === "starred" || n === "flagged" },
  { type: "important", test: (n) => n === "important" },
  { type: "inbox", test: (n) => n === "inbox" }
];
function classifyFolder(folder) {
  if (folder.specialUse) {
    const type = SPECIAL_USE_TO_TYPE[folder.specialUse];
    if (type) return type;
  }
  for (const [type, paths] of Object.entries(STANDARD_FOLDER_MAP)) {
    if (paths.some((p) => p === folder.path)) return type;
  }
  const lastSeg = (folder.path.split("/").pop() || folder.name || "").toLowerCase().trim();
  if (lastSeg) {
    for (const h of NAME_HEURISTICS) {
      if (h.test(lastSeg)) return h.type;
    }
  }
  return null;
}
var OWN_MAIL_WORD_RE = /(^|[^a-z])sent([^a-z]|$)/i;
function isOwnMailFolder(folder) {
  if (OWN_MAIL_WORD_RE.test(folder.path)) return true;
  const type = classifyFolder(folder);
  return type === "sent" || type === "drafts";
}
var isInboxFolder = (f) => classifyFolder(f) === "inbox";
var isSentFolder = (f) => classifyFolder(f) === "sent";
var isDraftsFolder = (f) => classifyFolder(f) === "drafts";
var isTrashFolder = (f) => classifyFolder(f) === "trash";
var isSpamFolder = (f) => classifyFolder(f) === "spam";
var isArchiveFolder = (f) => classifyFolder(f) === "archive";

// ../core/src/utils/event-loop.ts
var DEFAULT_YIELD_BUDGET_MS = 8;
function yieldToEventLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
var DEFAULT_DUTY_CYCLE = 0.25;
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
function createPacer(options = {}) {
  const dutyCycle = options.dutyCycle ?? DEFAULT_DUTY_CYCLE;
  const maxRestMs = options.maxRestMs ?? 2e3;
  const now = options.now ?? Date.now;
  const sleepFn = options.sleepFn ?? sleep;
  const yieldFn = options.yieldFn ?? yieldToEventLoop;
  const share = Number.isFinite(dutyCycle) && dutyCycle > 0 ? Math.min(dutyCycle, 1) : 1;
  const restFactor = 1 / share - 1;
  let workStartedAt = now();
  return {
    rest: async () => {
      const workedMs = Math.max(0, now() - workStartedAt);
      const restMs = Math.min(Math.round(workedMs * restFactor), maxRestMs);
      if (restMs >= 1) await sleepFn(restMs);
      else await yieldFn();
      workStartedAt = now();
      return restMs;
    }
  };
}
function createLoopYielder(options = {}) {
  const budgetMs = options.budgetMs ?? DEFAULT_YIELD_BUDGET_MS;
  const now = options.now ?? Date.now;
  const yieldFn = options.yieldFn ?? yieldToEventLoop;
  let lastYieldAt = now();
  return async () => {
    if (now() - lastYieldAt < budgetMs) return false;
    await yieldFn();
    lastYieldAt = now();
    return true;
  };
}

// ../core/src/utils/flush-scheduler.ts
var DEFAULT_FLUSH_INTERVAL_MS = 3e4;
function createFlushScheduler(options) {
  const intervalMs = options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const onError = options.onError ?? (() => void 0);
  let dirty = false;
  let disposed = false;
  let timer = null;
  function cancelTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }
  async function flush() {
    cancelTimer();
    if (!dirty) return;
    dirty = false;
    try {
      await options.write();
    } catch (error) {
      dirty = true;
      onError(error);
    }
  }
  return {
    markDirty() {
      dirty = true;
      if (timer || disposed) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, intervalMs);
      timer.unref?.();
    },
    isDirty() {
      return dirty;
    },
    flush,
    async dispose() {
      disposed = true;
      await flush();
    }
  };
}

// ../core/src/utils/single-flight.ts
function createSingleFlight() {
  const inFlight = /* @__PURE__ */ new Map();
  return {
    run(key, start) {
      const pending = inFlight.get(key);
      if (pending) return pending;
      let run;
      try {
        run = start();
      } catch (err) {
        return Promise.reject(err);
      }
      const tracked = run.finally(() => {
        if (inFlight.get(key) === tracked) inFlight.delete(key);
      });
      inFlight.set(key, tracked);
      return tracked;
    },
    pending(key) {
      return inFlight.get(key);
    },
    get size() {
      return inFlight.size;
    }
  };
}

exports.DEFAULT_DUTY_CYCLE = DEFAULT_DUTY_CYCLE;
exports.DEFAULT_FLUSH_INTERVAL_MS = DEFAULT_FLUSH_INTERVAL_MS;
exports.DEFAULT_YIELD_BUDGET_MS = DEFAULT_YIELD_BUDGET_MS;
exports.FLAG_TAG_NAMES = FLAG_TAG_NAMES;
exports.addTag = addTag;
exports.buildTags = buildTags;
exports.classifyFolder = classifyFolder;
exports.createFlushScheduler = createFlushScheduler;
exports.createLoopYielder = createLoopYielder;
exports.createPacer = createPacer;
exports.createSingleFlight = createSingleFlight;
exports.hasTag = hasTag;
exports.imapFlagsToTags = imapFlagsToTags;
exports.isArchiveFolder = isArchiveFolder;
exports.isDraftsFolder = isDraftsFolder;
exports.isInboxFolder = isInboxFolder;
exports.isOwnMailFolder = isOwnMailFolder;
exports.isSentFolder = isSentFolder;
exports.isSpamFolder = isSpamFolder;
exports.isTrashFolder = isTrashFolder;
exports.parseTags = parseTags;
exports.removeTag = removeTag;
exports.sanitizeTagName = sanitizeTagName;
exports.sleep = sleep;
exports.tagsToImapFlags = tagsToImapFlags;
exports.yieldToEventLoop = yieldToEventLoop;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map