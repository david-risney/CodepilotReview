import * as assert from 'assert';
import { PullRequestService, AdvancedFilter } from '../../core/pullRequestService';
import { PullRequest } from '../../types';

suite('PullRequestService', () => {
    let service: PullRequestService;

    const mockPRs: PullRequest[] = [
        {
            id: 'pr-1',
            title: 'Fix login bug',
            description: 'Fixes the login timeout issue',
            author: 'alice',
            status: 'open',
            sourceBranch: 'fix/login',
            targetBranch: 'main',
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-02'),
            reviewers: [{ name: 'bob', id: 'bob', isRequired: true }],
            labels: ['bug', 'urgent'],
            userNeed: 'blocking',
            priority: 'blocking',
            providerName: 'local',
        },
        {
            id: 'pr-2',
            title: 'Add feature X',
            description: 'New feature implementation',
            author: 'bob',
            status: 'draft',
            sourceBranch: 'feature/x',
            targetBranch: 'main',
            createdAt: new Date('2024-01-03'),
            updatedAt: new Date('2024-01-04'),
            reviewers: [],
            labels: ['feature'],
            userNeed: 'fyi',
            priority: 'interest',
            providerName: 'local',
        },
        {
            id: 'pr-3',
            title: 'Refactor utils',
            description: 'Clean up utility functions',
            author: 'alice',
            status: 'open',
            sourceBranch: 'refactor/utils',
            targetBranch: 'main',
            createdAt: new Date('2024-01-05'),
            updatedAt: new Date('2024-01-06'),
            reviewers: [{ name: 'carol', id: 'carol', isRequired: false }],
            labels: ['refactor'],
            userNeed: 'optional',
            providerName: 'local',
        },
    ];

    setup(() => {
        service = new PullRequestService();
    });

    test('filterPullRequests by search text', () => {
        const result = service.filterPullRequests(mockPRs, { searchText: 'login' });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-1');
    });

    test('filterPullRequests by status', () => {
        const result = service.filterPullRequests(mockPRs, { statuses: ['open'] });
        assert.strictEqual(result.length, 2);
    });

    test('filterPullRequests by author', () => {
        const result = service.filterPullRequests(mockPRs, { authors: ['alice'] });
        assert.strictEqual(result.length, 2);
    });

    test('filterPullRequests by userNeed', () => {
        const result = service.filterPullRequests(mockPRs, { userNeed: ['blocking'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-1');
    });

    test('filterPullRequests by priority', () => {
        const result = service.filterPullRequests(mockPRs, { priority: ['blocking'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-1');
    });

    test('filterPullRequests by labels', () => {
        const result = service.filterPullRequests(mockPRs, { labels: ['feature'] });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'pr-2');
    });

    test('filterPullRequests with combined filters', () => {
        const result = service.filterPullRequests(mockPRs, {
            authors: ['alice'],
            statuses: ['open'],
        });
        assert.strictEqual(result.length, 2);
    });

    test('filterPullRequests returns all with empty filter', () => {
        const result = service.filterPullRequests(mockPRs, {});
        assert.strictEqual(result.length, 3);
    });

    test('filterPullRequests search is case insensitive', () => {
        const result = service.filterPullRequests(mockPRs, { searchText: 'LOGIN' });
        assert.strictEqual(result.length, 1);
    });
});
