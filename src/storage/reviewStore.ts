import * as vscode from 'vscode';
import { ReviewIssue } from '../types';
import { logger } from '../logging/logger';

/**
 * Stores review session data persistently using VSCode workspace/global storage.
 * Allows draft issues, dismissed issues, and review sessions to survive reloads.
 */
export class ReviewStore {
    private context: vscode.ExtensionContext | undefined;

    initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /** Save issues for a PR */
    async saveIssues(prId: string, issues: ReviewIssue[]): Promise<void> {
        if (!this.context) { return; }
        const key = `issues:${prId}`;
        await this.context.workspaceState.update(key, issues);
    }

    /** Load issues for a PR */
    loadIssues(prId: string): ReviewIssue[] {
        if (!this.context) { return []; }
        const key = `issues:${prId}`;
        return this.context.workspaceState.get<ReviewIssue[]>(key, []);
    }

    /** Save a value to global storage (persists across workspaces) */
    async saveGlobal<T>(key: string, value: T): Promise<void> {
        if (!this.context) { return; }
        await this.context.globalState.update(`codepilotReview:${key}`, value);
    }

    /** Load a value from global storage */
    loadGlobal<T>(key: string, defaultValue: T): T {
        if (!this.context) { return defaultValue; }
        return this.context.globalState.get<T>(`codepilotReview:${key}`, defaultValue);
    }

    /** Clear all stored data for a PR */
    async clearPr(prId: string): Promise<void> {
        if (!this.context) { return; }
        await this.context.workspaceState.update(`issues:${prId}`, undefined);
    }
}
