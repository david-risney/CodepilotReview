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

/** Execute a GitHub GraphQL query/mutation */
async function githubGraphQL<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
    const resp = await githubRequest<any>(
        '/graphql',
        token,
        { method: 'POST', body: { query, variables } },
    );
    if (resp.data.errors?.length) {
        throw new ProviderError(
            `GitHub GraphQL error: ${resp.data.errors[0].message}`,
            'github',
        );
    }
    return resp.data.data as T;
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
        parentIssueId: c.in_reply_to_id ? String(c.in_reply_to_id) : undefined,
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
        supportsCommentEdit: true,
        supportsCommentDelete: true,
        supportsCommentResolve: true,
        commentStatuses: ['published', 'resolved'],
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

        if (!this.owner && !this.repo) {
            logger.info('GitHub provider initialized in cross-repo search mode');
        } else if (!this.owner || !this.repo) {
            logger.warn('GitHub owner and repo must both be configured (or both empty for cross-repo mode)');
        } else {
            logger.info(`GitHub provider initialized: ${this.owner}/${this.repo}`);
        }
    }

    dispose(): void {
        // Clean up resources
    }

    getOwner(): string { return this.owner; }
    getRepo(): string { return this.repo; }
    getInstanceId(): string { return this.instanceConfig?.id || this.name; }

    /** True when owner/repo are empty — uses search API for cross-repo queries */
    isCrossRepoMode(): boolean { return !this.owner && !this.repo; }

    /**
     * Parse a PR id that may be a compound "owner/repo#number" (cross-repo mode)
     * or a plain number string (single-repo mode).
     */
    parsePrId(prId: string): { owner: string; repo: string; number: string } {
        const match = prId.match(/^(.+?)\/(.+?)#(\d+)$/);
        if (match) {
            return { owner: match[1], repo: match[2], number: match[3] };
        }
        return { owner: this.owner, repo: this.repo, number: prId };
    }
}

// ── Pull Requests ──────────────────────────────────────────────────────

class GitHubPullRequestProvider implements IPullRequestProvider {
    constructor(private provider: GitHubProvider) {}

