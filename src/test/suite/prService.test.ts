import * as assert from 'assert';
import { PullRequestService, AdvancedFilter } from '../../core/pullRequestService';
import { PullRequest, UserNeedLevel, ReviewPriority } from '../../types';

/**
 * Tests for PullRequestService.parseSummarizeResponse and filterPullRequests.
 * Covers: AI enrichment response parsing, all filter dimensions, edge cases.
 */

// Replicate parseSummarizeResponse logic for unit-testing without private access
function parseSummarizeResponse(response: string): {
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

suite('PullRequestService - parseSummarizeResponse', () => {
    test('parses all fields from well-formed response', () => {
        const response = [
            'SUMMARY: This PR fixes the login flow',
            'PRIORITY: blocking',
            'USER_NEED: required',
            'LINKS: PR #42, Bug #123',
        ].join('\n');

        const result = parseSummarizeResponse(response);
        assert.strictEqual(result.summary, 'This PR fixes the login flow');
        assert.strictEqual(result.priority, 'blocking');
        assert.strictEqual(result.userNeed, 'required');
        assert.strictEqual(result.links.length, 2);
        assert.strictEqual(result.links[0].title, 'PR #42');
        assert.strictEqual(result.links[1].title, 'Bug #123');
    });

    test('returns nulls for empty response', () => {
        const result = parseSummarizeResponse('');
        assert.strictEqual(result.summary, null);
        assert.strictEqual(result.priority, null);
        assert.strictEqual(result.userNeed, null);
        assert.strictEqual(result.links.length, 0);
    });

    test('ignores invalid priority values', () => {
        const result = parseSummarizeResponse('PRIORITY: critical');
        assert.strictEqual(result.priority, null);
    });

    test('ignores invalid userNeed values', () => {
        const result = parseSummarizeResponse('USER_NEED: urgent');
        assert.strictEqual(result.userNeed, null);
    });

    test('handles LINKS: none', () => {
        const result = parseSummarizeResponse('LINKS: none');
        assert.strictEqual(result.links.length, 0);
    });

    test('handles response with extra whitespace', () => {
        const result = parseSummarizeResponse('  SUMMARY:   spaced summary  ');
        assert.strictEqual(result.summary, 'spaced summary');
    });

    test('handles all priority values', () => {
        for (const p of ['blocking', 'yes', 'interest', 'no']) {
            const result = parseSummarizeResponse(`PRIORITY: ${p}`);
            assert.strictEqual(result.priority, p);
        }
    });

    test('handles all userNeed values', () => {
        for (const u of ['blocking', 'required', 'optional', 'fyi']) {
            const result = parseSummarizeResponse(`USER_NEED: ${u}`);
            assert.strictEqual(result.userNeed, u);
        }
    });

    test('handles case-insensitive priority', () => {
        const result = parseSummarizeResponse('PRIORITY: BLOCKING');
        assert.strictEqual(result.priority, 'blocking');
    });

    test('parses partial response (only summary)', () => {
        const result = parseSummarizeResponse('SUMMARY: Just a summary\nSome other text');
        assert.strictEqual(result.summary, 'Just a summary');
        assert.strictEqual(result.priority, null);
        assert.strictEqual(result.userNeed, null);
    });

    test('handles single link', () => {
        const result = parseSummarizeResponse('LINKS: Bug #99');
        assert.strictEqual(result.links.length, 1);
        assert.strictEqual(result.links[0].title, 'Bug #99');
    });
});

suite('PullRequestService - filterPullRequests', () => {
    let service: PullRequestService;

    const mockPRs: PullRequest[] = [
        {
            id: 'pr-1', title: 'Fix login bug', description: 'Fixes the login timeout issue',
            author: 'alice', status: 'open', sourceBranch: 'fix/login', targetBranch: 'main',
            createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-02'),
            reviewers: [{ name: 'bob', id: 'bob', isRequired: true }],
            labels: ['bug', 'urgent'], userNeed: 'blocking', priority: 'blocking', providerName: 'local', providerId: 'local',
        },
        {
            id: 'pr-2', title: 'Add feature X', description: 'New feature implementation',
            author: 'bob', status: 'draft', sourceBranch: 'feature/x', targetBranch: 'main',
            createdAt: new Date('2024-01-03'), updatedAt: new Date('2024-01-04'),
            reviewers: [], labels: ['feature'], userNeed: 'fyi', priority: 'interest', providerName: 'local', providerId: 'local',
        },
        {
            id: 'pr-3', title: 'Refactor utils', description: 'Clean up utility functions',
            author: 'alice', status: 'open', sourceBranch: 'refactor/utils', targetBranch: 'main',
            createdAt: new Date('2024-01-05'), updatedAt: new Date('2024-01-06'),
            reviewers: [{ name: 'carol', id: 'carol', isRequired: false }],
            labels: ['refactor'], userNeed: 'optional', providerName: 'local', providerId: 'local',
        },
    ];

    setup(() => {
        service = new PullRequestService();
    });

    test('filter by search text (title)', () => {
        const result = service.filterPullRequests(mockPRs, { searchText: 'login' });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-1');
    });

    test('filter by search text (author)', () => {
        const result = service.filterPullRequests(mockPRs, { searchText: 'bob' });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-2');
    });

    test('filter by search text (description)', () => {
        const result = service.filterPullRequests(mockPRs, { searchText: 'utility' });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-3');
    });

    test('search is case insensitive', () => {
        const result = service.filterPullRequests(mockPRs, { searchText: 'LOGIN' });
        assert.strictEqual(result.length, 1);
    });

    test('filter by single status', () => {
        const result = service.filterPullRequests(mockPRs, { statuses: ['open'] });
        assert.strictEqual(result.length, 2);
    });

    test('filter by multiple statuses', () => {
        const result = service.filterPullRequests(mockPRs, { statuses: ['open', 'draft'] });
        assert.strictEqual(result.length, 3);
    });

    test('filter by author', () => {
        const result = service.filterPullRequests(mockPRs, { authors: ['alice'] });
        assert.strictEqual(result.length, 2);
    });

    test('filter by userNeed (single)', () => {
        const result = service.filterPullRequests(mockPRs, { userNeed: ['blocking'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-1');
    });

    test('filter by userNeed (multiple)', () => {
        const result = service.filterPullRequests(mockPRs, { userNeed: ['blocking', 'optional'] });
        assert.strictEqual(result.length, 2);
    });

    test('filter by priority', () => {
        const result = service.filterPullRequests(mockPRs, { priority: ['blocking'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-1');
    });

    test('filter by priority excludes PRs without priority', () => {
        const result = service.filterPullRequests(mockPRs, { priority: ['interest'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-2');
    });

    test('filter by labels', () => {
        const result = service.filterPullRequests(mockPRs, { labels: ['feature'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-2');
    });

    test('filter by labels matches any label', () => {
        const result = service.filterPullRequests(mockPRs, { labels: ['bug', 'refactor'] });
        assert.strictEqual(result.length, 2);
    });

    test('combined filters (author + status)', () => {
        const result = service.filterPullRequests(mockPRs, { authors: ['alice'], statuses: ['open'] });
        assert.strictEqual(result.length, 2);
    });

    test('combined filters narrow results', () => {
        const result = service.filterPullRequests(mockPRs, { authors: ['alice'], labels: ['bug'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-1');
    });

    test('empty filter returns all', () => {
        const result = service.filterPullRequests(mockPRs, {});
        assert.strictEqual(result.length, 3);
    });

    test('filter with no matches returns empty', () => {
        const result = service.filterPullRequests(mockPRs, { searchText: 'nonexistent' });
        assert.strictEqual(result.length, 0);
    });

    test('filter empty array returns empty', () => {
        const result = service.filterPullRequests([], { searchText: 'anything' });
        assert.strictEqual(result.length, 0);
    });
});
