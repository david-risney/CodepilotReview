import * as vscode from 'vscode';
import { DiffFile, ReviewIssue, DiffPosition } from '../types';
import { logger } from '../logging/logger';

/**
 * Interface for review tools that analyze code and produce potential issues.
 */
export interface IReviewTool {
    readonly name: string;
    readonly description: string;

    /** Run the review tool on the given diff */
    run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]>;
}

export interface ReviewToolInput {
    pullRequestId: string;
    diff: DiffFile[];
    existingIssues: ReviewIssue[];
}

export interface ReviewToolContext {
    cancellationToken: vscode.CancellationToken;
    progress: vscode.Progress<{ message?: string; increment?: number }>;
    workspaceRoot: string;
    /** Report a sub-phase of the tool's execution */
    onPhase?: (phase: string) => void;
}
