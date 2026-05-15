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

    constructor(private sessionService: ReviewSessionService) {
        this.commentController = vscode.comments.createCommentController(
            'codepilotReview',
            'CodepilotReview'
        );

        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: (_document: vscode.TextDocument) => {
                // Allow commenting on any line
                return [new vscode.Range(0, 0, _document.lineCount - 1, 0)];
            },
        };
    }

    /** Display review issues as inline comments */
    async showIssues(issues: ReviewIssue[], baseUri: vscode.Uri): Promise<void> {
        this.clearAll();

        for (const issue of issues) {
            await this.addIssueThread(issue, baseUri);
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
            case 'dismissed': return '❌';
            case 'resolved': return '✅';
        }
    }
}
