import * as vscode from 'vscode';

/**
 * Represents a pull request or code review from any provider.
 */
export interface PullRequest {
    /** Provider-specific unique identifier */
    id: string;
    /** PR title */
    title: string;
    /** PR description / body */
    description: string;
    /** Author of the PR */
    author: string;
    /** Current status */
    status: PullRequestStatus;
    /** URL to view the PR in the provider's web UI */
    url?: string;
    /** Source branch */
    sourceBranch: string;
    /** Target branch */
    targetBranch: string;
    /** Creation date */
    createdAt: Date;
    /** Last update date */
    updatedAt: Date;
    /** Reviewers */
    reviewers: Reviewer[];
    /** Labels / tags */
    labels: string[];
    /** How much the user's attention is needed */
    userNeed: UserNeedLevel;
    /** AI-generated priority assessment */
    priority?: ReviewPriority;
    /** AI-generated brief description */
    aiSummary?: string;
    /** Relevant links (other PRs, bugs, etc.) */
    relevantLinks?: RelevantLink[];
    /** Provider name that sourced this PR (provider type for display) */
    providerName: string;
    /** Unique provider instance ID (for routing back to correct provider) */
    providerId: string;
}

export type PullRequestStatus = 'open' | 'closed' | 'merged' | 'draft' | 'abandoned';

export type ReviewPriority = 'blocking' | 'yes' | 'interest' | 'no';

/** How much the current user's attention is needed for this PR */
export type UserNeedLevel = 'blocking' | 'required' | 'optional' | 'fyi';

export interface Reviewer {
    name: string;
    id: string;
    isRequired: boolean;
    vote?: ReviewVote;
}

export type ReviewVote = 'approved' | 'approvedWithSuggestions' | 'waitForAuthor' | 'rejected' | 'none';

export interface RelevantLink {
    title: string;
    url: string;
    type: 'pullRequest' | 'workItem' | 'bug' | 'document' | 'other';
}

// --- Diff Model ---

export interface DiffFile {
    /** Original file path (undefined for new files) */
    oldPath?: string;
    /** New file path (undefined for deleted files) */
    newPath?: string;
    /** Diff hunks */
    hunks: DiffHunk[];
    /** Old file revision/commit */
    oldRevision: string;
    /** New file revision/commit */
    newRevision: string;
    /** File change type */
    changeType: FileChangeType;
    /** Whether the file is binary */
    isBinary: boolean;
}

export type FileChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

/** Which content source to use for each side of the diff viewer */
export type DiffSide = 'remote-before' | 'remote-after' | 'local-current' | 'local-branch-base';

/** Configuration for how diffs are displayed */
export interface DiffMode {
    left: DiffSide;
    right: DiffSide;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    header: string;
    lines: DiffLine[];
}

export interface DiffLine {
    type: 'add' | 'delete' | 'context';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
}

export interface DiffPosition {
    filePath: string;
    line: number;
    side: 'base' | 'head';
}

// --- Review Comments & Issues ---

export type ReviewIssueStatus = 'suggested' | 'draft' | 'published' | 'dismissed' | 'resolved';
export type ReviewIssueSource = 'tool' | 'ai' | 'user' | 'provider';

export interface ReviewIssue {
    id: string;
    /** Short TLDR sentence */
    summary: string;
    /** Detailed description including what command to run to see the issue */
    details: string;
    /** Position in the diff */
    position: DiffPosition;
    /** Current lifecycle status */
    status: ReviewIssueStatus;
    /** Where this issue originated */
    source: ReviewIssueSource;
    /** Which tool generated this (if source is 'tool') */
    toolName?: string;
    /** Suggested fix, if available */
    suggestedFix?: SuggestedFix;
    /** Command to run to reproduce/see the issue */
    command?: string;
    /** Creation timestamp */
    createdAt: Date;
    /** Provider-specific comment ID (set after publishing) */
    providerCommentId?: string;
}

