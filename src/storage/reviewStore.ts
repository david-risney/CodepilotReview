import * as vscode from 'vscode';
import { ReviewIssue, Partition, CodeTour } from '../types';
import { logger } from '../logging/logger';

/** Tracks the state of a review session across reloads */
export interface ReviewSessionState {
    prId: string;
    providerName: string;
    openedAt: string;
    /** IDs of dismissed issues */
    dismissedIssueIds: string[];
    /** Active partition type */
    activePartitionType?: string;
    /** Current code tour step index */
    tourStepIndex?: number;
    /** Active tour ID */
    activeTourId?: string;
}

/**
 * Stores review session data persistently using VSCode workspace/global storage.
 * Allows draft issues, dismissed issues, partitions, tours, and review sessions
 * to survive reloads.
 */
export class ReviewStore {
    private context: vscode.ExtensionContext | undefined;

    initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    // --- Issues ---

    async saveIssues(prId: string, issues: ReviewIssue[]): Promise<void> {
        if (!this.context) { return; }
        await this.context.workspaceState.update(`issues:${prId}`, issues);
    }

    loadIssues(prId: string): ReviewIssue[] {
        if (!this.context) { return []; }
        return this.context.workspaceState.get<ReviewIssue[]>(`issues:${prId}`, []);
    }

    // --- Review Sessions ---

    async saveSessionState(prId: string, state: ReviewSessionState): Promise<void> {
        if (!this.context) { return; }
        await this.context.workspaceState.update(`session:${prId}`, state);
    }

    loadSessionState(prId: string): ReviewSessionState | undefined {
        if (!this.context) { return undefined; }
        return this.context.workspaceState.get<ReviewSessionState>(`session:${prId}`);
    }

    /** Get all known session PR IDs */
    getReviewedPrIds(): string[] {
        if (!this.context) { return []; }
        return this.context.workspaceState.get<string[]>('reviewedPrIds', []);
    }

    async addReviewedPrId(prId: string): Promise<void> {
        if (!this.context) { return; }
        const ids = this.getReviewedPrIds();
        if (!ids.includes(prId)) {
            ids.push(prId);
            await this.context.workspaceState.update('reviewedPrIds', ids);
        }
    }

    // --- Partitions ---

    async savePartitions(prId: string, partitions: Partition[]): Promise<void> {
        if (!this.context) { return; }
        await this.context.workspaceState.update(`partitions:${prId}`, partitions);
    }

    loadPartitions(prId: string): Partition[] {
        if (!this.context) { return []; }
        return this.context.workspaceState.get<Partition[]>(`partitions:${prId}`, []);
    }

    // --- Code Tours ---

    async saveTour(prId: string, tour: CodeTour): Promise<void> {
        if (!this.context) { return; }
        const tours = this.loadTours(prId);
        const idx = tours.findIndex(t => t.id === tour.id);
        if (idx >= 0) {
            tours[idx] = tour;
        } else {
            tours.push(tour);
        }
        await this.context.workspaceState.update(`tours:${prId}`, tours);
    }

    loadTours(prId: string): CodeTour[] {
        if (!this.context) { return []; }
        return this.context.workspaceState.get<CodeTour[]>(`tours:${prId}`, []);
    }

    // --- AI Cache ---

    async cacheAiResult(key: string, value: string): Promise<void> {
        if (!this.context) { return; }
        await this.context.workspaceState.update(`aiCache:${key}`, {
            value,
            timestamp: Date.now(),
        });
    }

    loadCachedAiResult(key: string, maxAgeMs: number = 30 * 60 * 1000): string | undefined {
        if (!this.context) { return undefined; }
        const cached = this.context.workspaceState.get<{ value: string; timestamp: number }>(`aiCache:${key}`);
        if (!cached) { return undefined; }
        if (Date.now() - cached.timestamp > maxAgeMs) { return undefined; }
        return cached.value;
    }

    // --- Global Storage ---

    async saveGlobal<T>(key: string, value: T): Promise<void> {
        if (!this.context) { return; }
        await this.context.globalState.update(`codepilotReview:${key}`, value);
    }

    loadGlobal<T>(key: string, defaultValue: T): T {
        if (!this.context) { return defaultValue; }
        return this.context.globalState.get<T>(`codepilotReview:${key}`, defaultValue);
    }

    // --- Cleanup ---

    async clearPr(prId: string): Promise<void> {
        if (!this.context) { return; }
        await this.context.workspaceState.update(`issues:${prId}`, undefined);
        await this.context.workspaceState.update(`session:${prId}`, undefined);
        await this.context.workspaceState.update(`partitions:${prId}`, undefined);
        await this.context.workspaceState.update(`tours:${prId}`, undefined);
    }
}
