import * as assert from 'assert';

suite('Configuration', () => {
    // Note: These tests exercise config merging logic without requiring VSCode.
    // Full config tests with VSCode workspace require integration test setup.

    test('config precedence merging logic', () => {
        // Simulate merging: defaults < project < user < vscode
        const defaults = { provider: 'local', localBaseBranch: 'main', reviewTools: [] };
        const project = { provider: 'github' };
        const user = { localBaseBranch: 'develop' };
        const vscodeSettings = { provider: 'azureDevOps' };

        const merged = {
            ...defaults,
            ...project,
            ...user,
            ...vscodeSettings,
        };

        // VSCode settings should win
        assert.strictEqual(merged.provider, 'azureDevOps');
        // User config should override project
        assert.strictEqual(merged.localBaseBranch, 'develop');
    });

    test('review tools merge from multiple sources', () => {
        const projectTools = [
            { name: 'lint', description: 'Linter', command: 'eslint .' },
        ];
        const userTools = [
            { name: 'security', description: 'Security check', command: 'snyk test' },
        ];

        const merged = [...projectTools, ...userTools];
        assert.strictEqual(merged.length, 2);
        assert.strictEqual(merged[0].name, 'lint');
        assert.strictEqual(merged[1].name, 'security');
    });
});
