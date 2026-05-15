import * as assert from 'assert';

/**
 * Tests for custom tool parse pattern logic.
 * Replicates patternToRegex from CustomCommandTool for unit testing.
 */

function patternToRegex(pattern: string): RegExp {
    let regexStr = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\$\\\{file\\\}/g, '(?<file>[^:]+)')
        .replace(/\\\$\\\{line\\\}/g, '(?<line>\\d+)')
        .replace(/\\\$\\\{column\\\}/g, '(?<column>\\d+)')
        .replace(/\\\$\\\{message\\\}/g, '(?<message>.+)')
        .replace(/\\\$\\\{severity\\\}/g, '(?<severity>\\w+)');
    return new RegExp(regexStr);
}

function parseWithPattern(output: string, pattern: string): Array<{
    file: string; line: number; message: string;
}> {
    const regex = patternToRegex(pattern);
    const results: Array<{ file: string; line: number; message: string }> = [];

    for (const line of output.split('\n')) {
        const match = line.match(regex);
        if (match && match.groups) {
            results.push({
                file: match.groups['file'] || 'unknown',
                line: parseInt(match.groups['line'] || '1'),
                message: match.groups['message'] || line.trim(),
            });
        }
    }

    return results;
}

suite('CustomTools - Pattern Parsing', () => {
    test('parse eslint-style output: file:line:col: message', () => {
        const pattern = '${file}:${line}:${column}: ${message}';
        const output = 'src/app.ts:42:10: Missing semicolon\nsrc/util.ts:7:1: Unused variable';

        const results = parseWithPattern(output, pattern);
        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].file, 'src/app.ts');
        assert.strictEqual(results[0].line, 42);
        assert.strictEqual(results[0].message, 'Missing semicolon');
        assert.strictEqual(results[1].file, 'src/util.ts');
        assert.strictEqual(results[1].line, 7);
    });

    test('parse gcc-style output: file:line: severity: message', () => {
        const pattern = '${file}:${line}: ${severity}: ${message}';
        const output = 'main.c:15: error: expected semicolon\nmain.c:20: warning: unused variable';

        const results = parseWithPattern(output, pattern);
        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].file, 'main.c');
        assert.strictEqual(results[0].line, 15);
    });

    test('no matches returns empty', () => {
        const pattern = '${file}:${line}: ${message}';
        const output = 'all good, no issues found';

        const results = parseWithPattern(output, pattern);
        assert.strictEqual(results.length, 0);
    });

    test('handles empty output', () => {
        const pattern = '${file}:${line}: ${message}';
        const results = parseWithPattern('', pattern);
        assert.strictEqual(results.length, 0);
    });

    test('handles pattern with only file and line', () => {
        const pattern = '${file}:${line}';
        const output = 'test.js:99';

        const results = parseWithPattern(output, pattern);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].file, 'test.js');
        assert.strictEqual(results[0].line, 99);
    });

    test('skips non-matching lines in mixed output', () => {
        const pattern = '${file}:${line}: ${message}';
        const output = [
            'Running linter...',
            'src/foo.ts:10: bad code',
            'Done.',
            'src/bar.ts:20: also bad',
        ].join('\n');

        const results = parseWithPattern(output, pattern);
        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].file, 'src/foo.ts');
        assert.strictEqual(results[1].file, 'src/bar.ts');
    });

    test('handles file paths with slashes', () => {
        const pattern = '${file}:${line}: ${message}';
        const output = 'src/deep/nested/file.ts:5: issue here';

        const results = parseWithPattern(output, pattern);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].file, 'src/deep/nested/file.ts');
    });
});

suite('CustomTools - Variable Expansion', () => {
    function expandVariables(command: string, vars: Record<string, string>): string {
        return command
            .replace(/\$\{workspaceRoot\}/g, vars['workspaceRoot'] || '')
            .replace(/\$\{pullRequestId\}/g, vars['pullRequestId'] || '');
    }

    test('expands workspaceRoot', () => {
        const result = expandVariables('lint ${workspaceRoot}/src', { workspaceRoot: '/home/user/proj' });
        assert.strictEqual(result, 'lint /home/user/proj/src');
    });

    test('expands pullRequestId', () => {
        const result = expandVariables('tool --pr=${pullRequestId}', { pullRequestId: '42' });
        assert.strictEqual(result, 'tool --pr=42');
    });

    test('expands multiple variables', () => {
        const result = expandVariables('${workspaceRoot}/run --pr ${pullRequestId}', {
            workspaceRoot: '/app', pullRequestId: '99',
        });
        assert.strictEqual(result, '/app/run --pr 99');
    });

    test('leaves unknown variables unchanged', () => {
        const result = expandVariables('${unknown} ${workspaceRoot}', { workspaceRoot: '/app' });
        assert.strictEqual(result, '${unknown} /app');
    });
});
