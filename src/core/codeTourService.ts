import * as vscode from 'vscode';
import { CodeTour, CodeTourStep, DiffFile } from '../types';
import { IAiService } from '../ai/aiService';
import { ReviewStore } from '../storage/reviewStore';
import { logger } from '../logging/logger';

/**
 * Service for generating and navigating code tours.
 * Manages tour state and decorations; UI is handled by separate view/CodeLens providers.
 */
export class CodeTourService {
    private currentTour: CodeTour | undefined;
    private currentStepIndex: number = 0;
    private currentStepDecoration: vscode.TextEditorDecorationType;
    private editorChangeDisposable: vscode.Disposable | undefined;

    private _onDidChangeTour = new vscode.EventEmitter<void>();
    readonly onDidChangeTour = this._onDidChangeTour.event;

    constructor(
        private aiService: IAiService,
        private store: ReviewStore,
    ) {
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

    /** Start a tour */
    async startTour(tour: CodeTour): Promise<void> {
        this.stopTour();
        this.currentTour = tour;
        this.currentStepIndex = 0;

        vscode.commands.executeCommand('setContext', 'codepilotReview.hasActiveTour', true);

        // Re-apply decorations when active editor changes
        this.editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateDecorations();
        });

        this._onDidChangeTour.fire();

        if (tour.steps.length > 0) {
            await this.navigateToStep(0);
        }
    }

    /** Navigate to a specific step by index */
    async goToStep(index: number): Promise<void> {
        if (!this.currentTour) { return; }
        if (index < 0 || index >= this.currentTour.steps.length) { return; }
        this.currentStepIndex = index;
        await this.navigateToStep(index);
    }

    async nextStep(): Promise<void> {
        if (!this.currentTour) { return; }
        if (this.currentStepIndex < this.currentTour.steps.length - 1) {
            this.currentStepIndex++;
            await this.navigateToStep(this.currentStepIndex);
        }
    }

    async prevStep(): Promise<void> {
        if (!this.currentTour) { return; }
        if (this.currentStepIndex > 0) {
            this.currentStepIndex--;
            await this.navigateToStep(this.currentStepIndex);
        }
    }

    getCurrentTour(): CodeTour | undefined {
        return this.currentTour;
    }

    getCurrentStepIndex(): number {
        return this.currentStepIndex;
    }

    getTotalSteps(): number {
        return this.currentTour?.steps.length || 0;
    }

    /** Get the URI for a tour step's file */
    getStepUri(step: CodeTourStep): vscode.Uri | undefined {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) { return undefined; }
        return vscode.Uri.joinPath(wsFolder.uri, step.filePath);
    }

    /** Get steps that are in a given file (by URI) */
    getStepsForUri(uri: vscode.Uri): { step: CodeTourStep; index: number }[] {
        if (!this.currentTour) { return []; }
        const results: { step: CodeTourStep; index: number }[] = [];
        for (let i = 0; i < this.currentTour.steps.length; i++) {
            const stepUri = this.getStepUri(this.currentTour.steps[i]);
            if (stepUri && stepUri.toString() === uri.toString()) {
                results.push({ step: this.currentTour.steps[i], index: i });
            }
        }
        return results;
    }

    private async navigateToStep(index: number): Promise<void> {
        if (!this.currentTour) { return; }
        const step = this.currentTour.steps[index];
        if (!step) { return; }

        const fileUri = this.getStepUri(step);
        if (!fileUri) { return; }

        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const line = Math.max(0, step.line - 1);
            await vscode.window.showTextDocument(doc, {
                preview: false,
                selection: new vscode.Range(line, 0, line, 0),
            });
            this.updateDecorations();
        } catch (error) {
            logger.error(`Failed to navigate to tour step: ${step.filePath}:${step.line}`, error);
        }

        this._onDidChangeTour.fire();
    }

    /** Update decorations on the active editor for current step */
    private updateDecorations(): void {
        if (!this.currentTour) { return; }
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        const step = this.currentTour.steps[this.currentStepIndex];
        if (!step) { return; }

        const stepUri = this.getStepUri(step);
        if (stepUri && editor.document.uri.toString() === stepUri.toString()) {
            const line = Math.max(0, step.line - 1);
            editor.setDecorations(this.currentStepDecoration, [
                new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
            ]);
        } else {
            editor.setDecorations(this.currentStepDecoration, []);
        }
    }

    stopTour(): void {
        this.currentTour = undefined;
        this.currentStepIndex = 0;

        this.editorChangeDisposable?.dispose();
        this.editorChangeDisposable = undefined;

        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.currentStepDecoration, []);
        }

        vscode.commands.executeCommand('setContext', 'codepilotReview.hasActiveTour', false);
        this._onDidChangeTour.fire();
    }

    dispose(): void {
        this.stopTour();
        this.currentStepDecoration.dispose();
        this._onDidChangeTour.dispose();
    }
}
