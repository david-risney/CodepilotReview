import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    PullRequest, DiffFile, DiffHunk, DiffLine, ReviewIssue, ProviderCapabilities,
    ReviewIssueStatus, Reviewer, ReviewVote
} from '../types';
import {
    ICodeReviewProvider, IPullRequestProvider, IDiffProvider, ICommentProvider,
    IAuthProvider, PullRequestFilter
} from './provider';
import { logger } from '../logging/logger';
import { ProviderError, AuthError } from '../errors';

// ── Gerrit REST API response types ──

interface GerritAccountInfo {
    _account_id: number;
    name?: string;
    email?: string;
    username?: string;
}

interface GerritLabelInfo {
    approved?: GerritAccountInfo;
    rejected?: GerritAccountInfo;
    value?: number;
    all?: Array<{ value?: number; _account_id: number; name?: string }>;
}

interface GerritChangeInfo {
    _number: number;
    id: string;
    project: string;
    branch: string;
    subject: string;
    status: string;
    owner: GerritAccountInfo;
    created: string;
    updated: string;
    labels?: Record<string, GerritLabelInfo>;
    reviewers?: { REVIEWER?: GerritAccountInfo[] };
    current_revision?: string;
    revisions?: Record<string, GerritRevisionInfo>;
}

interface GerritRevisionInfo {
    _number: number;
    ref: string;
    commit?: {
        subject: string;
        message: string;
    };
}

interface GerritDiffContent {
    a?: string[];
    b?: string[];
    ab?: string[];
    skip?: number;
}

interface GerritDiffInfo {
    meta_a?: { name: string; content_type: string };
    meta_b?: { name: string; content_type: string };
    change_type: string;
    content: GerritDiffContent[];
    binary?: boolean;
}

interface GerritFileInfo {
    status?: string;      // 'A' | 'D' | 'R' | 'C' | 'W' | undefined (modified)
    old_path?: string;
    lines_inserted?: number;
    lines_deleted?: number;
    binary?: boolean;
}

interface GerritCommentInfo {
    id: string;
    path: string;
    line?: number;
    message: string;
    updated: string;
    author?: GerritAccountInfo;
    patch_set?: number;
    side?: string;
    unresolved?: boolean;
}

// ── Credential types ──

interface GerritCredentials {
    username: string;
    password: string;
}

// ── Strip Gerrit JSON prefix ──

function stripGerritPrefix(body: string): string {
    // Gerrit prefixes all JSON responses with )]}' to prevent XSSI
    if (body.startsWith(")]}'")) {
        const newlineIdx = body.indexOf('\n');
        return newlineIdx >= 0 ? body.substring(newlineIdx + 1) : '';
    }
    return body;
}

// ── HTTP helper ──

function gerritRequest(
    url: string,
    method: string,
    credentials?: GerritCredentials,
    cookie?: string,
    body?: string
): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const requestModule = isHttps ? https : http;

        const headers: Record<string, string> = {
            'Accept': 'application/json',
        };

        if (credentials) {
            const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
            headers['Authorization'] = `Basic ${auth}`;
        }
        if (cookie) {
            headers['Cookie'] = cookie;
        }
        if (body) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(body).toString();
        }

        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers,
        };

        const req = requestModule.request(options, (res: http.IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf-8');
                resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
            });
        });

        req.on('error', (err: Error) => reject(err));
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

// ── Cookie-based auth from .gitcookies ──

function readGitCookies(host: string): string | undefined {
    const cookiePaths = [
        path.join(os.homedir(), '.gitcookies'),
    ];

    // Also check git config for http.cookiefile
    for (const cookiePath of cookiePaths) {
        try {
            if (!fs.existsSync(cookiePath)) {
                continue;
            }
            const content = fs.readFileSync(cookiePath, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                    continue;
                }
                // Netscape cookie format: domain\tTAILMATCH\tpath\tsecure\texpires\tname\tvalue
                const parts = trimmed.split('\t');
                if (parts.length >= 7) {
                    const domain = parts[0];
                    const name = parts[5];
                    const value = parts[6];
                    const parsedHost = new URL(`https://${host}`).hostname;
                    if (parsedHost.endsWith(domain) || domain === `.${parsedHost}` || domain === parsedHost) {
                        return `${name}=${value}`;
                    }
                }
            }
        } catch {
            // Ignore errors reading cookie files
        }
    }
    return undefined;
}

