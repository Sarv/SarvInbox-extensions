/** IMAP system flags mapped to our lowercase tag names. */
declare const FLAG_TAG_NAMES: readonly ["read", "starred", "answered", "draft", "deleted"];
/**
 * Make a tag name safe to store in the `|a|b|` encoding by replacing every
 * delimiter with `_`.
 *
 * Without this, a tag name that itself contains a `|` — a Gmail label, a
 * user-typed filter `applyLabel` value, a folder path — silently corrupts the
 * encoding: `addTag('||', 'a|b')` produced `|a|b|`, byte-identical to the two
 * tags `a` and `b`, so `hasTag(tags, 'a')` (and the equivalent SQL
 * `instr(tags, '|a|')`) then answered true for a message that was never tagged
 * `a`.
 *
 * SANITISE rather than THROW: this runs in the per-message sync hot path, where
 * an exception over one oddly-named label would abort the whole folder's sync.
 * Sanitising also cannot corrupt anything already stored — it rewrites no
 * existing tag string, and because it is applied identically on write and on
 * read (hasTag/addTag/removeTag all normalise their argument), a tag stored
 * under its sanitised name is still found by a lookup with the raw name.
 *
 * `_` and not `/`: `/` is the folder-hierarchy separator, so it would let a
 * label masquerade as a folder path tag.
 */
declare function sanitizeTagName(tag: string): string;
/** Build a tags string from an array of tag names. */
declare function buildTags(tagList: string[]): string;
/** Parse a tags string into an array of tag names. */
declare function parseTags(tags: string): string[];
/** Check if a tags string contains a specific tag. */
declare function hasTag(tags: string, tag: string): boolean;
/** Add a tag to a tags string (idempotent). */
declare function addTag(tags: string, tag: string): string;
/** Remove a tag from a tags string. */
declare function removeTag(tags: string, tag: string): string;
/** Convert IMAP flags to our tag names (unknown custom `\Flags` kept lowercased). */
declare function imapFlagsToTags(flags: string[]): string[];
/** Convert our tag names back to IMAP flags (folder/category tags are skipped). */
declare function tagsToImapFlags(tags: string[]): string[];

/**
 * Standard folder types — provider-agnostic identifiers used throughout the
 * app. Resolution order for any given folder:
 *   1. IMAP SPECIAL-USE attribute (RFC 6154) — the authoritative source when
 *      the server advertises it (Gmail, most modern IMAP servers, Outlook).
 *   2. Exact path match against STANDARD_FOLDER_MAP.
 *   3. Name-based substring heuristic (last resort, case-insensitive).
 */
type StandardFolderType = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'starred' | 'important';
/**
 * Minimum shape a folder needs to be classified — matches both `FolderRecord`
 * (DB shape) and `IMAPFolder` (wire shape).
 */
interface ClassifiableFolder {
    path: string;
    name?: string;
    specialUse?: string | null;
    uidValidity?: number | null;
    /**
     * Local rows carrying this folder as a membership TAG (folders.total_count).
     * NOT a count of mail filed here: a message that belongs to two folders —
     * including two names for the same one — is tagged with both, so this counts
     * the same message under every name it appears in.
     */
    totalCount?: number | null;
    /**
     * Rows whose PRIMARY folder is this one (`emails.folder_id`) — the mail
     * actually FILED under this name, counted once. This is the only count that
     * separates two names for one store: dedup keeps one row and adds the second
     * name as a tag, so `totalCount` reads ~1,718 for BOTH names of a Sent
     * mailbox while the filed count reads 1,718 and 1. Attached for contested
     * roles only (it costs a query per folder); absent means "not measured", and
     * the tag count is used instead.
     */
    ownedCount?: number | null;
    /** What the server last reported this mailbox holds (EXISTS). */
    serverMessageCount?: number | null;
}
/**
 * Resolve a folder to a standard type using the three-tier strategy:
 * special-use → exact path → name heuristic.
 */
declare function classifyFolder(folder: ClassifiableFolder): StandardFolderType | null;
/**
 * Is this folder the user's OWN outgoing mail — Sent or Drafts?
 *
 * The one place that decides it, because two stages act on the answer and a
 * disagreement between them is not cosmetic. `headerStage` refuses to spam-score
 * own mail (a draft has no Message-ID yet, a sent copy carries no authentication
 * verdict, and a `spam` tag on your own words would hide them from the Spam
 * filter view), and the header backfill excludes the same folders from the spam
 * half of its backlog. If the backfill thought a folder was ordinary mail while
 * the scorer thought it was the user's own, it would fetch those rows on every
 * tick, decline to score them, write nothing, and select them again — a backlog
 * that never drains.
 *
 * Deliberately wider than {@link classifyFolder} alone: any path segment whose
 * WORDS include "sent" counts, even when the server marks no special-use and
 * the name is not a standard one. That catches "Sent Items", "INBOX.Sent",
 * "Sent Mail" and a user's own "Sent 2019" or "sent-to-legal" archive.
 *
 * On words, not a bare substring, for the reason the folder classifier already
 * learned the hard way: "Consent Forms" contains "sent", and a plain
 * `.includes('sent')` would quietly exempt that mailbox from spam scoring
 * forever, with nothing on screen to say why.
 */
