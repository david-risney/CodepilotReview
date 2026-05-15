import * as vscode from 'vscode';
import * as https from 'https';
import {
    PullRequest, DiffFile, DiffHunk, DiffLine, ReviewIssue, ProviderCapabilities,
    ReviewIssueStatus, ReviewVote, FileChangeType
} from '../types';
import {
    ICodeReviewProvider, IPullRequestProvider, IDiffProvider, ICommentProvider,
    IAuthProvider, PullRequestFilter
} from './provider';
import { logger } from '../logging/logger';
import { ProviderError, AuthError } from '../errors';

// ── ADO API helper ──────────────────────────────────────────────────────────

interface AdoRequestOptions {
    method?: string;
    body?: unknown;
    apiVersion?: string;
    /** Extra query-string parameters */
    query?: Record<string, string>;
    /** If true, return raw string instead of parsed JSON */
    raw?: boolean;
}

/**
 * Make an Azure DevOps REST API request.
 * Handles auth (Bearer or PAT), JSON parsing, and error mapping.
 */
async function adoRequest<T = unknown>(
    baseUrl: string,
    path: string,
    token: string,
    isPat: boolean,
    options: AdoRequestOptions = {},
): Promise<T> {
    const { method = 'GET', body, apiVersion = '7.1', query = {}, raw = false } = options;

    const qs = new URLSearchParams({ 'api-version': apiVersion, ...query }).toString();
    const fullUrl = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${qs}`;

    const url = new URL(fullUrl);
    const authHeader = isPat
        ? `Basic ${Buffer.from(`:${token}`).toString('base64')}`
        : `Bearer ${token}`;

    const reqOptions: https.RequestOptions = {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
            'Authorization': authHeader,
            'Accept': 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
    };

    return new Promise<T>((resolve, reject) => {
        const req = https.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                const statusCode = res.statusCode ?? 0;
                if (statusCode === 401 || statusCode === 403) {
                    reject(new AuthError(`ADO API auth failed (${statusCode}): ${text}`));
                    return;
                }
                if (statusCode === 204) {
                    resolve(undefined as unknown as T);
                    return;
                }
                if (statusCode < 200 || statusCode >= 300) {
                    reject(new ProviderError(
                        `ADO API ${method} ${path} returned ${statusCode}: ${text}`,
                        'azureDevOps',
                    ));
                    return;
                }
                if (raw) {
                    resolve(text as unknown as T);
                    return;
                }
                try {
                    resolve(JSON.parse(text) as T);
                } catch (e) {
                    reject(new ProviderError(`Failed to parse ADO response: ${text}`, 'azureDevOps', e));
                }
            });
        });
        req.on('error', (e) => reject(new ProviderError(`ADO API request failed: ${e.message}`, 'azureDevOps', e)));
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/** Paginated fetch – ADO uses x-ms-continuationtoken header or continuationToken in response. */
async function adoRequestPaginated<TItem>(
    baseUrl: string,
    path: string,
    token: string,
    isPat: boolean,
    options: AdoRequestOptions = {},
): Promise<TItem[]> {
    const allItems: TItem[] = [];
    let skip = 0;
    const top = 100;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const query = { ...options.query, '$top': String(top), '$skip': String(skip) };
        const response = await adoRequest<{ value: TItem[]; count: number }>(
            baseUrl, path, token, isPat, { ...options, query },
        );
        if (!response.value || response.value.length === 0) {
            break;
        }
        allItems.push(...response.value);
        if (response.value.length < top) {
            break;
        }
        skip += top;
    }
    return allItems;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapAdoStatus(adoStatus: string): 'open' | 'closed' | 'merged' | 'draft' | 'abandoned' {
    switch (adoStatus) {
        case 'active': return 'open';
        case 'completed': return 'merged';
        case 'abandoned': return 'abandoned';
        default: return 'open';
    }
}

function mapAdoVote(vote: number): ReviewVote {
    // ADO vote values: 10=approved, 5=approvedWithSuggestions, 0=noVote, -5=waitingForAuthor, -10=rejected
    if (vote >= 10) { return 'approved'; }
    if (vote > 0) { return 'approvedWithSuggestions'; }
    if (vote === 0) { return 'none'; }
    if (vote > -10) { return 'waitForAuthor'; }
    return 'rejected';
}

function mapAdoChangeType(changeType: number): FileChangeType {
    // ADO VersionControlChangeType enum values
    switch (changeType) {
        case 1: return 'added';    // Add
        case 2: return 'modified'; // Edit
        case 16: return 'deleted'; // Delete
        case 8: return 'renamed';  // Rename
        default: return 'modified';
    }
}

function mapAdoThreadStatus(status: number): ReviewIssueStatus {
    // ADO CommentThreadStatus: 0=unknown, 1=active, 2=fixed(resolved), 3=wontFix, 4=closed, 5=byDesign, 6=pending
    switch (status) {
        case 1: return 'published';
        case 2: return 'resolved';
        case 3: return 'dismissed';
        case 4: return 'resolved';
        case 5: return 'dismissed';
        case 6: return 'draft';
        default: return 'published';
    }
}

function reviewIssueStatusToAdoThreadStatus(status: ReviewIssueStatus): number {
    switch (status) {
        case 'resolved': return 2; // fixed
        case 'dismissed': return 3; // wontFix
        case 'draft': return 6; // pending
        case 'published': return 1; // active
        default: return 1;
    }
}

function statusFilterToAdoStatus(statuses?: string[]): string | undefined {
    if (!statuses || statuses.length === 0) { return undefined; }
    // ADO supports a single status per request; prefer the first meaningful one
    for (const s of statuses) {
        switch (s) {
            case 'open': return 'active';
            case 'merged': return 'completed';
            case 'closed':
            case 'abandoned': return 'abandoned';
        }
    }
    // 'all' => return undefined (no filter)
    return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapAdoPullRequest(pr: any, providerName: string, webBaseUrl: string): PullRequest {
    const reviewers = (pr.reviewers ?? []).map((r: any) => ({
        name: r.displayName ?? r.uniqueName ?? '',
        id: r.id ?? '',
        isRequired: r.isRequired ?? false,
        vote: mapAdoVote(r.vote ?? 0),
    }));

    return {
        id: String(pr.pullRequestId),
        title: pr.title ?? '',
        description: pr.description ?? '',
        author: pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? '',
        status: pr.isDraft ? 'draft' : mapAdoStatus(pr.status ?? 'active'),
        url: `${webBaseUrl}/_git/${encodeURIComponent(pr.repository?.name ?? '')}/pullrequest/${pr.pullRequestId}`,
        sourceBranch: (pr.sourceRefName ?? '').replace('refs/heads/', ''),
        targetBranch: (pr.targetRefName ?? '').replace('refs/heads/', ''),
        createdAt: new Date(pr.creationDate),
        updatedAt: new Date(pr.closedDate ?? pr.creationDate),
        reviewers,
        labels: (pr.labels ?? []).map((l: any) => l.name ?? ''),
        isUserRequired: reviewers.some((r: any) => r.isRequired),
        providerName,
    };
}

// ── Main provider ───────────────────────────────────────────────────────────

export class AzureDevOpsProvider implements ICodeReviewProvider {
    readonly name = 'azureDevOps';
    readonly capabilities: ProviderCapabilities = {
        supportsDraftComments: true,
        supportsPublishing: true,
        supportsThreads: true,
        supportsSuggestedFixes: false,
        supportsReviewVotes: true,
        supportsLabels: true,
        requiresAuthentication: true,
    };

    readonly pullRequests: IPullRequestProvider;
    readonly diff: IDiffProvider;
    readonly comments: ICommentProvider;
    readonly auth: IAuthProvider;

    private organization = '';
    private project = '';
    private repositoryId = '';
    private token = '';
    private isPat = false;
    private currentUser = '';

    constructor() {
        this.pullRequests = new AdoPullRequestProvider(this);
        this.diff = new AdoDiffProvider(this);
        this.comments = new AdoCommentProvider(this);
        this.auth = new AdoAuthProvider(this);
    }

    async initialize(_context: vscode.ExtensionContext): Promise<void> {
        this.loadConfig();
        logger.info(`ADO provider initialized: ${this.organization}/${this.project}`);
    }

    dispose(): void {
        this.token = '';
    }

    // ── Internal accessors ──────────────────────────────────────────────────

    loadConfig(): void {
        const config = vscode.workspace.getConfiguration('codepilotReview');
        this.organization = config.get<string>('azureDevOps.organization', '');
        this.project = config.get<string>('azureDevOps.project', '');
        this.repositoryId = config.get<string>('azureDevOps.repositoryId', '');

        if (!this.repositoryId) {
            // Try to infer from git remote
            this.repositoryId = this.inferRepoFromGitRemote();
        }

        if (!this.organization || !this.project) {
            logger.warn('Azure DevOps organization and project must be configured');
        }
    }

    private inferRepoFromGitRemote(): string {
        try {
            const gitExt = vscode.extensions.getExtension('vscode.git');
            if (gitExt?.isActive) {
                const git = gitExt.exports.getAPI(1);
                const repo = git.repositories[0];
                if (repo) {
                    const remote = repo.state.remotes.find((r: any) => r.name === 'origin');
                    const url = remote?.fetchUrl ?? remote?.pushUrl ?? '';
                    // Parse ADO remote URLs:
                    //   https://dev.azure.com/{org}/{project}/_git/{repo}
                    //   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
                    const httpsMatch = url.match(/dev\.azure\.com\/[^/]+\/[^/]+\/_git\/([^/]+)/);
                    if (httpsMatch) { return httpsMatch[1]; }
                    const sshMatch = url.match(/:v3\/[^/]+\/[^/]+\/([^/]+)/);
                    if (sshMatch) { return sshMatch[1]; }
                }
            }
        } catch {
            logger.debug('Could not infer ADO repo from git remote');
        }
        return '';
    }

    getOrganization(): string { return this.organization; }
    getProject(): string { return this.project; }
    getRepositoryId(): string { return this.repositoryId; }

    /** Base URL for ADO REST API. */
    getApiBaseUrl(): string {
        return `https://dev.azure.com/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/_apis`;
    }

    /** Base URL for ADO web UI. */
    getWebBaseUrl(): string {
        return `https://dev.azure.com/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}`;
    }

    /** Git API base path (relative to API base). */
    getGitRepoPath(): string {
        return `/git/repositories/${encodeURIComponent(this.repositoryId)}`;
    }

    async ensureToken(): Promise<{ token: string; isPat: boolean }> {
        if (this.token) {
            return { token: this.token, isPat: this.isPat };
        }

        // Try PAT from config first
        const config = vscode.workspace.getConfiguration('codepilotReview');
        const pat = config.get<string>('azureDevOps.pat', '');
        if (pat) {
            this.token = pat;
            this.isPat = true;
            return { token: this.token, isPat: true };
        }

        // Use VSCode Microsoft auth provider
        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
                { createIfNone: true },
            );
            this.token = session.accessToken;
            this.isPat = false;
            this.currentUser = session.account.label;
            return { token: this.token, isPat: false };
        } catch (e) {
            throw new AuthError('Failed to authenticate with Azure DevOps', e);
        }
    }

    async apiRequest<T = unknown>(path: string, options: AdoRequestOptions = {}): Promise<T> {
        const { token, isPat } = await this.ensureToken();
        return adoRequest<T>(this.getApiBaseUrl(), path, token, isPat, options);
    }

    async apiRequestPaginated<TItem>(path: string, options: AdoRequestOptions = {}): Promise<TItem[]> {
        const { token, isPat } = await this.ensureToken();
        return adoRequestPaginated<TItem>(this.getApiBaseUrl(), path, token, isPat, options);
    }

    setToken(token: string, isPat: boolean): void {
        this.token = token;
        this.isPat = isPat;
    }

    clearToken(): void {
        this.token = '';
        this.isPat = false;
        this.currentUser = '';
    }

    getCurrentUserName(): string {
        return this.currentUser;
    }
}