// ── Gerrit status mapping ──

function mapGerritStatus(status: string): 'open' | 'closed' | 'merged' | 'abandoned' {
    switch (status) {
        case 'NEW': return 'open';
        case 'MERGED': return 'merged';
        case 'ABANDONED': return 'abandoned';
        default: return 'closed';
    }
}

function mapGerritVote(label: GerritLabelInfo | undefined): ReviewVote {
    if (!label) { return 'none'; }
    if (label.approved) { return 'approved'; }
    if (label.rejected) { return 'rejected'; }
    const value = label.value ?? 0;
    if (value >= 2) { return 'approved'; }
    if (value >= 1) { return 'approvedWithSuggestions'; }
    if (value <= -2) { return 'rejected'; }
    if (value <= -1) { return 'waitForAuthor'; }
    return 'none';
}

function mapGerritChangeType(status: string | undefined): 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' {
    switch (status) {
        case 'A': return 'added';
        case 'D': return 'deleted';
        case 'R': return 'renamed';
        case 'C': return 'copied';
        default: return 'modified';
    }
}

// ── Provider ──

const SECRET_KEY_USERNAME = 'codepilotReview.chromium.username';
const SECRET_KEY_PASSWORD = 'codepilotReview.chromium.password';

/**
 * Chromium Gerrit code review provider.
 * Uses the Gerrit REST API to interact with Chromium code reviews.
 */
export class ChromiumProvider implements ICodeReviewProvider {
    readonly name = 'chromium';
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

    private host: string = 'https://chromium-review.googlesource.com';
    private credentials: GerritCredentials | undefined;
    private cookie: string | undefined;
    private secretStorage: vscode.SecretStorage | undefined;

    constructor() {
        this.pullRequests = new ChromiumPullRequestProvider(this);
        this.diff = new ChromiumDiffProvider(this);
        this.comments = new ChromiumCommentProvider(this);
        this.auth = new ChromiumAuthProvider(this);
    }

    async initialize(context: vscode.ExtensionContext): Promise<void> {
        const config = vscode.workspace.getConfiguration('codepilotReview');
        this.host = config.get<string>('chromium.host', this.host);
        this.secretStorage = context.secrets;

        // Try to restore credentials from SecretStorage
        try {
            const username = await this.secretStorage.get(SECRET_KEY_USERNAME);
            const password = await this.secretStorage.get(SECRET_KEY_PASSWORD);
            if (username && password) {
                this.credentials = { username, password };
            }
        } catch {
            logger.warn('Failed to restore Chromium credentials from SecretStorage');
        }

        // Fall back to .gitcookies for googlesource.com hosts
        if (!this.credentials) {
            const hostname = new URL(this.host).hostname;
            const cookieValue = readGitCookies(hostname);
            if (cookieValue) {
                this.cookie = cookieValue;
                logger.info('Chromium provider: using .gitcookies auth');
            }
        }

        logger.info(`Chromium provider initialized: ${this.host}`);
    }

    dispose(): void {
        this.credentials = undefined;
        this.cookie = undefined;
    }

    getHost(): string { return this.host; }

    /** Build a URL path for authenticated API calls (/a/ prefix). */
    buildApiUrl(apiPath: string): string {
        const prefix = (this.credentials || this.cookie) ? '/a' : '';
        return `${this.host}${prefix}${apiPath}`;
    }