    async getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]> {
        const token = await requireToken();
        const owner = this.provider.getOwner();
        const repo = this.provider.getRepo();

        // Cross-repo mode: use GitHub Search API
        if (this.provider.isCrossRepoMode()) {
            return this.searchPullRequests(token, filter);
        }

        // Single-repo mode: use per-repo pulls endpoint
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

    /**
     * Cross-repo search using GitHub Search API.
     * Returns PRs from any repo matching the search criteria.
     */
    private async searchPullRequests(token: string, filter?: PullRequestFilter): Promise<PullRequest[]> {
        // Build search query
        const queryParts: string[] = ['is:pr'];

        // Status
        if (filter?.status) {
            if (filter.status.includes('merged')) {
                queryParts.push('is:merged');
            } else if (filter.status.includes('closed')) {
                queryParts.push('is:closed');
            } else if (filter.status.includes('open') || filter.status.length === 0) {
                queryParts.push('is:open');
            }
        } else {
            queryParts.push('is:open');
        }

        // Author
        if (filter?.author) {
            queryParts.push(`author:${filter.author}`);
        }

        // Reviewer (map to review-requested or reviewed-by)
        if (filter?.reviewer) {
            queryParts.push(`review-requested:${filter.reviewer}`);
        }

        // Labels
        if (filter?.labels) {
            for (const label of filter.labels) {
                queryParts.push(`label:"${label}"`);
            }
        }

        // Text search
        if (filter?.searchText) {
            queryParts.push(filter.searchText);
        }

        // Default: show PRs involving the authenticated user
        if (!filter?.author && !filter?.reviewer && !filter?.searchText) {
            queryParts.push('involves:@me');
        }

        const q = encodeURIComponent(queryParts.join(' '));
        const resp = await githubRequest<any>(
            `/search/issues?q=${q}&per_page=100&sort=updated&order=desc`,
            token,
        );

        const items = resp.data?.items ?? [];
        logger.info(`GitHub search PRs: found ${items.length} PRs (query: ${queryParts.join(' ')})`);

        // Map search results to PullRequest — extract owner/repo from repository_url
        return items.map((item: any) => {
            const repoUrl: string = item.repository_url ?? '';
            // repository_url is like "https://api.github.com/repos/owner/repo"
            const repoParts = repoUrl.split('/');
            const itemRepo = repoParts[repoParts.length - 1] ?? '';
            const itemOwner = repoParts[repoParts.length - 2] ?? '';

            const pr = mapPullRequest(item, this.provider.name, this.provider.getInstanceId());
            // Use compound ID so diff/comments can resolve the correct repo
            pr.id = `${itemOwner}/${itemRepo}#${item.number}`;
            // Fix branches — search results use pull_request object
            if (item.pull_request) {
                pr.url = item.pull_request.html_url ?? pr.url;
            }
            // Add repo context to description
            pr.description = `[${itemOwner}/${itemRepo}] ${pr.description}`;
            return pr;
        });
    }

    async getPullRequest(id: string): Promise<PullRequest | undefined> {
        const token = await requireToken();
        const { owner, repo, number } = this.provider.parsePrId(id);

        try {
            const resp = await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/${number}`,
                token,
            );
            const pr = mapPullRequest(resp.data, this.provider.name, this.provider.getInstanceId());
            if (this.provider.isCrossRepoMode()) {
                pr.id = `${owner}/${repo}#${number}`;
            }
            return pr;
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
        const { owner, repo, number } = this.provider.parsePrId(pullRequestId);

        // Fetch PR metadata to get base/head SHAs
        const prResp = await githubRequest<any>(
            `/repos/${owner}/${repo}/pulls/${number}`,
            token,
        );
        const baseSha: string = prResp.data.base?.sha ?? '';
        const headSha: string = prResp.data.head?.sha ?? '';

        const files = await githubPaginatedGet<any>(
            `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
            token,
        );

        logger.info(`GitHub getDiff: ${files.length} files in PR #${number}`);

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

        // In cross-repo mode, the revision may include repo info encoded as "owner/repo:sha"
        let resolvedOwner = owner;
        let resolvedRepo = repo;
        let resolvedRevision = revision;
        const repoMatch = revision.match(/^(.+?)\/(.+?):(.+)$/);
        if (repoMatch) {
            resolvedOwner = repoMatch[1];
            resolvedRepo = repoMatch[2];
            resolvedRevision = repoMatch[3];
        }

        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
        const resp = await githubRequest<any>(
            `/repos/${resolvedOwner}/${resolvedRepo}/contents/${encodedPath}?ref=${encodeURIComponent(resolvedRevision)}`,
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

/** Maps comment REST ID → thread GraphQL node ID for resolve/unresolve */
const commentThreadNodeIds = new Map<string, string>();

class GitHubCommentProvider implements ICommentProvider {
    constructor(private provider: GitHubProvider) {}

    async getComments(pullRequestId: string): Promise<ReviewIssue[]> {
        const token = await requireToken();
        const { owner, repo, number } = this.provider.parsePrId(pullRequestId);

        // Fetch comments via REST for full data
        const comments = await githubPaginatedGet<any>(
            `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
            token,
        );

        // Fetch thread resolution state via GraphQL
        const threadResolution = await this.fetchThreadResolution(owner, repo, number, token);

        logger.info(`GitHub getComments: ${comments.length} comments on PR #${number}`);

        return comments.map((c: any) => {
            const issue = mapComment(c);
            // Match comment to its thread resolution state via node_id
            const nodeId = c.node_id;
            if (nodeId && threadResolution.has(nodeId)) {
                const threadInfo = threadResolution.get(nodeId)!;
                if (threadInfo.isResolved) {
                    issue.status = 'resolved';
                }
                // Store thread node ID for later resolve/unresolve
                commentThreadNodeIds.set(String(c.id), threadInfo.threadNodeId);
            }
            return issue;
        });
    }

    /** Fetch thread resolution state and map comment node IDs → thread node IDs */
    private async fetchThreadResolution(
        owner: string, repo: string, prNumber: string, token: string,
    ): Promise<Map<string, { isResolved: boolean; threadNodeId: string }>> {
        const map = new Map<string, { isResolved: boolean; threadNodeId: string }>();

        try {
            const query = `
                query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
                    repository(owner: $owner, name: $repo) {
                        pullRequest(number: $number) {
                            reviewThreads(first: 100, after: $cursor) {
                                nodes {
                                    id
                                    isResolved
                                    comments(first: 1) {
                                        nodes { id }
                                    }
                                }
                                pageInfo { hasNextPage endCursor }
                            }
                        }
                    }
                }
            `;

            let cursor: string | null = null;
            let hasNext = true;

            while (hasNext) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const result: any = await githubGraphQL<any>(
                    query,
                    { owner, repo, number: parseInt(prNumber, 10), cursor },
                    token,
                );

                const threads: any = result.repository?.pullRequest?.reviewThreads;
                if (!threads) { break; }

                for (const thread of threads.nodes) {
                    const firstCommentNodeId = thread.comments?.nodes?.[0]?.id;
                    if (firstCommentNodeId) {
                        map.set(firstCommentNodeId, {
                            isResolved: thread.isResolved,
                            threadNodeId: thread.id,
                        });
                    }
                }

                hasNext = threads.pageInfo.hasNextPage;
                cursor = threads.pageInfo.endCursor;
            }
        } catch (error) {
            // GraphQL may fail (e.g. token lacks permissions); fall back gracefully
            logger.warn('GitHub: failed to fetch thread resolution state via GraphQL', error);
        }

        return map;
    }

    async publishComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        const token = await requireToken();
        const { owner, repo, number } = this.provider.parsePrId(pullRequestId);

        const body = issue.details || issue.summary;

        if (issue.position.filePath && issue.position.line > 0) {
            // File-level review comment — requires the latest commit on the PR head
            const prResp = await githubRequest<any>(
                `/repos/${owner}/${repo}/pulls/${number}`,
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
                `/repos/${owner}/${repo}/pulls/${number}/comments`,
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
                `/repos/${owner}/${repo}/issues/${number}/comments`,
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

    async replyToComment(pullRequestId: string, parentProviderCommentId: string, body: string): Promise<ReviewIssue> {
        const token = await requireToken();
        const { owner, repo } = this.provider.parsePrId(pullRequestId);

        const resp = await githubRequest<any>(
            `/repos/${owner}/${repo}/pulls/comments/${parentProviderCommentId}/replies`,
            token,
            { method: 'POST', body: { body } },
        );

        return mapComment(resp.data);
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
        const token = await requireToken();

        // GitHub supports resolved/unresolved via GraphQL thread mutations
        const threadNodeId = commentThreadNodeIds.get(commentId);

        if (!threadNodeId) {
            logger.warn(`GitHub updateCommentStatus: no thread node ID for comment ${commentId}, cannot resolve/unresolve`);
            return;
        }

        if (status === 'resolved') {
            await githubGraphQL<any>(
                `mutation($threadId: ID!) {
                    resolveReviewThread(input: { threadId: $threadId }) {
                        thread { id isResolved }
                    }
                }`,
                { threadId: threadNodeId },
                token,
            );
        } else if (status === 'published') {
            // Unresolve = set back to active/published
            await githubGraphQL<any>(
                `mutation($threadId: ID!) {
                    unresolveReviewThread(input: { threadId: $threadId }) {
                        thread { id isResolved }
                    }
                }`,
                { threadId: threadNodeId },
                token,
            );
        } else {
            logger.warn(`GitHub updateCommentStatus: status '${status}' not natively supported, only resolved/published`);
            return;
        }

        void pullRequestId;
        logger.info(`GitHub updateCommentStatus: ${commentId} → ${status} (thread ${threadNodeId})`);
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
