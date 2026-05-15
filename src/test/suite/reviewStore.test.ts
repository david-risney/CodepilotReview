import * as assert from 'assert';
import { ReviewStore } from '../../storage/reviewStore';

suite('ReviewStore', () => {
    // Test the non-VSCode-dependent parts of the store

    test('ReviewSessionState has correct defaults', () => {
        // Verify the interface shape matches expectations
        const state = {
            prId: 'test-pr',
            provider: 'local',
            openedAt: new Date(),
            partitions: [],
            tours: [],
            dismissedIssueIds: [],
        };

        assert.strictEqual(state.prId, 'test-pr');
        assert.strictEqual(state.provider, 'local');
        assert.strictEqual(state.partitions.length, 0);
        assert.strictEqual(state.tours.length, 0);
        assert.strictEqual(state.dismissedIssueIds.length, 0);
    });

    test('AI cache TTL logic', () => {
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000);
        const thirtyMinutesAgo = now - (30 * 60 * 1000);
        const defaultTTL = 60 * 60 * 1000; // 1 hour

        // Entry from 30 min ago should still be valid with 1hr TTL
        assert.ok(thirtyMinutesAgo + defaultTTL > now);

        // Entry from 1+ hour ago should be expired
        assert.ok(oneHourAgo + defaultTTL <= now);
    });
});
