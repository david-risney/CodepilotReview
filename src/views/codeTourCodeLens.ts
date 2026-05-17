import * as vscode from 'vscode';
import { CodeTourService } from '../core/codeTourService';

/**
 * CodeLensProvider that shows tour step indicators above relevant lines.
 * Only shows lenses for steps in the currently open file.
 * Current step gets prev/next/details actions; other steps get a "go to step" action.
 */
export class CodeTourCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(private tourService: CodeTourService) {
        tourService.onDidChangeTour(() => this._onDidChangeCodeLenses.fire());
    }

    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.CodeLens[] {
        const tour = this.tourService.getCurrentTour();
        if (!tour) { return []; }

        const stepsInFile = this.tourService.getStepsForUri(document.uri);
        if (stepsInFile.length === 0) { return []; }

        const currentIdx = this.tourService.getCurrentStepIndex();
        const total = this.tourService.getTotalSteps();
        const lenses: vscode.CodeLens[] = [];

        for (const { step, index } of stepsInFile) {
            const line = Math.max(0, step.line - 1);
            const range = new vscode.Range(line, 0, line, 0);
            const isCurrent = index === currentIdx;

            // Main step label — clicking goes to this step
            const label = `📍 Step ${index + 1}/${total}: ${step.title}`;
            lenses.push(new vscode.CodeLens(range, {
                title: label,
                command: 'codepilotReview.goToTourStep',
                arguments: [index],
            }));

            if (isCurrent) {
                // Prev button
                if (index > 0) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: '◀ Prev',
                        command: 'codepilotReview.prevTourStep',
                    }));
                }

                // Next button
                if (index < total - 1) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: 'Next ▶',
                        command: 'codepilotReview.nextTourStep',
                    }));
                }

                // Details button — focuses the side pane
                lenses.push(new vscode.CodeLens(range, {
                    title: '📖 Details',
                    command: 'codepilotReview.showTourDetails',
                }));
            }
        }

        return lenses;
    }
}
