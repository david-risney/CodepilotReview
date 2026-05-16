import * as vscode from 'vscode';
import { ReviewIssue, ReviewIssueStatus, DiffFile, PullRequest } from '../types';
import { ICodeReviewProvider, ProviderInstance } from '../providers/provider';
import { logger } from '../logging/logger';

/**
 * Manages review sessions - the core orchestrator for a single review.
 * Coordinates issues, comments, and provider interactions.
 */
export class ReviewSessionService {
    private currentPrId: string | undefined;
    private currentProviderId: string | undefined;
    private issues: Map<string, ReviewIssue> = new Map();
    private diff: DiffFile[] = [];
    private provider: ICodeReviewProvider | undefined;
    private providerLookup: ((id: string) => ProviderInstance | undefined) | undefined;

    private _onDidChangeIssues = new vscode.EventEmitter<void>();
    readonly onDidChangeIssues = this._onDidChangeIssues.event;

    /** @deprecated Use setProviderLookup() for multi-provider support */
    setProvider(provider: ICodeReviewProvider): void {
        this.provider = provider;
    }

    /** Set a function to look up provider instances by ID */
    setProviderLookup(lookup: (id: string) => ProviderInstance | undefined): void {
        this.providerLookup = lookup;
    }

    /** Clear the current review session (no PR selected) */
    clearReview(): void {
        this.currentPrId = undefined;
        this.currentProviderId = undefined;
        this.issues.clear();
        this.diff = [];
        this._onDidChangeIssues.fire();
    }

    /** Start a review session for a pull request */
    async openReview(prOrId: string | PullRequest): Promise<void> {
        let prId: string;
        let providerId: string | undefined;

        if (typeof prOrId === 'string') {
            prId = prOrId;
        } else {
            prId = prOrId.id;
            providerId = prOrId.providerId;
        }

        // Resolve the provider for this review
        const resolvedProvider = providerId && this.providerLookup
            ? this.providerLookup(providerId)?.provider
            : this.provider;

        if (!resolvedProvider) {
            throw new Error('No provider configured');
        }

        this.currentPrId = prId;
        this.currentProviderId = providerId;
        this.provider = resolvedProvider;
        this.issues.clear();

        // Load diff
        this.diff = await resolvedProvider.diff.getDiff(prId);

        // Load existing comments from provider
        if (resolvedProvider.comments) {
            const comments = await resolvedProvider.comments.getComments(prId);
            for (const comment of comments) {
                this.issues.set(comment.id, comment);
            }
        }

        this._onDidChangeIssues.fire();
        logger.info(`Opened review for PR ${prId} (provider: ${providerId || 'default'}) with ${this.diff.length} files`);
    }

    getCurrentPrId(): string | undefined {
        return this.currentPrId;
    }

    getCurrentProviderId(): string | undefined {
        return this.currentProviderId;
    }

    getDiff(): DiffFile[] {
        return this.diff;
    }

    getIssues(): ReviewIssue[] {
        return Array.from(this.issues.values());
    }

    getIssuesByStatus(status: ReviewIssueStatus): ReviewIssue[] {
        return this.getIssues().filter(i => i.status === status);
    }

    /** Add a new review issue (from tool, AI, or user) */
    addIssue(issue: ReviewIssue): void {
        this.issues.set(issue.id, issue);
        this._onDidChangeIssues.fire();
    }

    /** Accept a suggested issue, promoting it to draft status */
    acceptIssue(issueId: string): void {
        const issue = this.issues.get(issueId);
        if (issue && issue.status === 'suggested') {
            issue.status = 'draft';
            this._onDidChangeIssues.fire();
        }
    }

    /** Update issue status */
    async updateIssueStatus(issueId: string, status: ReviewIssueStatus): Promise<void> {
        const issue = this.issues.get(issueId);
        if (!issue) {
            return;
        }

        const oldStatus = issue.status;
        issue.status = status;

        // If publishing, push to provider
        if (status === 'published' && oldStatus === 'draft' && this.provider?.comments && this.currentPrId) {
            try {
                const updated = await this.provider.comments.publishComment(this.currentPrId, issue);
                this.issues.set(issueId, updated);
            } catch (error) {
                logger.error(`Failed to publish issue ${issueId}`, error);
                issue.status = oldStatus;
            }
        }

        this._onDidChangeIssues.fire();
    }

    /** Dismiss a suggested issue */
    dismissIssue(issueId: string): void {
        const issue = this.issues.get(issueId);
        if (issue) {
            issue.status = 'dismissed';
            this._onDidChangeIssues.fire();
        }
    }

    /** Publish all draft issues */
    async publishAllDrafts(): Promise<number> {
        const drafts = this.getIssuesByStatus('draft');
        let published = 0;

        for (const draft of drafts) {
            try {
                await this.updateIssueStatus(draft.id, 'published');
                published++;
            } catch (error) {
                logger.error(`Failed to publish draft ${draft.id}`, error);
            }
        }

        return published;
    }

    dispose(): void {
        this._onDidChangeIssues.dispose();
    }
}
