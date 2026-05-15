import * as vscode from 'vscode';
import { DiffFile, ReviewIssue } from '../types';
import { logger } from '../logging/logger';

/**
 * AI service interface for Copilot/LLM integration.
 * Provides structured AI capabilities for review tasks.
 */
export interface IAiService {
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
}

export interface AiContext {
    diff?: DiffFile[];
    fileContents?: Map<string, string>;
    existingIssues?: ReviewIssue[];
    /** Additional context from knowledge base */
    knowledgeBase?: string;
}

export interface PartitionSuggestion {
    name: string;
    description: string;
    files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>;
    dependsOn: string[];
}

/**
 * Stub AI service implementation.
 * To be replaced with actual Copilot API integration.
 */
export class StubAiService implements IAiService {
    async chat(prompt: string, _context: AiContext, _token?: vscode.CancellationToken): Promise<string> {
        logger.info('AI chat: integration pending');
        return 'AI integration not yet available. This will use the Copilot API.';
    }

    async summarizeDiff(_diff: DiffFile[], _token?: vscode.CancellationToken): Promise<string> {
        logger.info('AI summarizeDiff: integration pending');
        return '';
    }

    async explainIssue(
        _issue: ReviewIssue, _diff: DiffFile[], _token?: vscode.CancellationToken
    ): Promise<string> {
        logger.info('AI explainIssue: integration pending');
        return '';
    }

    async proposeFix(
        _issue: ReviewIssue, _diff: DiffFile[], _token?: vscode.CancellationToken
    ): Promise<string> {
        logger.info('AI proposeFix: integration pending');
        return '';
    }

    async partitionDiff(
        _diff: DiffFile[], _criteria: string, _token?: vscode.CancellationToken
    ): Promise<PartitionSuggestion[]> {
        logger.info('AI partitionDiff: integration pending');
        return [];
    }
}
