import * as assert from 'assert';
import { ReviewSessionService } from '../../core/reviewSessionService';
import { ReviewIssue, ReviewIssueStatus } from '../../types';

/**
 * Extended tests for ReviewSessionService covering edge cases
 * and all status transitions.
 */

function makeIssue(id: string, overrides: Partial<ReviewIssue> = {}): ReviewIssue {
    return {
        id,
        summary: `Issue ${id}`,
        details: 'test details',
        position: { filePath: 'test.ts', line: 10, side: 'head' },
        status: 'suggested',
        source: 'tool',
        createdAt: new Date(),
        ...overrides,
    };
}

suite('ReviewSessionService - Extended', () => {
    let service: ReviewSessionService;

    setup(() => {
        service = new ReviewSessionService();
    });

    // --- addIssue ---

    test('addIssue with same id overwrites', () => {
        service.addIssue(makeIssue('x', { summary: 'first' }));
        service.addIssue(makeIssue('x', { summary: 'second' }));
        const issues = service.getIssues();
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].summary, 'second');
    });

    test('addIssue preserves other issues', () => {
        service.addIssue(makeIssue('a'));
        service.addIssue(makeIssue('b'));
        service.addIssue(makeIssue('c'));
        assert.strictEqual(service.getIssues().length, 3);
    });

    // --- acceptIssue ---

    test('acceptIssue fires event', () => {
        service.addIssue(makeIssue('e1', { status: 'suggested' }));
        let fired = false;
        service.onDidChangeIssues(() => { fired = true; });
        service.acceptIssue('e1');
        assert.strictEqual(fired, true);
    });

    test('acceptIssue on already-draft does nothing', () => {
        service.addIssue(makeIssue('d1', { status: 'draft' }));
        service.acceptIssue('d1');
        assert.strictEqual(service.getIssues()[0].status, 'draft');
    });

    test('acceptIssue on published does nothing', () => {
        service.addIssue(makeIssue('p1', { status: 'published' }));
        service.acceptIssue('p1');
        assert.strictEqual(service.getIssues()[0].status, 'published');
    });

    test('acceptIssue on dismissed does nothing', () => {
        service.addIssue(makeIssue('dm1', { status: 'dismissed' }));
        service.acceptIssue('dm1');
        assert.strictEqual(service.getIssues()[0].status, 'dismissed');
    });

    // --- updateIssueStatus ---

    test('updateIssueStatus: draft → dismissed', async () => {
        service.addIssue(makeIssue('u1', { status: 'draft' }));
        await service.updateIssueStatus('u1', 'dismissed');
        assert.strictEqual(service.getIssues()[0].status, 'dismissed');
    });

    test('updateIssueStatus: draft → resolved', async () => {
        service.addIssue(makeIssue('u2', { status: 'draft' }));
        await service.updateIssueStatus('u2', 'resolved');
        assert.strictEqual(service.getIssues()[0].status, 'resolved');
    });

    test('updateIssueStatus: suggested → dismissed', async () => {
        service.addIssue(makeIssue('u3', { status: 'suggested' }));
        await service.updateIssueStatus('u3', 'dismissed');
        assert.strictEqual(service.getIssues()[0].status, 'dismissed');
    });

    test('updateIssueStatus on nonexistent id is no-op', async () => {
        await service.updateIssueStatus('nonexistent', 'resolved');
        // Should not throw
        assert.strictEqual(service.getIssues().length, 0);
    });

    test('updateIssueStatus fires event', async () => {
        service.addIssue(makeIssue('ev1', { status: 'draft' }));
        let fired = false;
        service.onDidChangeIssues(() => { fired = true; });
        await service.updateIssueStatus('ev1', 'dismissed');
        assert.strictEqual(fired, true);
    });

    // --- getIssuesByStatus ---

    test('getIssuesByStatus with mixed statuses', () => {
        service.addIssue(makeIssue('s1', { status: 'suggested' }));
        service.addIssue(makeIssue('s2', { status: 'draft' }));
        service.addIssue(makeIssue('s3', { status: 'suggested' }));
        service.addIssue(makeIssue('s4', { status: 'published' }));
        service.addIssue(makeIssue('s5', { status: 'dismissed' }));
        service.addIssue(makeIssue('s6', { status: 'resolved' }));

        assert.strictEqual(service.getIssuesByStatus('suggested').length, 2);
        assert.strictEqual(service.getIssuesByStatus('draft').length, 1);
        assert.strictEqual(service.getIssuesByStatus('published').length, 1);
        assert.strictEqual(service.getIssuesByStatus('dismissed').length, 1);
        assert.strictEqual(service.getIssuesByStatus('resolved').length, 1);
    });

    test('getIssuesByStatus returns empty for no matches', () => {
        service.addIssue(makeIssue('x', { status: 'draft' }));
        assert.strictEqual(service.getIssuesByStatus('published').length, 0);
    });

    // --- getDiff ---

    test('getDiff returns empty before openReview', () => {
        assert.deepStrictEqual(service.getDiff(), []);
    });

    // --- getCurrentPrId ---

    test('getCurrentPrId returns undefined initially', () => {
        assert.strictEqual(service.getCurrentPrId(), undefined);
    });

    // --- Multiple event listeners ---

    test('multiple listeners all fire on addIssue', () => {
        let count = 0;
        service.onDidChangeIssues(() => { count++; });
        service.onDidChangeIssues(() => { count++; });
        service.addIssue(makeIssue('m1'));
        assert.strictEqual(count, 2);
    });
});
