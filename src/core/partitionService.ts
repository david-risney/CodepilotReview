import * as vscode from 'vscode';
import { DiffFile, Partition, PartitionChunk, PartitionType, PartitionScheme } from '../types';
import { IAiService, PartitionSuggestion } from '../ai/aiService';
import { ReviewStore } from '../storage/reviewStore';
import { logger } from '../logging/logger';

/**
 * Service for partitioning code changes into logical chunks.
 * Manages partition schemes (default, dependencies, custom).
 */
export class PartitionService {
    private _onDidChangePartitions = new vscode.EventEmitter<void>();
    readonly onDidChangePartitions = this._onDidChangePartitions.event;

    private schemes: PartitionScheme[] = [];
    private currentPrId: string | undefined;
    private currentDiff: DiffFile[] = [];
    private _activeSchemeId: string = 'default';

    constructor(
        private aiService: IAiService,
        private store: ReviewStore,
    ) {}

    /** Get all current schemes */
    getSchemes(): PartitionScheme[] {
        return this.schemes;
    }

    /** Get the active scheme */
    getActiveScheme(): PartitionScheme | undefined {
        return this.schemes.find(s => s.id === this._activeSchemeId);
    }

    /** Get the active scheme ID */
    getActiveSchemeId(): string {
        return this._activeSchemeId;
    }

    /** Set the active scheme */
    setActiveScheme(schemeId: string): void {
        this._activeSchemeId = schemeId;
        this._onDidChangePartitions.fire();
    }

    /** Clear all schemes (e.g. when no PR is selected) */
    clear(): void {
        this.schemes = [];
        this.currentPrId = undefined;
        this.currentDiff = [];
        this._activeSchemeId = 'default';
        this._onDidChangePartitions.fire();
    }

    /** Set up schemes for a new PR review. Creates default + dependencies schemes. */
    async initForReview(prId: string, diff: DiffFile[]): Promise<void> {
        this.currentPrId = prId;
        this.currentDiff = diff;

        // Build default scheme immediately (no AI needed)
        const defaultScheme: PartitionScheme = {
            id: 'default',
            label: 'Default',
            type: 'default',
            partitions: [this.createDefaultPartition(diff)],
            isLoaded: true,
        };

        // Dependencies scheme — lazy loaded
        const depsScheme: PartitionScheme = {
            id: 'dependencies',
            label: 'Dependencies',
            type: 'dependencies',
            partitions: [],
            isLoaded: false,
        };

        // Restore any saved custom schemes
        const savedSchemes = this.store.loadCustomSchemes(prId);

        this.schemes = [defaultScheme, depsScheme, ...savedSchemes];
        this._onDidChangePartitions.fire();

        // Auto-generate dependencies in background
        this.generateDependencies(prId, diff).catch(err => {
            logger.warn('Auto-dependency partitioning failed', err);
        });
    }

    /** Create a simple partition containing all files */
    private createDefaultPartition(diff: DiffFile[]): Partition {
        return {
            id: 'default-all',
            name: 'All Changes',
            description: `${diff.length} changed file(s)`,
            chunks: diff.map(f => ({ filePath: f.newPath || f.oldPath || '' })),
            dependsOn: [],
        };
    }

    /** Generate dependency partitions (async, updates scheme when done) */
    private async generateDependencies(prId: string, diff: DiffFile[]): Promise<void> {
        const scheme = this.schemes.find(s => s.id === 'dependencies');
        if (!scheme) { return; }

        try {
            const partitions = await this.partitionByDependency(prId, diff);
            scheme.partitions = partitions;
            scheme.isLoaded = true;
            this._onDidChangePartitions.fire();
        } catch (err) {
            scheme.partitions = [this.createDefaultPartition(diff)];
            scheme.isLoaded = true;
            this._onDidChangePartitions.fire();
            throw err;
        }
    }

    /** Add a custom partition scheme with a user prompt */
    async addCustomScheme(label: string, prompt: string): Promise<PartitionScheme> {
        if (!this.currentPrId || this.currentDiff.length === 0) {
            throw new Error('No review is open');
        }

        const id = `custom-${Date.now()}`;
        const scheme: PartitionScheme = {
            id,
            label,
            type: 'custom',
            prompt,
            partitions: [],
            isLoaded: false,
        };

        this.schemes.push(scheme);
        this._onDidChangePartitions.fire();

        // Generate partitions
        try {
            const partitions = await this.partitionCustom(
                this.currentPrId, this.currentDiff, prompt
            );
            scheme.partitions = partitions;
            scheme.isLoaded = true;

            // Save custom schemes
            this.store.saveCustomSchemes(this.currentPrId, this.getCustomSchemes());
            this._onDidChangePartitions.fire();
        } catch (err) {
            scheme.isLoaded = true;
            this._onDidChangePartitions.fire();
            throw err;
        }

        return scheme;
    }

    /** Remove a custom scheme */
    removeScheme(schemeId: string): void {
        const idx = this.schemes.findIndex(s => s.id === schemeId);
        if (idx >= 0 && this.schemes[idx].type === 'custom') {
            this.schemes.splice(idx, 1);
            if (this.currentPrId) {
                this.store.saveCustomSchemes(this.currentPrId, this.getCustomSchemes());
            }
            this._onDidChangePartitions.fire();
        }
    }

    /** Regenerate partitions for a scheme */
    async regenerateScheme(schemeId: string): Promise<void> {
        if (!this.currentPrId || this.currentDiff.length === 0) { return; }

        const scheme = this.schemes.find(s => s.id === schemeId);
        if (!scheme) { return; }

        scheme.isLoaded = false;
        this._onDidChangePartitions.fire();

        if (scheme.type === 'default') {
            scheme.partitions = [this.createDefaultPartition(this.currentDiff)];
            scheme.isLoaded = true;
        } else if (scheme.type === 'dependencies') {
            await this.generateDependencies(this.currentPrId, this.currentDiff);
        } else if (scheme.type === 'custom' && scheme.prompt) {
            const partitions = await this.partitionCustom(
                this.currentPrId, this.currentDiff, scheme.prompt
            );
            scheme.partitions = partitions;
            scheme.isLoaded = true;
        }

        this._onDidChangePartitions.fire();
    }

    private getCustomSchemes(): PartitionScheme[] {
        return this.schemes.filter(s => s.type === 'custom');
    }

    /** Partition a diff by dependency relationships */
    async partitionByDependency(
        prId: string, diff: DiffFile[], token?: vscode.CancellationToken
    ): Promise<Partition[]> {
        const criteria = 'Group changed files into logically related chunks based on dependency relationships. ' +
            'For example, data model changes, API changes, UI changes, test changes. ' +
            'Aim for chunks of 20–100 lines of changed code each; up to 400 lines per chunk is acceptable for closely related changes. ' +
            'Avoid very small chunks (under 20 lines) — prefer merging related small changes into one chunk rather than creating many tiny partitions. ' +
            'Order chunks so that foundational changes come first.';

        return this.partitionWithAi(prId, diff, 'dependency', criteria, token);
    }

    /** Partition a diff by ownership */
    async partitionByOwnership(
        prId: string, diff: DiffFile[], workspaceRoot: string, token?: vscode.CancellationToken
    ): Promise<Partition[]> {
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
