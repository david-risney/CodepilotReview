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
    /** Whether the current user is a required reviewer */
    isUserRequired: boolean;
    /** AI-generated priority assessment */
    priority?: ReviewPriority;
    /** AI-generated brief description */
    aiSummary?: string;
    /** Relevant links (other PRs, bugs, etc.) */
    relevantLinks?: RelevantLink[];
    /** Provider name that sourced this PR */
    providerName: string;
}

export type PullRequestStatus = 'open' | 'closed' | 'merged' | 'draft' | 'abandoned';

export type ReviewPriority = 'blocking' | 'yes' | 'interest' | 'no';

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
