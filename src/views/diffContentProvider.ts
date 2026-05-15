import * as vscode from 'vscode';
import { ICodeReviewProvider, ProviderInstance } from '../providers/provider';
import { logger } from '../logging/logger';

/**
 * Virtual document content provider for viewing remote file content
 * in read-only mode during code reviews.
 *
 * URI format: codepilot-diff://review/filePath?revision=xxx&prId=yyy&providerId=zzz
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
        const cacheKey = uri.toString();
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey)!;
        }

        const params = new URLSearchParams(uri.query);
        const providerId = params.get('providerId') || '';

        // Resolve the correct provider
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

/**
 * Opens a diff editor showing the before/after of a file in a PR.
 */
export async function openDiffView(
    filePath: string,
    oldRevision: string,
    newRevision: string,
    prId: string,
    providerId?: string,
): Promise<void> {
    const providerParam = providerId ? `&providerId=${encodeURIComponent(providerId)}` : '';
    const leftUri = vscode.Uri.parse(
        `codepilot-diff://review/${filePath}?revision=${encodeURIComponent(oldRevision)}&prId=${encodeURIComponent(prId)}${providerParam}`
    );
    const rightUri = vscode.Uri.parse(
        `codepilot-diff://review/${filePath}?revision=${encodeURIComponent(newRevision)}&prId=${encodeURIComponent(prId)}${providerParam}`
    );

    const title = `${filePath} (${oldRevision.slice(0, 7)}..${newRevision.slice(0, 7)})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
        preview: true,
    });
}
