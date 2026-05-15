import * as assert from 'assert';

suite('Extension', () => {
    // These tests verify extension manifest consistency and
    // can run without VSCode host

    test('package.json commands are all declared', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        const commands: string[] = pkg.contributes.commands.map((c: any) => c.command);

        // Verify all expected commands are registered
        const expectedCommands = [
            'codepilotReview.openReview',
            'codepilotReview.refreshPRs',
            'codepilotReview.selectProvider',
            'codepilotReview.filterPRs',
            'codepilotReview.runReviewTools',
            'codepilotReview.goToIssue',
            'codepilotReview.acceptIssue',
            'codepilotReview.dismissIssue',
            'codepilotReview.challengeIssue',
            'codepilotReview.fixIssue',
            'codepilotReview.publishDraftComments',
            'codepilotReview.partitionByDependency',
            'codepilotReview.partitionByOwnership',
            'codepilotReview.partitionCustom',
            'codepilotReview.startTour',
            'codepilotReview.nextTourStep',
            'codepilotReview.prevTourStep',
            'codepilotReview.suggestReviewers',
            'codepilotReview.openChat',
            'codepilotReview.signIn',
            'codepilotReview.signOut',
            'codepilotReview.openConfig',
            'codepilotReview.viewDiff',
        ];

        for (const cmd of expectedCommands) {
            assert.ok(
                commands.includes(cmd),
                `Expected command ${cmd} to be declared in package.json`
            );
        }
    });

    test('package.json views are all declared', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        const viewIds: string[] = [];
        for (const container of Object.values(pkg.contributes.views)) {
            for (const view of container as any[]) {
                viewIds.push(view.id);
            }
        }

        assert.ok(viewIds.includes('codepilotReview.prList'));
        assert.ok(viewIds.includes('codepilotReview.reviewIssues'));
        assert.ok(viewIds.includes('codepilotReview.partitions'));
    });

    test('package.json has correct engine requirement', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        assert.ok(pkg.engines.vscode.includes('1.90'));
    });

    test('package.json view containers declared', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        const containers = pkg.contributes.viewsContainers.activitybar;
        assert.ok(containers.length > 0);
        assert.strictEqual(containers[0].id, 'codepilotReview');
    });
});