// ── Pull Requests ───────────────────────────────────────────────────────────

class AdoPullRequestProvider implements IPullRequestProvider {
    constructor(private provider: AzureDevOpsProvider) {}

    async getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]> {
        const repoPath = this.provider.getGitRepoPath();
        const adoStatus = statusFilterToAdoStatus(filter?.status);
        const query: Record<string, string> = {};
        if (adoStatus) {
            query['searchCriteria.status'] = adoStatus;
        }

        logger.info('ADO: fetching pull requests', filter);
        const prs = await this.provider.apiRequestPaginated<any>(
            `${repoPath}/pullrequests`,
            { query },
        );

        const webBase = this.provider.getWebBaseUrl();
        let results = prs.map((pr: any) => mapAdoPullRequest(pr, this.provider.name, webBase));

        // Client-side filtering for fields ADO search doesn't support
        if (filter) {
            results = this.applyClientFilter(results, filter);
        }

        return results;
    }

    async getPullRequest(id: string): Promise<PullRequest | undefined> {
        const repoPath = this.provider.getGitRepoPath();
        try {
            const pr = await this.provider.apiRequest<any>(`${repoPath}/pullrequests/${id}`);
            return mapAdoPullRequest(pr, this.provider.name, this.provider.getWebBaseUrl());
        } catch (e) {
            logger.error(`ADO: failed to get PR ${id}`, e);
            return undefined;
        }
    }

    private applyClientFilter(prs: PullRequest[], filter: PullRequestFilter): PullRequest[] {
        return prs.filter((pr) => {
            if (filter.author && !pr.author.toLowerCase().includes(filter.author.toLowerCase())) {
                return false;
            }
            if (filter.searchText && !pr.title.toLowerCase().includes(filter.searchText.toLowerCase())) {
                return false;
            }
            if (filter.labels && filter.labels.length > 0) {
                const prLabels = new Set(pr.labels.map(l => l.toLowerCase()));
                if (!filter.labels.some(l => prLabels.has(l.toLowerCase()))) {
                    return false;
                }
            }
            if (filter.createdAfter && pr.createdAt < filter.createdAfter) {
                return false;
            }
            if (filter.createdBefore && pr.createdAt > filter.createdBefore) {
                return false;
            }
            if (filter.reviewer) {
                const rev = filter.reviewer.toLowerCase();
                if (!pr.reviewers.some(r => r.name.toLowerCase().includes(rev))) {
                    return false;
                }
            }
            return true;
        });
    }
}

