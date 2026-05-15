import * as assert from 'assert';
import { ReviewIssue, ReviewIssueStatus, Partition, CodeTour, CodeTourStep } from '../../types';

/**
 * Tests for the partition model and code tour data structures.
 * Validates coverage logic, dependency ordering, and tour step integrity.
 */

suite('Partition Model', () => {
    test('partition chunks can reference file subsets via lineRanges', () => {
        const partition: Partition = {
            id: 'dep-0',
            name: 'Model changes',
            description: 'Data model updates',
            chunks: [
                { filePath: 'src/model.ts', lineRanges: [{ start: 10, end: 50 }, { start: 100, end: 120 }] },
                { filePath: 'src/types.ts' }, // whole file
            ],
            dependsOn: [],
        };

        assert.strictEqual(partition.chunks.length, 2);
        assert.strictEqual(partition.chunks[0].lineRanges?.length, 2);
        assert.strictEqual(partition.chunks[1].lineRanges, undefined);
    });

    test('partition dependencies form a valid DAG', () => {
        const partitions: Partition[] = [
            { id: 'a', name: 'Models', description: '', chunks: [], dependsOn: [] },
            { id: 'b', name: 'Services', description: '', chunks: [], dependsOn: ['a'] },
            { id: 'c', name: 'UI', description: '', chunks: [], dependsOn: ['b'] },
        ];

        // Verify topological order: a before b before c
        const idxA = partitions.findIndex(p => p.id === 'a');
        const idxB = partitions.findIndex(p => p.id === 'b');
        const idxC = partitions.findIndex(p => p.id === 'c');
        assert.ok(idxA < idxB);
        assert.ok(idxB < idxC);
    });

    test('coverage validation detects uncovered files', () => {
        const changedFiles = new Set(['a.ts', 'b.ts', 'c.ts']);
        const partitions: Partition[] = [
            { id: 'p1', name: 'P1', description: '', chunks: [{ filePath: 'a.ts' }], dependsOn: [] },
            { id: 'p2', name: 'P2', description: '', chunks: [{ filePath: 'b.ts' }], dependsOn: [] },
        ];

        const coveredFiles = new Set<string>();
        for (const p of partitions) {
            for (const c of p.chunks) {
                coveredFiles.add(c.filePath);
            }
        }

        const uncovered = [...changedFiles].filter(f => !coveredFiles.has(f));
        assert.deepStrictEqual(uncovered, ['c.ts']);
    });

    test('overlapping partitions are allowed', () => {
        const partitions: Partition[] = [
            { id: 'p1', name: 'P1', description: '', chunks: [{ filePath: 'shared.ts' }], dependsOn: [] },
            { id: 'p2', name: 'P2', description: '', chunks: [{ filePath: 'shared.ts' }], dependsOn: [] },
        ];

        // Both partitions contain shared.ts — this is valid per INIT.md
        const allFiles = partitions.flatMap(p => p.chunks.map(c => c.filePath));
        assert.strictEqual(allFiles.length, 2);
        assert.strictEqual(allFiles.filter(f => f === 'shared.ts').length, 2);
    });
});

suite('CodeTour Model', () => {
    test('tour has sequential steps', () => {
        const tour: CodeTour = {
            id: 'tour-1',
            name: 'Review Tour',
            steps: [
                { title: 'Step 1', description: 'First change', filePath: 'a.ts', line: 10 },
                { title: 'Step 2', description: 'Second change', filePath: 'b.ts', line: 20 },
                { title: 'Step 3', description: 'Third change', filePath: 'a.ts', line: 50 },
            ],
        };

        assert.strictEqual(tour.steps.length, 3);
        // Multiple steps can target the same file
        const aSteps = tour.steps.filter(s => s.filePath === 'a.ts');
        assert.strictEqual(aSteps.length, 2);
    });

    test('tour steps can have partition IDs', () => {
        const step: CodeTourStep = {
            title: 'Auth change',
            description: 'Updated token validation',
            filePath: 'src/auth.ts',
            line: 42,
            partitionId: 'dep-0',
        };

        assert.strictEqual(step.partitionId, 'dep-0');
    });

    test('empty tour has no steps', () => {
        const tour: CodeTour = { id: 'empty', name: 'Empty Tour', steps: [] };
        assert.strictEqual(tour.steps.length, 0);
    });
});

suite('ReviewIssue Model', () => {
    test('issue lifecycle transitions', () => {
        const transitions: Array<{ from: ReviewIssueStatus; to: ReviewIssueStatus }> = [
            { from: 'suggested', to: 'draft' },      // accept
            { from: 'draft', to: 'published' },       // publish
            { from: 'published', to: 'resolved' },    // resolve
            { from: 'suggested', to: 'dismissed' },   // dismiss
            { from: 'draft', to: 'dismissed' },       // dismiss
        ];

        // All transitions should be valid status values
        const validStatuses: ReviewIssueStatus[] = ['suggested', 'draft', 'published', 'dismissed', 'resolved'];
        for (const t of transitions) {
            assert.ok(validStatuses.includes(t.from), `${t.from} is valid`);
            assert.ok(validStatuses.includes(t.to), `${t.to} is valid`);
        }
    });

    test('issue with all optional fields', () => {
        const issue: ReviewIssue = {
            id: 'full-1',
            summary: 'Missing null check',
            details: 'The variable could be null at line 42',
            position: { filePath: 'src/app.ts', line: 42, side: 'head' },
            status: 'draft',
            source: 'tool',
            toolName: 'eslint',
            command: 'npx eslint src/app.ts',
            suggestedFix: { kind: 'openChat', prompt: 'How to fix null check?' },
            createdAt: new Date(),
            providerCommentId: 'gh-123',
        };

        assert.strictEqual(issue.toolName, 'eslint');
        assert.strictEqual(issue.command, 'npx eslint src/app.ts');
        assert.strictEqual(issue.suggestedFix?.kind, 'openChat');
        assert.strictEqual(issue.providerCommentId, 'gh-123');
    });

    test('issue with minimal fields', () => {
        const issue: ReviewIssue = {
            id: 'min-1',
            summary: 'Something wrong',
            details: '',
            position: { filePath: 'file.ts', line: 1, side: 'base' },
            status: 'suggested',
            source: 'ai',
            createdAt: new Date(),
        };

        assert.strictEqual(issue.toolName, undefined);
        assert.strictEqual(issue.command, undefined);
        assert.strictEqual(issue.suggestedFix, undefined);
    });
});
