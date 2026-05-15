import { PullRequest, PullRequestStatus } from '../types';
import { ICodeReviewProvider, PullRequestFilter } from '../providers/provider';
import { logger } from '../logging/logger';

/**
 * Service layer for pull request operations.
 * Coordinates between providers and UI.
 */
export class PullRequestService {
    private provider: ICodeReviewProvider | undefined;
    private cachedPRs: PullRequest[] = [];

    setProvider(provider: ICodeReviewProvider): void {
        this.provider = provider;
        this.cachedPRs = [];
    }

    async getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]> {
        if (!this.provider) {
            logger.warn('No provider set');
            return [];
        }

        try {
            this.cachedPRs = await this.provider.pullRequests.getPullRequests(filter);
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

            if (filter.isUserRequired !== undefined) {
                if (pr.isUserRequired !== filter.isUserRequired) { return false; }
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
    isUserRequired?: boolean;
    priority?: string[];
    labels?: string[];
}