// ── Diff ────────────────────────────────────────────────────────────────────

class AdoDiffProvider implements IDiffProvider {
    constructor(private provider: AzureDevOpsProvider) {}

    async getDiff(pullRequestId: string): Promise<DiffFile[]> {
        const repoPath = this.provider.getGitRepoPath();

        // 1. Get iterations
        const iterResponse = await this.provider.apiRequest<{ value: any[] }>(
            `${repoPath}/pullrequests/${pullRequestId}/iterations`,
        );
        const iterations = iterResponse.value ?? [];
        if (iterations.length === 0) {
            return [];
        }

        // Use the latest iteration
        const latestIteration = iterations[iterations.length - 1];
        const iterationId = latestIteration.id;

        // 2. Get changes for that iteration
        const changesResponse = await this.provider.apiRequest<{ changeEntries: any[] }>(
            `${repoPath}/pullrequests/${pullRequestId}/iterations/${iterationId}/changes`,
        );
        const changes = changesResponse.changeEntries ?? [];

        const sourceCommit = latestIteration.sourceRefCommit?.commitId ?? '';
        const targetCommit = latestIteration.targetRefCommit?.commitId ?? '';

        return changes.map((change: any): DiffFile => {
            const item = change.item ?? {};
            const originalPath = change.originalPath ?? item.path ?? '';
            const newPath = item.path ?? '';
            const changeType = mapAdoChangeType(change.changeType ?? 2);

            const hunk: DiffHunk = {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 0,
                header: '',
                lines: [],
            };

            return {
                oldPath: changeType === 'added' ? undefined : originalPath,
                newPath: changeType === 'deleted' ? undefined : newPath,
                hunks: [hunk],
                oldRevision: targetCommit,
                newRevision: sourceCommit,
                changeType,
                isBinary: item.contentMetadata?.isBinary ?? false,
            };
        });
    }

