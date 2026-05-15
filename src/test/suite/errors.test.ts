import * as assert from 'assert';
import { CodepilotReviewError, AuthError, ProviderError, ToolError, AiError, AiNotAvailableError, ConfigError } from '../../errors';

suite('Errors', () => {
    test('CodepilotReviewError has code and userMessage', () => {
        const err = new CodepilotReviewError('internal msg', 'TEST_ERROR', 'User-facing message');
        assert.strictEqual(err.message, 'internal msg');
        assert.strictEqual(err.code, 'TEST_ERROR');
        assert.strictEqual(err.userMessage, 'User-facing message');
        assert.strictEqual(err.name, 'CodepilotReviewError');
    });

    test('AuthError', () => {
        const err = new AuthError('token expired');
        assert.strictEqual(err.code, 'AUTH_ERROR');
        assert.ok(err.userMessage?.includes('Authentication failed'));
    });

    test('ProviderError includes provider name', () => {
        const err = new ProviderError('API 500', 'github');
        assert.strictEqual(err.providerName, 'github');
        assert.ok(err.userMessage?.includes('github'));
    });

    test('ToolError includes tool name', () => {
        const err = new ToolError('parse failed', 'my-linter');
        assert.strictEqual(err.toolName, 'my-linter');
        assert.ok(err.userMessage?.includes('my-linter'));
    });

    test('AiNotAvailableError', () => {
        const err = new AiNotAvailableError();
        assert.strictEqual(err.code, 'AI_NOT_AVAILABLE');
        assert.ok(err.userMessage?.includes('Copilot'));
    });

    test('error cause chaining', () => {
        const original = new Error('network timeout');
        const err = new AiError('request failed', original);
        assert.strictEqual(err.cause, original);
    });
});
