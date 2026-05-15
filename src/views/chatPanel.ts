import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IAiService } from '../ai/aiService';
import { DiffFile, ReviewIssue } from '../types';
import { logger } from '../logging/logger';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

/**
 * WebView-based chat panel for discussing code changes with Copilot.
 * Maintains conversation history and provides context from the current review.
 */
export class ChatPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private history: ChatMessage[] = [];
    private diff: DiffFile[] = [];
    private existingIssues: ReviewIssue[] = [];
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly aiService: IAiService,
        private readonly extensionUri: vscode.Uri,
    ) {}

    setContext(diff: DiffFile[], issues: ReviewIssue[]): void {
        this.diff = diff;
        this.existingIssues = issues;
    }

    async open(initialPrompt?: string): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Two);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'codepilotReview.chat',
                'CodepilotReview Chat',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this.extensionUri],
                },
            );

            this.panel.webview.html = this.getHtml();

            this.panel.webview.onDidReceiveMessage(
                async (msg) => {
                    if (msg.type === 'send') {
                        await this.handleUserMessage(msg.text);
                    } else if (msg.type === 'clear') {
                        this.history = [];
                        this.postMessage({ type: 'cleared' });
                    }
                },
                undefined,
                this.disposables,
            );

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            }, null, this.disposables);
        }

        if (initialPrompt) {
            await this.handleUserMessage(initialPrompt);
        }
    }

    private async handleUserMessage(text: string): Promise<void> {
        const userMsg: ChatMessage = { role: 'user', content: text, timestamp: new Date() };
        this.history.push(userMsg);
        this.postMessage({ type: 'message', role: 'user', content: text });
        this.postMessage({ type: 'thinking' });

        try {
            // Build context string with conversation history
            const contextParts: string[] = [];
            if (this.history.length > 1) {
                const prevMessages = this.history.slice(0, -1).map(m =>
                    `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
                ).join('\n\n');
                contextParts.push(`Previous conversation:\n${prevMessages}`);
            }

            const response = await this.aiService.chat(text, {
                diff: this.diff,
                existingIssues: this.existingIssues,
                conversationHistory: contextParts.join('\n\n'),
                knowledgeBase: this.loadKnowledgeBase(),
            });

            const assistantMsg: ChatMessage = { role: 'assistant', content: response, timestamp: new Date() };
            this.history.push(assistantMsg);
            this.postMessage({ type: 'message', role: 'assistant', content: response });
        } catch (error) {
            logger.error('Chat error', error);
            this.postMessage({
                type: 'message',
                role: 'assistant',
                content: `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    private postMessage(msg: unknown): void {
        this.panel?.webview.postMessage(msg);
    }

    /** Load knowledge base docs from the workspace */
    private loadKnowledgeBase(): string | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return undefined; }

        const kbPaths = [
            path.join(workspaceFolder.uri.fsPath, 'docs', 'knowledge-base'),
            path.join(workspaceFolder.uri.fsPath, '.codepilotreview', 'knowledge-base'),
        ];

        const parts: string[] = [];
        for (const kbPath of kbPaths) {
            if (!fs.existsSync(kbPath)) { continue; }
            try {
                const files = fs.readdirSync(kbPath).filter(f => f.endsWith('.md'));
                for (const file of files.slice(0, 5)) { // Limit to avoid huge prompts
                    const content = fs.readFileSync(path.join(kbPath, file), 'utf-8');
                    // Truncate large files
                    parts.push(`## ${file}\n${content.substring(0, 2000)}`);
                }
            } catch {
                // Skip unreadable KB dirs
            }
        }

        return parts.length > 0 ? parts.join('\n\n') : undefined;
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodepilotReview Chat</title>
    <style>
        :root {
            --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
        }
        body {
            margin: 0; padding: 0;
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex; flex-direction: column; height: 100vh;
        }
        #chat-header {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex; justify-content: space-between; align-items: center;
        }
        #chat-header h3 { margin: 0; font-size: 13px; }
        #clear-btn {
            background: none; border: none; color: var(--vscode-textLink-foreground);
            cursor: pointer; font-size: 12px; padding: 2px 6px;
        }
        #clear-btn:hover { text-decoration: underline; }
        #messages {
            flex: 1; overflow-y: auto; padding: 12px;
        }
        .message {
            margin-bottom: 12px; padding: 8px 12px;
            border-radius: 6px; max-width: 90%; white-space: pre-wrap;
            line-height: 1.5; font-size: 13px;
        }
        .message.user {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            margin-left: auto;
        }
        .message.assistant {
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        .thinking {
            color: var(--vscode-descriptionForeground);
            font-style: italic; font-size: 12px; margin-bottom: 12px;
        }
        #input-area {
            border-top: 1px solid var(--vscode-panel-border);
            padding: 8px; display: flex; gap: 8px;
        }
        #input {
            flex: 1; padding: 6px 10px; border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            font-family: var(--vscode-font-family); font-size: 13px;
            outline: none; resize: none; min-height: 36px; max-height: 120px;
        }
        #input:focus { border-color: var(--vscode-focusBorder); }
        #send-btn {
            padding: 6px 16px; border-radius: 4px; border: none;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer; font-size: 13px;
        }
        #send-btn:hover { background: var(--vscode-button-hoverBackground); }
        #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    </style>
</head>
<body>
    <div id="chat-header">
        <h3>Chat about this code change</h3>
        <button id="clear-btn">Clear</button>
    </div>
    <div id="messages"></div>
    <div id="input-area">
        <textarea id="input" placeholder="Ask about the code change..." rows="1"></textarea>
        <button id="send-btn">Send</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const messagesEl = document.getElementById('messages');
        const inputEl = document.getElementById('input');
        const sendBtn = document.getElementById('send-btn');
        const clearBtn = document.getElementById('clear-btn');
        let thinkingEl = null;

        function addMessage(role, content) {
            if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
            const div = document.createElement('div');
            div.className = 'message ' + role;
            div.textContent = content;
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function showThinking() {
            if (thinkingEl) return;
            thinkingEl = document.createElement('div');
            thinkingEl.className = 'thinking';
            thinkingEl.textContent = 'Thinking...';
            messagesEl.appendChild(thinkingEl);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function send() {
            const text = inputEl.value.trim();
            if (!text) return;
            inputEl.value = '';
            inputEl.style.height = 'auto';
            sendBtn.disabled = true;
            vscode.postMessage({ type: 'send', text });
        }

        sendBtn.addEventListener('click', send);
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
        inputEl.addEventListener('input', () => {
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
        });
        clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
        });

        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'message':
                    addMessage(msg.role, msg.content);
                    sendBtn.disabled = false;
                    break;
                case 'thinking':
                    showThinking();
                    break;
                case 'cleared':
                    messagesEl.innerHTML = '';
                    sendBtn.disabled = false;
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
