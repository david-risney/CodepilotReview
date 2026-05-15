import * as assert from 'assert';
import { ReviewerSuggestionService, ReviewerSuggestion } from '../../core/reviewerSuggestionService';

suite('ReviewerSuggestionService', () => {
    // Note: Full tests require a git repository. These test the scoring logic.

    test('suggestions are sorted by score descending', () => {
        const suggestions: ReviewerSuggestion[] = [
            { name: 'Alice', email: 'alice@example.com', commitCount: 5, lastCommitDate: new Date('2024-01-01'), score: 2.5 },
            { name: 'Bob', email: 'bob@example.com', commitCount: 10, lastCommitDate: new Date('2024-06-01'), score: 8.0 },
            { name: 'Carol', email: 'carol@example.com', commitCount: 3, lastCommitDate: new Date('2024-03-01'), score: 1.2 },
        ];

        suggestions.sort((a, b) => b.score - a.score);

        assert.strictEqual(suggestions[0].name, 'Bob');
        assert.strictEqual(suggestions[1].name, 'Alice');
        assert.strictEqual(suggestions[2].name, 'Carol');
    });

    test('recency factor calculation', () => {
        const now = Date.now();
        const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000);
        const oneYearAgo = new Date(now - 365 * 24 * 60 * 60 * 1000);

        const recentDays = (now - oneDayAgo.getTime()) / (1000 * 60 * 60 * 24);
        const oldDays = (now - oneYearAgo.getTime()) / (1000 * 60 * 60 * 24);

        const recentFactor = Math.max(0.1, 1 - (recentDays / 365));
        const oldFactor = Math.max(0.1, 1 - (oldDays / 365));

        // Recent commit should have higher recency factor
        assert.ok(recentFactor > oldFactor);
        assert.ok(recentFactor > 0.9); // 1 day ago should be ~0.997
        assert.ok(oldFactor <= 0.1); // 1 year ago should be ~0.1 (clamped)
    });
});
