import * as vscode from 'vscode';
import { PullRequest, PullRequestStatus, ReviewPriority, UserNeedLevel, ProviderViewQuery, LocalFilter } from '../types';
import { ICodeReviewProvider, PullRequestFilter, ProviderInstance } from '../providers/provider';
import { IAiService } from '../ai/aiService';
import { logger } from '../logging/logger';

/**
 * Service layer for pull request operations.
 * Coordinates between multiple providers and UI.
 */
export class PullRequestService {
    private providers: ProviderInstance[] = [];
    private aiService: IAiService | undefined;
    private cachedPRs = new Map<string, PullRequest[]>();
    private _enriching = false;
    private _enrichQueue: PullRequest[] | undefined;

    private _onDidEnrich = new vscode.EventEmitter<void>();
    readonly onDidEnrich = this._onDidEnrich.event;

    /** @deprecated Use setProviders() for multi-provider support */
    setProvider(provider: ICodeReviewProvider): void {
        const config = { id: provider.name, label: provider.name, type: provider.name as any };
        this.providers = [{
            id: provider.name,
            displayName: provider.name,
            type: provider.name as any,
            provider,
            views: [{ id: 'all', label: 'All' }],
            config,
        }];
        this.cachedPRs.clear();
    }

    setProviders(providers: ProviderInstance[]): void {
        this.providers = providers;
        this.cachedPRs.clear();
    }

    setAiService(aiService: IAiService): void {
        this.aiService = aiService;
    }

    /** Get the provider instance for a given provider ID */
    getProviderById(id: string): ProviderInstance | undefined {
        return this.providers.find(p => p.id === id);
    }

    /**
     * Get PRs for a specific view within a provider.
     * Translates the ProviderViewQuery into provider-specific API filter,
     * then applies optional LocalFilter client-side.
     */
    async getPullRequestsForView(
        providerId: string,
        viewId: string,
        query?: ProviderViewQuery,
        localFilter?: LocalFilter,
    ): Promise<PullRequest[]> {
        const instance = this.providers.find(p => p.id === providerId);
        if (!instance) {
            logger.warn(`Provider "${providerId}" not found`);
            return [];
        }

        const cacheKey = `${providerId}:${viewId}`;

        try {
            const apiFilter = this.translateQuery(query);
            const freshPrs = await instance.provider.pullRequests.getPullRequests(apiFilter);

            // Preserve AI enrichment data from previously cached PRs
            const oldPrs = this.cachedPRs.get(cacheKey);
            if (oldPrs) {
                const oldById = new Map(oldPrs.map(p => [p.id, p]));
                for (const pr of freshPrs) {
                    const old = oldById.get(pr.id);
                    if (old) {
                        pr.aiSummary = pr.aiSummary ?? old.aiSummary;
                        pr.priority = pr.priority ?? old.priority;
                        pr.relevantLinks = pr.relevantLinks ?? old.relevantLinks;
                        if (old.userNeed && !pr.userNeed) {
                            pr.userNeed = old.userNeed;
                        }
                    }
                }
            }

            this.cachedPRs.set(cacheKey, freshPrs);
        } catch (error) {
            logger.error(`Failed to fetch PRs for view "${viewId}" from "${providerId}"`, error);
            // Fall back to cached
            if (!this.cachedPRs.has(cacheKey)) {
                return [];
            }
        }

        let results = this.cachedPRs.get(cacheKey) || [];

        // Apply local filters
        if (localFilter) {
            results = this.applyLocalFilter(results, localFilter);
        }

        // Enrich with AI in background
        this.enrichPrsWithAi(results);

        return results;
    }

    /** Translate a ProviderViewQuery into a generic PullRequestFilter for the provider API */
    private translateQuery(query?: ProviderViewQuery): PullRequestFilter | undefined {
        if (!query) { return undefined; }

        switch (query.type) {
            case 'azureDevOps':
                return {
                    status: query.status ? [query.status] : undefined,
                    author: query.creatorId,
                    reviewer: query.reviewerId,
                };
            case 'github':
                return {
                    status: query.state ? [query.state] : undefined,
                    author: query.author,
                    searchText: query.searchQuery,
                };
            case 'chromium':
                return {
                    status: query.status ? [query.status] : undefined,
                    author: query.owner,
                };
            case 'local':
            default:
                return undefined;
        }
    }