declare function isOwnMailFolder(folder: ClassifiableFolder): boolean;
declare const isInboxFolder: (f: ClassifiableFolder) => boolean;
declare const isSentFolder: (f: ClassifiableFolder) => boolean;
declare const isDraftsFolder: (f: ClassifiableFolder) => boolean;
declare const isTrashFolder: (f: ClassifiableFolder) => boolean;
declare const isSpamFolder: (f: ClassifiableFolder) => boolean;
declare const isArchiveFolder: (f: ClassifiableFolder) => boolean;

/**
 * Cooperative yielding for long loops that run on the Electron main thread.
 *
 * better-sqlite3 is synchronous, so every `await` around a query resolves as a
 * microtask and the queue drains without ever reaching libuv's poll phase. A
 * loop that never hands the thread back therefore freezes EVERYTHING: IMAP
 * socket reads, ImapFlow's own timeouts, and every renderer IPC reply — which
 * macOS shows as the spinning beachball, and which the log shows as body-fetch
 * timeouts and poisoned pool connections that look like network faults but are
 * not. `yieldToEventLoop` is the single primitive that gives the thread back.
 *
 * `createLoopYielder` exists because the row-COUNT yield this replaces is the
 * bug, not the fix. `if (++n % 500 === 0) await yield()` silently assumes a
 * fixed per-row cost: when a row got expensive (a per-row query whose plan
 * degraded to a full table scan), 500 rows became 25 SECONDS of uninterruptible
 * work — measured in the field 2026-08-26, one 500-row chunk per beachball. A
 * time budget cannot be wrong that way: however slow one item turns out to be,
 * the thread comes back within roughly `budgetMs`, so a future regression is a
 * slowdown instead of a freeze.
 *
 * Deliberately NOT reaching for a library: this is two lines of platform
 * primitive (`setImmediate`, `Date.now`) with no edge cases a package would
 * handle better, and it must not add a dependency to the storage hot path.
 */
/**
 * How long a loop may hold the thread before yielding. One frame at 120Hz is
 * ~8ms; staying under that keeps the UI drawing and lets IMAP sockets and IPC
 * replies through, while still amortising the yield over enough work that the
 * loop makes real progress.
 */
declare const DEFAULT_YIELD_BUDGET_MS = 8;
/**
 * Hand the thread back to libuv for one turn.
 *
 * `setImmediate` (the check phase) rather than `setTimeout(0)` (the timer
 * phase): it runs after the poll phase, so pending I/O is serviced BEFORE the
 * loop resumes, and it does not incur the timer's minimum clamp.
 */
declare function yieldToEventLoop(): Promise<void>;
type LoopYielderOptions = {
    /** Milliseconds of work allowed between yields. */
    budgetMs?: number;
    /** Clock, injected for tests. */
    now?: () => number;
    /** Yield primitive, injected for tests. */
    yieldFn?: () => Promise<void>;
};
/**
 * Build a yielder to `await` on EVERY iteration of a long loop. It returns
 * without yielding while the time budget holds, so the cost in the common case
 * is one `Date.now()` per item; once the budget is spent it yields and resets.
 *
 * Resolves to `true` when it actually yielded, which lets a caller re-check
 * cancellation or log progress only on real yield points.
 *
 *     const breathe = createLoopYielder();
 *     for (const row of rows) {
 *       await breathe();
 *       expensiveSyncWork(row);
 *     }
 */
/**
 * How much of the wall clock a background pass may spend on the main thread.
 *
 * A yielder is not enough on its own, and a CPU profile of the running app said
 * so: with the wasteful query removed, the inline-image pass still held 79% of
 * wall-clock in JS, because yielding hands the thread back for ONE turn and the
 * loop immediately takes it again. Nothing else — IMAP reads, IPC replies, the
 * renderer — gets a look in, so the app beachballs for the whole migration.
 *
 * A duty cycle bounds the SHARE instead of the slice: work for as long as the
 * chunk takes, then rest proportionally. The pass takes longer in wall-clock and
 * that is the correct trade for work nobody is waiting on — a 13-minute migration
 * that makes the app unusable is worse than a 50-minute one nobody notices.
 */
declare const DEFAULT_DUTY_CYCLE = 0.25;
type PacerOptions = {
    /** Share of wall clock the caller's work may occupy, in (0, 1]. */
    dutyCycle?: number;
    /** Never rest longer than this, however slow one unit of work was. */
    maxRestMs?: number;
    /** Clock, injected for tests. */
    now?: () => number;
    /** Sleep primitive, injected for tests. */
    sleepFn?: (ms: number) => Promise<void>;
    /** Yield primitive for the no-rest-needed case, injected for tests. */
    yieldFn?: () => Promise<void>;
};
/** Sleep for real — the timer phase, so the thread is genuinely released. */
declare function sleep(ms: number): Promise<void>;
/**
 * Build a pacer whose `rest()` is awaited after each unit of work, keeping that
 * work under `dutyCycle` of the wall clock.
 *
 *     const pace = createPacer({ dutyCycle: 0.25 });
 *     for (;;) {
 *       const chunk = runChunk();      // holds the thread; a transaction cannot yield
 *       if (!chunk.visited) break;
 *       await pace.rest();             // rests ~3x however long that took
 *     }
 *
 * Returns the milliseconds actually rested, which lets a caller log its own
 * pacing without measuring it twice.
 *
 * `rest()` ALWAYS awaits something. When the work was fast enough to need no
 * rest it still yields one turn, so this is a strict replacement for a yielder at
 * the same call site rather than something to layer on top of one — a pacer that
 * could return synchronously would starve the loop on a mailbox of tiny rows.
 */
