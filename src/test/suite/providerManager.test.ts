import * as assert from 'assert';
import { ProviderManager } from '../../providers/providerManager';
import { ProviderInstance } from '../../providers/provider';
import { ProviderInstanceConfig, ProviderType } from '../../types';

// Minimal mock context for provider initialization
function mockContext(): any {
    return {
        subscriptions: [],
        extensionUri: { fsPath: '/mock' },
        extensionPath: '/mock',
        globalState: {
            get: () => undefined,
            update: () => Promise.resolve(),
            keys: () => [],
            setKeysForSync: () => {},
        },
        workspaceState: {
            get: () => undefined,
            update: () => Promise.resolve(),
            keys: () => [],
        },
        secrets: {
            get: () => Promise.resolve(undefined),
            store: () => Promise.resolve(),
            delete: () => Promise.resolve(),
            onDidChange: () => ({ dispose: () => {} }),
        },
        globalStorageUri: { fsPath: '/mock/globalStorage' },
        storageUri: { fsPath: '/mock/storage' },
        logUri: { fsPath: '/mock/log' },
    };
}

suite('ProviderManager', () => {
    let manager: ProviderManager;

    setup(() => {
        manager = new ProviderManager();
        manager.setContext(mockContext());
    });

    teardown(() => {
        manager.dispose();
    });

    test('starts with no providers', () => {
        assert.strictEqual(manager.getAllProviders().length, 0);
    });

    test('addProvider creates a local provider instance', async () => {
        const config: ProviderInstanceConfig = {
            id: 'test-local',
            label: 'Test Local',
            type: 'local',
            baseBranch: 'main',
        };

        const instance = await manager.addProvider(config);
        assert.strictEqual(instance.id, 'test-local');
        assert.strictEqual(instance.displayName, 'Test Local');
        assert.strictEqual(instance.type, 'local');
        assert.ok(instance.provider);
    });

    test('addProvider creates github provider', async () => {
        const config: ProviderInstanceConfig = {
            id: 'test-gh',
            label: 'Test GitHub',
            type: 'github',
            owner: 'testowner',
            repo: 'testrepo',
        };

        const instance = await manager.addProvider(config);
        assert.strictEqual(instance.id, 'test-gh');
        assert.strictEqual(instance.type, 'github');
    });

    test('addProvider creates ado provider', async () => {
        const config: ProviderInstanceConfig = {
            id: 'test-ado',
            label: 'Test ADO',
            type: 'azureDevOps',
            organization: 'testorg',
            project: 'testproj',
        };

        const instance = await manager.addProvider(config);
        assert.strictEqual(instance.id, 'test-ado');
        assert.strictEqual(instance.type, 'azureDevOps');
    });

    test('addProvider creates chromium provider', async () => {
        const config: ProviderInstanceConfig = {
            id: 'test-cr',
            label: 'Test Chromium',
            type: 'chromium',
            host: 'https://review.example.com',
        };

        const instance = await manager.addProvider(config);
        assert.strictEqual(instance.id, 'test-cr');
        assert.strictEqual(instance.type, 'chromium');
    });

    test('getProvider returns instance by id', async () => {
        await manager.addProvider({ id: 'p1', label: 'P1', type: 'local' });
        const inst = manager.getProvider('p1');
        assert.ok(inst);
        assert.strictEqual(inst!.id, 'p1');
    });

    test('getProvider returns undefined for unknown id', () => {
        assert.strictEqual(manager.getProvider('nonexistent'), undefined);
    });

    test('getAllProviders returns all added providers', async () => {
        await manager.addProvider({ id: 'a', label: 'A', type: 'local' });
        await manager.addProvider({ id: 'b', label: 'B', type: 'local' });
        assert.strictEqual(manager.getAllProviders().length, 2);
    });

    test('removeProvider disposes and removes', async () => {
        await manager.addProvider({ id: 'r1', label: 'R1', type: 'local' });
        assert.strictEqual(manager.getAllProviders().length, 1);
        manager.removeProvider('r1');
        assert.strictEqual(manager.getAllProviders().length, 0);
        assert.strictEqual(manager.getProvider('r1'), undefined);
    });

    test('removeProvider does nothing for unknown id', () => {
        // Should not throw
        manager.removeProvider('unknown');
    });

    test('addProvider replaces existing provider with same id', async () => {
        await manager.addProvider({ id: 'dup', label: 'First', type: 'local' });
        await manager.addProvider({ id: 'dup', label: 'Second', type: 'local' });
        assert.strictEqual(manager.getAllProviders().length, 1);
        assert.strictEqual(manager.getProvider('dup')!.displayName, 'Second');
    });

    test('hasProviderOfType returns true when type exists', async () => {
        await manager.addProvider({ id: 'gh1', label: 'GH', type: 'github' });
        assert.ok(manager.hasProviderOfType('github'));
        assert.ok(!manager.hasProviderOfType('local'));
    });

    test('initializeAll replaces all providers', async () => {
        await manager.addProvider({ id: 'old', label: 'Old', type: 'local' });
        await manager.initializeAll([
            { id: 'new1', label: 'New 1', type: 'local' },
            { id: 'new2', label: 'New 2', type: 'github' },
        ]);
        assert.strictEqual(manager.getAllProviders().length, 2);
        assert.strictEqual(manager.getProvider('old'), undefined);
        assert.ok(manager.getProvider('new1'));
        assert.ok(manager.getProvider('new2'));
    });

    test('disposeAll clears all providers', async () => {
        await manager.addProvider({ id: 'x', label: 'X', type: 'local' });
        await manager.addProvider({ id: 'y', label: 'Y', type: 'local' });
        manager.disposeAll();
        assert.strictEqual(manager.getAllProviders().length, 0);
    });

    test('onDidChangeProviders fires on add via initializeAll', async () => {
        let fired = false;
        manager.onDidChangeProviders(() => { fired = true; });
        await manager.initializeAll([{ id: 'z', label: 'Z', type: 'local' }]);
        assert.ok(fired, 'Expected onDidChangeProviders to fire');
    });

    test('onDidChangeProviders fires on removeProvider', async () => {
        await manager.addProvider({ id: 'rm', label: 'RM', type: 'local' });
        let fired = false;
        manager.onDidChangeProviders(() => { fired = true; });
        manager.removeProvider('rm');
        assert.ok(fired, 'Expected onDidChangeProviders to fire on remove');
    });

    test('addProvider throws when context not set', async () => {
        const noCtxMgr = new ProviderManager();
        try {
            await noCtxMgr.addProvider({ id: 'fail', label: 'Fail', type: 'local' });
            assert.fail('Expected error');
        } catch (e: any) {
            assert.ok(e.message.includes('context'));
        }
        noCtxMgr.dispose();
    });

    test('multiple providers of same type with different ids', async () => {
        await manager.addProvider({ id: 'local-1', label: 'Local 1', type: 'local', baseBranch: 'main' });
        await manager.addProvider({ id: 'local-2', label: 'Local 2', type: 'local', baseBranch: 'develop' });
        assert.strictEqual(manager.getAllProviders().length, 2);
        assert.ok(manager.getProvider('local-1'));
        assert.ok(manager.getProvider('local-2'));
        assert.ok(manager.hasProviderOfType('local'));
    });
});
