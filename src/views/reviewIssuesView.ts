import * as vscode from 'vscode';
import { ReviewIssue, ReviewIssueStatus } from '../types';
import { ReviewSessionService } from '../core/reviewSessionService';
import { logger } from '../logging/logger';

/**
 * TreeDataProvider for the Review Issues view.
 * Shows issues grouped by status with actions (Really?, Fix, Dismiss, Publish).
 */
export class ReviewIssuesViewProvider implements vscode.TreeDataProvider<ReviewIssueTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ReviewIssueTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private sessionService: ReviewSessionService) {
        sessionService.onDidChangeIssues(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ReviewIssueTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ReviewIssueTreeItem): Promise<ReviewIssueTreeItem[]> {
        if (!element) {
            return this.getStatusGroups();
        }

        if (element.isGroup) {
            // Only show root issues (not replies) in status groups
            const issues = this.sessionService.getIssuesByStatus(element.groupStatus!)
                .filter(i => !i.parentIssueId);
            return issues.map(issue => new ReviewIssueTreeItem(issue));
        }

        // Issue details and replies as children
        if (element.issue) {
            return this.getIssueDetails(element.issue);
        }

        return [];
    }

    private getStatusGroups(): ReviewIssueTreeItem[] {
        const groups: ReviewIssueTreeItem[] = [];
        const statuses: Array<{ status: ReviewIssueStatus; label: string; icon: string }> = [
            { status: 'suggested', label: '💭 Suggested', icon: 'lightbulb' },
            { status: 'draft', label: '📝 Draft', icon: 'edit' },
            { status: 'published', label: '📤 Active', icon: 'comment-discussion' },
            { status: 'pending', label: '⏳ Pending', icon: 'clock' },
            { status: 'resolved', label: '✅ Resolved', icon: 'check' },
            { status: 'closed', label: '🔒 Closed', icon: 'lock' },
            { status: 'wontFix', label: '🚫 Won\'t Fix', icon: 'circle-slash' },
            { status: 'byDesign', label: '📐 By Design', icon: 'verified' },
            { status: 'dismissed', label: '❌ Dismissed', icon: 'circle-slash' },
        ];

        for (const { status, label, icon } of statuses) {
            // Count only root issues for group display
            const issues = this.sessionService.getIssuesByStatus(status)
                .filter(i => !i.parentIssueId);
            if (issues.length > 0) {
                groups.push(ReviewIssueTreeItem.group(label, status, issues.length, icon));
            }
        }

        if (groups.length === 0) {
            groups.push(ReviewIssueTreeItem.message('No review issues. Run review tools to find potential issues.'));
        }

        return groups;
    }

    private getIssueDetails(issue: ReviewIssue): ReviewIssueTreeItem[] {
        const details: ReviewIssueTreeItem[] = [];

        details.push(ReviewIssueTreeItem.detail(
            `📍 ${issue.position.filePath}:${issue.position.line}`
        ));

        if (issue.details) {
            const truncated = issue.details.length > 100
                ? issue.details.substring(0, 100) + '...'
                : issue.details;
            details.push(ReviewIssueTreeItem.detail(truncated));
        }

        if (issue.toolName) {
            details.push(ReviewIssueTreeItem.detail(`🔧 Found by: ${issue.toolName}`));
        }

        if (issue.suggestedFix) {
            details.push(ReviewIssueTreeItem.detail(`💡 Fix available (${issue.suggestedFix.kind})`));
        }

        // Show replies as children of this issue
        const replies = this.sessionService.getIssues().filter(i => i.parentIssueId === issue.id);
        for (const reply of replies) {
            details.push(ReviewIssueTreeItem.reply(reply));
        }

        return details;
    }
}

export class ReviewIssueTreeItem extends vscode.TreeItem {
    constructor(
        public readonly issue?: ReviewIssue,
        public readonly isGroup: boolean = false,
        public readonly groupStatus?: ReviewIssueStatus,
    ) {
        super(
            issue?.summary || '',
            issue
                ? vscode.TreeItemCollapsibleState.Collapsed
                : isGroup
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.None
        );

        if (issue) {
            this.description = `${issue.source} · ${issue.position.filePath}:${issue.position.line}`;
            this.tooltip = new vscode.MarkdownString(
                `**${issue.summary}**\n\n${issue.details || ''}\n\n` +
                `File: ${issue.position.filePath}:${issue.position.line}\n` +
                `Status: ${issue.status} | Source: ${issue.source}`
            );
            this.contextValue = `reviewIssue:${issue.status}`;
            this.iconPath = this.getStatusIcon(issue.status);

            // Click to navigate to the issue location
            this.command = {
                command: 'codepilotReview.goToIssue',
                title: 'Go to Issue',
                arguments: [issue],
            };
        }
    }

    static group(label: string, status: ReviewIssueStatus, count: number, icon: string): ReviewIssueTreeItem {
        const item = new ReviewIssueTreeItem(undefined, true, status);
        item.label = `${label} (${count})`;
        item.iconPath = new vscode.ThemeIcon(icon);
        return item;
    }

    static detail(text: string): ReviewIssueTreeItem {
        const item = new ReviewIssueTreeItem();
        item.label = text;
        return item;
    }

    static message(text: string): ReviewIssueTreeItem {
        const item = new ReviewIssueTreeItem();
        item.label = text;
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
    }

    static reply(reply: ReviewIssue): ReviewIssueTreeItem {
        const item = new ReviewIssueTreeItem();
        const statusLabel = reply.status === 'draft' ? '📝 ' : '';
        const truncated = reply.details.length > 80
            ? reply.details.substring(0, 80) + '...'
            : reply.details;
        item.label = `${statusLabel}↩ ${truncated}`;
        item.description = reply.status;
        item.iconPath = new vscode.ThemeIcon('comment');
        item.tooltip = new vscode.MarkdownString(
            `**Reply** (${reply.status})\n\n${reply.details}`
        );
        item.contextValue = `reviewIssueReply:${reply.status}`;
        return item;
    }

    private getStatusIcon(status: ReviewIssueStatus): vscode.ThemeIcon {
        switch (status) {
            case 'suggested': return new vscode.ThemeIcon('lightbulb');
            case 'draft': return new vscode.ThemeIcon('edit');
            case 'published': return new vscode.ThemeIcon('comment-discussion');
            case 'pending': return new vscode.ThemeIcon('clock');
            case 'resolved': return new vscode.ThemeIcon('check');
            case 'closed': return new vscode.ThemeIcon('lock');
            case 'wontFix': return new vscode.ThemeIcon('circle-slash');
            case 'byDesign': return new vscode.ThemeIcon('verified');
            case 'dismissed': return new vscode.ThemeIcon('circle-slash');
        }
    }
}
