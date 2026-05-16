import * as vscode from 'vscode';
import { CodeTour, CodeTourStep, Partition, DiffFile } from '../types';
import { IAiService } from '../ai/aiService';
import { ReviewStore } from '../storage/reviewStore';
import { logger } from '../logging/logger';

/**
 * Service for generating and navigating code tours.
 * Creates guided walkthroughs of entire code changes using inline comments.
 */
export class CodeTourService {
    private currentTour: CodeTour | undefined;
    private currentStepIndex: number = 0;
    private commentController: vscode.CommentController;
    private tourThreads: vscode.CommentThread[] = [];
    private currentStepDecoration: vscode.TextEditorDecorationType;

    private _onDidChangeTour = new vscode.EventEmitter<void>();
    readonly onDidChangeTour = this._onDidChangeTour.event;

    constructor(
        private aiService: IAiService,
        private store: ReviewStore,
    ) {
        this.commentController = vscode.comments.createCommentController(
            'codepilotReview.tour',
            'Code Tour'
        );

        this.currentStepDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            isWholeLine: true,
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        });
    }

    /** Generate a code tour across the entire code change */
    async generateTour(
        prId: string,
        diff: DiffFile[],
        token?: vscode.CancellationToken
    ): Promise<CodeTour> {
        logger.info(`Generating tour for PR ${prId} across ${diff.length} file(s)`);

        const diffSummary = diff.map(f => {
            const path = f.newPath || f.oldPath || '';
            const addedLines = f.hunks.reduce((sum, h) =>
                sum + h.lines.filter(l => l.type === 'add').length, 0);
            const deletedLines = f.hunks.reduce((sum, h) =>
                sum + h.lines.filter(l => l.type === 'delete').length, 0);
            return `${path}: +${addedLines} -${deletedLines} (${f.changeType})`;
        }).join('\n');

        const prompt =
            `Generate a code review walkthrough for this entire code change.\n\n` +
            `Files changed:\n${diffSummary}\n\n` +
            `Create a logical walkthrough that guides the reviewer through the changes ` +
            `in dependency order — foundational changes first, then changes that build on them.\n\n` +
            `For each significant change, provide a tour step with:\n` +
            `- title: brief name for this step\n` +
            `- description: explain WHY this change was made, HOW it works, and what to look for\n` +
            `- filePath: the file\n` +
            `- line: the key line number to focus on\n\n` +
            `Respond with a JSON array:\n` +
            '```json\n' +
            '[{"title": "...", "description": "...", "filePath": "...", "line": 1}]\n' +
            '```';

        const response = await this.aiService.chat(prompt, { diff }, token);

        let steps: CodeTourStep[] = [];
        try {
            const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
            const jsonStr = jsonMatch ? jsonMatch[1] : response;
            const parsed = JSON.parse(jsonStr.trim()) as Array<{
                title: string; description: string; filePath: string; line: number;
            }>;
            steps = parsed.map(s => ({ ...s }));
        } catch (error) {
            logger.error('Failed to parse tour steps from AI', error);
            // Fallback: one step per file
            steps = diff.map(f => ({
                title: `Review ${f.newPath || f.oldPath || ''}`,
                description: `Changes in ${f.newPath || f.oldPath || ''}`,
                filePath: f.newPath || f.oldPath || '',
                line: f.hunks[0]?.newStart || 1,
            }));
        }

        const tour: CodeTour = {
            id: `tour-${prId}`,
            name: `Code Tour`,
            steps,
        };

        await this.store.saveTour(prId, tour);
        return tour;
    }

    /** Start a tour, displaying all steps as inline comment threads */
    async startTour(tour: CodeTour): Promise<void> {
        this.stopTour();
        this.currentTour = tour;
        this.currentStepIndex = 0;
        this._onDidChangeTour.fire();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        // Create comment threads for all steps
        for (let i = 0; i < tour.steps.length; i++) {
            const step = tour.steps[i];
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, step.filePath);
            const line = Math.max(0, step.line - 1);
            const range = new vscode.Range(line, 0, line, 0);

            const body = new vscode.MarkdownString();
            body.isTrusted = true;
            body.appendMarkdown(`**Step ${i + 1}/${tour.steps.length}: ${step.title}**\n\n`);
            body.appendMarkdown(step.description);

            const comment: vscode.Comment = {
                body,
                author: { name: `🚶 Tour Step ${i + 1}` },
                mode: vscode.CommentMode.Preview,
            };

            const thread = this.commentController.createCommentThread(uri, range, [comment]);
            thread.label = step.title;
            thread.canReply = false;
            thread.collapsibleState = i === 0
                ? vscode.CommentThreadCollapsibleState.Expanded
                : vscode.CommentThreadCollapsibleState.Collapsed;

            this.tourThreads.push(thread);
        }

        // Navigate to first step
        if (tour.steps.length > 0) {
            await this.navigateToStep(0);
        }
    }

    /** Navigate to the next step */
    async nextStep(): Promise<void> {
        if (!this.currentTour) { return; }
        if (this.currentStepIndex < this.currentTour.steps.length - 1) {
            this.currentStepIndex++;
            await this.navigateToStep(this.currentStepIndex);
        }
    }

    /** Navigate to the previous step */
    async prevStep(): Promise<void> {
        if (!this.currentTour) { return; }
        if (this.currentStepIndex > 0) {
            this.currentStepIndex--;
            await this.navigateToStep(this.currentStepIndex);
        }
    }

    /** Get current tour state */
    getCurrentTour(): CodeTour | undefined {
        return this.currentTour;
    }

    getCurrentStepIndex(): number {
        return this.currentStepIndex;
    }

    getTotalSteps(): number {
        return this.currentTour?.steps.length || 0;
    }

    private async navigateToStep(index: number): Promise<void> {
        if (!this.currentTour) { return; }
        const step = this.currentTour.steps[index];
        if (!step) { return; }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, step.filePath);

        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const line = Math.max(0, step.line - 1);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                selection: new vscode.Range(line, 0, line, 0),
            });

            // Highlight current step line
            editor.setDecorations(this.currentStepDecoration, [
                new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
            ]);

            // Expand current thread, collapse others
            for (let i = 0; i < this.tourThreads.length; i++) {
                this.tourThreads[i].collapsibleState = i === index
                    ? vscode.CommentThreadCollapsibleState.Expanded
                    : vscode.CommentThreadCollapsibleState.Collapsed;
            }

            // Show step progress in status bar
            vscode.window.setStatusBarMessage(
                `$(play) Tour: Step ${index + 1}/${this.currentTour.steps.length} — ${step.title}`,
                5000
            );
        } catch (error) {
            logger.error(`Failed to navigate to tour step: ${step.filePath}:${step.line}`, error);
        }

        this._onDidChangeTour.fire();
    }

    /** Stop the current tour and clear all comment threads */
    stopTour(): void {
        for (const thread of this.tourThreads) {
            thread.dispose();
        }
        this.tourThreads = [];
        this.currentTour = undefined;
        this.currentStepIndex = 0;

        // Clear decorations from visible editors
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.currentStepDecoration, []);
        }

        this._onDidChangeTour.fire();
    }

    dispose(): void {
        this.stopTour();
        this.currentStepDecoration.dispose();
        this.commentController.dispose();
        this._onDidChangeTour.dispose();
    }
}
