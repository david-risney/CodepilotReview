import * as vscode from 'vscode';
import * as https from 'https';
import {
    PullRequest, DiffFile, DiffHunk, DiffLine, ReviewIssue, ProviderCapabilities,
    ReviewIssueStatus, FileChangeType, Reviewer, ProviderInstanceConfig
} from '../types';
import {
    ICodeReviewProvider, IPullRequestProvider, IDiffProvider, ICommentProvider,
    IAuthProvider, PullRequestFilter
} from './provider';
import { logger } from '../logging/logger';
import { ProviderError, AuthError } from '../errors';

// ── GitHub API helpers ─────────────────────────────────────────────────

interface GitHubApiOptions {
    method?: string;
    body?: unknown;
    accept?: string;
}

interface GitHubApiResponse<T> {
    data: T;
    headers: Record<string, string | string[] | undefined>;
}

/**
 * Parse the RFC 5988 Link header returned by GitHub to extract the URL
 * for the requested relation (e.g. "next").
 */
function parseLinkHeader(header: string | undefined): Map<string, string> {
    const links = new Map<string, string>();
    if (!header) { return links; }
    const parts = header.split(',');
    for (const part of parts) {
        const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
        if (match) {
            links.set(match[2], match[1]);
        }
    }
    return links;
}

/**
 * Low-level HTTPS request wrapper for the GitHub REST API.
 * Handles auth, headers, JSON parsing, and error mapping.
 */
function githubRequest<T>(
    path: string,
    token: string,
    options: GitHubApiOptions = {},
): Promise<GitHubApiResponse<T>> {
    return new Promise((resolve, reject) => {
        const method = options.method ?? 'GET';
        const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

        const reqOptions: https.RequestOptions = {
            hostname: 'api.github.com',
            path,
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': options.accept ?? 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'CodepilotReview-VSCode',
                ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
            },
        };

        const req = https.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                const statusCode = res.statusCode ?? 0;
                const responseHeaders: Record<string, string | string[] | undefined> = {};
                for (const [k, v] of Object.entries(res.headers)) {
                    responseHeaders[k] = v;
                }

                if (statusCode === 204) {
                    return resolve({ data: undefined as unknown as T, headers: responseHeaders });
                }

                let parsed: unknown;
                try {
                    parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
                } catch {
                    return reject(new ProviderError(
                        `GitHub API returned non-JSON response (${statusCode}): ${raw.slice(0, 200)}`,
                        'github',
                    ));
                }

                if (statusCode === 401 || statusCode === 403) {
                    const msg = (parsed as Record<string, string>)?.message ?? 'Authentication failed';
                    return reject(new AuthError(`GitHub API ${statusCode}: ${msg}`));
                }
                if (statusCode === 404) {
                    return reject(new ProviderError(
                        `GitHub API resource not found: ${path}`,
                        'github',
                    ));
                }
                if (statusCode === 422) {
                    const msg = (parsed as Record<string, string>)?.message ?? 'Validation failed';
                    return reject(new ProviderError(`GitHub API 422: ${msg}`, 'github'));
                }
                if (statusCode === 429) {
                    return reject(new ProviderError(
                        'GitHub API rate limit exceeded. Please wait and try again.',
                        'github',
                    ));
                }
                if (statusCode >= 400) {
                    const msg = (parsed as Record<string, string>)?.message ?? raw.slice(0, 200);
                    return reject(new ProviderError(`GitHub API ${statusCode}: ${msg}`, 'github'));
                }

                resolve({ data: parsed as T, headers: responseHeaders });
            });
        });

        req.on('error', (err) =>
            reject(new ProviderError(`GitHub API request failed: ${err.message}`, 'github', err)),
        );

        if (bodyStr) { req.write(bodyStr); }
        req.end();
    });
}

/**
 * Fetch all pages of a paginated GitHub list endpoint.
 */
