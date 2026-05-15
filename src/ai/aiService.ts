import * as vscode from 'vscode';
import { DiffFile, ReviewIssue } from '../types';
import { AiError, AiNotAvailableError } from '../errors';
import { logger } from '../logging/logger';

/**
 * AI service interface for Copilot/LLM integration.
 * Provides structured AI capabilities for review tasks.
 */
export interface IAiService {
    /** Check if AI is available */
    isAvailable(): Promise<boolean>;

    /** Chat about a code change with context */
    chat(prompt: string, context: AiContext, token?: vscode.CancellationToken): Promise<string>;

    /** Summarize a diff for PR description */
    summarizeDiff(diff: DiffFile[], token?: vscode.CancellationToken): Promise<string>;

    /** Explain a potential issue in detail */
    explainIssue(issue: ReviewIssue, diff: DiffFile[], token?: vscode.CancellationToken): Promise<string>;

    /** Propose a fix for an issue */
    proposeFix(issue: ReviewIssue, diff: DiffFile[], token?: vscode.CancellationToken): Promise<string>;

    /** Partition a diff into logical chunks */
    partitionDiff(
        diff: DiffFile[], criteria: string, token?: vscode.CancellationToken
    ): Promise<PartitionSuggestion[]>;

    /** Run a review prompt and parse into issues */
    reviewWithPrompt(
        prompt: string, diff: DiffFile[], token?: vscode.CancellationToken
    ): Promise<ReviewIssue[]>;
}

export interface AiContext {
    diff?: DiffFile[];
    fileContents?: Map<string, string>;
    existingIssues?: ReviewIssue[];
    knowledgeBase?: string;
}

export interface PartitionSuggestion {
    name: string;
    description: string;
    files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>;
    dependsOn: string[];
}

/**
 * Real AI service implementation using VSCode Language Model API (vscode.lm).
 * Requires GitHub Copilot to be installed and signed in.
 */
export class CopilotAiService implements IAiService {
    private model: vscode.LanguageModelChat | undefined;

