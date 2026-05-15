import * as assert from 'assert';
import { ReviewSessionService } from '../../core/reviewSessionService';
import { ReviewIssue } from '../../types';

function makeIssue(id: string, status: ReviewIssue['status'] = 'suggested'): ReviewIssue {
    return {
        id,
        summary: `Issue ${id}`,
        details: 'test details',
        position: { filePath: 'test.ts', line: 10, side: 'head' },
        status,
        source: 'tool',
        createdAt: new Date(),
    };
}

suite('ReviewSessionService', () => {
    let service: ReviewSessionService;

    setup(() => {
        service = new ReviewSessionService();
    });

    test('addIssue adds to issues list', () => {
        const issue = makeIssue('i1');
        service.addIssue(issue);
        const issues = service.getIssues();
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].id, 'i1');
    });

    test('getIssuesByStatus filters correctly', () => {
        service.addIssue(makeIssue('s1', 'suggested'));
        service.addIssue(makeIssue('d1', 'draft'));
        service.addIssue(makeIssue('s2', 'suggested'));

        const suggested = service.getIssuesByStatus('suggested');
        assert.strictEqual(suggested.length, 2);

        const drafts = service.getIssuesByStatus('draft');
        assert.strictEqual(drafts.length, 1);
        assert.strictEqual(drafts[0].id, 'd1');
    });

    test('acceptIssue promotes suggested to draft', () => {
        service.addIssue(makeIssue('a1', 'suggested'));
        service.acceptIssue('a1');

        const issue = service.getIssues().find(i => i.id === 'a1');
        assert.strictEqual(issue?.status, 'draft');
    });

    test('acceptIssue does nothing for non-suggested issues', () => {
        service.addIssue(makeIssue('d1', 'draft'));
        service.acceptIssue('d1');

        const issue = service.getIssues().find(i => i.id === 'd1');
        assert.strictEqual(issue?.status, 'draft'); // unchanged
    });

    test('acceptIssue does nothing for missing issues', () => {
        // Should not throw
        service.acceptIssue('nonexistent');
        assert.strictEqual(service.getIssues().length, 0);
    });

    test('updateIssueStatus changes status', async () => {
        service.addIssue(makeIssue('u1', 'draft'));
        await service.updateIssueStatus('u1', 'dismissed');

        const issue = service.getIssues().find(i => i.id === 'u1');
        assert.strictEqual(issue?.status, 'dismissed');
    });

    test('getCurrentPrId returns undefined before openReview', () => {
        assert.strictEqual(service.getCurrentPrId(), undefined);
    });

    test('onDidChangeIssues fires when issue is added', () => {
        let fired = false;
        service.onDidChangeIssues(() => { fired = true; });
        service.addIssue(makeIssue('f1'));
        assert.strictEqual(fired, true);
    });

    test('onDidChangeIssues fires when issue is accepted', () => {
        service.addIssue(makeIssue('f2', 'suggested'));
        let fired = false;
        service.onDidChangeIssues(() => { fired = true; });
        service.acceptIssue('f2');
        assert.strictEqual(fired, true);
    });
});