async function githubPaginatedGet<T>(
    path: string,
    token: string,
    maxPages: number = 10,
): Promise<T[]> {
    const results: T[] = [];
    let url: string | undefined = path;
    let page = 0;

    while (url && page < maxPages) {
        // For subsequent pages the Link header gives a full URL; extract the path.
        const requestPath = url.startsWith('https://') ? url.replace('https://api.github.com', '') : url;
        const resp = await githubRequest<T[]>(requestPath, token);
        if (Array.isArray(resp.data)) {
            results.push(...resp.data);
        }
        const linkHeader = resp.headers['link'];
        const links = parseLinkHeader(Array.isArray(linkHeader) ? linkHeader[0] : linkHeader);
        url = links.get('next');
        page++;
    }

    return results;
}

// ── Token helper ───────────────────────────────────────────────────────

async function getGitHubToken(createIfNone: boolean = false): Promise<string | undefined> {
    try {
        const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone });
        return session?.accessToken;
    } catch (err) {
        logger.warn('Failed to obtain GitHub session', err);
        return undefined;
    }
}

async function requireToken(): Promise<string> {
    // First try silently, then prompt if needed
    let token = await getGitHubToken(false);
    if (!token) {
        token = await getGitHubToken(true);
    }
    if (!token) {
        throw new AuthError('Not authenticated with GitHub. Please sign in first.');
    }
    return token;
}

// ── Mapping helpers ────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapPullRequest(pr: any, providerName: string, providerId: string): PullRequest {
    const isDraft: boolean = pr.draft === true;
    let status: PullRequest['status'];
    if (isDraft) {
        status = 'draft';
    } else if (pr.merged_at || pr.merged) {
        status = 'merged';
    } else if (pr.state === 'closed') {
        status = 'closed';
    } else {
        status = 'open';
    }

    const reviewers: Reviewer[] = (pr.requested_reviewers ?? []).map((r: any) => ({
        name: r.login ?? r.name ?? '',
        id: String(r.id ?? ''),
        isRequired: false,
        vote: 'none' as const,
    }));

    return {
        id: String(pr.number),
        title: pr.title ?? '',
        description: pr.body ?? '',
        author: pr.user?.login ?? '',
        status,
        url: pr.html_url ?? '',
        sourceBranch: pr.head?.ref ?? '',
        targetBranch: pr.base?.ref ?? '',
        createdAt: new Date(pr.created_at),
        updatedAt: new Date(pr.updated_at),
        reviewers,
        labels: (pr.labels ?? []).map((l: any) => l.name ?? l),
        userNeed: 'optional',
        providerName,
        providerId,
    };
}

function mapFileChangeType(status: string): FileChangeType {
    switch (status) {
        case 'added': return 'added';
        case 'removed': return 'deleted';
        case 'renamed': return 'renamed';
        case 'copied': return 'copied';
        default: return 'modified';
    }
}

/**
 * Parse a unified-diff patch string into DiffHunk[].
 */
function parsePatch(patch: string | undefined): DiffHunk[] {
    if (!patch) { return []; }
    const hunks: DiffHunk[] = [];
    const lines = patch.split('\n');
    let currentHunk: DiffHunk | undefined;

    for (const line of lines) {
        const hunkHeader = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/);
        if (hunkHeader) {
            currentHunk = {
                oldStart: parseInt(hunkHeader[1], 10),
                oldLines: parseInt(hunkHeader[2] ?? '1', 10),
                newStart: parseInt(hunkHeader[3], 10),
                newLines: parseInt(hunkHeader[4] ?? '1', 10),
                header: hunkHeader[5]?.trim() ?? '',
                lines: [],
            };
            hunks.push(currentHunk);
            continue;
        }

        if (!currentHunk) { continue; }

        if (line.startsWith('+')) {
            currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        } else if (line.startsWith('-')) {
            currentHunk.lines.push({ type: 'delete', content: line.slice(1) });
        } else if (line.startsWith(' ') || line === '') {
            currentHunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
        }
    }

    // Assign line numbers
    for (const hunk of hunks) {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const dl of hunk.lines) {
            switch (dl.type) {
                case 'context':
                    dl.oldLineNumber = oldLine++;
                    dl.newLineNumber = newLine++;
                    break;
                case 'delete':
                    dl.oldLineNumber = oldLine++;
                    break;
                case 'add':
                    dl.newLineNumber = newLine++;
                    break;
            }
        }
    }

    return hunks;
}