declare function createPacer(options?: PacerOptions): {
    rest: () => Promise<number>;
};
declare function createLoopYielder(options?: LoopYielderOptions): () => Promise<boolean>;

/**
 * Email record stored in database
 */
interface EmailRecord {
    id: string;
    messageId: string;
    threadId: string;
    folderId: string;
    uid: number;
    accountId?: string;
    tags: string;
    subject: string | null;
    fromAddress: string;
    fromName: string | null;
    toAddress: string;
    toNames: string | null;
    ccAddress: string | null;
    ccNames: string | null;
    bccAddress: string | null;
    bccNames: string | null;
    replyTo: string | null;
    date: number;
    receivedDate: number | null;
    cleanBody: string;
    rawBody: string;
    /** True when the DB holds a body for this row. Set on LIST rows (where rawBody
     *  is omitted); on full rows it reflects rawBody presence. */
    hasBody?: boolean;
    contentType: 'text' | 'html' | 'multipart';
    contentHash: string;
    inReplyTo: string | null;
    references: string | null;
    priority: 'low' | 'normal' | 'high' | null;
    hasAttachments: boolean;
    attachmentCount: number;
    attachmentNames: string | null;
    attachmentSizes: string | null;
    calendarIcs?: string | null;
    calendarAdded?: boolean;
    hasEmbedding: boolean;
    embeddingLastGenerated: number | null;
    importanceScore?: number;
    importanceSource?: 'none' | 'provider' | 'ai' | 'user' | 'rule';
    authStatus?: string;
    spamScore?: number | null;
    spamReasons?: string | null;
    originIp?: string | null;
    spamUserVerdict?: 'spam' | 'ham' | null;
    aiProcessedAt?: number | null;
    aiConfidence?: number;
    aiReasoning?: string | null;
    priorityScore?: number;
    snoozeUntil?: number | null;
    snoozeOriginalTags?: string | null;
    threadMessageCount?: number;
    threadFirstSender?: string;
    threadLastSender?: string;
    createdAt: number;
    updatedAt: number;
    flags?: string[];
    labels?: string[];
    isImportant?: boolean;
    isStarred?: boolean;
}

/**
 * Pipeline Types and Interfaces
 * Core type definitions for the email processing pipeline
 */

/**
 * Result of a workflow processing an email
 */
interface WorkflowResult {
    /** Whether the workflow succeeded */
    success: boolean;
    /** Modifications to apply to the email record */
    modifications?: Partial<EmailRecord>;
    /** Labels to add to the email */
    labelsToAdd?: string[];
    /** Labels to remove from the email */
    labelsToRemove?: string[];
    /** Flags to add (e.g., '\Seen', '\Flagged') */
    flagsToAdd?: string[];
    /** Flags to remove */
    flagsToRemove?: string[];
    /** Arbitrary metadata to store */
    metadata?: Record<string, any>;
    /** Chain to specific workflows next */
    nextWorkflows?: string[];
    /** Skip remaining workflows */
    skipRemaining?: boolean;
    /** Error if failed */
    error?: Error;
    /** Processing time in ms */
    processingTime?: number;
}
/**
 * All possible pipeline events
 */
type PipelineEvent = EmailReceivedEvent | EmailSyncedEvent | EmailBodyReadyEvent | EmailProcessedEvent | EmailLabeledEvent | EmailFlaggedEvent | SyncStartedEvent | SyncProgressEvent | SyncCompletedEvent | SyncErrorEvent | WorkflowStartedEvent | WorkflowCompletedEvent | WorkflowErrorEvent | TaskScheduledEvent | TaskCompletedEvent | TaskFailedEvent;
interface EmailReceivedEvent {
    type: 'email:received';
    email: EmailRecord;
    folder: string;
    timestamp: number;
}
interface EmailSyncedEvent {
    type: 'email:synced';
    email: EmailRecord;
    folder: string;
    isNew: boolean;
    timestamp: number;
}
interface EmailBodyReadyEvent {
    type: 'email:body-ready';
    emailId: string;
    timestamp: number;
}
interface EmailProcessedEvent {
    type: 'email:processed';
    emailId: string;
    workflowId: string;
    result: WorkflowResult;
    timestamp: number;
}
interface EmailLabeledEvent {
    type: 'email:labeled';
    emailId: string;
    labelsAdded: string[];
    labelsRemoved: string[];
    timestamp: number;
}
interface EmailFlaggedEvent {
    type: 'email:flagged';
    emailId: string;
    flagsAdded: string[];
    flagsRemoved: string[];
    timestamp: number;
}
interface SyncStartedEvent {
    type: 'sync:started';
    folders: string[];
    fullSync: boolean;
    timestamp: number;
}
interface SyncProgressEvent {
    type: 'sync:progress';
    currentFolder: string;
    foldersCompleted: number;
    totalFolders: number;
    messagesProcessed: number;
    totalMessages: number;
    percentComplete: number;
    timestamp: number;
}
interface SyncCompletedEvent {
    type: 'sync:completed';
    stats: SyncStats;
    timestamp: number;
}
interface SyncErrorEvent {
    type: 'sync:error';
    error: Error;
    folder?: string;
    recoverable: boolean;
    timestamp: number;
}
interface WorkflowStartedEvent {
    type: 'workflow:started';
    workflowId: string;
    emailId: string;
    timestamp: number;
}
interface WorkflowCompletedEvent {
    type: 'workflow:completed';
    workflowId: string;
    emailId: string;
    result: WorkflowResult;
    timestamp: number;
}
interface WorkflowErrorEvent {
    type: 'workflow:error';
    workflowId: string;
    emailId: string;
    error: Error;
    timestamp: number;
}
interface TaskScheduledEvent {
    type: 'task:scheduled';
    taskId: string;
    taskType: string;
    scheduledAt: number;
    timestamp: number;
}
interface TaskCompletedEvent {
    type: 'task:completed';
    taskId: string;
    taskType: string;
    result: any;
    timestamp: number;
}
interface TaskFailedEvent {
    type: 'task:failed';
    taskId: string;
    taskType: string;
    error: Error;
    retryCount: number;
    timestamp: number;
}
/**
 * Event handler function type
 */