    async getFileContent(filePath: string, revision: string): Promise<string> {
        const repoPath = this.provider.getGitRepoPath();
        const query: Record<string, string> = {
            path: filePath,
        };
        if (revision) {
            query['versionDescriptor.version'] = revision;
            query['versionDescriptor.versionType'] = 'commit';
        }
        try {
            return await this.provider.apiRequest<string>(
                `${repoPath}/items`,
                { query, raw: true },
            );
        } catch (e) {
            logger.error(`ADO: failed to get file content ${filePath}@${revision}`, e);
            return '';
        }
    }
}

// ── Comments ────────────────────────────────────────────────────────────────

class AdoCommentProvider implements ICommentProvider {
    constructor(private provider: AzureDevOpsProvider) {}

    async getComments(pullRequestId: string): Promise<ReviewIssue[]> {
        const repoPath = this.provider.getGitRepoPath();
        const response = await this.provider.apiRequest<{ value: any[] }>(
            `${repoPath}/pullrequests/${pullRequestId}/threads`,
        );
        const threads = response.value ?? [];
        const issues: ReviewIssue[] = [];

        for (const thread of threads) {
            // Skip system threads (no comments or only system-generated)
            const comments: any[] = thread.comments ?? [];
            if (comments.length === 0) { continue; }

            const firstComment = comments[0];
            if (firstComment.commentType === 'system') { continue; }

            const filePath = thread.threadContext?.filePath ?? '';
            const line = thread.threadContext?.rightFileEnd?.line
                ?? thread.threadContext?.rightFileStart?.line
                ?? 1;

            issues.push({
                id: `${thread.id}:${firstComment.id}`,
                summary: firstComment.content ?? '',
                details: comments.length > 1
                    ? comments.map((c: any) => c.content).join('\n---\n')
                    : firstComment.content ?? '',
                position: {
                    filePath,
                    line,
                    side: 'head',
                },
                status: mapAdoThreadStatus(thread.status ?? 0),
                source: 'provider',
                createdAt: new Date(firstComment.publishedDate ?? Date.now()),
                providerCommentId: `${thread.id}:${firstComment.id}`,
            });
        }

        return issues;
    }