function mapComment(c: any): ReviewIssue {
    return {
        id: String(c.id),
        summary: c.body?.split('\n')[0]?.slice(0, 120) ?? '',
        details: c.body ?? '',
        position: {
            filePath: c.path ?? '',
            line: c.line ?? c.original_line ?? c.position ?? 0,
            side: c.side === 'LEFT' ? 'base' : 'head',
        },
        status: 'published',
        source: 'provider',
        createdAt: new Date(c.created_at),
        providerCommentId: String(c.id),
    };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Provider implementation ────────────────────────────────────────────

/**
 * GitHub code review provider using the GitHub REST API via built-in https.
 */
export class GitHubProvider implements ICodeReviewProvider {
    readonly name = 'github';
    readonly capabilities: ProviderCapabilities = {
        supportsDraftComments: true,
        supportsPublishing: true,
        supportsThreads: true,
        supportsSuggestedFixes: true,
        supportsReviewVotes: true,
        supportsLabels: true,
        requiresAuthentication: true,
    };

    readonly pullRequests: IPullRequestProvider;
    readonly diff: IDiffProvider;
    readonly comments: ICommentProvider;
    readonly auth: IAuthProvider;

    private instanceConfig: ProviderInstanceConfig | undefined;
    private owner: string = '';
    private repo: string = '';

    constructor(instanceConfig?: ProviderInstanceConfig) {
        this.instanceConfig = instanceConfig;
        this.pullRequests = new GitHubPullRequestProvider(this);
        this.diff = new GitHubDiffProvider(this);
        this.comments = new GitHubCommentProvider(this);
        this.auth = new GitHubAuthProvider(this);
    }

    async initialize(_context: vscode.ExtensionContext): Promise<void> {
        if (this.instanceConfig) {
            this.owner = this.instanceConfig.owner || '';
            this.repo = this.instanceConfig.repo || '';
        }

        if (!this.owner || !this.repo) {
            logger.warn('GitHub owner and repo must be configured');
        }

        logger.info(`GitHub provider initialized: ${this.owner}/${this.repo}`);
    }

    dispose(): void {
        // Clean up resources
    }

    getOwner(): string { return this.owner; }
    getRepo(): string { return this.repo; }
    getInstanceId(): string { return this.instanceConfig?.id || this.name; }
}

// ── Pull Requests ──────────────────────────────────────────────────────

class GitHubPullRequestProvider implements IPullRequestProvider {
    constructor(private provider: GitHubProvider) {}

    async getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        // Map filter status to GitHub API state parameter
        let state = 'open';
        if (filter?.status) {
            if (filter.status.includes('all') || (filter.status.includes('open') && filter.status.includes('closed'))) {
                state = 'all';
            } else if (filter.status.includes('closed') || filter.status.includes('merged')) {
                state = 'closed';
            }
        }

        const params = new URLSearchParams({ state, per_page: '100' });

        let prs = await githubPaginatedGet<any>(
            `/repos/${owner}/${repo}/pulls?${params.toString()}`,
            token,
        );

        // Client-side filtering
        if (filter?.author) {
            const authorLower = filter.author.toLowerCase();
            prs = prs.filter((pr: any) => pr.user?.login?.toLowerCase() === authorLower);
        }
        if (filter?.searchText) {
            const searchLower = filter.searchText.toLowerCase();
            prs = prs.filter((pr: any) => pr.title?.toLowerCase().includes(searchLower));
        }
        if (filter?.labels && filter.labels.length > 0) {
            const wantedLabels = new Set(filter.labels.map(l => l.toLowerCase()));
            prs = prs.filter((pr: any) =>
                (pr.labels ?? []).some((l: any) => wantedLabels.has((l.name ?? '').toLowerCase())),
            );
        }
        if (filter?.createdAfter) {
            const after = filter.createdAfter.getTime();
            prs = prs.filter((pr: any) => new Date(pr.created_at).getTime() >= after);
        }
        if (filter?.createdBefore) {
            const before = filter.createdBefore.getTime();
            prs = prs.filter((pr: any) => new Date(pr.created_at).getTime() <= before);
        }
        // If merged filter was requested, filter for merged PRs only
        if (filter?.status?.includes('merged') && !filter.status.includes('closed')) {
            prs = prs.filter((pr: any) => pr.merged_at !== null && pr.merged_at !== undefined);
        }

        logger.info(`GitHub getPullRequests: found ${prs.length} PRs`);
        return prs.map((pr: any) => mapPullRequest(pr, this.provider.name, this.provider.getInstanceId()));
    }

    async getPullRequest(id: string): Promise<PullRequest | undefined> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        try {
            const resp = await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/${id}`,
                token,
            );
            return mapPullRequest(resp.data, this.provider.name, this.provider.getInstanceId());
        } catch (err) {
            if (err instanceof ProviderError && err.message.includes('not found')) {
                return undefined;
            }
            throw err;
        }
    }
}

// ── Diff ───────────────────────────────────────────────────────────────

class GitHubDiffProvider implements IDiffProvider {
    constructor(private provider: GitHubProvider) {}

    async getDiff(pullRequestId: string): Promise<DiffFile[]> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        // Fetch PR metadata to get base/head SHAs
        const prResp = await githubRequest<any>(
            `/repos/${owner}/${repo}/pulls/${pullRequestId}`,
            token,
        );
        const baseSha: string = prResp.data.base?.sha ?? '';
        const headSha: string = prResp.data.head?.sha ?? '';

        const files = await githubPaginatedGet<any>(
            `/repos/${owner}/${repo}/pulls/${pullRequestId}/files?per_page=100`,
            token,
        );

        logger.info(`GitHub getDiff: ${files.length} files in PR #${pullRequestId}`);

        return files.map((f: any): DiffFile => ({
            oldPath: f.status === 'added' ? undefined : (f.previous_filename ?? f.filename),
            newPath: f.status === 'removed' ? undefined : f.filename,
            hunks: parsePatch(f.patch),
            oldRevision: baseSha,
            newRevision: headSha,
            changeType: mapFileChangeType(f.status),
            isBinary: f.patch === undefined && f.changes === 0,
        }));
    }

    async getFileContent(filePath: string, revision: string): Promise<string> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
        const resp = await githubRequest<any>(
            `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(revision)}`,
            token,
        );

        const data = resp.data;
        if (data.encoding === 'base64' && data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return data.content ?? '';
    }
}

