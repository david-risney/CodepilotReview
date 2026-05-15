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
});