    async apiGet(apiPath: string): Promise<unknown> {
        const url = this.buildApiUrl(apiPath);
        logger.debug(`Gerrit GET ${apiPath}`);
        const resp = await gerritRequest(url, 'GET', this.credentials, this.cookie);
        if (resp.statusCode === 401 || resp.statusCode === 403) {
            throw new AuthError(`Gerrit auth failed (${resp.statusCode}) for ${apiPath}`);
        }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            throw new ProviderError(
                `Gerrit API error ${resp.statusCode}: ${apiPath}`,
                'chromium'
            );
        }
        const json = stripGerritPrefix(resp.body);
        return JSON.parse(json);
    }

    async apiPut(apiPath: string, payload: unknown): Promise<unknown> {
        const url = this.buildApiUrl(apiPath);
        const body = JSON.stringify(payload);
        logger.debug(`Gerrit PUT ${apiPath}`);
        const resp = await gerritRequest(url, 'PUT', this.credentials, this.cookie, body);
        if (resp.statusCode === 401 || resp.statusCode === 403) {
            throw new AuthError(`Gerrit auth failed (${resp.statusCode}) for ${apiPath}`);
        }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            throw new ProviderError(
                `Gerrit API error ${resp.statusCode}: ${apiPath}`,
                'chromium'
            );
        }
        const json = stripGerritPrefix(resp.body);
        return json ? JSON.parse(json) : undefined;
    }

    async apiPost(apiPath: string, payload?: unknown): Promise<unknown> {
        const url = this.buildApiUrl(apiPath);
        const body = payload ? JSON.stringify(payload) : undefined;
        logger.debug(`Gerrit POST ${apiPath}`);
        const resp = await gerritRequest(url, 'POST', this.credentials, this.cookie, body);
        if (resp.statusCode === 401 || resp.statusCode === 403) {
            throw new AuthError(`Gerrit auth failed (${resp.statusCode}) for ${apiPath}`);
        }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            throw new ProviderError(
                `Gerrit API error ${resp.statusCode}: ${apiPath}`,
                'chromium'
            );
        }
        const json = stripGerritPrefix(resp.body);
        return json ? JSON.parse(json) : undefined;
    }

    setCredentials(creds: GerritCredentials | undefined): void {
        this.credentials = creds;
        if (creds) {
            this.cookie = undefined;
        }
    }

    getCredentials(): GerritCredentials | undefined { return this.credentials; }
    getCookie(): string | undefined { return this.cookie; }
    getSecretStorage(): vscode.SecretStorage | undefined { return this.secretStorage; }
}

// ── Pull Requests (Gerrit Changes) ──

class ChromiumPullRequestProvider implements IPullRequestProvider {
    constructor(private provider: ChromiumProvider) {}

    async getPullRequests(filter?: PullRequestFilter): Promise<PullRequest[]> {
        const queryParts: string[] = [];

        // Map status filter
        if (filter?.status && filter.status.length > 0) {
            const statusQueries = filter.status.map(s => {
                switch (s) {
                    case 'open': return 'status:open';
                    case 'closed': return 'status:closed';
                    case 'merged': return 'status:merged';
                    default: return 'status:open';
                }
            });
            // If there are multiple statuses, OR them together
            if (statusQueries.length === 1) {
                queryParts.push(statusQueries[0]);
            } else {
                queryParts.push(`(${statusQueries.join(' OR ')})`);
            }
        } else {
            queryParts.push('status:open');
        }

        if (filter?.author) {
            queryParts.push(`owner:${filter.author}`);
        }
        if (filter?.reviewer) {
            queryParts.push(`reviewer:${filter.reviewer}`);
        }
        if (filter?.searchText) {
            queryParts.push(`message:${filter.searchText}`);
        }
        if (filter?.labels) {
            for (const label of filter.labels) {
                queryParts.push(`label:${label}`);
            }
        }
        if (filter?.createdAfter) {
            queryParts.push(`after:${filter.createdAfter.toISOString().split('T')[0]}`);
        }
        if (filter?.createdBefore) {
            queryParts.push(`before:${filter.createdBefore.toISOString().split('T')[0]}`);
        }

        const query = queryParts.join('+');
        const apiPath = `/changes/?q=${encodeURIComponent(query)}&o=LABELS&o=DETAILED_ACCOUNTS`;

        const data = await this.provider.apiGet(apiPath) as GerritChangeInfo[];
        return data.map(change => this.mapChange(change));
    }

