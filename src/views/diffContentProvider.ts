import * as vscode from 'vscode';
import { DiffFile, DiffMode, DiffSide } from '../types';
import { ICodeReviewProvider, ProviderInstance } from '../providers/provider';
import { logger } from '../logging/logger';
import * as cp from 'child_process';

/**
 * Virtual document content provider for viewing file content in diff views.
 *
 * Supported URI schemes:
 * - codepilot-diff://review/{filePath}?revision=xxx&prId=yyy&providerId=zzz
 * - codepilot-diff://git/{filePath}?ref=xxx  (git content at a specific ref)
 * - codepilot-empty:///{filePath}  (empty document for added/deleted files)
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private provider: ICodeReviewProvider | undefined;
    private providerLookup: ((id: string) => ProviderInstance | undefined) | undefined;
    private cache = new Map<string, string>();

    /** @deprecated Use setProviderLookup() for multi-provider support */
    setProvider(provider: ICodeReviewProvider): void {
        this.provider = provider;
        this.cache.clear();
    }

    /** Set a function to look up provider instances by ID */
    setProviderLookup(lookup: (id: string) => ProviderInstance | undefined): void {
        this.providerLookup = lookup;
    }

    async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken): Promise<string> {
        // Empty scheme returns empty content
        if (uri.scheme === 'codepilot-empty') {
            return '';
        }

        const cacheKey = uri.toString();
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey)!;
        }

        const params = new URLSearchParams(uri.query);

        // Git content: use git show
        if (uri.authority === 'git') {
            const ref = params.get('ref') || 'HEAD';
            const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
            try {
                const content = await gitShow(ref, filePath);
                this.cache.set(cacheKey, content);
                return content;
            } catch (error) {
                logger.error(`Failed to get git content: ${ref}:${filePath}`, error);
                return `// Error loading git content: ${error instanceof Error ? error.message : String(error)}`;
            }
        }

        // Remote provider content
        const providerId = params.get('providerId') || '';
        const resolvedProvider = providerId && this.providerLookup
            ? this.providerLookup(providerId)?.provider
            : this.provider;

        if (!resolvedProvider?.diff) {
            return '// Provider not available';
        }

        const revision = params.get('revision') || '';
        const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;

        try {
            const content = await resolvedProvider.diff.getFileContent(filePath, revision);
            this.cache.set(cacheKey, content);
            return content;
        } catch (error) {
            logger.error(`Failed to get file content: ${filePath}@${revision}`, error);
            return `// Error loading file: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    clearCache(): void {
        this.cache.clear();
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

/** Get the configured diff mode, with defaults based on provider type */
export function getDiffMode(providerType?: string): DiffMode {
    const config = vscode.workspace.getConfiguration('codepilotReview');
    const userMode = config.get<Partial<DiffMode>>('diffMode') || {};
    const isLocal = providerType === 'local';

    return {
        left: userMode.left || (isLocal ? 'local-branch-base' : 'remote-before'),
        right: userMode.right || (isLocal ? 'local-current' : 'remote-after'),
    };
}

/**
 * Build a URI for one side of a diff based on the DiffSide config.
 */
function buildSideUri(
    side: DiffSide,
    diffFile: DiffFile,
    prId: string,
    providerId: string | undefined,
    mergeBase: string | undefined,
): vscode.Uri {
    const isLeftSide = side === 'remote-before' || side === 'local-branch-base';
    const filePath = isLeftSide
        ? (diffFile.oldPath || diffFile.newPath || '')
        : (diffFile.newPath || diffFile.oldPath || '');

    // For added files on the left side, or deleted files on the right side, return empty
    if (isLeftSide && diffFile.changeType === 'added') {
        return vscode.Uri.from({ scheme: 'codepilot-empty', path: `/${filePath}` });
    }
    if (!isLeftSide && diffFile.changeType === 'deleted') {
        return vscode.Uri.from({ scheme: 'codepilot-empty', path: `/${filePath}` });
    }

    switch (side) {
        case 'remote-before': {
            const query = new URLSearchParams({
                revision: diffFile.oldRevision,
                prId,
                ...(providerId ? { providerId } : {}),
            }).toString();
            return vscode.Uri.from({ scheme: 'codepilot-diff', authority: 'review', path: `/${filePath}`, query });
        }
        case 'remote-after': {
            const query = new URLSearchParams({
                revision: diffFile.newRevision,
                prId,
                ...(providerId ? { providerId } : {}),
            }).toString();
            return vscode.Uri.from({ scheme: 'codepilot-diff', authority: 'review', path: `/${filePath}`, query });
        }
        case 'local-current': {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            if (wsFolder) {
                return vscode.Uri.joinPath(wsFolder.uri, filePath);
            }
            return vscode.Uri.file(filePath);
        }
        case 'local-branch-base': {
            const ref = mergeBase || 'HEAD';
            const query = new URLSearchParams({ ref }).toString();
            return vscode.Uri.from({ scheme: 'codepilot-diff', authority: 'git', path: `/${filePath}`, query });
        }
    }
}

/**
 * Opens a diff editor for a file using the configured diff mode.
 */
export async function openFileDiff(
    diffFile: DiffFile,
    prId: string,
    options?: {
        providerId?: string;
        providerType?: string;
        mergeBase?: string;
        preview?: boolean;
    },
): Promise<void> {
    const mode = getDiffMode(options?.providerType);
    const filePath = diffFile.newPath || diffFile.oldPath || '';

    const leftUri = buildSideUri(mode.left, diffFile, prId, options?.providerId, options?.mergeBase);
    const rightUri = buildSideUri(mode.right, diffFile, prId, options?.providerId, options?.mergeBase);

    const leftLabel = sideLabel(mode.left);
    const rightLabel = sideLabel(mode.right);
    const title = `${filePath} (${leftLabel} ↔ ${rightLabel})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
        preview: options?.preview ?? true,
    });
}

