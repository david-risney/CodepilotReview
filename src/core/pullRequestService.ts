import * as vscode from 'vscode';
import { PullRequest, PullRequestStatus, ReviewPriority, UserNeedLevel } from '../types';
import { ICodeReviewProvider, PullRequestFilter } from '../providers/provider';
import { IAiService } from '../ai/aiService';
import { logger } from '../logging/logger';

/**
 * Service layer for pull request operations.
 * Coordinates between providers and UI.
 */
export class PullRequestService {
    private provider: ICodeReviewProvider | undefined;
    private aiService: IAiService | undefined;
    private cachedPRs: PullRequest[] = [];

    private _onDidEnrich = new vscode.EventEmitter<void>();
    readonly onDidEnrich = this._onDidEnrich.event;

    setProvider(provider: ICodeReviewProvider): void {
        this.provider = provider;
        this.cachedPRs = [];
    }

    setAiService(aiService: IAiService): void {
        this.aiService = aiService;
    }

    async getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]> {
        if (!this.provider) {
            logger.warn('No provider set');
            return [];
        }

        try {
            this.cachedPRs = await this.provider.pullRequests.getPullRequests(filter);

            // Enrich PRs with AI-generated info in background
            this.enrichPrsWithAi(this.cachedPRs);

            return this.cachedPRs;
        } catch (error) {
            logger.error('Failed to fetch pull requests', error);
            return this.cachedPRs;
        }
    }

    async getPullRequest(id: string): Promise<PullRequest | undefined> {
        if (!this.provider) {
            return undefined;
        }
        return this.provider.pullRequests.getPullRequest(id);
    }

    /**
     * Enrich PRs with AI-generated summary, priority, and relevant links.
     * Runs in background — doesn't block the PR list from appearing.
     */
    private async enrichPrsWithAi(prs: PullRequest[]): Promise<void> {
        if (!this.aiService || !(await this.aiService.isAvailable())) {
            return;
        }

        for (const pr of prs) {
            // Skip if already enriched
            if (pr.aiSummary) { continue; }

            try {
                const diff = await this.provider?.diff.getDiff(pr.id);
                if (!diff || diff.length === 0) { continue; }

                const response = await this.aiService.summarizeDiff(diff);
                const parsed = this.parseSummarizeResponse(response);

                pr.aiSummary = parsed.summary || undefined;
                pr.priority = parsed.priority || undefined;
                pr.relevantLinks = parsed.links;

                // AI can upgrade userNeed if it detects the user should pay attention
                if (parsed.userNeed) {
                    pr.userNeed = parsed.userNeed;
                }
            } catch (error) {
                logger.warn(`Failed to enrich PR ${pr.id} with AI info`, error);
            }
        }

        // Notify views that PRs have been enriched with AI info
        this._onDidEnrich.fire();
    }

    private parseSummarizeResponse(response: string): {
        summary: string | null;
        priority: ReviewPriority | null;
        userNeed: UserNeedLevel | null;
        links: Array<{ title: string; url: string; type: 'other' }>;
    } {
        let summary: string | null = null;
        let priority: ReviewPriority | null = null;
        let userNeed: UserNeedLevel | null = null;
        const links: Array<{ title: string; url: string; type: 'other' }> = [];

        for (const line of response.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('SUMMARY:')) {
                summary = trimmed.substring('SUMMARY:'.length).trim();
            } else if (trimmed.startsWith('PRIORITY:')) {
                const p = trimmed.substring('PRIORITY:'.length).trim().toLowerCase();
                if (['blocking', 'yes', 'interest', 'no'].includes(p)) {
                    priority = p as ReviewPriority;
                }
            } else if (trimmed.startsWith('USER_NEED:')) {
                const u = trimmed.substring('USER_NEED:'.length).trim().toLowerCase();
                if (['blocking', 'required', 'optional', 'fyi'].includes(u)) {
                    userNeed = u as UserNeedLevel;
                }
            } else if (trimmed.startsWith('LINKS:')) {
                const linkStr = trimmed.substring('LINKS:'.length).trim();
                if (linkStr !== 'none') {
                    for (const part of linkStr.split(',')) {
                        const t = part.trim();
                        if (t) {
                            links.push({ title: t, url: '', type: 'other' });
                        }
                    }
                }
            }
        }

        return { summary, priority, userNeed, links };
    }

    /** Advanced filtering that works across all providers (useful for ADO) */
    filterPullRequests(prs: PullRequest[], filter: AdvancedFilter): PullRequest[] {
        return prs.filter(pr => {
            if (filter.searchText) {
                const search = filter.searchText.toLowerCase();
                const matches =
                    pr.title.toLowerCase().includes(search) ||
                    pr.description.toLowerCase().includes(search) ||
                    pr.author.toLowerCase().includes(search);
                if (!matches) { return false; }
            }

            if (filter.statuses && filter.statuses.length > 0) {
                if (!filter.statuses.includes(pr.status)) { return false; }
            }

            if (filter.authors && filter.authors.length > 0) {
                if (!filter.authors.includes(pr.author)) { return false; }
            }

            if (filter.userNeed && filter.userNeed.length > 0) {
                if (!filter.userNeed.includes(pr.userNeed)) { return false; }
            }

            if (filter.priority && filter.priority.length > 0) {
                if (!pr.priority || !filter.priority.includes(pr.priority)) { return false; }
            }

            if (filter.labels && filter.labels.length > 0) {
                if (!filter.labels.some(l => pr.labels.includes(l))) { return false; }
            }

            return true;
        });
    }
}

export interface AdvancedFilter {
    searchText?: string;
    statuses?: PullRequestStatus[];
    authors?: string[];
    userNeed?: UserNeedLevel[];
    priority?: string[];
    labels?: string[];
}
