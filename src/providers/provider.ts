import * as vscode from 'vscode';
import {
    PullRequest, DiffFile, ReviewIssue, ProviderCapabilities, ReviewIssueStatus, ProviderType, ProviderView, ProviderInstanceConfig
} from '../types';

/**
 * Interface for fetching pull requests from a code review provider.
 */
export interface IPullRequestProvider {
    /** Get all pull requests matching optional filter criteria */
    getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]>;
    /** Get a single pull request by ID */
    getPullRequest(id: string): Promise<PullRequest | undefined>;
}

/**
 * Interface for fetching diffs from a code review provider.
 */
export interface IDiffProvider {
    /** Get the diff for a pull request */
    getDiff(pullRequestId: string): Promise<DiffFile[]>;
    /** Get the content of a file at a specific revision */
    getFileContent(filePath: string, revision: string): Promise<string>;
}

/**
 * Interface for managing review comments/issues on a provider.
 */
export interface ICommentProvider {
    /** Get existing comments/issues for a pull request */
    getComments(pullRequestId: string): Promise<ReviewIssue[]>;
    /** Publish a draft comment to the provider */
    publishComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue>;
    /** Reply to an existing published comment */
    replyToComment?(pullRequestId: string, parentProviderCommentId: string, body: string): Promise<ReviewIssue>;
    /** Update an existing published comment */
    updateComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue>;
    /** Delete a comment from the provider */
    deleteComment(pullRequestId: string, commentId: string): Promise<void>;
    /** Update the status of a comment */
    updateCommentStatus(pullRequestId: string, commentId: string, status: ReviewIssueStatus): Promise<void>;
}

/**
 * Interface for provider authentication.
 */
export interface IAuthProvider {
    /** Check if the user is authenticated */
    isAuthenticated(): Promise<boolean>;
    /** Trigger authentication flow */
    authenticate(): Promise<boolean>;
    /** Sign out */
    signOut(): Promise<void>;
    /** Get the current user's display name */
    getCurrentUser(): Promise<string | undefined>;
}

/**
 * Filter criteria for pull request queries.
 */
export interface PullRequestFilter {
    status?: string[];
    author?: string;
    reviewer?: string;
    searchText?: string;
    labels?: string[];
    createdAfter?: Date;
    createdBefore?: Date;
}

/**
 * Combined code review provider interface.
 * Providers implement the sub-interfaces they support.
 */
export interface ICodeReviewProvider {
    readonly name: string;
    readonly capabilities: ProviderCapabilities;

    readonly pullRequests: IPullRequestProvider;
    readonly diff: IDiffProvider;
    readonly comments?: ICommentProvider;
    readonly auth?: IAuthProvider;

    /** Initialize the provider */
    initialize(context: vscode.ExtensionContext): Promise<void>;
    /** Dispose of provider resources */
    dispose(): void;
}

/** Wraps an ICodeReviewProvider with instance metadata for multi-provider support */
export interface ProviderInstance {
    /** Unique identifier for this provider instance */
    id: string;
    /** Display label shown in UI */
    displayName: string;
    /** Provider type */
    type: ProviderType;
    /** The actual provider implementation */
    provider: ICodeReviewProvider;
    /** Configured views (saved searches) */
    views: ProviderView[];
    /** Original config used to create this instance */
    config: ProviderInstanceConfig;
}
