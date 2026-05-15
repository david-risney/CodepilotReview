import * as vscode from 'vscode';
import { ReviewIssue, DiffFile } from '../types';
import { IReviewTool, ReviewToolInput, ReviewToolContext } from './reviewTool';
import { Configuration } from '../config/configuration';
import { logger } from '../logging/logger';

/**
 * Manages review tools (built-in and custom) and orchestrates running them.
 */
export class ReviewToolManager {
    private tools: Map<string, IReviewTool> = new Map();

    constructor(private config: Configuration) {
        this.registerBuiltInTools();
    }

    /** Register a review tool */
    registerTool(tool: IReviewTool): void {
        this.tools.set(tool.name, tool);
        logger.info(`Registered review tool: ${tool.name}`);
    }

    /** Get all registered tools */
    getTools(): IReviewTool[] {
        return Array.from(this.tools.values());
    }

    /** Run all tools (or specified tools) with progress */
    async runTools(
        input: ReviewToolInput,
        toolNames?: string[]
    ): Promise<ReviewIssue[]> {
        const toolsToRun = toolNames
            ? Array.from(this.tools.values()).filter(t => toolNames.includes(t.name))
            : Array.from(this.tools.values());

        const allIssues: ReviewIssue[] = [];

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Running review tools...',
                cancellable: true,
            },
            async (progress, token) => {
                for (let i = 0; i < toolsToRun.length; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const tool = toolsToRun[i];
                    progress.report({
                        message: `Running ${tool.name}...`,
                        increment: (100 / toolsToRun.length),
                    });

                    try {
                        const context: ReviewToolContext = {
                            cancellationToken: token,
                            progress,
                            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                        };

                        const issues = await tool.run(input, context);
                        allIssues.push(...issues);
                        logger.info(`Tool ${tool.name} found ${issues.length} issues`);
                    } catch (error) {
                        logger.error(`Tool ${tool.name} failed`, error);
                        vscode.window.showWarningMessage(
                            `Review tool "${tool.name}" failed: ${error}`
                        );
                    }
                }
            }
        );

        return allIssues;
    }

    private registerBuiltInTools(): void {
        this.registerTool(new HistoricReviewTool());
        this.registerTool(new MetaQuestionsTool());
    }
}

/**
 * Built-in tool: Analyzes based on previous changes and code review feedback.
 * Uses AI to check for patterns from historic reviews.
 */
class HistoricReviewTool implements IReviewTool {
    readonly name = 'historic-review';
    readonly description = 'Check for issues based on previous code review feedback in related files';

    async run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]> {
        // TODO: Implement with AI integration
        // Will use copilot prompt: "Based on previous changes and previous code review
        // feedback in related files, are there any issues?"
        logger.info('Historic review tool: AI integration pending');
        return [];
    }
}

/**
 * Built-in tool: Meta-level questions about the change.
 * Checks if the change makes sense, matches the task, involves correct reviewers.
 */
class MetaQuestionsTool implements IReviewTool {
    readonly name = 'meta-questions';
    readonly description = 'Check if the change makes sense, matches the task, and involves correct reviewers';

    async run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]> {
        // TODO: Implement with AI integration
        // Will use copilot prompt: "Does it make sense to do this? Does it match the
        // bug/task? Is the bug/task ready? Are correct people in code review?"
        logger.info('Meta questions tool: AI integration pending');
        return [];
    }
}
