import * as vscode from 'vscode';
import { PullRequest, PullRequestStatus, UserNeedLevel, ReviewPriority, ProviderView, LocalFilter } from '../types';
import { PullRequestService } from '../core/pullRequestService';
import { ProviderInstance } from '../providers/provider';

/**
 * Tree node types for the PR list view hierarchy:
 * Provider → View → PR → Details
 */
type TreeNode = ProviderTreeNode | ViewTreeNode | PrTreeNode | DetailTreeNode;

/**
 * TreeDataProvider for the Pull Request list view.
 * Shows a hierarchy: Provider → Views → PRs → PR Details.
 */
export class PrListViewProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private providers: ProviderInstance[] = [];

    constructor(private prService: PullRequestService) {}

    setProviders(providers: ProviderInstance[]): void {
        this.providers = providers;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Refresh a specific view node only */
    refreshView(viewNode: ViewTreeNode): void {
        this._onDidChangeTreeData.fire(viewNode);
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // Root level: show providers
            return this.providers.map(p => new ProviderTreeNode(p));
        }

        if (element instanceof ProviderTreeNode) {
            // Provider level: show views
            return element.instance.views.map(v => new ViewTreeNode(element.instance, v));
        }

        if (element instanceof ViewTreeNode) {
            // View level: fetch and show PRs
            const prs = await this.prService.getPullRequestsForView(
                element.instance.id,
                element.view.id,
                element.view.query,
                element.view.filter,
            );
            return prs.map(pr => new PrTreeNode(pr));
        }

        if (element instanceof PrTreeNode) {
            // PR level: show details
            return this.getPrDetails(element.pr);
        }

        return [];
    }

    getParent(element: TreeNode): TreeNode | undefined {
        // Required for reveal() to work
        if (element instanceof ViewTreeNode) {
            const provider = this.providers.find(p => p.id === element.instance.id);
            return provider ? new ProviderTreeNode(provider) : undefined;
        }
        if (element instanceof PrTreeNode) {
            // Can't easily resolve parent without storing it
            return undefined;
        }
        return undefined;
    }

    private getPrDetails(pr: PullRequest): DetailTreeNode[] {
        const details: DetailTreeNode[] = [];

        details.push(new DetailTreeNode('Author', pr.author));
        details.push(new DetailTreeNode('Branch', `${pr.sourceBranch} → ${pr.targetBranch}`));
        details.push(new DetailTreeNode('Status', pr.status));
        details.push(new DetailTreeNode('User Need', pr.userNeed));

        if (pr.priority) {
            details.push(new DetailTreeNode('Priority', pr.priority));
        }
        if (pr.aiSummary) {
            details.push(new DetailTreeNode('Summary', pr.aiSummary));
        }
        if (pr.reviewers.length > 0) {
            details.push(new DetailTreeNode('Reviewers', pr.reviewers.map(r => r.name).join(', ')));
        }
        if (pr.relevantLinks && pr.relevantLinks.length > 0) {
            details.push(new DetailTreeNode('Links', pr.relevantLinks.map(l => l.title).join(', ')));
        }

        return details;
    }

    // --- Legacy filter methods (kept for backward compat with filter command) ---

    setFilter(text: string): void {
        // Apply as transient text filter to all views — not persisted
        for (const provider of this.providers) {
            for (const view of provider.views) {
                if (!view.filter) { view.filter = {}; }
                view.filter.text = text.toLowerCase() || undefined;
            }
        }
        this.refresh();
    }

    setStatusFilter(statuses: PullRequestStatus[]): void {
        for (const provider of this.providers) {
            for (const view of provider.views) {
                if (!view.filter) { view.filter = {}; }
                view.filter.statuses = statuses.length > 0 ? statuses : undefined;
            }
        }
        this.refresh();
    }

    setUserNeedFilter(needs: UserNeedLevel[]): void {
        for (const provider of this.providers) {
            for (const view of provider.views) {
                if (!view.filter) { view.filter = {}; }
                view.filter.userNeed = needs.length > 0 ? needs : undefined;
            }
        }
        this.refresh();
    }

    setPriorityFilter(priorities: ReviewPriority[]): void {
        for (const provider of this.providers) {
            for (const view of provider.views) {
                if (!view.filter) { view.filter = {}; }
                view.filter.priority = priorities.length > 0 ? priorities : undefined;
            }
        }
        this.refresh();
    }

    setProviderFilter(_providerIds: string[]): void {
        // No longer needed with hierarchical view; kept for interface compat
        this.refresh();
    }
}

// ── Tree Node Classes ───────────────────────────────────────────────────────

export class ProviderTreeNode extends vscode.TreeItem {
    readonly contextValue = 'provider';

    constructor(public readonly instance: ProviderInstance) {
        super(instance.displayName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = instance.type;
        this.iconPath = this.getProviderIcon(instance.type);
        this.tooltip = `${instance.displayName} (${instance.type}) — ${instance.views.length} view(s)`;
    }

    private getProviderIcon(type: string): vscode.ThemeIcon {
        switch (type) {
            case 'azureDevOps': return new vscode.ThemeIcon('azure');
            case 'github': return new vscode.ThemeIcon('github');
            case 'chromium': return new vscode.ThemeIcon('globe');
            case 'local': return new vscode.ThemeIcon('git-branch');
            default: return new vscode.ThemeIcon('plug');
        }
    }
}

export class ViewTreeNode extends vscode.TreeItem {
    readonly contextValue = 'providerView';

    constructor(
        public readonly instance: ProviderInstance,
        public readonly view: ProviderView,
    ) {
        super(view.label, vscode.TreeItemCollapsibleState.Expanded);
        this.description = this.buildDescription();
        this.iconPath = new vscode.ThemeIcon('filter');
        this.tooltip = this.buildTooltip();
    }

    private buildDescription(): string {
        const parts: string[] = [];
        if (this.view.query) {
            const q = this.view.query;
            if (q.type === 'azureDevOps' && q.status) { parts.push(q.status); }
            if (q.type === 'github' && q.searchQuery) { parts.push(q.searchQuery); }
            if (q.type === 'chromium' && q.status) { parts.push(q.status); }
        }
        if (this.view.filter?.text) { parts.push(`"${this.view.filter.text}"`); }
        return parts.join(' · ') || '';
    }

    private buildTooltip(): string {
        let tip = `View: ${this.view.label}`;
        if (this.view.query) {
            tip += `\nQuery: ${JSON.stringify(this.view.query, null, 2)}`;
        }
        if (this.view.filter) {
            tip += `\nFilter: ${JSON.stringify(this.view.filter)}`;
        }
        return tip;
    }
}

export class PrTreeNode extends vscode.TreeItem {
    readonly contextValue = 'pullRequest';

    constructor(public readonly pr: PullRequest) {
        super(pr.title, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = `${pr.author} · ${pr.status}`;
        this.tooltip = this.buildTooltip(pr);
        this.iconPath = this.getStatusIcon(pr.status);

        this.command = {
            command: 'codepilotReview.openReview',
            title: 'Open Review',
            arguments: [pr],
        };
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

export class DetailTreeNode extends vscode.TreeItem {
    readonly contextValue = 'prDetail';

    constructor(label: string, value: string) {
        super(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('info');
    }
}

// Keep PrTreeItem as an alias for backward compatibility with tests
export { PrTreeNode as PrTreeItem };