/** Legacy openDiffView for backward compatibility */
export async function openDiffView(
    filePath: string,
    oldRevision: string,
    newRevision: string,
    prId: string,
    providerId?: string,
): Promise<void> {
    const diffFile: DiffFile = {
        oldPath: filePath,
        newPath: filePath,
        oldRevision,
        newRevision,
        changeType: 'modified',
        isBinary: false,
        hunks: [],
    };
    await openFileDiff(diffFile, prId, { providerId });
}

function sideLabel(side: DiffSide): string {
    switch (side) {
        case 'remote-before': return 'before';
        case 'remote-after': return 'after';
        case 'local-current': return 'local';
        case 'local-branch-base': return 'base';
    }
}

/** Run git show to get file content at a specific ref */
async function gitShow(ref: string, filePath: string): Promise<string> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder) { throw new Error('No workspace folder'); }

    return new Promise((resolve, reject) => {
        const args = ['show', `${ref}:${filePath}`];
        const proc = cp.execFile('git', args, { cwd: wsFolder, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(err);
            } else {
                resolve(stdout);
            }
        });
        proc.stdin?.end();
    });
}

/** Get the merge-base commit for the current branch against a target branch */
export async function getMergeBase(targetBranch?: string): Promise<string | undefined> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder) { return undefined; }

    const target = targetBranch || 'main';

    return new Promise((resolve) => {
        cp.execFile('git', ['merge-base', 'HEAD', target], { cwd: wsFolder }, (err, stdout) => {
            if (err) {
                // Try 'master' if 'main' fails
                if (target === 'main') {
                    cp.execFile('git', ['merge-base', 'HEAD', 'master'], { cwd: wsFolder }, (err2, stdout2) => {
                        resolve(err2 ? undefined : stdout2.trim());
                    });
                } else {
                    resolve(undefined);
                }
            } else {
                resolve(stdout.trim());
            }
        });
    });
}