    /** Apply local (client-side) filters to a PR list */
    private applyLocalFilter(prs: PullRequest[], filter: LocalFilter): PullRequest[] {
        return prs.filter(pr => {
            if (filter.text) {
                const text = filter.text.toLowerCase();
                const matches =
                    pr.title.toLowerCase().includes(text) ||
                    pr.description.toLowerCase().includes(text) ||
                    pr.author.toLowerCase().includes(text) ||
                    pr.labels.some(l => l.toLowerCase().includes(text));
                if (!matches) { return false; }
            }
            if (filter.statuses && filter.statuses.length > 0) {
                if (!filter.statuses.includes(pr.status)) { return false; }
            }
            if (filter.userNeed && filter.userNeed.length > 0) {
                if (!filter.userNeed.includes(pr.userNeed)) { return false; }
            }
            if (filter.priority && filter.priority.length > 0) {
                if (!pr.priority || !filter.priority.includes(pr.priority)) { return false; }
            }
            return true;
        });
    }

    async getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]> {
        if (this.providers.length === 0) {
            logger.warn('No providers set');
            return [];
        }

        // Fetch from all providers in parallel, tolerating individual failures
        const results = await Promise.allSettled(
            this.providers.map(async (instance) => {
                try {
                    const prs = await instance.provider.pullRequests.getPullRequests(filter);
                    this.cachedPRs.set(instance.id, prs);
                    return prs;
                } catch (error) {
                    logger.error(`Failed to fetch PRs from provider "${instance.id}"`, error);
                    // Return cached PRs for this provider on failure
                    return this.cachedPRs.get(instance.id) || [];
                }
            }),
        );

        const allPRs: PullRequest[] = [];
        for (const result of results) {
            if (result.status === 'fulfilled') {
                allPRs.push(...result.value);
            }
        }

        // Enrich PRs with AI-generated info in background
        this.enrichPrsWithAi(allPRs);

        return allPRs;
    }

    async getPullRequest(id: string, providerId?: string): Promise<PullRequest | undefined> {
        // If providerId is given, look up only that provider
        if (providerId) {
            const instance = this.providers.find(p => p.id === providerId);
            if (instance) {
                return instance.provider.pullRequests.getPullRequest(id);
            }
        }
        // Otherwise search all providers
        for (const instance of this.providers) {
            const pr = await instance.provider.pullRequests.getPullRequest(id);
            if (pr) { return pr; }
        }
        return undefined;
    }

    /**
     * Enrich PRs with AI-generated summary, priority, and relevant links.
     * Runs in background — doesn't block the PR list from appearing.
     */
    private async enrichPrsWithAi(prs: PullRequest[]): Promise<void> {
        if (!this.aiService || !(await this.aiService.isAvailable())) {
            return;
        }

        // Prevent concurrent enrichment runs — queue for later
        if (this._enriching) {
            this._enrichQueue = prs;
            return;
        }
        this._enriching = true;

        try {
            let enrichedAny = false;

            for (const pr of prs) {
                // Skip if already enriched
                if (pr.aiSummary) { continue; }

                try {
                    // Look up the correct provider for this PR
                    const instance = this.providers.find(p => p.id === pr.providerId);
                    if (!instance) { continue; }

                    const diff = await instance.provider.diff.getDiff(pr.id);
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

                    enrichedAny = true;
                } catch (error) {
                    logger.warn(`Failed to enrich PR ${pr.id} with AI info`, error);
                }
            }

            // Only notify views if at least one PR was actually enriched
            if (enrichedAny) {
                this._onDidEnrich.fire();
            }
        } finally {
            this._enriching = false;
            // Process queued enrichment if any
            if (this._enrichQueue) {
                const queued = this._enrichQueue;
                this._enrichQueue = undefined;
                this.enrichPrsWithAi(queued);
            }
        }
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
