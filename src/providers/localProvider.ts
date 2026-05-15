import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
    PullRequest, DiffFile, DiffHunk, DiffLine, ReviewIssue, ProviderCapabilities,
    FileChangeType, ReviewIssueStatus
} from '../types';
import {
    ICodeReviewProvider, IPullRequestProvider, IDiffProvider, ICommentProvider,
    PullRequestFilter
} from './provider';
import { logger } from '../logging/logger';

const execAsync = promisify(exec);

/**
 * Local provider that uses git diff to create a synthetic code review session.
 * Compares the current branch against a configured base branch.
 */
export class LocalProvider implements ICodeReviewProvider {
    readonly name = 'local';
    readonly capabilities: ProviderCapabilities = {
        supportsDraftComments: true,
        supportsPublishing: false,
        supportsThreads: false,
        supportsSuggestedFixes: true,
        supportsReviewVotes: false,
        supportsLabels: false,
        requiresAuthentication: false,
    };

    readonly pullRequests: IPullRequestProvider;
    readonly diff: IDiffProvider;
    readonly comments: ICommentProvider;
    readonly auth = undefined;

    private workspaceRoot: string = '';
    private baseBranch: string = 'main';
    private draftIssues: Map<string, ReviewIssue[]> = new Map();
    private context?: vscode.ExtensionContext;

    constructor() {
        this.pullRequests = new LocalPullRequestProvider(this);
        this.diff = new LocalDiffProvider(this);
        this.comments = new LocalCommentProvider(this);
    }

    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this.workspaceRoot = folders[0].uri.fsPath;
        }

        const config = vscode.workspace.getConfiguration('codepilotReview');
        this.baseBranch = config.get<string>('local.baseBranch', 'main');

        // Restore draft issues from workspace storage
        const stored = context.workspaceState.get<Record<string, ReviewIssue[]>>('localDraftIssues');
        if (stored) {
            for (const [key, value] of Object.entries(stored)) {
                this.draftIssues.set(key, value);
            }
        }

        logger.info(`Local provider initialized with base branch: ${this.baseBranch}`);
    }

    dispose(): void {
        // Persist draft issues
        if (this.context) {
            const obj: Record<string, ReviewIssue[]> = {};
            for (const [key, value] of this.draftIssues.entries()) {
                obj[key] = value;
            }
            this.context.workspaceState.update('localDraftIssues', obj);
        }
    }

    getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    getBaseBranch(): string {
        return this.baseBranch;
    }

    async runGit(args: string): Promise<string> {
        try {
            const { stdout } = await execAsync(`git ${args}`, { cwd: this.workspaceRoot });
            return stdout.trim();
        } catch (error) {
            logger.error(`Git command failed: git ${args}`, error);
            throw error;
        }
    }

    getDraftIssues(prId: string): ReviewIssue[] {
        return this.draftIssues.get(prId) || [];
    }

    setDraftIssues(prId: string, issues: ReviewIssue[]): void {
        this.draftIssues.set(prId, issues);
    }
}

class LocalPullRequestProvider implements IPullRequestProvider {
    constructor(private provider: LocalProvider) {}

    async getPullRequests(_filter?: PullRequestFilter): Promise<PullRequest[]> {
        try {
            const currentBranch = await this.provider.runGit('rev-parse --abbrev-ref HEAD');
            const baseBranch = this.provider.getBaseBranch();

            if (currentBranch === baseBranch) {
                return [];
            }

            // Create a synthetic PR for current branch vs base
            const logOutput = await this.provider.runGit(
                `log ${baseBranch}..HEAD --format="%H|%an|%s|%ai" --reverse`
            );

            if (!logOutput) {
                return [];
            }

            const lines = logOutput.split('\n').filter(l => l.trim());
            const firstCommit = lines[0]?.split('|') || [];
            const lastCommit = lines[lines.length - 1]?.split('|') || [];

            const pr: PullRequest = {
                id: `local-${currentBranch}`,
                title: `${currentBranch} → ${baseBranch}`,
                description: lines.map(l => l.split('|')[2]).join('\n'),
                author: firstCommit[1] || 'unknown',
                status: 'open',
                sourceBranch: currentBranch,
                targetBranch: baseBranch,
                createdAt: new Date(firstCommit[3] || Date.now()),
                updatedAt: new Date(lastCommit[3] || Date.now()),
                reviewers: [],
                labels: [],
                isUserRequired: true,
                providerName: 'local',
            };

            return [pr];
        } catch (error) {
            logger.error('Failed to get local pull requests', error);
            return [];
        }
    }

    async getPullRequest(id: string): Promise<PullRequest | undefined> {
        const prs = await this.getPullRequests();
        return prs.find(pr => pr.id === id);
    }
}

class LocalDiffProvider implements IDiffProvider {
    constructor(private provider: LocalProvider) {}

    async getDiff(pullRequestId: string): Promise<DiffFile[]> {
        try {
            const baseBranch = this.provider.getBaseBranch();
            const rawDiff = await this.provider.runGit(`diff ${baseBranch}...HEAD`);
            return this.parseDiff(rawDiff);
        } catch (error) {
            logger.error(`Failed to get diff for ${pullRequestId}`, error);
            return [];
        }
    }