    async getPullRequest(id: string): Promise<PullRequest | undefined> {
        try {
            const data = await this.provider.apiGet(`/changes/${encodeURIComponent(id)}/detail`) as GerritChangeInfo;
            return this.mapChange(data);
        } catch (err) {
            logger.error(`Failed to get change ${id}`, err);
            return undefined;
        }
    }

    private mapChange(change: GerritChangeInfo): PullRequest {
        const reviewers: Reviewer[] = [];
        if (change.reviewers?.REVIEWER) {
            for (const r of change.reviewers.REVIEWER) {
                const codeReviewLabel = change.labels?.['Code-Review'];
                let vote: ReviewVote = 'none';
                if (codeReviewLabel?.all) {
                    const entry = codeReviewLabel.all.find(e => e._account_id === r._account_id);
                    if (entry?.value !== undefined) {
                        if (entry.value >= 2) { vote = 'approved'; }
                        else if (entry.value >= 1) { vote = 'approvedWithSuggestions'; }
                        else if (entry.value <= -2) { vote = 'rejected'; }
                        else if (entry.value <= -1) { vote = 'waitForAuthor'; }
                    }
                }
                reviewers.push({
                    name: r.name ?? r.email ?? `Account ${r._account_id}`,
                    id: String(r._account_id),
                    isRequired: false,
                    vote,
                });
            }
        }

        const labels: string[] = [];
        if (change.labels) {
            for (const [labelName, labelInfo] of Object.entries(change.labels)) {
                const v = mapGerritVote(labelInfo);
                if (v !== 'none') {
                    labels.push(`${labelName}: ${v}`);
                }
            }
        }

        return {
            id: String(change._number),
            title: change.subject,
            description: change.revisions?.[change.current_revision ?? '']?.commit?.message ?? change.subject,
            author: change.owner.name ?? change.owner.email ?? `Account ${change.owner._account_id}`,
            status: mapGerritStatus(change.status),
            url: `${this.provider.getHost()}/c/${change.project}/+/${change._number}`,
            sourceBranch: change.revisions?.[change.current_revision ?? '']?.ref ?? '',
            targetBranch: change.branch,
            createdAt: new Date(change.created),
            updatedAt: new Date(change.updated),
            reviewers,
            labels,
            userNeed: 'optional',
            providerName: 'chromium',
        };
    }
}

// ── Diff ──

class ChromiumDiffProvider implements IDiffProvider {
    constructor(private provider: ChromiumProvider) {}

    async getDiff(pullRequestId: string): Promise<DiffFile[]> {
        const changeId = encodeURIComponent(pullRequestId);

        // Get the list of files in the current patchset
        const filesData = await this.provider.apiGet(
            `/changes/${changeId}/revisions/current/files`
        ) as Record<string, GerritFileInfo>;

        // Get the change detail to determine revisions
        const changeDetail = await this.provider.apiGet(
            `/changes/${changeId}/detail`
        ) as GerritChangeInfo;
        const currentRevision = changeDetail.current_revision ?? '';
        const patchSetNumber = changeDetail.revisions?.[currentRevision]?._number ?? 0;

        const diffFiles: DiffFile[] = [];

        for (const [filePath, fileInfo] of Object.entries(filesData)) {
            // Skip the magic /COMMIT_MSG and /MERGE_LIST entries
            if (filePath === '/COMMIT_MSG' || filePath === '/MERGE_LIST' || filePath === '/PATCHSET_LEVEL') {
                continue;
            }

            try {
                const encodedFile = encodeURIComponent(filePath);
                const diffData = await this.provider.apiGet(
                    `/changes/${changeId}/revisions/current/files/${encodedFile}/diff`
                ) as GerritDiffInfo;

                const changeType = mapGerritChangeType(fileInfo.status);
                const hunks = this.parseDiffContent(diffData.content);

                diffFiles.push({
                    oldPath: changeType === 'added' ? undefined : (fileInfo.old_path ?? filePath),
                    newPath: changeType === 'deleted' ? undefined : filePath,
                    hunks,
                    oldRevision: `${patchSetNumber - 1}`,
                    newRevision: `${patchSetNumber}`,
                    changeType,
                    isBinary: fileInfo.binary ?? diffData.binary ?? false,
                });
            } catch (err) {
                logger.warn(`Failed to get diff for file ${filePath}`, err);
            }
        }

        return diffFiles;
    }

