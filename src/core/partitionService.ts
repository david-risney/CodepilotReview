import * as vscode from 'vscode';
import { DiffFile, Partition, PartitionChunk, PartitionType } from '../types';
import { IAiService, PartitionSuggestion } from '../ai/aiService';
import { ReviewStore } from '../storage/reviewStore';
import { logger } from '../logging/logger';

/**
 * Service for partitioning code changes into logical chunks.
 * Supports dependency, ownership, and custom partitioning via AI.
 */
export class PartitionService {
    private _onDidChangePartitions = new vscode.EventEmitter<void>();
    readonly onDidChangePartitions = this._onDidChangePartitions.event;

    constructor(
        private aiService: IAiService,
        private store: ReviewStore,
    ) {}

    /** Partition a diff by dependency relationships */
    async partitionByDependency(
        prId: string, diff: DiffFile[], token?: vscode.CancellationToken
    ): Promise<Partition[]> {
        const criteria = 'Group changed files into logically related chunks based on dependency relationships. ' +
            'For example, data model changes, API changes, UI changes, test changes. ' +
            'Order chunks so that foundational changes come first.';

        return this.partitionWithAi(prId, diff, 'dependency', criteria, token);
    }

    /** Partition a diff by ownership */
    async partitionByOwnership(
        prId: string, diff: DiffFile[], workspaceRoot: string, token?: vscode.CancellationToken
    ): Promise<Partition[]> {
        // Try to use CODEOWNERS if available
        let ownershipContext = '';
        try {
            const codeownersUri = vscode.Uri.file(`${workspaceRoot}/CODEOWNERS`);
            const altUri = vscode.Uri.file(`${workspaceRoot}/.github/CODEOWNERS`);

            let codeowners = '';
            try {
                const doc = await vscode.workspace.openTextDocument(codeownersUri);
                codeowners = doc.getText();
            } catch {
                try {
                    const doc = await vscode.workspace.openTextDocument(altUri);
                    codeowners = doc.getText();
                } catch {
                    // No CODEOWNERS file
                }
            }

            if (codeowners) {
                ownershipContext = `\n\nCODEOWNERS file:\n${codeowners}`;
            }
        } catch {
            // Ignore CODEOWNERS errors
        }

        const criteria = 'Partition the code change into two groups: ' +
            '(1) files/regions that the current reviewer owns and is required to review, and ' +
            '(2) files/regions owned by others.' + ownershipContext;

        return this.partitionWithAi(prId, diff, 'ownership', criteria, token);
    }

    /** Partition a diff by user-defined criteria */
    async partitionCustom(
        prId: string, diff: DiffFile[], criteria: string, token?: vscode.CancellationToken
    ): Promise<Partition[]> {
        return this.partitionWithAi(prId, diff, 'custom', criteria, token);
    }

    /** Load cached partitions for a PR */
    loadPartitions(prId: string): Partition[] {
        return this.store.loadPartitions(prId);
    }

    private async partitionWithAi(
        prId: string,
        diff: DiffFile[],
        type: PartitionType,
        criteria: string,
        token?: vscode.CancellationToken
    ): Promise<Partition[]> {
        logger.info(`Partitioning PR ${prId} by ${type}`);

        const suggestions = await this.aiService.partitionDiff(diff, criteria, token);
        const partitions = this.suggestionsToPartitions(suggestions, type);

        // Validate all files are covered
        const changedFiles = new Set(diff.map(f => f.newPath || f.oldPath || ''));
        const coveredFiles = new Set<string>();
        for (const p of partitions) {
            for (const c of p.chunks) {
                coveredFiles.add(c.filePath);
            }
        }

        const uncovered = [...changedFiles].filter(f => f && !coveredFiles.has(f));
        if (uncovered.length > 0) {
            // Add uncovered files to an "Other" partition
            partitions.push({
                id: `${type}-other`,
                name: 'Other Changes',
                description: 'Files not covered by other partitions',
                chunks: uncovered.map(f => ({ filePath: f })),
                dependsOn: [],
            });
        }

        // Persist
        await this.store.savePartitions(prId, partitions);
        this._onDidChangePartitions.fire();

        return partitions;
    }

    private suggestionsToPartitions(suggestions: PartitionSuggestion[], type: PartitionType): Partition[] {
        return suggestions.map((s, i) => ({
            id: `${type}-${i}`,
            name: s.name,
            description: s.description,
            chunks: s.files.map(f => ({
                filePath: f.path,
                lineRanges: f.lineRanges,
            })),
            dependsOn: s.dependsOn,
        }));
    }

    dispose(): void {
        this._onDidChangePartitions.dispose();
    }
}
