import * as vscode from 'vscode';
import { CodeTourService } from '../core/codeTourService';

/**
 * WebviewViewProvider for the Code Tour side pane.
 * Shows the full text of the current tour step with prev/next and go-to-code buttons.
 */
export class CodeTourViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codepilotReview.tourDetails';

    private view: vscode.WebviewView | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly tourService: CodeTourService,
    ) {
        tourService.onDidChangeTour(() => this.updateView());
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'prev': this.tourService.prevStep(); break;
                case 'next': this.tourService.nextStep(); break;
                case 'goToCode': this.tourService.goToStep(this.tourService.getCurrentStepIndex()); break;
                case 'goToStep': this.tourService.goToStep(message.index); break;
                case 'stop': this.tourService.stopTour(); break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateView();
            }
        });

        this.updateView();
    }

    private updateView(): void {
        if (!this.view) { return; }

        const tour = this.tourService.getCurrentTour();
        if (!tour) {
            this.view.webview.html = this.getNoTourHtml();
            return;
        }

        const stepIndex = this.tourService.getCurrentStepIndex();
        const step = tour.steps[stepIndex];
        const total = tour.steps.length;

        this.view.webview.html = this.getTourHtml(step, stepIndex, total, tour.steps);
    }

    private getNoTourHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-tour';">
    <style>${this.getStyles()}</style>
</head>
<body>
    <div class="empty">
        <p>No code tour active.</p>
        <p class="hint">Select a code review and click "Start Code Tour" to begin.</p>
    </div>
</body>
</html>`;
    }

    private getTourHtml(
        step: { title: string; description: string; filePath: string; line: number },
        index: number,
        total: number,
        allSteps: { title: string; filePath: string }[],
    ): string {
        const safeTitle = this.escapeHtml(step.title);
        const safeDesc = this.escapeHtml(step.description);
        const safeFile = this.escapeHtml(step.filePath);
        const hasPrev = index > 0;
        const hasNext = index < total - 1;

        const stepListHtml = allSteps.map((s, i) => {
            const active = i === index ? ' class="step-item active"' : ' class="step-item"';
            const sTitle = this.escapeHtml(s.title);
            const sFile = this.escapeHtml(s.filePath);
            return `<div${active} data-index="${i}">
                <span class="step-num">${i + 1}.</span>
                <span class="step-title">${sTitle}</span>
                <span class="step-file">${sFile}</span>
            </div>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-tour';">
    <style>${this.getStyles()}</style>
</head>
<body>
    <div class="header">
        <div class="step-counter">Step ${index + 1} of ${total}</div>
        <div class="nav-buttons">
            <button class="nav-btn" id="prevBtn" ${hasPrev ? '' : 'disabled'} title="Previous step">◀ Prev</button>
            <button class="nav-btn" id="nextBtn" ${hasNext ? '' : 'disabled'} title="Next step">Next ▶</button>
            <button class="nav-btn accent" id="goToCodeBtn" title="Go to this step in the editor">📄 Go to Code</button>
            <button class="nav-btn danger" id="stopBtn" title="Stop the tour">✕</button>
        </div>
    </div>

    <div class="step-content">
        <h2>${safeTitle}</h2>
        <div class="file-location">${safeFile}:${step.line}</div>
        <div class="description">${safeDesc}</div>
    </div>

    <div class="step-list">
        <h3>All Steps</h3>
        ${stepListHtml}
    </div>

    <script nonce="tour">
        const vscode = acquireVsCodeApi();

        document.getElementById('prevBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'prev' });
        });
        document.getElementById('nextBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'next' });
        });
        document.getElementById('goToCodeBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'goToCode' });
        });
        document.getElementById('stopBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'stop' });
        });

        document.querySelectorAll('.step-item').forEach(el => {
            el.addEventListener('click', () => {
                const index = parseInt(el.getAttribute('data-index') || '0', 10);
                vscode.postMessage({ command: 'goToStep', index });
            });
        });
    </script>
</body>
</html>`;
    }

    private getStyles(): string {
        return `
            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                color: var(--vscode-foreground);
                padding: 0 8px;
                margin: 0;
            }
            .empty {
                text-align: center;
                padding: 20px 0;
                opacity: 0.7;
            }
            .hint { font-size: 0.9em; opacity: 0.7; }
            .header {
                padding: 8px 0;
                border-bottom: 1px solid var(--vscode-panel-border);
                margin-bottom: 8px;
            }
            .step-counter {
                font-weight: bold;
                margin-bottom: 6px;
                font-size: 0.9em;
                opacity: 0.8;
            }
            .nav-buttons {
                display: flex;
                gap: 4px;
                flex-wrap: wrap;
            }
            .nav-btn {
                padding: 4px 8px;
                border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                cursor: pointer;
                border-radius: 3px;
                font-size: 0.85em;
            }
            .nav-btn:hover:not(:disabled) {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            .nav-btn:disabled {
                opacity: 0.4;
                cursor: default;
            }
            .nav-btn.accent {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }
            .nav-btn.accent:hover {
                background: var(--vscode-button-hoverBackground);
            }
            .nav-btn.danger {
                opacity: 0.7;
            }
            .step-content {
                padding: 4px 0;
            }
            .step-content h2 {
                margin: 4px 0 8px 0;
                font-size: 1.1em;
            }
            .file-location {
                font-family: var(--vscode-editor-font-family);
                font-size: 0.85em;
                opacity: 0.7;
                margin-bottom: 8px;
            }
            .description {
                line-height: 1.5;
                white-space: pre-wrap;
            }
            .step-list {
                margin-top: 16px;
                border-top: 1px solid var(--vscode-panel-border);
                padding-top: 8px;
            }
            .step-list h3 {
                margin: 0 0 8px 0;
                font-size: 0.9em;
                opacity: 0.7;
            }
            .step-item {
                padding: 4px 6px;
                cursor: pointer;
                border-radius: 3px;
                display: flex;
                gap: 6px;
                align-items: baseline;
                font-size: 0.9em;
            }
            .step-item:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .step-item.active {
                background: var(--vscode-list-activeSelectionBackground);
                color: var(--vscode-list-activeSelectionForeground);
            }
            .step-num {
                opacity: 0.6;
                min-width: 20px;
            }
            .step-title {
                flex: 1;
            }
            .step-file {
                font-size: 0.8em;
                opacity: 0.5;
                font-family: var(--vscode-editor-font-family);
            }
        `;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/\n/g, '<br>');
    }
}