type EventHandler<T extends PipelineEvent = PipelineEvent> = (event: T) => void | Promise<void>;
/**
 * Unsubscribe function returned by event subscriptions
 */
type Unsubscribe = () => void;
interface SyncStats {
    startTime: number;
    endTime: number;
    duration: number;
    foldersProcessed: number;
    messagesProcessed: number;
    newMessages: number;
    updatedMessages: number;
    errors: number;
    folderStats: Record<string, FolderSyncStats>;
}
interface FolderSyncStats {
    folder: string;
    messagesProcessed: number;
    newMessages: number;
    updatedMessages: number;
    duration: number;
    error?: string;
}

/**
 * Extension System Types
 *
 * Core type definitions for the Sarv Inbox extension system,
 * enabling VS Code-like extensibility.
 */

/**
 * Extension manifest file structure (sarvinbox-extension.json)
 */
interface ExtensionManifest {
    /** Unique identifier (lowercase, alphanumeric, hyphens) */
    id: string;
    /** Human-readable name */
    name: string;
    /** Semantic version (e.g., "1.0.0") */
    version: string;
    /** Description of what the extension does */
    description: string;
    /** Author name or organization */
    author: string;
    /** Author's email (optional) */
    authorEmail?: string;
    /** Repository URL (optional) */
    repository?: string;
    /** Homepage URL (optional) */
    homepage?: string;
    /** License identifier (e.g., "MIT", "Apache-2.0") */
    license?: string;
    /** Path to main entry point (relative to extension root) */
    main: string;
    /** Engine compatibility */
    engines: {
        /** Required Sarv Inbox version (semver range) */
        sarvinbox: string;
    };
    /** Required permissions */
    permissions: ExtensionPermission[];
    /** Extension contributions */
    contributes?: ExtensionContributions;
    /** Keywords for search/discovery */
    keywords?: string[];
    /** Extension icon path (optional) */
    icon?: string;
    /** Whether this is a builtin extension */
    builtin?: boolean;
}
/**
 * Extension contributions - what the extension provides
 */
interface ExtensionContributions {
    /** Workflow contributions */
    workflows?: WorkflowContribution[];
    /** Settings contributions */
    settings?: SettingContribution[];
    /** Event subscriptions */
    events?: string[];
    /** UI panels the extension renders inside the app */
    panels?: PanelContribution[];
    /** App features this extension can serve (see `CapabilityContribution`) */
    capabilities?: CapabilityContribution[];
}
/**
 * An app feature this extension offers to serve.
 *
 * This is what lets the app stop naming extensions. Summarising a thread used
 * to be an IPC handler that asked for the `email-summarization` extension by
 * id: the feature and the one extension that implemented it were the same
 * thing, so a second implementation was unpublishable and removing the first
 * broke the app. Now the app asks for the CAPABILITY, any extension may
 * declare it, and none is special.
 *
 * The declaration lives in the manifest rather than being registered at
 * runtime so it is visible before a line of extension code has run — reviewable
 * in the repository, and shown to the reader alongside the permissions.
 */
interface CapabilityContribution {
    /**
     * What this serves, e.g. `thread.summarize`. Capability ids the app itself
     * asks for are listed in docs/EXTENSIONS.md; an extension may also invent
     * its own for another extension to call.
     */
    id: string;
    /** The name on `context.exports` that implements it. */
    export: string;
    /** Highest wins when more than one active extension declares the same id. */
    priority?: number;
    /** One line for the settings UI, e.g. "Summarises threads with AI". */
    description?: string;
}
/**
 * Where a panel is shown.
 *
 * 'sidebar' — a column beside the open message, for something the reader wants
 *             alongside the mail (a tracker, an order, a ticket).
 * 'modal'   — a dialog over the app, for a task with a beginning and an end.
 *
 * Deliberately not a third option that renders inside the message body. A panel
 * drawn there is indistinguishable from the message's own content, which is
 * exactly the confusion a phishing mail wants; keeping extension UI outside the
 * body is what lets the reader tell the app apart from the mail.
 */
