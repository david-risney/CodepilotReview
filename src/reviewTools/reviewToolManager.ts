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
        const totalFiles = input.diff.length;
        let completedCount = 0;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Review Tools',
                cancellable: true,
            },
            async (progress, token) => {
                progress.report({
                    message: `Running ${toolsToRun.length} tool(s) concurrently on ${totalFiles} file(s)...`,
                });

                const promises = toolsToRun.map(async (tool, i) => {
                    if (token.isCancellationRequested) { return []; }

                    const toolLabel = `${tool.name}`;
                    const toolProgress = this.createToolProgressReporter(progress, toolLabel, totalFiles);

                    try {
                        const context: ReviewToolContext = {
                            cancellationToken: token,
                            progress,
                            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                            onPhase: (phase: string) => toolProgress.reportPhase(phase),
                        };

                        const issues = await tool.run(input, context);
                        completedCount++;

                        const increment = 100 / toolsToRun.length;
                        progress.report({
                            message: `${toolLabel}: ${issues.length} issue(s). (${completedCount}/${toolsToRun.length} tools done)`,
                            increment,
                        });

                        logger.info(`Tool ${tool.name} found ${issues.length} issues`);
                        return issues;
                    } catch (error) {
                        completedCount++;
                        logger.error(`Tool ${tool.name} failed`, error);
                        progress.report({
                            message: `${toolLabel}: failed. (${completedCount}/${toolsToRun.length} tools done)`,
                            increment: 100 / toolsToRun.length,
                        });
                        vscode.window.showWarningMessage(
                            `Review tool "${tool.name}" failed: ${error}`
                        );
                        return [];
                    }
                });

                const results = await Promise.all(promises);
                for (const issues of results) {
                    allIssues.push(...issues);
                }

                if (allIssues.length > 0) {
                    progress.report({ message: `Complete — ${allIssues.length} issue(s) found` });
                } else {
                    progress.report({ message: 'Complete — no issues found' });
                }
            }
        );

        return allIssues;
    }

    /** Create a progress reporter that tools can use for sub-step updates */
    private createToolProgressReporter(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        toolLabel: string,
        totalFiles: number,
    ) {
        return {
            reportPhase(phase: string) {
                progress.report({ message: `${toolLabel}: ${phase}` });
            },
            reportFile(fileName: string, fileIndex: number) {
                progress.report({
                    message: `${toolLabel}: file ${fileIndex + 1}/${totalFiles} — ${fileName}`,
                });
            },
        };
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
 * Uses git log to find past changes and review patterns in affected files.
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

        context.onPhase?.('gathering git history...');

        // Gather git history for changed files
        let historyContext = '';
        if (context.workspaceRoot) {
            const changedFiles = input.diff.map(f => f.newPath || f.oldPath).filter(Boolean);
            historyContext = await this.getGitHistory(changedFiles as string[], context.workspaceRoot);
        }

        const prompt =
            'You are reviewing a code change. Analyze it based on the git history of the affected files.\n\n' +
            'Focus on:\n' +
            '- Patterns from previous commits that were later reverted or fixed (indicating bugs)\n' +
            '- Repeated changes to the same areas (indicating fragile code)\n' +
            '- Previous code review feedback patterns (things reviewers commonly catch)\n' +
            '- Common mistakes in similar past changes\n' +
            '- Missed edge cases or error handling that was added in follow-up commits\n\n' +
            (historyContext
                ? `Here is the recent git history for the affected files:\n${historyContext}\n\n`
                : '') +
            'Only report real, actionable issues. Do not report style nits.';

        return this.aiService.reviewWithPrompt(prompt, input.diff, context.cancellationToken, context.onPhase);
    }

    private async getGitHistory(files: string[], cwd: string): Promise<string> {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        const parts: string[] = [];
        for (const file of files.slice(0, 5)) { // Limit to 5 files to avoid huge prompts
            try {
                const { stdout } = await execAsync(
                    `git log --oneline -10 --follow -- "${file}"`,
                    { cwd, timeout: 10000 }
                );
                if (stdout.trim()) {
                    parts.push(`## ${file}\n${stdout.trim()}`);
                }
            } catch {
                // Skip files with no history
            }
        }
        return parts.join('\n\n');
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

        context.onPhase?.('gathering reviewer context...');

        // Get reviewer info from git history for context
        let reviewerContext = '';
        if (context.workspaceRoot) {
            reviewerContext = await this.getReviewerContext(input, context);
        }

        const prompt =
            'You are a senior reviewer performing a high-level review. Consider these meta questions:\n\n' +
            '1. Does this change make sense as a coherent unit? Should it be split?\n' +
            '2. Does this change match the stated bug/task/feature? Are there signs it\'s solving the wrong problem?\n' +
            '3. Is the bug/task ready to be implemented? Are prerequisites met?\n' +
            '4. Are there any files changed that seem unrelated to the main purpose?\n' +
            '5. Is the scope appropriate — too large, too small, or mixed concerns?\n' +
            '6. Are there obvious missing changes (e.g., tests, documentation, config)?\n' +
            '7. Are there potential security implications?\n' +
            '8. Are the correct people involved in this code review? Based on the files changed, ' +
            'are the people who know this code best being consulted?\n\n' +
            (reviewerContext
                ? `File ownership context (recent committers per file):\n${reviewerContext}\n\n`
                : '') +
            'Only report genuine concerns. Use file path "GENERAL" and line 1 for project-level issues.';

        return this.aiService.reviewWithPrompt(prompt, input.diff, context.cancellationToken, context.onPhase);
    }

    private async getReviewerContext(input: ReviewToolInput, context: ReviewToolContext): Promise<string> {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        const parts: string[] = [];
        const files = input.diff.map(f => f.newPath || f.oldPath).filter(Boolean);

        for (const file of files.slice(0, 5)) {
            try {
                const { stdout } = await execAsync(
                    `git log --format="%an" -10 -- "${file}"`,
                    { cwd: context.workspaceRoot, timeout: 10000 }
                );
                if (stdout.trim()) {
                    const authors = [...new Set(stdout.trim().split('\n'))];
                    parts.push(`${file}: ${authors.join(', ')}`);
                }
            } catch {
                // Skip
            }
        }
        return parts.join('\n');
    }
}