    async isAvailable(): Promise<boolean> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            return models.length > 0;
        } catch {
            return false;
        }
    }

    private async getModel(): Promise<vscode.LanguageModelChat> {
        if (this.model) {
            return this.model;
        }

        // Prefer gpt-4o, fall back to any copilot model
        let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        }

        if (models.length === 0) {
            throw new AiNotAvailableError();
        }

        this.model = models[0];
        logger.info(`AI model selected: ${this.model.name} (${this.model.family})`);
        return this.model;
    }

    private async sendRequest(
        messages: vscode.LanguageModelChatMessage[],
        token?: vscode.CancellationToken
    ): Promise<string> {
        const model = await this.getModel();
        const cancellation = token || new vscode.CancellationTokenSource().token;

        try {
            const response = await model.sendRequest(
                messages,
                { justification: 'CodepilotReview needs AI to assist with code review' },
                cancellation
            );

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }
            return result;
        } catch (error) {
            if (error instanceof vscode.LanguageModelError) {
                logger.error(`AI request failed: ${error.code} - ${error.message}`);
                if (error.code === 'NoPermissions') {
                    throw new AiError('Copilot access denied. Please grant permission.', error);
                }
                if (error.code === 'Blocked') {
                    throw new AiError('AI request was blocked (rate limit or content filter).', error);
                }
            }
            throw new AiError('AI request failed', error);
        }
    }

    private formatDiffForPrompt(diff: DiffFile[]): string {
        const parts: string[] = [];
        for (const file of diff) {
            const path = file.newPath || file.oldPath || 'unknown';
            parts.push(`--- File: ${path} (${file.changeType}) ---`);
            for (const hunk of file.hunks) {
                for (const line of hunk.lines) {
                    const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
                    parts.push(`${prefix}${line.content}`);
                }
            }
            parts.push('');
        }
        return parts.join('\n');
    }

    async chat(prompt: string, context: AiContext, token?: vscode.CancellationToken): Promise<string> {
        const messages: vscode.LanguageModelChatMessage[] = [];

        // No system messages in vscode.lm — use a leading User message for persona
        let systemPrompt = 'You are a helpful code review assistant. You help developers review code changes thoroughly and constructively.';
        if (context.diff) {
            systemPrompt += '\n\nHere is the code change being reviewed:\n' + this.formatDiffForPrompt(context.diff);
        }
        if (context.existingIssues && context.existingIssues.length > 0) {
            systemPrompt += '\n\nExisting review issues:\n' + context.existingIssues.map(
                i => `- [${i.status}] ${i.summary}`
            ).join('\n');
        }

        messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
        messages.push(vscode.LanguageModelChatMessage.User(prompt));

        return this.sendRequest(messages, token);
    }

    async summarizeDiff(diff: DiffFile[], token?: vscode.CancellationToken): Promise<string> {
        const diffText = this.formatDiffForPrompt(diff);
        const messages = [
            vscode.LanguageModelChatMessage.User(
                'You are a code review assistant. Analyze the following code change and provide:\n' +
                '1. A brief one-sentence summary of what this change does\n' +
                '2. A priority assessment: is this blocking (needs immediate review), yes (should review), interest (nice to review), or no (does not need review)\n' +
                '3. Any relevant links or references mentioned in the code (PR numbers, bug IDs, etc.)\n\n' +
                'Respond in this exact format:\n' +
                'SUMMARY: <one sentence>\n' +
                'PRIORITY: <blocking|yes|interest|no>\n' +
                'LINKS: <comma-separated list or "none">\n\n' +
                'Code change:\n' + diffText
            ),
        ];

        return this.sendRequest(messages, token);
    }

    async explainIssue(issue: ReviewIssue, diff: DiffFile[], token?: vscode.CancellationToken): Promise<string> {
        const diffText = this.formatDiffForPrompt(diff);
        const messages = [
            vscode.LanguageModelChatMessage.User(
                'You are a code review assistant. A review tool found the following potential issue:\n\n' +
                `Summary: ${issue.summary}\n` +
                `Details: ${issue.details}\n` +
                `File: ${issue.position.filePath}, Line: ${issue.position.line}\n\n` +
                'Given this code change:\n' + diffText + '\n\n' +
                'Please explain:\n' +
                '1. Is this a real issue? Why or why not?\n' +
                '2. What is the impact if not addressed?\n' +
                '3. How would you fix it?'
            ),
        ];

        return this.sendRequest(messages, token);
    }

    async proposeFix(issue: ReviewIssue, diff: DiffFile[], token?: vscode.CancellationToken): Promise<string> {
        const diffText = this.formatDiffForPrompt(diff);
        const messages = [
            vscode.LanguageModelChatMessage.User(
                'You are a code review assistant. Propose a fix for this issue:\n\n' +
                `Issue: ${issue.summary}\n` +
                `Details: ${issue.details}\n` +
                `File: ${issue.position.filePath}, Line: ${issue.position.line}\n\n` +
                'Code change:\n' + diffText + '\n\n' +
                'Provide the fix as a code suggestion that could be used as a review comment.'
            ),
        ];

        return this.sendRequest(messages, token);
    }

    async partitionDiff(
        diff: DiffFile[], criteria: string, token?: vscode.CancellationToken
    ): Promise<PartitionSuggestion[]> {
        const diffText = this.formatDiffForPrompt(diff);
        const messages = [
            vscode.LanguageModelChatMessage.User(
                'You are a code review assistant. Partition this code change into logical chunks for easier review.\n\n' +
                `Partitioning criteria: ${criteria}\n\n` +
                'Rules:\n' +
                '- All changed code must be included in at least one chunk\n' +
                '- Some overlap between chunks is OK\n' +
                '- Chunks can include sub-file ranges (not just whole files)\n' +
                '- Order chunks by dependency (reviewed first → last)\n\n' +
                'Respond with a JSON array of partitions:\n' +
                '```json\n' +
                '[{"name": "...", "description": "...", "files": [{"path": "...", "lineRanges": [{"start": 1, "end": 10}]}], "dependsOn": ["other-partition-name"]}]\n' +
                '```\n\n' +
                'Code change:\n' + diffText
            ),
        ];

        const response = await this.sendRequest(messages, token);

        try {
            const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
            const jsonStr = jsonMatch ? jsonMatch[1] : response;
            return JSON.parse(jsonStr.trim());
        } catch (error) {
            logger.error('Failed to parse partition response', error);
            return [];
        }
    }

    async reviewWithPrompt(
        prompt: string, diff: DiffFile[], token?: vscode.CancellationToken
    ): Promise<ReviewIssue[]> {
        const diffText = this.formatDiffForPrompt(diff);

        // First pass: run the user's prompt
        const firstPassMessages = [
            vscode.LanguageModelChatMessage.User(prompt + '\n\nCode change:\n' + diffText),
        ];
        const rawResult = await this.sendRequest(firstPassMessages, token);

        // Second pass: reformat into structured issues
        const reformatMessages = [
            vscode.LanguageModelChatMessage.User(
                'Convert the following code review feedback into a JSON array of issues.\n' +
                'Each issue must have: summary (short TLDR), details (full explanation with how to reproduce), ' +
                'filePath, line (number), side ("head" or "base").\n\n' +
                'Respond with ONLY a JSON array:\n' +
                '```json\n' +
                '[{"summary": "...", "details": "...", "filePath": "...", "line": 1, "side": "head"}]\n' +
                '```\n\n' +
                'Review feedback to convert:\n' + rawResult
            ),
        ];
        const structured = await this.sendRequest(reformatMessages, token);

        try {
            const jsonMatch = structured.match(/```json\s*([\s\S]*?)```/);
            const jsonStr = jsonMatch ? jsonMatch[1] : structured;
            const parsed = JSON.parse(jsonStr.trim()) as Array<{
                summary: string; details: string; filePath: string; line: number; side: string;
            }>;

            return parsed.map((item, index) => ({
                id: `prompt-${Date.now()}-${index}`,
                summary: item.summary,
                details: item.details,
                position: {
                    filePath: item.filePath,
                    line: item.line,
                    side: (item.side === 'base' ? 'base' : 'head') as 'base' | 'head',
                },
                status: 'suggested' as const,
                source: 'ai' as const,
                toolName: 'Custom Prompt',
                createdAt: new Date(),
            }));
        } catch (error) {
            logger.error('Failed to parse review prompt response', error);
            return [];
        }
    }
}

/**
 * Stub AI service for when Copilot is not available.
 */
export class StubAiService implements IAiService {
    async isAvailable(): Promise<boolean> {
        return false;
    }

    async chat(_prompt: string, _context: AiContext, _token?: vscode.CancellationToken): Promise<string> {
        return 'AI integration not available. Please install GitHub Copilot.';
    }

    async summarizeDiff(_diff: DiffFile[], _token?: vscode.CancellationToken): Promise<string> {
        return '';
    }

    async explainIssue(
        _issue: ReviewIssue, _diff: DiffFile[], _token?: vscode.CancellationToken
    ): Promise<string> {
        return 'AI not available.';
    }

    async proposeFix(
        _issue: ReviewIssue, _diff: DiffFile[], _token?: vscode.CancellationToken
    ): Promise<string> {
        return 'AI not available.';
    }

    async partitionDiff(
        _diff: DiffFile[], _criteria: string, _token?: vscode.CancellationToken
    ): Promise<PartitionSuggestion[]> {
        return [];
    }

    async reviewWithPrompt(
        _prompt: string, _diff: DiffFile[], _token?: vscode.CancellationToken
    ): Promise<ReviewIssue[]> {
        return [];
    }
}