type PanelSurface = 'sidebar' | 'modal';
/**
 * A panel contribution — an HTML page the extension ships, rendered by the app.
 *
 * The page is served from the extension's own folder over a privileged scheme
 * and loaded into a sandboxed iframe: no Node, no app internals, no access to
 * the renderer's DOM. Everything it can do it asks for over the panel bridge,
 * and every one of those requests is permission-checked in main.
 */
interface PanelContribution {
    /** Panel id, scoped to the extension. Lowercase alphanumeric with hyphens. */
    id: string;
    /** Title shown in the panel header */
    title: string;
    /**
     * The HTML file to load, relative to the extension folder.
     * Resolved inside that folder; a path that escapes it is refused.
     */
    entry: string;
    /** Where the panel is rendered */
    surface: PanelSurface;
    /** Icon path relative to the extension folder (SVG) */
    icon?: string;
    /** One line describing what the panel is for */
    description?: string;
    /**
     * Open the panel automatically when a message is open, rather than waiting
     * for the reader to ask for it. Sidebar panels only.
     */
    autoOpen?: boolean;
    /** Preferred sidebar width in px. Clamped to what the window can give. */
    width?: number;
}
/**
 * Workflow contribution declaration
 */
interface WorkflowContribution {
    /** Workflow ID (scoped to extension) */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description */
    description?: string;
    /** Priority (lower = runs first) */
    priority: number;
    /** Whether this workflow requires AI */
    requiresAI?: boolean;
    /**
     * Re-run this workflow once the message body has been fetched.
     *
     * Bodies are fetched lazily AFTER `email:synced`, so a workflow that reads
     * `cleanBody`/`rawBody` sees an empty body on the arrival pass. Setting this
     * makes the host run the workflow again on `email:body-ready`. Such a
     * workflow MUST be idempotent — it will see the same message twice.
     */
    requiresBody?: boolean;
    /** Whether to run in background */
    runInBackground?: boolean;
    /** Default enabled state */
    enabledByDefault?: boolean;
}
/**
 * Setting contribution declaration
 */
interface SettingContribution {
    /** Setting key (scoped to extension: "extension-id.setting-name") */
    key: string;
    /** Setting type */
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    /** Default value */
    default: unknown;
    /** Human-readable description */
    description: string;
    /** Enum values (for string type) */
    enum?: string[];
    /** Minimum value (for number type) */
    minimum?: number;
    /** Maximum value (for number type) */
    maximum?: number;
}
/**
 * Available extension permissions
 */
type ExtensionPermission = 'email:read' | 'email:label' | 'email:flag' | 'email:move' | 'email:delete' | 'ai:use' | 'storage:local' | 'network:fetch' | 'settings:read' | 'settings:write' | 'ui:notify' | 'ui:panel';
/**
 * Context passed to extension's activate function
 * This is the API surface available to extensions
 */
interface ExtensionContext {
    /** Extension manifest */
    readonly manifest: ExtensionManifest;
    /** Extension's storage directory path */
    readonly storagePath: string;
    /** Register a workflow */
    registerWorkflow(workflow: ExtensionWorkflow): void;
    /** Unregister a workflow */
    unregisterWorkflow(workflowId: string): void;
    /** Event bus for subscribing to events */
    readonly events: ExtensionEventBus;
    /** Local storage for extension data */
    readonly storage: ExtensionStorage;
    /** AI client (if ai:use permission granted) */
    readonly ai?: ExtensionAI;
    /** Settings access */
    readonly settings: ExtensionSettings;
    /**
     * Reading and changing mail, each method gated on its own permission.
     *
     * The counterpart to a workflow result: a workflow acts on arrival, this acts
     * whenever the extension decides to.
     */
    readonly mail: ExtensionMail;
    /** Notification cards shown in the app window (if ui:notify granted) */
    readonly ui: ExtensionUI;
    /** Logger */
    readonly log: ExtensionLogger;
    /** Disposables to clean up on deactivation */
    subscriptions: Unsubscribe[];
    /**
     * API this extension offers to the rest of the app, set during `activate`.
     *
     * Reached by the host through `getExtensionExports(id)` — that is how the app
     * calls into an extension on demand (see `contributes.capabilities`) rather
     * than waiting for a workflow to run over a message. Declared here and
     * not only on the implementation class because an extension is written
     * against THIS interface: without it, assigning exports needs a cast, and a
     * cast is where the export contract stops being checked.
     */
    exports: Record<string, unknown>;
}
/**
 * Simplified workflow interface for extensions
 */
interface ExtensionWorkflow {
    /** Workflow ID (will be prefixed with extension ID) */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description */
    description?: string;
    /** Priority (lower = runs first, default: 50) */
    priority?: number;
    /** Whether this workflow requires AI */
    requiresAI?: boolean;
    /**
     * Re-run once the body has been fetched (see WorkflowContribution). The
     * workflow must be idempotent: it sees the message on arrival AND again when
     * the body lands.
     */
    requiresBody?: boolean;
    /** Whether to run in background */
    runInBackground?: boolean;
    /** Whether enabled (default: true) */
    enabled?: boolean;
    /** Filter function - return true if workflow should process this email */
    shouldProcess: (email: EmailRecord) => boolean | Promise<boolean>;
    /** Process the email */
    process: (email: EmailRecord, ctx: WorkflowExecutionContext) => Promise<ExtensionWorkflowResult>;
}
/**
 * Context available during workflow execution
 */
