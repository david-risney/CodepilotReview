import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ReviewIssue, DiffFile, CustomReviewToolConfig } from '../types';
import { IReviewTool, ReviewToolInput, ReviewToolContext } from './reviewTool';
import { IAiService } from '../ai/aiService';
import { ToolError } from '../errors';
import { logger } from '../logging/logger';

const execAsync = promisify(exec);

/**
 * Runs a user-configured external command as a review tool.
 * Parses output using a problem-matcher-style pattern or AI.
 */
export class CustomCommandTool implements IReviewTool {
    readonly name: string;
    readonly description: string;

    constructor(
        private config: CustomReviewToolConfig,
        private aiService: IAiService,
    ) {
        this.name = config.name;
        this.description = config.description;
    }

    async run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]> {
        if (context.cancellationToken.isCancellationRequested) {
            return [];
        }

        context.onPhase?.('running command...');

        context.progress.report({ message: `Running ${this.name}...` });

        try {
            const command = this.expandVariables(this.config.command, input, context);
            const { stdout, stderr } = await execAsync(command, {
                cwd: context.workspaceRoot,
                timeout: 60000,
            });

            const output = stdout + (stderr ? '\n' + stderr : '');

            if (!output.trim()) {
                return [];
            }

            let issues: ReviewIssue[];
            if (this.config.outputParsePattern) {
                issues = this.parseWithPattern(output, this.config.outputParsePattern);
            } else {
                // Use AI to parse freeform output
                issues = await this.parseWithAi(output, context);
            }

            // Run optional post-parse script
            if (this.config.postParseScript && issues.length > 0) {
                issues = await this.runPostParseScript(issues, this.config.postParseScript, context);
            }

            return issues;
        } catch (error) {
            // Non-zero exit codes are expected for tools that find issues
            if (error && typeof error === 'object' && 'stdout' in error) {
                const output = (error as { stdout: string; stderr: string }).stdout +
                    '\n' + (error as { stdout: string; stderr: string }).stderr;
                if (output.trim()) {
                    if (this.config.outputParsePattern) {
                        return this.parseWithPattern(output, this.config.outputParsePattern);
                    }
                    return this.parseWithAi(output, context);
                }
            }
            throw new ToolError(`Command failed: ${this.config.command}`, this.name, error);
        }
    }

    private expandVariables(command: string, input: ReviewToolInput, context: ReviewToolContext): string {
        return command
            .replace(/\$\{workspaceRoot\}/g, context.workspaceRoot)
            .replace(/\$\{pullRequestId\}/g, input.pullRequestId);
    }

    /**
     * Parse output using a compile-error-style pattern.
     * Pattern variables: ${file}, ${line}, ${column}, ${message}, ${severity}
     */
    private parseWithPattern(output: string, pattern: string): ReviewIssue[] {
        const regex = this.patternToRegex(pattern);
        const issues: ReviewIssue[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            const match = line.match(regex);
            if (match && match.groups) {
                issues.push({
                    id: `cmd-${Date.now()}-${issues.length}`,
                    summary: match.groups['message'] || line.trim(),
                    details: `Command: \`${this.config.command}\`\nOutput: ${line}`,
                    position: {
                        filePath: match.groups['file'] || 'unknown',
                        line: parseInt(match.groups['line'] || '1'),
                        side: 'head',
                    },
                    status: 'suggested',
                    source: 'tool',
                    toolName: this.name,
                    createdAt: new Date(),
                });
            }
        }

        return issues;
    }

    private patternToRegex(pattern: string): RegExp {
        let regexStr = pattern
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\\\$\\\{file\\\}/g, '(?<file>[^:]+)')
            .replace(/\\\$\\\{line\\\}/g, '(?<line>\\d+)')
            .replace(/\\\$\\\{column\\\}/g, '(?<column>\\d+)')
            .replace(/\\\$\\\{message\\\}/g, '(?<message>.+)')
            .replace(/\\\$\\\{severity\\\}/g, '(?<severity>\\w+)');
        return new RegExp(regexStr);
    }

    private async parseWithAi(output: string, context: ReviewToolContext): Promise<ReviewIssue[]> {
        try {
            return await this.aiService.reviewWithPrompt(
                `Parse the following tool output into code review issues. ` +
                `Tool name: ${this.name}\nTool description: ${this.description}\n\nTool output:\n${output}`,
                [],
                context.cancellationToken,
                context.onPhase,
            );
        } catch {
            logger.warn(`AI parsing failed for ${this.name}, returning raw output as single issue`);
            return [{
                id: `cmd-${Date.now()}-0`,
                summary: `${this.name}: issues found`,
                details: output.substring(0, 1000),
                position: { filePath: 'unknown', line: 1, side: 'head' },
                status: 'suggested',
                source: 'tool',
                toolName: this.name,
                createdAt: new Date(),
            }];
        }
    }

    private async runPostParseScript(
        issues: ReviewIssue[], script: string, context: ReviewToolContext
    ): Promise<ReviewIssue[]> {
        try {
            const input = JSON.stringify(issues);
            const { stdout } = await execAsync(`node -e "${script}"`, {
                cwd: context.workspaceRoot,
                env: { ...process.env, INPUT: input },
                timeout: 30000,
            });
            return JSON.parse(stdout);
        } catch (error) {
            logger.warn(`Post-parse script failed for ${this.name}`, error);
            return issues;
        }
    }
}

/**
 * Runs a user-provided prompt as a review tool.
 * Uses AI to generate issues from the prompt + diff.
 */
export class CustomPromptTool implements IReviewTool {
    readonly name: string;
    readonly description: string;

    constructor(
        private config: CustomReviewToolConfig,
        private aiService: IAiService,
    ) {
        this.name = config.name;
        this.description = config.description;
    }

    async run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]> {
        if (context.cancellationToken.isCancellationRequested) {
            return [];
        }

        const prompt = this.config.prompt || '';
        if (!prompt) {
            logger.warn(`Custom prompt tool ${this.name} has no prompt configured`);
            return [];
        }

        context.progress.report({ message: `Running ${this.name} (AI prompt)...` });

        return this.aiService.reviewWithPrompt(prompt, input.diff, context.cancellationToken, context.onPhase);
    }
}