    async getFileContent(filePath: string, revision: string): Promise<string> {
        return this.provider.runGit(`show ${revision}:${filePath}`);
    }

    private parseDiff(rawDiff: string): DiffFile[] {
        const files: DiffFile[] = [];
        const fileChunks = rawDiff.split(/^diff --git /m).filter(c => c.trim());

        for (const chunk of fileChunks) {
            const file = this.parseDiffFile(chunk);
            if (file) {
                files.push(file);
            }
        }

        return files;
    }

    private parseDiffFile(chunk: string): DiffFile | null {
        const lines = chunk.split('\n');
        const headerMatch = lines[0]?.match(/a\/(.+) b\/(.+)/);
        if (!headerMatch) {
            return null;
        }

        const oldPath = headerMatch[1];
        const newPath = headerMatch[2];

        let changeType: FileChangeType = 'modified';
        let oldRevision = '';
        let newRevision = '';
        const isBinary = chunk.includes('Binary files');

        for (const line of lines) {
            if (line.startsWith('new file')) {
                changeType = 'added';
            } else if (line.startsWith('deleted file')) {
                changeType = 'deleted';
            } else if (line.startsWith('rename from')) {
                changeType = 'renamed';
            } else if (line.startsWith('index ')) {
                const indexMatch = line.match(/index ([a-f0-9]+)\.\.([a-f0-9]+)/);
                if (indexMatch) {
                    oldRevision = indexMatch[1];
                    newRevision = indexMatch[2];
                }
            }
        }

        const hunks = this.parseHunks(lines);

        return {
            oldPath: changeType === 'added' ? undefined : oldPath,
            newPath: changeType === 'deleted' ? undefined : newPath,
            hunks,
            oldRevision,
            newRevision,
            changeType,
            isBinary,
        };
    }

    private parseHunks(lines: string[]): DiffHunk[] {
        const hunks: DiffHunk[] = [];
        let currentHunk: DiffHunk | null = null;

        for (const line of lines) {
            const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
            if (hunkMatch) {
                if (currentHunk) {
                    hunks.push(currentHunk);
                }
                currentHunk = {
                    oldStart: parseInt(hunkMatch[1]),
                    oldLines: parseInt(hunkMatch[2] || '1'),
                    newStart: parseInt(hunkMatch[3]),
                    newLines: parseInt(hunkMatch[4] || '1'),
                    header: hunkMatch[5]?.trim() || '',
                    lines: [],
                };
            } else if (currentHunk) {
                if (line.startsWith('+')) {
                    currentHunk.lines.push({
                        type: 'add',
                        content: line.substring(1),
                        newLineNumber: currentHunk.newStart + currentHunk.lines.filter(
                            l => l.type !== 'delete'
                        ).length,
                    });
                } else if (line.startsWith('-')) {
                    currentHunk.lines.push({
                        type: 'delete',
                        content: line.substring(1),
                        oldLineNumber: currentHunk.oldStart + currentHunk.lines.filter(
                            l => l.type !== 'add'
                        ).length,
                    });
                } else if (line.startsWith(' ')) {
                    const addCount = currentHunk.lines.filter(l => l.type !== 'delete').length;
                    const delCount = currentHunk.lines.filter(l => l.type !== 'add').length;
                    currentHunk.lines.push({
                        type: 'context',
                        content: line.substring(1),
                        oldLineNumber: currentHunk.oldStart + delCount,
                        newLineNumber: currentHunk.newStart + addCount,
                    });
                }
            }
        }

        if (currentHunk) {
            hunks.push(currentHunk);
        }

        return hunks;
    }
}

class LocalCommentProvider implements ICommentProvider {
    constructor(private provider: LocalProvider) {}

    async getComments(pullRequestId: string): Promise<ReviewIssue[]> {
        return this.provider.getDraftIssues(pullRequestId);
    }

    async publishComment(_pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        // Local provider doesn't support publishing; keep as draft
        logger.warn('Local provider does not support publishing comments');
        return issue;
    }

    async updateComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        const issues = this.provider.getDraftIssues(pullRequestId);
        const index = issues.findIndex(i => i.id === issue.id);
        if (index >= 0) {
            issues[index] = issue;
            this.provider.setDraftIssues(pullRequestId, issues);
        }
        return issue;
    }

    async deleteComment(pullRequestId: string, commentId: string): Promise<void> {
        const issues = this.provider.getDraftIssues(pullRequestId);
        this.provider.setDraftIssues(
            pullRequestId,
            issues.filter(i => i.id !== commentId)
        );
    }

    async updateCommentStatus(
        pullRequestId: string, commentId: string, status: ReviewIssueStatus
    ): Promise<void> {
        const issues = this.provider.getDraftIssues(pullRequestId);
        const issue = issues.find(i => i.id === commentId);
        if (issue) {
            issue.status = status;
            this.provider.setDraftIssues(pullRequestId, issues);
        }
    }
}
