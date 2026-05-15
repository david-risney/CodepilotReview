import { exec } from 'child_process';
import { promisify } from 'util';
import { DiffFile } from '../types';
import { logger } from '../logging/logger';

const execAsync = promisify(exec);

export interface ReviewerSuggestion {
    name: string;
    email: string;
    /** Number of commits touching the changed files */
    commitCount: number;
    /** Most recent commit date */
    lastCommitDate: Date;
    /** Score combining frequency and recency */
    score: number;
}

/**
 * Analyzes git history to suggest reviewers for changed files.
 * Ranks by frequency and recency of commits to the same files.
 */
export class ReviewerSuggestionService {
    constructor(private workspaceRoot: string) {}

    /** Get suggested reviewers based on git history of changed files */
    async suggestReviewers(diff: DiffFile[], excludeAuthor?: string): Promise<ReviewerSuggestion[]> {
        const filePaths = diff
            .map(f => f.newPath || f.oldPath)
            .filter((p): p is string => !!p);

        if (filePaths.length === 0) {
            return [];
        }

        const reviewerMap = new Map<string, { name: string; email: string; count: number; latest: Date }>();

        for (const filePath of filePaths) {
            try {
                const { stdout } = await execAsync(
                    `git log --format="%aN|%aE|%ai" --follow -20 -- "${filePath}"`,
                    { cwd: this.workspaceRoot }
                );

                for (const line of stdout.trim().split('\n')) {
                    if (!line.trim()) { continue; }
                    const [name, email, dateStr] = line.split('|');
                    if (!name || !email) { continue; }

                    // Skip the PR author
                    if (excludeAuthor && (name === excludeAuthor || email === excludeAuthor)) {
                        continue;
                    }

                    const key = email.toLowerCase();
                    const date = new Date(dateStr);
                    const existing = reviewerMap.get(key);

                    if (existing) {
                        existing.count++;
                        if (date > existing.latest) {
                            existing.latest = date;
                        }
                    } else {
                        reviewerMap.set(key, { name, email, count: 1, latest: date });
                    }
                }
            } catch (error) {
                logger.debug(`Failed to get git log for ${filePath}: ${error}`);
            }
        }

        const now = Date.now();
        const suggestions: ReviewerSuggestion[] = [];

        for (const [_key, data] of reviewerMap) {
            const daysSinceLastCommit = (now - data.latest.getTime()) / (1000 * 60 * 60 * 24);
            // Score: frequency * recency decay
            const recencyFactor = Math.max(0.1, 1 - (daysSinceLastCommit / 365));
            const score = data.count * recencyFactor;

            suggestions.push({
                name: data.name,
                email: data.email,
                commitCount: data.count,
                lastCommitDate: data.latest,
                score,
            });
        }

        // Sort by score descending
        suggestions.sort((a, b) => b.score - a.score);

        return suggestions.slice(0, 10);
    }
}
