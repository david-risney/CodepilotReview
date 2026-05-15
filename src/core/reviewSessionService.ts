import * as vscode from 'vscode';
import { ReviewIssue, ReviewIssueStatus, DiffFile } from '../types';
import { ICodeReviewProvider } from '../providers/provider';
import { logger } from '../logging/logger';

/**
 * Manages review sessions - the core orchestrator for a single review.
 * Coordinates issues, comments, and provider interactions.
 */
export class ReviewSessionService {
    private currentPrId: string | undefined;
    private issues: Map<string, ReviewIssue> = new Map();
    private diff: DiffFile[] = [];
    private provider: ICodeReviewProvider | undefined;

    private _onDidChangeIssues = new vscode.EventEmitter<void>();
    readonly onDidChangeIssues = this._onDidChangeIssues.event;

    setProvider(provider: ICodeReviewProvider): void {
        this.provider = provider;
    }

    /** Start a review session for a pull request */
    async openReview(prId: string): Promise<void> {
        if (!this.provider) {
            throw new Error('No provider configured');
        }

        this.currentPrId = prId;
        this.issues.clear();

        // Load diff
        this.diff = await this.provider.diff.getDiff(prId);

        // Load existing comments from provider
        if (this.provider.comments) {
            const comments = await this.provider.comments.getComments(prId);
            for (const comment of comments) {
                this.issues.set(comment.id, comment);
            }
        }

        this._onDidChangeIssues.fire();
        logger.info(`Opened review for PR ${prId} with ${this.diff.length} files`);
    }

    getCurrentPrId(): string | undefined {
        return this.currentPrId;
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