    async publishComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        const repoPath = this.provider.getGitRepoPath();
        const threadBody: any = {
            comments: [
                {
                    parentCommentId: 0,
                    content: issue.details || issue.summary,
                    commentType: 1, // text
                },
            ],
            status: 1, // active
        };

        if (issue.position.filePath) {
            threadBody.threadContext = {
                filePath: issue.position.filePath,
                rightFileStart: { line: issue.position.line, offset: 1 },
                rightFileEnd: { line: issue.position.line, offset: 1 },
            };
        }

        const result = await this.provider.apiRequest<any>(
            `${repoPath}/pullrequests/${pullRequestId}/threads`,
            { method: 'POST', body: threadBody },
        );

        const firstComment = result.comments?.[0];
        return {
            ...issue,
            id: `${result.id}:${firstComment?.id ?? 1}`,
            providerCommentId: `${result.id}:${firstComment?.id ?? 1}`,
            status: 'published',
        };
    }

    async updateComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        const repoPath = this.provider.getGitRepoPath();
        const [threadId, commentId] = this.parseCommentId(issue.providerCommentId ?? issue.id);

        await this.provider.apiRequest(
            `${repoPath}/pullrequests/${pullRequestId}/threads/${threadId}/comments/${commentId}`,
            { method: 'PATCH', body: { content: issue.details || issue.summary } },
        );

        return issue;
    }

    async deleteComment(pullRequestId: string, commentId: string): Promise<void> {
        const repoPath = this.provider.getGitRepoPath();
        const [threadId, cId] = this.parseCommentId(commentId);

        await this.provider.apiRequest(
            `${repoPath}/pullrequests/${pullRequestId}/threads/${threadId}/comments/${cId}`,
            { method: 'DELETE' },
        );
    }

    async updateCommentStatus(
        pullRequestId: string, commentId: string, status: ReviewIssueStatus,
    ): Promise<void> {
        const repoPath = this.provider.getGitRepoPath();
        const [threadId] = this.parseCommentId(commentId);

        await this.provider.apiRequest(
            `${repoPath}/pullrequests/${pullRequestId}/threads/${threadId}`,
            {
                method: 'PATCH',
                body: { status: reviewIssueStatusToAdoThreadStatus(status) },
            },
        );
    }

    /** Parse composite "threadId:commentId" into numeric parts. */
    private parseCommentId(compositeId: string): [string, string] {
        const parts = compositeId.split(':');
        if (parts.length >= 2) {
            return [parts[0], parts[1]];
        }
        return [compositeId, '1'];
    }
}

// ── Auth ────────────────────────────────────────────────────────────────────

class AdoAuthProvider implements IAuthProvider {
    constructor(private provider: AzureDevOpsProvider) {}

    async isAuthenticated(): Promise<boolean> {
        try {
            // Try silent session check first
            const config = vscode.workspace.getConfiguration('codepilotReview');
            const pat = config.get<string>('azureDevOps.pat', '');
            if (pat) { return true; }

            const session = await vscode.authentication.getSession(
                'microsoft',
                ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
                { createIfNone: false },
            );
            return !!session;
        } catch {
            return false;
        }
    }

    async authenticate(): Promise<boolean> {
        try {
            await this.provider.ensureToken();
            return true;
        } catch (e) {
            logger.error('ADO authentication failed', e);
            vscode.window.showErrorMessage('Azure DevOps authentication failed. Check your PAT or sign in with Microsoft.');
            return false;
        }
    }

    async signOut(): Promise<void> {
        this.provider.clearToken();
        logger.info('ADO: signed out');
    }

    async getCurrentUser(): Promise<string | undefined> {
        const name = this.provider.getCurrentUserName();
        if (name) { return name; }

        // If using PAT, call the profile API
        try {
            await this.provider.ensureToken();
            const resp = await this.provider.apiRequest<{ authenticatedUser?: { providerDisplayName?: string } }>(
                '', // connection data at root
                { query: {} },
            );
            return resp.authenticatedUser?.providerDisplayName;
        } catch {
            return undefined;
        }
    }
}
