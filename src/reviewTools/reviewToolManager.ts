import * as vscode from 'vscode';
import { ReviewIssue, DiffFile } from '../types';
import { IReviewTool, ReviewToolInput, ReviewToolContext } from './reviewTool';
import { CustomCommandTool, CustomPromptTool } from './customTools';
import { IAiService } from '../ai/aiService';
import { Configuration } from '../config/configuration';
import { ToolError } from '../errors';
import { logger } from '../logging/logger';

/**
 * Manages review tools (built-in and custom) and orchestrates running them.
 */
export class ReviewToolManager {
    private tools: Map<string, IReviewTool> = new Map();

    constructor(
        private config: Configuration,
        private aiService: IAiService,
    ) {
        this.registerBuiltInTools();
        this.loadCustomTools();

        // Reload custom tools when config changes
        config.onDidChange(() => this.loadCustomTools());
    }

    registerTool(tool: IReviewTool): void {
        this.tools.set(tool.name, tool);
        logger.info(`Registered review tool: ${tool.name}`);
    }

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
        this.registerTool(new HistoricReviewTool(this.aiService));
        this.registerTool(new MetaQuestionsTool(this.aiService));
    }

    private loadCustomTools(): void {
        // Remove previously loaded custom tools
        for (const [name, tool] of this.tools) {
            if (tool instanceof CustomCommandTool || tool instanceof CustomPromptTool) {
                this.tools.delete(name);
            }
        }

        const customConfigs = this.config.getReviewTools();
        for (const config of customConfigs) {
            if (config.isPromptTool) {
                this.registerTool(new CustomPromptTool(config, this.aiService));
            } else {
                this.registerTool(new CustomCommandTool(config, this.aiService));
            }
        }
    }
}

/**
 * Built-in tool: Analyzes based on previous changes and code review feedback.
 */
class HistoricReviewTool implements IReviewTool {
    readonly name = 'historic-review';
    readonly description = 'Check for issues based on previous code review feedback in related files';

    constructor(private aiService: IAiService) {}

    async run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]> {
        const available = await this.aiService.isAvailable();
        if (!available) {
            logger.warn('Historic review tool skipped: AI not available');
            return [];
        }

        const prompt =
            'You are reviewing a code change. Based on common code review patterns and best practices ' +
            'for the languages and frameworks used in these files, identify potential issues.\n\n' +
            'Focus on:\n' +
            '- Patterns that have historically caused bugs in similar code\n' +
            '- Common code review feedback for this type of change\n' +
            '- Missed edge cases or error handling\n' +
            '- API misuse or deprecated patterns\n\n' +
            'Only report real, actionable issues. Do not report style nits.';

        return this.aiService.reviewWithPrompt(prompt, input.diff, context.cancellationToken);
    }
}

/**
 * Built-in tool: Meta-level questions about the change.
 */
class MetaQuestionsTool implements IReviewTool {
    readonly name = 'meta-questions';
    readonly description = 'Check if the change makes sense, matches the task, and involves correct reviewers';

    constructor(private aiService: IAiService) {}

    async run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]> {
        const available = await this.aiService.isAvailable();
        if (!available) {
            logger.warn('Meta questions tool skipped: AI not available');
            return [];
        }

        const prompt =
            'You are a senior reviewer performing a high-level review. Consider these meta questions:\n\n' +
            '1. Does this change make sense as a coherent unit? Should it be split?\n' +
            '2. Are there any files changed that seem unrelated to the main purpose?\n' +
            '3. Is the scope appropriate — too large, too small, or mixed concerns?\n' +
            '4. Are there obvious missing changes (e.g., tests, documentation, config)?\n' +
            '5. Are there potential security implications?\n\n' +
            'Only report genuine concerns. Use file path "GENERAL" and line 1 for project-level issues.';

        return this.aiService.reviewWithPrompt(prompt, input.diff, context.cancellationToken);
    }
}