    async getFileContent(filePath: string, revision: string): Promise<string> {
        // revision is expected to be "changeId/revisionId" e.g. "12345/3"
        const parts = revision.split('/');
        let changeId: string;
        let revisionId: string;

        if (parts.length >= 2) {
            changeId = encodeURIComponent(parts[0]);
            revisionId = encodeURIComponent(parts[1]);
        } else {
            // If only changeId provided, use "current"
            changeId = encodeURIComponent(revision);
            revisionId = 'current';
        }

        const encodedPath = encodeURIComponent(filePath);
        const url = this.provider.buildApiUrl(
            `/changes/${changeId}/revisions/${revisionId}/files/${encodedPath}/content`
        );

        const resp = await gerritRequest(url, 'GET', this.provider.getCredentials(), this.provider.getCookie());
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            throw new ProviderError(
                `Failed to get file content: ${resp.statusCode}`,
                'chromium'
            );
        }

        // Response is base64-encoded
        return Buffer.from(resp.body, 'base64').toString('utf-8');
    }

    /**
     * Parse Gerrit diff content entries into DiffHunks.
     * Gerrit returns an array of content blocks with 'a' (old only), 'b' (new only), and 'ab' (common).
     */
    private parseDiffContent(content: GerritDiffContent[]): DiffHunk[] {
        if (!content || content.length === 0) {
            return [];
        }

        const hunks: DiffHunk[] = [];
        let oldLine = 1;
        let newLine = 1;
        let currentLines: DiffLine[] = [];
        let hunkOldStart = 1;
        let hunkNewStart = 1;
        let hunkOldCount = 0;
        let hunkNewCount = 0;
        let inDiff = false;

        const flushHunk = () => {
            if (currentLines.length > 0) {
                hunks.push({
                    oldStart: hunkOldStart,
                    oldLines: hunkOldCount,
                    newStart: hunkNewStart,
                    newLines: hunkNewCount,
                    header: `@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`,
                    lines: currentLines,
                });
                currentLines = [];
                hunkOldCount = 0;
                hunkNewCount = 0;
            }
            inDiff = false;
        };

        for (const block of content) {
            if (block.skip) {
                flushHunk();
                oldLine += block.skip;
                newLine += block.skip;
                continue;
            }

            if (block.ab) {
                // Context lines — if we have an active diff, include some as context then flush
                if (inDiff) {
                    // Include up to 3 trailing context lines
                    const trailing = block.ab.slice(0, 3);
                    for (const line of trailing) {
                        currentLines.push({ type: 'context', content: line, oldLineNumber: oldLine, newLineNumber: newLine });
                        hunkOldCount++;
                        hunkNewCount++;
                        oldLine++;
                        newLine++;
                    }
                    flushHunk();
                    // Skip the remaining context lines
                    const remaining = block.ab.length - trailing.length;
                    oldLine += remaining;
                    newLine += remaining;
                } else {
                    // Keep last 3 lines as potential leading context for next hunk
                    const skip = Math.max(0, block.ab.length - 3);
                    oldLine += skip;
                    newLine += skip;
                    const leading = block.ab.slice(skip);
                    if (leading.length > 0) {
                        hunkOldStart = oldLine;
                        hunkNewStart = newLine;
                        for (const line of leading) {
                            currentLines.push({ type: 'context', content: line, oldLineNumber: oldLine, newLineNumber: newLine });
                            hunkOldCount++;
                            hunkNewCount++;
                            oldLine++;
                            newLine++;
                        }
                    }
                }
                continue;
            }

            // Start a new hunk if needed
            if (!inDiff && currentLines.length === 0) {
                hunkOldStart = oldLine;
                hunkNewStart = newLine;
            }
            inDiff = true;

            if (block.a) {
                for (const line of block.a) {
                    currentLines.push({ type: 'delete', content: line, oldLineNumber: oldLine });
                    hunkOldCount++;
                    oldLine++;
                }
            }

            if (block.b) {
                for (const line of block.b) {
                    currentLines.push({ type: 'add', content: line, newLineNumber: newLine });
                    hunkNewCount++;
                    newLine++;
                }
            }
        }

        flushHunk();
        return hunks;
    }
}

