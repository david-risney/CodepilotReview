import * as assert from 'assert';
import { StubAiService } from '../../ai/aiService';

suite('AiService', () => {
    let stubService: StubAiService;

    setup(() => {
        stubService = new StubAiService();
    });

    test('stub service reports not available', async () => {
        const available = await stubService.isAvailable();
        assert.strictEqual(available, false);
    });

    test('stub chat returns informative message', async () => {
        const result = await stubService.chat('test', {});
        assert.ok(result.includes('not available'));
    });

    test('stub summarizeDiff returns empty', async () => {
        const result = await stubService.summarizeDiff([]);
        assert.strictEqual(result, '');
    });

    test('stub partitionDiff returns empty array', async () => {
        const result = await stubService.partitionDiff([], 'test');
        assert.strictEqual(result.length, 0);
    });

    test('stub reviewWithPrompt returns empty array', async () => {
        const result = await stubService.reviewWithPrompt('test', []);
        assert.strictEqual(result.length, 0);
    });

    test('stub generateParsePattern returns default pattern', async () => {
        const result = await stubService.generateParsePattern('some example output', 'test command');
        assert.ok(result.pattern.includes('${file}'));
    });

    test('stub explainIssue returns not-available message', async () => {
        const result = await stubService.explainIssue({
            id: 'test',
            summary: 'test issue',
            details: 'details',
            position: { filePath: 'foo.ts', line: 1, side: 'head' },
            status: 'draft',
            source: 'user',
            createdAt: new Date(),
        }, []);
        assert.ok(result.includes('not available'));
    });

    test('stub proposeFix returns not-available message', async () => {
        const result = await stubService.proposeFix({
            id: 'test',
            summary: 'test issue',
            details: 'details',
            position: { filePath: 'foo.ts', line: 1, side: 'head' },
            status: 'draft',
            source: 'user',
            createdAt: new Date(),
        }, []);
        assert.ok(result.includes('not available'));
    });
});
