import * as vscode from 'vscode';
import { PullRequest, PullRequestStatus, UserNeedLevel, ReviewPriority } from '../types';
import { PullRequestService } from '../core/pullRequestService';

/**
 * TreeDataProvider for the Pull Request list view.
 * Supports filtering and displays PR metadata including AI-generated info.
 * Shows PRs from all active providers with provider labels.
 */
export class PrListViewProvider implements vscode.TreeDataProvider<PrTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PrTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private filterText: string = '';
    private statusFilter: PullRequestStatus[] = [];
    private userNeedFilter: UserNeedLevel[] = [];
    private priorityFilter: ReviewPriority[] = [];
    private providerFilter: string[] = [];

    constructor(private prService: PullRequestService) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setFilter(text: string): void {
        this.filterText = text.toLowerCase();
        this.refresh();
    }

    setStatusFilter(statuses: PullRequestStatus[]): void {
        this.statusFilter = statuses;
        this.refresh();
    }

    setUserNeedFilter(needs: UserNeedLevel[]): void {
        this.userNeedFilter = needs;
        this.refresh();
    }

    setPriorityFilter(priorities: ReviewPriority[]): void {
        this.priorityFilter = priorities;
        this.refresh();
    }

    setProviderFilter(providerIds: string[]): void {
        this.providerFilter = providerIds;
        this.refresh();
    }

    getTreeItem(element: PrTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PrTreeItem): Promise<PrTreeItem[]> {
        if (element) {
            return this.getPrDetails(element.pr);
        }

        const prs = await this.prService.getPullRequests();
        let filtered = prs;

        if (this.filterText) {
            filtered = filtered.filter(pr =>
                pr.title.toLowerCase().includes(this.filterText) ||
                pr.description.toLowerCase().includes(this.filterText) ||
                pr.author.toLowerCase().includes(this.filterText) ||
                pr.labels.some(l => l.toLowerCase().includes(this.filterText))
            );
        }

        if (this.statusFilter.length > 0) {
            filtered = filtered.filter(pr => this.statusFilter.includes(pr.status));
        }

        if (this.userNeedFilter.length > 0) {
            filtered = filtered.filter(pr => this.userNeedFilter.includes(pr.userNeed));
        }

        if (this.priorityFilter.length > 0) {
            filtered = filtered.filter(pr => pr.priority && this.priorityFilter.includes(pr.priority));
        }

        if (this.providerFilter.length > 0) {
            filtered = filtered.filter(pr => this.providerFilter.includes(pr.providerId));
        }

        return filtered.map(pr => new PrTreeItem(pr));
    }

    private getPrDetails(pr: PullRequest): PrTreeItem[] {
        const details: PrTreeItem[] = [];

        details.push(PrTreeItem.detail('Author', pr.author));
        details.push(PrTreeItem.detail('Provider', pr.providerName || pr.providerId));
        details.push(PrTreeItem.detail('Branch', `${pr.sourceBranch} → ${pr.targetBranch}`));
        details.push(PrTreeItem.detail('Status', pr.status));
        details.push(PrTreeItem.detail('User Need', pr.userNeed));

        if (pr.priority) {
            details.push(PrTreeItem.detail('Priority', pr.priority));
        }
        if (pr.aiSummary) {
            details.push(PrTreeItem.detail('Summary', pr.aiSummary));
        }
        if (pr.reviewers.length > 0) {
            details.push(PrTreeItem.detail('Reviewers', pr.reviewers.map(r => r.name).join(', ')));
        }
        if (pr.relevantLinks && pr.relevantLinks.length > 0) {
            details.push(PrTreeItem.detail('Links', pr.relevantLinks.map(l => l.title).join(', ')));
        }

        return details;
    }
}

export class PrTreeItem extends vscode.TreeItem {
    constructor(
        public readonly pr: PullRequest,
        public readonly isDetail: boolean = false,
    ) {
        super(
            pr.title,
            isDetail
                ? vscode.TreeItemCollapsibleState.None
                : vscode.TreeItemCollapsibleState.Collapsed
        );

        if (!isDetail) {
            const providerLabel = pr.providerName && pr.providerName !== pr.providerId
                ? ` · ${pr.providerName}`
                : (pr.providerId ? ` · ${pr.providerId}` : '');
            this.description = `${pr.author} · ${pr.status}${providerLabel}`;
            this.tooltip = this.buildTooltip(pr);
            this.contextValue = 'pullRequest';
            this.iconPath = this.getStatusIcon(pr.status);

            this.command = {
                command: 'codepilotReview.openReview',
                title: 'Open Review',
                arguments: [pr],
            };
        }
    }

    static detail(label: string, value: string): PrTreeItem {
        const dummyPr: PullRequest = {
            id: '', title: `${label}: ${value}`, description: '', author: '',
            status: 'open', sourceBranch: '', targetBranch: '',
            createdAt: new Date(), updatedAt: new Date(),
            reviewers: [], labels: [], userNeed: 'optional', providerName: '', providerId: '',
        };
        return new PrTreeItem(dummyPr, true);
    }

    private buildTooltip(pr: PullRequest): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${pr.title}**\n\n`);
        if (pr.description) {
            md.appendMarkdown(`${pr.description}\n\n`);
        }
        md.appendMarkdown(`Author: ${pr.author}\n\n`);
        md.appendMarkdown(`Branch: ${pr.sourceBranch} → ${pr.targetBranch}\n\n`);
        if (pr.priority) {
            md.appendMarkdown(`Priority: ${pr.priority}\n\n`);
        }
        return md;
    }

    private getStatusIcon(status: PullRequestStatus): vscode.ThemeIcon {
        switch (status) {
            case 'open': return new vscode.ThemeIcon('git-pull-request');
            case 'closed': return new vscode.ThemeIcon('git-pull-request-closed');
            case 'merged': return new vscode.ThemeIcon('git-merge');
            case 'draft': return new vscode.ThemeIcon('git-pull-request-draft');
            case 'abandoned': return new vscode.ThemeIcon('circle-slash');
        }
    }
}