// ── Comments ───────────────────────────────────────────────────────────

class GitHubCommentProvider implements ICommentProvider {
    constructor(private provider: GitHubProvider) {}

    async getComments(pullRequestId: string): Promise<ReviewIssue[]> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        const comments = await githubPaginatedGet<any>(
            `/repos/${owner}/${repo}/pulls/${pullRequestId}/comments?per_page=100`,
            token,
        );

        logger.info(`GitHub getComments: ${comments.length} comments on PR #${pullRequestId}`);
        return comments.map(mapComment);
    }

    async publishComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        const body = issue.details || issue.summary;

        if (issue.position.filePath && issue.position.line > 0) {
            // File-level review comment — requires the latest commit on the PR head
            const prResp = await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/${pullRequestId}`,
                token,
            );
            const commitId: string = prResp.data.head?.sha ?? '';

            const payload: Record<string, unknown> = {
                body,
                commit_id: commitId,
                path: issue.position.filePath,
                side: issue.position.side === 'base' ? 'LEFT' : 'RIGHT',
                line: issue.position.line,
            };

            const resp = await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/${pullRequestId}/comments`,
                token,
                { method: 'POST', body: payload },
            );

            return {
                ...issue,
                id: String(resp.data.id),
                status: 'published',
                providerCommentId: String(resp.data.id),
            };
        } else {
            // PR-level (issue) comment
            const resp = await githubRequest<any>(
                `/repos/${owner}/${repo}/issues/${pullRequestId}/comments`,
                token,
                { method: 'POST', body: { body } },
            );

            return {
                ...issue,
                id: String(resp.data.id),
                status: 'published',
                providerCommentId: String(resp.data.id),
            };
        }
    }

    async updateComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();
        const commentId = issue.providerCommentId;

        if (!commentId) {
            throw new ProviderError('Cannot update comment without providerCommentId', 'github');
        }

        const body = issue.details || issue.summary;

        // Try as a pull request review comment first
        try {
            await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
                token,
                { method: 'PATCH', body: { body } },
            );
        } catch {
            // Fall back to issue comment
            await githubRequest<any>(
                `/repos/${owner}/${repo}/issues/comments/${commentId}`,
                token,
                { method: 'PATCH', body: { body } },
            );
        }

        // Suppress unused variable warning — pullRequestId is part of the interface
        void pullRequestId;

        return { ...issue, details: body };
    }

    async deleteComment(pullRequestId: string, commentId: string): Promise<void> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        try {
            await githubRequest<void>(
                `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
                token,
                { method: 'DELETE' },
            );
        } catch {
            // Fall back to issue comment
            await githubRequest<void>(
                `/repos/${owner}/${repo}/issues/comments/${commentId}`,
                token,
                { method: 'DELETE' },
            );
        }

        void pullRequestId;
        logger.info(`GitHub deleteComment: deleted comment ${commentId}`);
    }

    async updateCommentStatus(
        pullRequestId: string,
        commentId: string,
        status: ReviewIssueStatus,
    ): Promise<void> {
        // GitHub doesn't have a native comment status field.
        // We emulate it by prepending a status tag to the comment body.
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        let existing: any;
        try {
            const resp = await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
                token,
            );
            existing = resp.data;
        } catch {
            const resp = await githubRequest<any>(
                `/repos/${owner}/${repo}/issues/comments/${commentId}`,
                token,
            );
            existing = resp.data;
        }

        // Strip any existing status tag and prepend the new one
        let body: string = existing.body ?? '';
        body = body.replace(/^\[status:\s*\w+\]\s*/i, '');
        if (status !== 'published') {
            body = `[status: ${status}] ${body}`;
        }

        try {
            await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
                token,
                { method: 'PATCH', body: { body } },
            );
        } catch {
            await githubRequest<any>(
                `/repos/${owner}/${repo}/issues/comments/${commentId}`,
                token,
                { method: 'PATCH', body: { body } },
            );
        }

        void pullRequestId;
        logger.info(`GitHub updateCommentStatus: ${commentId} → ${status}`);
    }
}

// ── Auth ───────────────────────────────────────────────────────────────

class GitHubAuthProvider implements IAuthProvider {
    private session: vscode.AuthenticationSession | undefined;

    constructor(private provider: GitHubProvider) {}

    async isAuthenticated(): Promise<boolean> {
        try {
            const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
            this.session = session;
            return session !== undefined;
        } catch {
            return false;
        }
    }

    async authenticate(): Promise<boolean> {
        try {
            const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
            this.session = session;
            if (session) {
                logger.info(`GitHub authenticated as ${session.account.label}`);
                return true;
            }
            return false;
        } catch (err) {
            logger.error('GitHub authentication failed', err);
            throw new AuthError('GitHub authentication failed', err);
        }
    }

    async signOut(): Promise<void> {
        this.session = undefined;
        // VS Code doesn't expose a sign-out API for built-in auth providers;
        // clearing the cached session is the best we can do.
        logger.info('GitHub session cleared');
        void this.provider;
    }

    async getCurrentUser(): Promise<string | undefined> {
        if (this.session) {
            return this.session.account.label;
        }
        const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
        return session?.account.label;
    }
}
