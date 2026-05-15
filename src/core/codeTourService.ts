import * as vscode from 'vscode';
import { CodeTour, CodeTourStep, Partition, DiffFile } from '../types';
import { IAiService } from '../ai/aiService';
import { ReviewStore } from '../storage/reviewStore';
import { logger } from '../logging/logger';

/**
 * Service for generating and navigating code tours.
 * Creates guided walkthroughs of code changes based on partitions.
 */
export class CodeTourService {
    private currentTour: CodeTour | undefined;
    private currentStepIndex: number = 0;
    private stepDecoration: vscode.TextEditorDecorationType;
    private annotationDecorationType: vscode.TextEditorDecorationType;
    private allStepDecorations: Map<string, vscode.DecorationOptions[]> = new Map();

    private _onDidChangeTour = new vscode.EventEmitter<void>();
    readonly onDidChangeTour = this._onDidChangeTour.event;

    constructor(
        private aiService: IAiService,
        private store: ReviewStore,
    ) {
        this.stepDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            isWholeLine: true,
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        });

        // Inline annotation decoration for tour step descriptions
        this.annotationDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1em',
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                fontStyle: 'italic',
            },
            isWholeLine: true,
        });
    }

    /** Generate a code tour for a partition */
    async generateTour(
        prId: string,
        partition: Partition,
        diff: DiffFile[],
        token?: vscode.CancellationToken
    ): Promise<CodeTour> {
        logger.info(`Generating tour for partition: ${partition.name}`);

        // Build context about the files in this partition
        const partitionDiff = diff.filter(f => {
            const path = f.newPath || f.oldPath || '';
            return partition.chunks.some(c => c.filePath === path);
        });

        const diffSummary = partitionDiff.map(f => {
            const path = f.newPath || f.oldPath || '';
            const addedLines = f.hunks.reduce((sum, h) =>
                sum + h.lines.filter(l => l.type === 'add').length, 0);
            const deletedLines = f.hunks.reduce((sum, h) =>
                sum + h.lines.filter(l => l.type === 'delete').length, 0);
            return `${path}: +${addedLines} -${deletedLines} (${f.changeType})`;
        }).join('\n');

        // Use AI to generate tour steps
        const prompt =
            `Generate a code review walkthrough for the "${partition.name}" partition.\n\n` +
            `Description: ${partition.description}\n\n` +
            `Files changed:\n${diffSummary}\n\n` +
            `For each significant change, provide a tour step with:\n` +
            `- title: brief name for this step\n` +
            `- description: explain WHY this change was made and HOW it works\n` +
            `- filePath: the file\n` +
            `- line: the key line number to focus on\n\n` +
            `Respond with a JSON array:\n` +
            '```json\n' +
            '[{"title": "...", "description": "...", "filePath": "...", "line": 1}]\n' +
            '```';

        const response = await this.aiService.chat(prompt, { diff: partitionDiff }, token);

        let steps: CodeTourStep[] = [];
        try {
            const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
            const jsonStr = jsonMatch ? jsonMatch[1] : response;
            const parsed = JSON.parse(jsonStr.trim()) as Array<{
                title: string; description: string; filePath: string; line: number;
            }>;
            steps = parsed.map(s => ({
                ...s,
                partitionId: partition.id,
            }));
        } catch (error) {
            logger.error('Failed to parse tour steps from AI', error);
            // Fallback: one step per file
            steps = partition.chunks.map(chunk => ({
                title: `Review ${chunk.filePath}`,
                description: `Changes in ${chunk.filePath}`,
                filePath: chunk.filePath,
                line: chunk.lineRanges?.[0]?.start || 1,
                partitionId: partition.id,
            }));
        }

        const tour: CodeTour = {
            id: `tour-${partition.id}`,
            name: `Tour: ${partition.name}`,
            steps,
        };

        await this.store.saveTour(prId, tour);
        return tour;
    }

    /** Start a tour */
    async startTour(tour: CodeTour): Promise<void> {
        this.currentTour = tour;
        this.currentStepIndex = 0;
        this._onDidChangeTour.fire();

        // Pre-compute inline annotations per file
        this.allStepDecorations.clear();
        for (let i = 0; i < tour.steps.length; i++) {
            const step = tour.steps[i];
            const key = step.filePath;
            if (!this.allStepDecorations.has(key)) {
                this.allStepDecorations.set(key, []);
            }
            const line = Math.max(0, step.line - 1);
            this.allStepDecorations.get(key)!.push({
                range: new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
                renderOptions: {
                    after: {
                        contentText: `  ◀ Step ${i + 1}: ${step.title} — ${step.description.substring(0, 80)}`,
                    },
                },
            });
        }

        if (tour.steps.length > 0) {
            await this.showStep(0);
        }
    }

    /** Navigate to the next step */
    async nextStep(): Promise<void> {
        if (!this.currentTour) { return; }
        if (this.currentStepIndex < this.currentTour.steps.length - 1) {
            this.currentStepIndex++;
            await this.showStep(this.currentStepIndex);
        }
    }

    /** Navigate to the previous step */
    async prevStep(): Promise<void> {
        if (!this.currentTour) { return; }
        if (this.currentStepIndex > 0) {
            this.currentStepIndex--;
            await this.showStep(this.currentStepIndex);
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

    private async showStep(index: number): Promise<void> {
        if (!this.currentTour) { return; }
        const step = this.currentTour.steps[index];
        if (!step) { return; }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, step.filePath);

        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                selection: new vscode.Range(
                    Math.max(0, step.line - 1), 0,
                    Math.max(0, step.line - 1), 0
                ),
            });

            // Highlight the current step line
            editor.setDecorations(this.stepDecoration, [
                new vscode.Range(Math.max(0, step.line - 1), 0, Math.max(0, step.line - 1), Number.MAX_SAFE_INTEGER),
            ]);

            // Apply inline annotations for all tour steps in this file
            const fileAnnotations = this.allStepDecorations.get(step.filePath) || [];
            editor.setDecorations(this.annotationDecorationType, fileAnnotations);

            // Show step info with navigation
            const stepNum = index + 1;
            const total = this.currentTour.steps.length;
            const actions: string[] = [];
            if (index > 0) { actions.push('Previous'); }
            if (index < total - 1) { actions.push('Next'); }
            actions.push('Stop Tour');

            vscode.window.showInformationMessage(
                `Tour Step ${stepNum}/${total}: ${step.title}\n\n${step.description}`,
                ...actions
            ).then(action => {
                if (action === 'Next') { this.nextStep(); }
                if (action === 'Previous') { this.prevStep(); }
                if (action === 'Stop Tour') { this.stopTour(); }
            });

        } catch (error) {
            logger.error(`Failed to show tour step: ${step.filePath}:${step.line}`, error);
        }

        this._onDidChangeTour.fire();
    }

    /** Stop the current tour and clear decorations */
    stopTour(): void {
        this.currentTour = undefined;
        this.currentStepIndex = 0;
        this.allStepDecorations.clear();

        // Clear decorations from all visible editors
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.stepDecoration, []);
            editor.setDecorations(this.annotationDecorationType, []);
        }

        this._onDidChangeTour.fire();
    }

    dispose(): void {
        this.stepDecoration.dispose();
        this.annotationDecorationType.dispose();
        this._onDidChangeTour.dispose();
    }
}
