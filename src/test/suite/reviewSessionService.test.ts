import * as assert from 'assert';
import { ReviewSessionService } from '../../core/reviewSessionService';
import { ReviewIssue } from '../../types';

suite('ReviewSessionService', () => {
    let service: ReviewSessionService;

    const createIssue = (id: string, status: ReviewIssue['status'] = 'draft'): ReviewIssue => ({
        id,
        summary: `Issue ${id}`,
        details: `Details for ${id}`,
        position: { filePath: 'test.ts', line: 1, side: 'head' },
        status,
        source: 'user',
        createdAt: new Date(),
    });

    setup(() => {
        service = new ReviewSessionService();
    });

    teardown(() => {
        service.dispose();
    });

    test('addIssue and getIssues', () => {
        service.addIssue(createIssue('i1'));
        service.addIssue(createIssue('i2'));

        const issues = service.getIssues();
        assert.strictEqual(issues.length, 2);
    });

    test('getIssuesByStatus', () => {
        service.addIssue(createIssue('i1', 'draft'));
        service.addIssue(createIssue('i2', 'suggested'));
        service.addIssue(createIssue('i3', 'draft'));

        const drafts = service.getIssuesByStatus('draft');
        assert.strictEqual(drafts.length, 2);

        const suggested = service.getIssuesByStatus('suggested');
        assert.strictEqual(suggested.length, 1);
    });

    test('dismissIssue', () => {
        service.addIssue(createIssue('i1', 'suggested'));
        service.dismissIssue('i1');

        const issues = service.getIssues();
        assert.strictEqual(issues[0].status, 'dismissed');
    });

    test('getCurrentPrId is undefined before openReview', () => {
        assert.strictEqual(service.getCurrentPrId(), undefined);
    });

    test('getDiff returns empty before openReview', () => {
        assert.strictEqual(service.getDiff().length, 0);
    });

    test('fires onDidChangeIssues when adding', (done) => {
        service.onDidChangeIssues(() => {
            done();
        });
        service.addIssue(createIssue('i1'));
    });
});