// ── Comments ──

class ChromiumCommentProvider implements ICommentProvider {
    constructor(private provider: ChromiumProvider) {}

    async getComments(pullRequestId: string): Promise<ReviewIssue[]> {
        const changeId = encodeURIComponent(pullRequestId);
        const data = await this.provider.apiGet(
            `/changes/${changeId}/comments`
        ) as Record<string, GerritCommentInfo[]>;

        const issues: ReviewIssue[] = [];
        for (const [_filePath, comments] of Object.entries(data)) {
            for (const comment of comments) {
                issues.push(this.mapComment(comment));
            }
        }
        return issues;
    }

    async publishComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        const changeId = encodeURIComponent(pullRequestId);

        const commentInput: Record<string, unknown> = {
            message: issue.details || issue.summary,
        };
        if (issue.position.line > 0) {
            commentInput['line'] = issue.position.line;
        }
        if (issue.position.side === 'base') {
            commentInput['side'] = 'PARENT';
        }

        const reviewInput = {
            comments: {
                [issue.position.filePath]: [commentInput],
            },
        };

        const result = await this.provider.apiPost(
            `/changes/${changeId}/revisions/current/review`,
            reviewInput
        ) as Record<string, unknown>;

        logger.info(`Published comment on change ${pullRequestId}`, result);

        return {
            ...issue,
            status: 'published',
            source: 'provider',
            providerCommentId: issue.providerCommentId,
        };
    }

    async updateComment(pullRequestId: string, issue: ReviewIssue): Promise<ReviewIssue> {
        // Gerrit doesn't support editing published comments — publish a new one instead
        logger.info(`Gerrit does not support editing comments; creating new comment for change ${pullRequestId}`);
        return this.publishComment(pullRequestId, issue);
    }

    async deleteComment(pullRequestId: string, commentId: string): Promise<void> {
        const changeId = encodeURIComponent(pullRequestId);

        // We need to find which revision and file the comment belongs to
        // First get the comment from all revisions
        const allComments = await this.provider.apiGet(
            `/changes/${changeId}/comments`
        ) as Record<string, GerritCommentInfo[]>;

        for (const [_filePath, comments] of Object.entries(allComments)) {
            const comment = comments.find(c => c.id === commentId);
            if (comment) {
                const revisionId = comment.patch_set ?? 'current';
                await this.provider.apiPost(
                    `/changes/${changeId}/revisions/${revisionId}/comments/${encodeURIComponent(commentId)}/delete`,
                    { reason: 'Deleted via CodepilotReview' }
                );
                logger.info(`Deleted comment ${commentId} from change ${pullRequestId}`);
                return;
            }
        }

        throw new ProviderError(
            `Comment ${commentId} not found on change ${pullRequestId}`,
            'chromium'
        );
    }

    async updateCommentStatus(
        pullRequestId: string, commentId: string, status: ReviewIssueStatus
    ): Promise<void> {
        // Gerrit supports marking comments as resolved/unresolved
        if (status === 'resolved' || status === 'dismissed') {
            // Publish a reply that resolves the thread
            const changeId = encodeURIComponent(pullRequestId);
            const allComments = await this.provider.apiGet(
                `/changes/${changeId}/comments`
            ) as Record<string, GerritCommentInfo[]>;

            for (const [filePath, comments] of Object.entries(allComments)) {
                const comment = comments.find(c => c.id === commentId);
                if (comment) {
                    await this.provider.apiPost(
                        `/changes/${changeId}/revisions/current/review`,
                        {
                            comments: {
                                [filePath]: [{
                                    message: status === 'resolved' ? '(resolved)' : '(dismissed)',
                                    in_reply_to: commentId,
                                    unresolved: false,
                                }],
                            },
                        }
                    );
                    return;
                }
            }
        }
        logger.warn(`Cannot update status to '${status}' for comment ${commentId} — unsupported by Gerrit`);
    }

    private mapComment(comment: GerritCommentInfo): ReviewIssue {
        return {
            id: comment.id,
            summary: comment.message.split('\n')[0].substring(0, 120),
            details: comment.message,
            position: {
                filePath: comment.path,
                line: comment.line ?? 0,
                side: comment.side === 'PARENT' ? 'base' : 'head',
            },
            status: comment.unresolved === false ? 'resolved' : 'published',
            source: 'provider',
            createdAt: new Date(comment.updated),
            providerCommentId: comment.id,
        };
    }
}

