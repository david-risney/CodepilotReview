import * as assert from 'assert';

// Test the diff parsing logic from local provider.
// We can't import LocalProvider directly because it depends on vscode module,
// so we replicate the pure parsing logic here for testability.

function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string } | null {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (!match) { return null; }
    return {
        oldStart: parseInt(match[1]),
        oldLines: parseInt(match[2] || '1'),
        newStart: parseInt(match[3]),
        newLines: parseInt(match[4] || '1'),
        header: match[5]?.trim() || '',
    };
}

function detectChangeType(chunk: string): string {
    if (chunk.includes('new file')) { return 'added'; }
    if (chunk.includes('deleted file')) { return 'deleted'; }
    if (chunk.includes('rename from')) { return 'renamed'; }
    return 'modified';
}

suite('Diff Parsing', () => {
    test('parse hunk header with both ranges', () => {
        const result = parseHunkHeader('@@ -10,5 +20,8 @@ function foo()');
        assert.ok(result);
        assert.strictEqual(result!.oldStart, 10);
        assert.strictEqual(result!.oldLines, 5);
        assert.strictEqual(result!.newStart, 20);
        assert.strictEqual(result!.newLines, 8);
        assert.strictEqual(result!.header, 'function foo()');
    });

    test('parse hunk header with single-line ranges', () => {
        const result = parseHunkHeader('@@ -1 +1 @@');
        assert.ok(result);
        assert.strictEqual(result!.oldStart, 1);
        assert.strictEqual(result!.oldLines, 1);
        assert.strictEqual(result!.newStart, 1);
        assert.strictEqual(result!.newLines, 1);
    });

    test('parse hunk header with no match', () => {
        const result = parseHunkHeader('not a hunk header');
        assert.strictEqual(result, null);
    });

    test('detect added file', () => {
        assert.strictEqual(detectChangeType('new file mode 100644'), 'added');
    });

    test('detect deleted file', () => {
        assert.strictEqual(detectChangeType('deleted file mode 100644'), 'deleted');
    });

    test('detect renamed file', () => {
        assert.strictEqual(detectChangeType('rename from old.ts\nrename to new.ts'), 'renamed');
    });

    test('detect modified file', () => {
        assert.strictEqual(detectChangeType('index abc..def 100644'), 'modified');
    });

    test('parse hunk header with large line numbers', () => {
        const result = parseHunkHeader('@@ -1234,100 +5678,200 @@ class MyClass');
        assert.ok(result);
        assert.strictEqual(result!.oldStart, 1234);
        assert.strictEqual(result!.oldLines, 100);
        assert.strictEqual(result!.newStart, 5678);
        assert.strictEqual(result!.newLines, 200);
    });
});