export type SuggestedFix =
    | { kind: 'workspaceEdit'; edit: vscode.WorkspaceEdit }
    | { kind: 'suggestedChangeComment'; newContent: string }
    | { kind: 'openChat'; prompt: string }
    | { kind: 'copyPatch'; patch: string };

// --- Partitioning ---

export interface Partition {
    id: string;
    name: string;
    description: string;
    /** Files and ranges included in this partition chunk */
    chunks: PartitionChunk[];
    /** Dependencies on other partitions (for dependency partitioning) */
    dependsOn: string[];
}

export interface PartitionChunk {
    filePath: string;
    /** If undefined, the entire file is in this chunk */
    lineRanges?: Array<{ start: number; end: number }>;
}

export type PartitionType = 'dependency' | 'ownership' | 'custom';

/** A partition scheme defines how to divide a code change */
export interface PartitionScheme {
    id: string;
    label: string;
    type: 'all' | 'dependencies' | 'custom';
    /** User-defined Copilot prompt (only for 'custom' type) */
    prompt?: string;
    /** Generated partitions (populated after running the scheme) */
    partitions: Partition[];
    /** Whether partitions have been generated */
    isLoaded: boolean;
}

// --- Code Tour ---

export interface CodeTour {
    id: string;
    name: string;
    steps: CodeTourStep[];
}

export interface CodeTourStep {
    title: string;
    description: string;
    filePath: string;
    line: number;
    partitionId?: string;
}

// --- Configuration ---

export interface CodepilotReviewConfig {
    provider: string;
    /** Custom review tools configuration */
    reviewTools?: CustomReviewToolConfig[];
    /** Base branch for local provider */
    localBaseBranch?: string;
    /** Provider-specific settings */
    providerSettings?: Record<string, unknown>;
}

export interface CustomReviewToolConfig {
    name: string;
    description: string;
    /** Command to run */
    command: string;
    /** Optional post-parse script */
    postParseScript?: string;
    /** Declarative parse language for compile-error style output */
    outputParsePattern?: string;
    /** Whether this is a prompt-based tool */
    isPromptTool?: boolean;
    /** User prompt for prompt-based tools */
    prompt?: string;
}

// --- Provider Capabilities ---

export interface ProviderCapabilities {
    supportsDraftComments: boolean;
    supportsPublishing: boolean;
    supportsThreads: boolean;
    supportsSuggestedFixes: boolean;
    supportsReviewVotes: boolean;
    supportsLabels: boolean;
    requiresAuthentication: boolean;
}

// --- Multi-Provider Configuration ---

export type ProviderType = 'local' | 'azureDevOps' | 'github' | 'chromium';

/** A saved search/view for a provider */
export interface ProviderView {
    /** Unique identifier within the provider */
    id: string;
    /** Display label */
    label: string;
    /** Provider-specific search criteria passed to the API */
    query?: ProviderViewQuery;
    /** Local filters applied client-side after fetch */
    filter?: LocalFilter;
}

/** Provider-specific query — varies by type */
export type ProviderViewQuery =
    | { type: 'azureDevOps'; status?: string; creatorId?: string; reviewerId?: string; repositoryId?: string }
    | { type: 'github'; searchQuery?: string; state?: string; author?: string }
    | { type: 'chromium'; status?: string; owner?: string }
    | { type: 'local' };

/** Client-side filter applied after fetching PRs */
export interface LocalFilter {
    text?: string;
    statuses?: PullRequestStatus[];
    userNeed?: UserNeedLevel[];
    priority?: ReviewPriority[];
}

/** Configuration for a single provider instance */
export interface ProviderInstanceConfig {
    /** Unique identifier for this provider instance */
    id: string;
    /** Display label shown in UI */
    label: string;
    /** Provider type */
    type: ProviderType;
    /** Configured views (saved searches). If empty, a default "All" view is created. */
    views?: ProviderView[];
    // ADO-specific
    organization?: string;
    project?: string;
    repositoryId?: string;
    pat?: string;
    // GitHub-specific
    owner?: string;
    repo?: string;
    // Chromium-specific
    host?: string;
    // Local-specific
    baseBranch?: string;
}