interface WorkflowExecutionContext {
    /** AI client (if permission granted) */
    ai?: ExtensionAI;
    /** Access to previous workflow results */
    previousResults: Map<string, WorkflowResult>;
    /** Abort signal for cancellation */
    abortSignal?: AbortSignal;
    /** Logger */
    log: ExtensionLogger;
}
/**
 * Simplified workflow result for extensions
 */
interface ExtensionWorkflowResult {
    /** Whether processing succeeded */
    success: boolean;
    /** Modifications to apply to email */
    modifications?: {
        aiCategory?: string;
        aiCategories?: string[];
        aiConfidence?: number;
        aiSummary?: string;
        labels?: string[];
    };
    /** Labels to add */
    labelsToAdd?: string[];
    /** Labels to remove */
    labelsToRemove?: string[];
    /** Skip remaining workflows */
    skipRemaining?: boolean;
    /** Error if failed */
    error?: Error;
    /** Additional metadata */
    metadata?: Record<string, unknown>;
}
/**
 * Event bus interface exposed to extensions
 */
interface ExtensionEventBus {
    /** Subscribe to an event */
    on<T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): Unsubscribe;
    /** Subscribe to an event once */
    once<T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): void;
    /** Emit an event */
    emit(event: PipelineEvent): void;
}
/**
 * Local storage interface for extensions
 */
interface ExtensionStorage {
    /** Get a value */
    get<T>(key: string): Promise<T | undefined>;
    /** Set a value */
    set<T>(key: string, value: T): Promise<void>;
    /** Delete a value */
    delete(key: string): Promise<void>;
    /** Get all keys */
    keys(): Promise<string[]>;
    /** Clear all extension data */
    clear(): Promise<void>;
}
/**
 * AI completion options
 */
interface AICompletionOptions {
    /** System prompt for the AI */
    systemPrompt: string;
    /** User prompt/message */
    userPrompt: string;
    /** Maximum tokens in response */
    maxTokens?: number;
}
/**
 * AI interface exposed to extensions
 */
interface ExtensionAI {
    /** Categorize an email */
    categorize(email: EmailRecord): Promise<AICategorizationResult>;
    /** Generate reply suggestions */
    generateReplySuggestions(email: EmailRecord): Promise<string[]>;
    /** Summarize content */
    summarize(content: string): Promise<string>;
    /** Extract action items */
    extractActionItems(email: EmailRecord): Promise<string[]>;
    /** Check if AI is available */
    isAvailable(): boolean;
    /** Generic completion API for custom prompts */
    complete(options: AICompletionOptions): Promise<string>;
}
/**
 * AI categorization result
 */
interface AICategorizationResult {
    /** Primary category */
    category: string;
    /** All applicable categories */
    categories: string[];
    /** Confidence score (0-1) */
    confidence: number;
    /** Brief explanation */
    reasoning?: string;
}
/**
 * Settings interface for extensions
 */
interface ExtensionSettings {
    /** Get a setting value */
    get<T>(key: string): T | undefined;
    /** Get a setting value with default */
    get<T>(key: string, defaultValue: T): T;
    /** Update a setting value */
    update(key: string, value: unknown): Promise<void>;
    /** Check if setting exists */
    has(key: string): boolean;
}
/**
 * Logger interface for extensions
 */
interface ExtensionLogger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/**
 * One labelled value on a notification card.
 *
 * `copyable` renders a copy button next to the value — the reason this exists:
 * an extension that extracts something the user must paste elsewhere (a
 * one-time passcode, a tracking number, a reference id) should not make them
 * open the mail and select the text by hand.
 */
interface ExtensionUIField {
    /** Field label, e.g. "Code" */
    label: string;
    /** Field value, rendered verbatim (never as HTML) */
    value: string;
    /** Show a copy-to-clipboard button for this value */
    copyable?: boolean;
    /** Render in a larger monospace face — for codes and reference numbers */
    emphasis?: boolean;
}
/**
 * A notification card an extension asks the app to show.
 *
 * This is the ONLY way an extension reaches the renderer. It is deliberately
 * declarative (no markup, no scripts, no styling) so the app can render it with
 * its own design system and an extension can never inject DOM into the window.
 */
interface ExtensionUINotification {
    /** Stable id — re-notifying with the same id replaces the visible card */
    id: string;
    /** Card title, e.g. "Verification code" */
    title: string;
    /** Optional supporting line, e.g. the sender name */
    body?: string;
    /** Labelled values rendered as rows on the card */
    fields?: ExtensionUIField[];
    /**
     * UTC epoch milliseconds at which the information stops being useful. The
     * card renders a live countdown to this moment and dismisses itself when it
     * passes. Omit for a card that has no natural expiry.
     */
    expiresAt?: number;
    /** Auto-dismiss after this many ms. Ignored when `expiresAt` is set. */
    timeoutMs?: number;
    /** Email this card refers to; clicking the card opens it */
    emailId?: string;
    /** Account owning `emailId`, for the cross-account open path */
    accountId?: string;
}
/**
 * Something the reader did to a card, reported back to the extension that
 * raised it.
 *
 * A card is one-way without this: the extension puts a value on screen and
 * never learns whether it was used. That gap is what stops an extension doing
 * the obvious follow-up — a verification code that has been copied has served
 * its purpose, and the mail carrying it can be marked read without the reader
 * ever opening it.
 *
 * `notificationId` is the extension's OWN id for the card, not the namespaced
 * one the renderer holds: an extension should never have to know the host
 * namespaces its ids.
 */
