import * as vscode from 'vscode';
import { ReviewIssue, ReviewIssueStatus, DiffPosition } from '../types';
import { ReviewSessionService } from '../core/reviewSessionService';
import { logger } from '../logging/logger';

/**
 * Manages VSCode inline comments for code review using the CommentController API.
 * Maps ReviewIssues to VSCode comment threads.
 */
export class ReviewCommentController {
    private commentController: vscode.CommentController;
    private threads: Map<string, vscode.CommentThread> = new Map();
    private threadToIssueId: WeakMap<vscode.CommentThread, string> = new WeakMap();
    private isLocalProvider: boolean = true;

    constructor(private sessionService: ReviewSessionService) {
        this.commentController = vscode.comments.createCommentController(
            'codepilotReview',
            'CodepilotReview'
        );

        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: (_document: vscode.TextDocument) => {
                // Only allow creating new comment threads for local providers (read/write)
                // Remote providers show existing issues read-only
                if (!this.isLocalProvider) {
                    return [];
                }
                return [new vscode.Range(0, 0, _document.lineCount - 1, 0)];
            },
        };
    }

    /** Set whether the current provider is local (read/write) or remote (read-only) */
    setLocalProvider(isLocal: boolean): void {
        this.isLocalProvider = isLocal;
    }

    /** Display review issues as inline comments, grouping replies under parent threads */
    async showIssues(issues: ReviewIssue[], baseUri: vscode.Uri): Promise<void> {
        this.clearAll();

        // Separate root issues from replies
        const rootIssues = issues.filter(i => !i.parentIssueId);
        const replies = issues.filter(i => i.parentIssueId);

        for (const issue of rootIssues) {
            await this.addIssueThread(issue, baseUri);
        }

        // Add replies to their parent threads
        for (const reply of replies) {
            this.addReplyToThread(reply);
        }
    }

    /** Add a single issue as a comment thread */
    async addIssueThread(issue: ReviewIssue, baseUri: vscode.Uri): Promise<void> {
        const uri = vscode.Uri.joinPath(baseUri, issue.position.filePath);
        const range = new vscode.Range(
            issue.position.line - 1, 0,
            issue.position.line - 1, 0
        );

        const thread = this.commentController.createCommentThread(uri, range, []);

        const comment: vscode.Comment = {
            body: this.formatIssueBody(issue),
            author: { name: this.getAuthorLabel(issue) },
            mode: vscode.CommentMode.Preview,
            contextValue: issue.status,
        };

        thread.comments = [comment];
        thread.label = issue.summary;
        thread.contextValue = `reviewIssue:${issue.status}`;
        thread.canReply = true;

        this.threads.set(issue.id, thread);
        this.threadToIssueId.set(thread, issue.id);
    }

    /** Add a reply comment to an existing parent thread */
    addReplyToThread(reply: ReviewIssue): void {
        const parentId = reply.parentIssueId;
        if (!parentId) { return; }

        const thread = this.threads.get(parentId);
        if (!thread) {
            logger.warn(`Cannot add reply ${reply.id}: parent thread ${parentId} not found`);
            return;
        }

        const isDraft = reply.status === 'draft';
        const comment: vscode.Comment = {
            body: new vscode.MarkdownString(isDraft ? `📝 *(draft)* ${reply.details}` : reply.details),
            author: { name: this.getAuthorLabel(reply) },
            mode: vscode.CommentMode.Preview,
            contextValue: reply.status,
        };

        thread.comments = [...thread.comments, comment];
    }

    /** Look up which issue ID owns a given comment thread */
    getIssueIdForThread(thread: vscode.CommentThread): string | undefined {
        return this.threadToIssueId.get(thread);
    }

    /** Update the display of an existing issue */
    updateIssue(issue: ReviewIssue): void {
        const thread = this.threads.get(issue.id);
        if (!thread) {
            return;
        }

        const comment: vscode.Comment = {
            body: this.formatIssueBody(issue),
            author: { name: this.getAuthorLabel(issue) },
            mode: vscode.CommentMode.Preview,
            contextValue: issue.status,
        };

        thread.comments = [comment];
        thread.contextValue = `reviewIssue:${issue.status}`;
    }

    /** Remove an issue thread */
    removeIssue(issueId: string): void {
        const thread = this.threads.get(issueId);
        if (thread) {
            thread.dispose();
            this.threads.delete(issueId);
        }
    }

    /** Clear all comment threads */
    clearAll(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }

    dispose(): void {
        this.clearAll();
        this.commentController.dispose();
    }

    private formatIssueBody(issue: ReviewIssue): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        // Status badge
        const statusEmoji = this.getStatusEmoji(issue.status);
        md.appendMarkdown(`${statusEmoji} **${issue.summary}**\n\n`);

        if (issue.details) {
            md.appendMarkdown(`${issue.details}\n\n`);
        }

        if (issue.command) {
            md.appendMarkdown(`**To reproduce:** \`${issue.command}\`\n\n`);
        }

        if (issue.toolName) {
            md.appendMarkdown(`*Found by: ${issue.toolName}*\n\n`);
        }

        if (issue.suggestedFix) {
            md.appendMarkdown(`💡 Fix available (${issue.suggestedFix.kind})\n`);
        }

        return md;
    }

    private getAuthorLabel(issue: ReviewIssue): string {
        switch (issue.source) {
            case 'tool': return `🔧 ${issue.toolName || 'Review Tool'}`;
            case 'ai': return '🤖 AI Review';
            case 'user': return '👤 You';
            case 'provider': return '💬 Review Comment';
        }
    }

    private getStatusEmoji(status: ReviewIssueStatus): string {
        switch (status) {
            case 'suggested': return '💭';
            case 'draft': return '📝';
            case 'published': return '📤';
            case 'pending': return '⏳';
            case 'resolved': return '✅';
            case 'closed': return '🔒';
            case 'wontFix': return '🚫';
            case 'byDesign': return '📐';
            case 'dismissed': return '❌';
        }
    }
}