// ── Auth ──

class ChromiumAuthProvider implements IAuthProvider {
    constructor(private provider: ChromiumProvider) {}

    async isAuthenticated(): Promise<boolean> {
        return !!(this.provider.getCredentials() || this.provider.getCookie());
    }

    async authenticate(): Promise<boolean> {
        // Prompt user for HTTP credentials (from Gerrit Settings page)
        const username = await vscode.window.showInputBox({
            prompt: 'Enter your Gerrit HTTP username (from Settings → HTTP Credentials)',
            placeHolder: 'user@example.com',
            ignoreFocusOut: true,
        });
        if (!username) {
            return false;
        }

        const password = await vscode.window.showInputBox({
            prompt: 'Enter your Gerrit HTTP password',
            password: true,
            ignoreFocusOut: true,
        });
        if (!password) {
            return false;
        }

        // Verify credentials by calling /accounts/self
        const creds: GerritCredentials = { username, password };
        try {
            const url = `${this.provider.getHost()}/a/accounts/self`;
            const resp = await gerritRequest(url, 'GET', creds);
            if (resp.statusCode === 200) {
                this.provider.setCredentials(creds);

                // Store in SecretStorage
                const secrets = this.provider.getSecretStorage();
                if (secrets) {
                    await secrets.store(SECRET_KEY_USERNAME, username);
                    await secrets.store(SECRET_KEY_PASSWORD, password);
                }

                vscode.window.showInformationMessage('Successfully authenticated with Gerrit.');
                logger.info('Chromium auth: credentials verified');
                return true;
            } else {
                vscode.window.showErrorMessage(`Gerrit authentication failed (HTTP ${resp.statusCode}).`);
                return false;
            }
        } catch (err) {
            logger.error('Chromium auth failed', err);
            throw new AuthError('Failed to authenticate with Gerrit', err);
        }
    }

    async signOut(): Promise<void> {
        this.provider.setCredentials(undefined);
        const secrets = this.provider.getSecretStorage();
        if (secrets) {
            await secrets.delete(SECRET_KEY_USERNAME);
            await secrets.delete(SECRET_KEY_PASSWORD);
        }
        logger.info('Chromium: signed out');
    }

    async getCurrentUser(): Promise<string | undefined> {
        if (!await this.isAuthenticated()) {
            return undefined;
        }
        try {
            const data = await this.provider.apiGet('/accounts/self') as GerritAccountInfo;
            return data.name ?? data.email ?? data.username;
        } catch {
            return undefined;
        }
    }
}