interface ExtensionUIAction {
    /** The card's id, exactly as the extension passed it to `notify`. */
    notificationId: string;
    /**
     * What happened.
     *  - `copy` — a field's copy button was pressed
     *  - `dismiss` — the reader closed the card by hand
     *  - `expire` — the card ran out its `expiresAt`/`timeoutMs` and left
     *  - `open` — the reader followed the card to its message
     */
    action: 'copy' | 'dismiss' | 'expire' | 'open';
    /** For `copy`: the index into `fields` that was copied. */
    fieldIndex?: number;
    /** For `copy`: that field's label, so a handler need not re-index. */
    fieldLabel?: string;
    /** The card's `emailId`, carried through so a handler has it to hand. */
    emailId?: string;
    /** The card's `accountId`, carried through alongside `emailId`. */
    accountId?: string;
}
/** What an extension registers with `ui.onAction`. */
type ExtensionUIActionHandler = (action: ExtensionUIAction) => void | Promise<void>;
/**
 * Notification API exposed to extensions (requires `ui:notify`)
 */
interface ExtensionUI {
    /** Show (or replace) a notification card */
    notify(notification: ExtensionUINotification): void;
    /** Dismiss a card early by id */
    dismiss(notificationId: string): void;
    /**
     * Hear about what the reader did to this extension's cards.
     *
     * Only this extension's own cards are reported: card ids are namespaced by
     * extension, so one extension cannot observe another's.
     *
     * Handlers are fire-and-forget. A handler that throws is logged and dropped;
     * it cannot fail the reader's click.
     *
     * @returns an unsubscribe function
     */
    onAction(handler: ExtensionUIActionHandler): Unsubscribe;
    /**
     * Open one of this extension's own panels (requires `ui:panel`).
     *
     * The id is the panel's id from `contributes.panels`. An extension may only
     * open a panel it declared itself.
     */
    openPanel(panelId: string): void;
    /** Open a message in the reader's window (requires `email:read`). */
    openMessage(emailId: string, accountId?: string): void;
}
/**
 * The mail-mutation API on `ExtensionContext`.
 *
 * Until this existed an extension could only ASK for a change, by returning
 * `labelsToAdd`/`labelsToRemove` from a workflow — which meant it could act
 * only at the instant a message arrived, and never in response to anything the
 * reader did. This is the same set of effects, available at any time.
 *
 * Every method is gated on the permission named beside it, checked in the main
 * process against what the user approved at install time — the sandbox's copy
 * of the granted set is a convenience that makes an authoring mistake fail
 * where it was written, never the thing that decides. Every mutation is also
 * logged with the extension's id, so what an installed extension actually did
 * to the mailbox is answerable after the fact.
 *
 * Deliberately id-based rather than record-based: an extension passes the id it
 * was given and the host reads the row itself, so nothing an extension invents
 * about a message can reach storage.
 */
interface ExtensionMail {
    /** Read one message, or null when it is not in any open mailbox. `email:read` */
    get(emailId: string): Promise<EmailRecord | null>;
    /** The folders of the account owning `emailId`, or of the active account. `email:read` */
    folders(accountId?: string): Promise<ExtensionMailFolder[]>;
    /** Mark read. Pushed to the server like any other read receipt. `email:flag` */
    markRead(emailId: string): Promise<void>;
    /** Mark unread. `email:flag` */
    markUnread(emailId: string): Promise<void>;
    /** Star. `email:flag` */
    star(emailId: string): Promise<void>;
    /** Unstar. `email:flag` */
    unstar(emailId: string): Promise<void>;
    /** Add a label/tag. `email:label` */
    addLabel(emailId: string, label: string): Promise<void>;
    /** Remove a label/tag. `email:label` */
    removeLabel(emailId: string, label: string): Promise<void>;
    /** Move to another folder, by folder id. `email:move` */
    move(emailId: string, folderId: string): Promise<void>;
    /**
     * Move to the account's trash folder. `email:delete`
     *
     * Never an expunge: an extension can put a message in the bin, and only the
     * reader empties it. An extension that could destroy mail outright would be
     * one bug away from an unrecoverable mailbox.
     */
    trash(emailId: string): Promise<void>;
}
/** A folder, in the subset an extension is shown. */
interface ExtensionMailFolder {
    id: string;
    name: string;
    path: string;
    type?: string;
    accountId?: string;
}
/**
 * Email data structure for summarization
 */
interface EmailForSummary {
    id: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    toAddress: string;
    date: number;
    body: string;
}
/**
 * Thread summary result
 */
interface ThreadSummaryResult {
    summary: string;
    key_points: string[];
    participants: string[];
    action_items?: string[];
    confidence: number;
}
/**
 * Single email summary result
 */
interface EmailSummaryResult {
    summary: string;
    key_points: string[];
    action_items?: string[];
    confidence: number;
}
/**
 * The signatures behind the `thread.summarize` and `email.summarize`
 * capabilities.
 *
 * Named for what they DO, not for which extension does it. The app once asked
 * for the `email-summarization` extension by id, which made the feature and
 * that one extension the same thing — a second implementation was
 * unpublishable and removing the first broke the app. Now an extension
 * declares the capability in `contributes.capabilities` and exports a function
 * of this shape; the app asks for the capability and never learns who served
 * it. Typing an implementation against this is optional but keeps the export
 * honest.
 */
interface EmailSummarizationExports {
    /** Summarize a single email on demand */
    summarizeEmail: (email: EmailForSummary) => Promise<EmailSummaryResult>;
    /** Summarize a thread of emails */
    summarizeThread: (emails: EmailForSummary[]) => Promise<ThreadSummaryResult | null>;
}

/**
 * Coalesce many in-memory changes into few writes.
 *
 * The problem this solves is the extension storage backend, which rewrites the
 * WHOLE of its `storage.json` synchronously, on the main thread, for every
 * `set`. Anything an extension records per message — a sender counter, a cached
 * summary — would otherwise turn a 40,000-message first sync into 40,000
 * synchronous whole-file writes of an ever-growing file. That is quadratic work
 * on the thread that draws the window.
 *
 * So callers hold their state in memory, call {@link FlushScheduler.markDirty}
 * at no I/O cost, and the write happens at most once per interval and only when
 * something actually changed. The cost is bounded and acceptable: a crash loses
 * at most one interval of changes, which the caller can relearn or recompute.
 *
 * Dependency-free on purpose — it is re-exported to extensions through
 * `@sarvinbox/core/extension-sdk`, which every extension bundles verbatim.
 */
/** Default gap between writes. Long enough to coalesce a sync burst. */
declare const DEFAULT_FLUSH_INTERVAL_MS = 30000;
interface FlushSchedulerOptions {
    /**
     * Performs the write. Called only when there are pending changes, never
     * concurrently with itself.
     */
    write: () => Promise<void>;
    /** Gap between writes. Defaults to {@link DEFAULT_FLUSH_INTERVAL_MS}. */
    intervalMs?: number;
    /** Reports a failed write. The scheduler itself never throws. */
    onError?: (error: unknown) => void;
}
interface FlushScheduler {
    /** Record that state changed and schedule a write. */
    markDirty(): void;
    /** True while changes are waiting to be written. */
    isDirty(): boolean;
    /** Write now, if anything changed. Resolves once the write has finished. */
    flush(): Promise<void>;
    /** Stop scheduling and write whatever is pending. */
    dispose(): Promise<void>;
}
declare function createFlushScheduler(options: FlushSchedulerOptions): FlushScheduler;

/** A keyed set of in-flight operations. See `createSingleFlight`. */
interface SingleFlight<T> {
    /**
     * Run `start()` under `key`, or join the run already in flight under that
     * key. The joiner gets the same settlement — value or rejection — as the
     * caller that started it.
     */
    run(key: string, start: () => Promise<T>): Promise<T>;
    /** The in-flight promise for `key`, if there is one. Diagnostics/tests. */
    pending(key: string): Promise<T> | undefined;
    /** How many operations are in flight right now. Diagnostics/tests. */
    readonly size: number;
}
/**
 * Coalesce concurrent calls that want the same thing.
 *
 * An operation that is expensive, stateful, or externally visible must not be
 * started twice just because two callers asked at once — and in this app they
 * routinely do. Mount, window focus, network-online and the reconnect ladder all
 * reach for the same connection, and React's StrictMode double-invokes mount
 * effects in development on top of that. Two overlapping connects then fight:
 * one tears down the socket the other is still opening ("Already connected or
 * connecting" → "Unexpected close"), and every write the operation performs on
 * the way through happens twice.
 *
 * Keying matters as much as the coalescing: same key means "the same thing", so
 * two connects to the SAME account join while connects to DIFFERENT accounts
 * both run.
 *
 * The entry is cleared only if it is still the one this run installed, so a
 * later run under the same key is never deleted by an earlier one's settlement.
 */
declare function createSingleFlight<T>(): SingleFlight<T>;

export { type AICompletionOptions, type CapabilityContribution, type ClassifiableFolder, DEFAULT_DUTY_CYCLE, DEFAULT_FLUSH_INTERVAL_MS, DEFAULT_YIELD_BUDGET_MS, type EmailBodyReadyEvent, type EmailForSummary, type EmailRecord, type EmailSummarizationExports, type EmailSummaryResult, type EmailSyncedEvent, type ExtensionAI, type ExtensionContext, type ExtensionEventBus, type ExtensionLogger, type ExtensionMail, type ExtensionMailFolder, type ExtensionManifest, type ExtensionPermission, type ExtensionSettings, type ExtensionStorage, type ExtensionUI, type ExtensionUIAction, type ExtensionUIActionHandler, type ExtensionUIField, type ExtensionUINotification, type ExtensionWorkflow, type ExtensionWorkflowResult, FLAG_TAG_NAMES, type FlushScheduler, type FlushSchedulerOptions, type LoopYielderOptions, type PacerOptions, type PipelineEvent, type SingleFlight, type StandardFolderType, type ThreadSummaryResult, type WorkflowExecutionContext, addTag, buildTags, classifyFolder, createFlushScheduler, createLoopYielder, createPacer, createSingleFlight, hasTag, imapFlagsToTags, isArchiveFolder, isDraftsFolder, isInboxFolder, isOwnMailFolder, isSentFolder, isSpamFolder, isTrashFolder, parseTags, removeTag, sanitizeTagName, sleep, tagsToImapFlags, yieldToEventLoop };
