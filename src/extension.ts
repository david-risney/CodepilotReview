import * as vscode from 'vscode';
import { ReviewIssue, PullRequestStatus, ReviewPriority, UserNeedLevel } from './types';
import { Configuration } from './config/configuration';
import { LocalProvider } from './providers/localProvider';
import { AzureDevOpsProvider } from './providers/adoProvider';
import { GitHubProvider } from './providers/githubProvider';
import { ChromiumProvider } from './providers/chromiumProvider';
import { ICodeReviewProvider } from './providers/provider';
import { PullRequestService } from './core/pullRequestService';
import { ReviewSessionService } from './core/reviewSessionService';
import { PartitionService } from './core/partitionService';
import { CodeTourService } from './core/codeTourService';
import { ReviewerSuggestionService } from './core/reviewerSuggestionService';
import { PrListViewProvider } from './views/prListView';
import { ReviewIssuesViewProvider } from './views/reviewIssuesView';
import { PartitionViewProvider } from './views/partitionView';
import { ChatPanel } from './views/chatPanel';
import { DiffContentProvider, openDiffView } from './views/diffContentProvider';
import { ReviewCommentController } from './comments/commentController';
import { ReviewToolManager } from './reviewTools/reviewToolManager';
import { ReviewStore } from './storage/reviewStore';
import { AuthManager } from './auth/authManager';
import { CopilotAiService, StubAiService, IAiService } from './ai/aiService';
import { CodepilotReviewError } from './errors';
import { logger } from './logging/logger';

let currentProvider: ICodeReviewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.info('CodepilotReview extension activating...');

    // Initialize configuration
    const config = new Configuration();
    await config.initialize();
    context.subscriptions.push({ dispose: () => config.dispose() });

    // Initialize auth
    const authManager = new AuthManager();
    authManager.initialize(context);
    context.subscriptions.push({ dispose: () => authManager.dispose() });

    // Initialize storage
    const store = new ReviewStore();
    store.initialize(context);

    // Initialize AI service — try Copilot, fall back to stub
    let aiService: IAiService;
    const copilotAi = new CopilotAiService();
    if (await copilotAi.isAvailable()) {
        aiService = copilotAi;
        logger.info('Copilot AI service initialized');
    } else {
        aiService = new StubAiService();
        logger.info('Copilot not available, using stub AI service');
    }

    // Initialize services
    const prService = new PullRequestService();
    prService.setAiService(aiService);
    const sessionService = new ReviewSessionService();
    const partitionService = new PartitionService(aiService, store);
    const tourService = new CodeTourService(aiService, store);
    const toolManager = new ReviewToolManager(config, aiService);

    // Initialize views
    const prListView = new PrListViewProvider(prService);

    // Refresh PR list when AI enrichment completes
    prService.onDidEnrich(() => prListView.refresh());

    const prTreeView = vscode.window.createTreeView('codepilotReview.prList', {
        treeDataProvider: prListView,
        showCollapseAll: true,
    });
    context.subscriptions.push(prTreeView);

    const reviewIssuesView = new ReviewIssuesViewProvider(sessionService);
    const reviewIssuesTreeView = vscode.window.createTreeView('codepilotReview.reviewIssues', {
        treeDataProvider: reviewIssuesView,
        showCollapseAll: true,
    });
    context.subscriptions.push(reviewIssuesTreeView);

    const partitionView = new PartitionViewProvider(partitionService, tourService);
    const partitionTreeView = vscode.window.createTreeView('codepilotReview.partitions', {
        treeDataProvider: partitionView,
        showCollapseAll: true,
    });
    context.subscriptions.push(partitionTreeView);

    // Initialize comment controller
    const commentController = new ReviewCommentController(sessionService);
    context.subscriptions.push({ dispose: () => commentController.dispose() });

    // Initialize chat panel
    const chatPanel = new ChatPanel(aiService, context.extensionUri);
    context.subscriptions.push(chatPanel);

    // Register virtual document provider for read-only diff viewing
    const diffContentProvider = new DiffContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('codepilot-diff', diffContentProvider)
    );
    context.subscriptions.push(diffContentProvider);

    // Helper: show error to user
    const showError = (error: unknown) => {
        if (error instanceof CodepilotReviewError && error.userMessage) {
            vscode.window.showErrorMessage(error.userMessage, 'Show Output').then(action => {
                if (action === 'Show Output') { logger.show(); }
            });
        } else {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
        logger.error('Command error', error);
    };

    // Provider factory
    const createProvider = (name: string): ICodeReviewProvider => {
        switch (name) {
            case 'azureDevOps': return new AzureDevOpsProvider();
            case 'github': return new GitHubProvider();
            case 'chromium': return new ChromiumProvider();
            case 'local':
            default: return new LocalProvider();
        }
    };

    // Initialize provider
    const initProvider = async (providerName: string): Promise<void> => {
        if (currentProvider) {
            currentProvider.dispose();
        }

        currentProvider = createProvider(providerName);
        await currentProvider.initialize(context);

        // Check auth if needed
        if (currentProvider.capabilities.requiresAuthentication) {
            await authManager.ensureAuthenticated(currentProvider.name, currentProvider.auth);
        }

        prService.setProvider(currentProvider);
        sessionService.setProvider(currentProvider);
        diffContentProvider.setProvider(currentProvider);
        commentController.setLocalProvider(providerName === 'local');

        prListView.refresh();
        logger.info(`Provider set to: ${currentProvider.name}`);
    };

    // Set initial provider
    const initialProvider = config.getConfig().provider;
    await initProvider(initialProvider);

    // Register commands
    context.subscriptions.push(
        // --- PR Commands ---
        vscode.commands.registerCommand('codepilotReview.openReview', async (pr) => {
            if (!pr) {
                vscode.window.showWarningMessage('No pull request selected');
                return;
            }
            try {
                await sessionService.openReview(pr.id);
                await store.addReviewedPrId(pr.id);
                const issues = sessionService.getIssues();
                const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (workspaceUri) {
                    await commentController.showIssues(issues, workspaceUri);
                }
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.refreshPRs', () => {
            prListView.refresh();
        }),

        vscode.commands.registerCommand('codepilotReview.selectProvider', async () => {
            const items = [
                { label: 'Local', description: 'Git diff based review', value: 'local' },
                { label: 'Azure DevOps', description: 'ADO pull requests', value: 'azureDevOps' },
                { label: 'GitHub', description: 'GitHub pull requests', value: 'github' },
                { label: 'Chromium', description: 'Gerrit code review', value: 'chromium' },
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select code review provider',
            });

            if (selected) {
                await initProvider(selected.value);
                vscode.window.showInformationMessage(`Switched to ${selected.label} provider`);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.filterPRs', async () => {
            const filterType = await vscode.window.showQuickPick(
                [
                    { label: '$(search) Text Search', description: 'Filter by title, author, description', value: 'text' },
                    { label: '$(filter) Status', description: 'Filter by PR status', value: 'status' },
                    { label: '$(person) User Need', description: 'Filter by how much your attention is needed', value: 'userNeed' },
                    { label: '$(arrow-up) Priority', description: 'Filter by AI-assessed priority', value: 'priority' },
                    { label: '$(close) Clear Filters', description: 'Remove all filters', value: 'clear' },
                ],
                { placeHolder: 'Choose filter type' }
            );

            if (!filterType) { return; }

            switch (filterType.value) {
                case 'text': {
                    const text = await vscode.window.showInputBox({
                        prompt: 'Filter pull requests',
                        placeHolder: 'Search by title, author, description, label...',
                    });
                    if (text !== undefined) {
                        prListView.setFilter(text);
                    }
                    break;
                }
                case 'status': {
                    const statuses = await vscode.window.showQuickPick(
                        ['open', 'closed', 'merged', 'draft', 'abandoned'].map(s => ({ label: s, picked: false })),
                        { canPickMany: true, placeHolder: 'Select statuses to show' }
                    );
                    if (statuses) {
                        prListView.setStatusFilter(statuses.map(s => s.label as PullRequestStatus));
                    }
                    break;
                }
                case 'userNeed': {
                    const needs = await vscode.window.showQuickPick(
                        [
                            { label: 'blocking', description: 'You are blocking this PR' },
                            { label: 'required', description: 'Your review is required' },
                            { label: 'optional', description: 'Your review is optional' },
                            { label: 'fyi', description: 'FYI only, no action needed' },
                        ],
                        { canPickMany: true, placeHolder: 'Select user need levels to show' }
                    );
                    if (needs) {
                        prListView.setUserNeedFilter(needs.map(n => n.label as UserNeedLevel));
                    }
                    break;
                }
                case 'priority': {
                    const priorities = await vscode.window.showQuickPick(
                        ['blocking', 'yes', 'interest', 'no'].map(p => ({ label: p })),
                        { canPickMany: true, placeHolder: 'Select priorities to show' }
                    );
                    if (priorities) {
                        prListView.setPriorityFilter(priorities.map(p => p.label as ReviewPriority));
                    }
                    break;
                }
                case 'clear':
                    prListView.setFilter('');
                    prListView.setStatusFilter([]);
                    prListView.setUserNeedFilter([]);
                    prListView.setPriorityFilter([]);
                    break;
            }
        }),

        // --- Review Tool Commands ---
        vscode.commands.registerCommand('codepilotReview.runReviewTools', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) {
                vscode.window.showWarningMessage('Open a review first');
                return;
            }

            try {
                const diff = sessionService.getDiff();
                const existingIssues = sessionService.getIssues();

                const issues = await toolManager.runTools({
                    pullRequestId: prId,
                    diff,
                    existingIssues,
                });

                if (issues.length === 0) {
                    vscode.window.showInformationMessage('Review tools found no issues');
                    return;
                }

                // Let user pick which issues to keep (triage step)
                const picks = issues.map(issue => ({
                    label: issue.summary,
                    description: `${issue.position.filePath}:${issue.position.line}`,
                    detail: issue.details?.substring(0, 120),
                    picked: true, // default all selected
                    issue,
                }));

                const selected = await vscode.window.showQuickPick(picks, {
                    canPickMany: true,
                    placeHolder: `${issues.length} potential issue(s) found. Select which to keep as draft review issues.`,
                    title: 'Triage Review Tool Results',
                });

                if (!selected || selected.length === 0) {
                    vscode.window.showInformationMessage('No issues selected');
                    return;
                }

                for (const pick of selected) {
                    sessionService.addIssue(pick.issue);
                }

                const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (workspaceUri) {
                    await commentController.showIssues(sessionService.getIssues(), workspaceUri);
                }

                vscode.window.showInformationMessage(
                    `Added ${selected.length} of ${issues.length} issue(s) as drafts`
                );
            } catch (error) {
                showError(error);
            }
        }),

        // --- Issue Commands ---
        vscode.commands.registerCommand('codepilotReview.createIssue', async () => {
            // Create a new review issue from the current editor position
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Open a file first');
                return;
            }
            const prId = sessionService.getCurrentPrId();
            if (!prId) {
                vscode.window.showWarningMessage('Open a review first');
                return;
            }

            const summary = await vscode.window.showInputBox({
                prompt: 'Issue summary (TLDR)',
                placeHolder: 'e.g., Missing null check before dereference',
            });
            if (!summary) { return; }

            const details = await vscode.window.showInputBox({
                prompt: 'Details (optional)',
                placeHolder: 'Full description of the issue...',
            });

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const filePath = workspaceFolder
                ? vscode.workspace.asRelativePath(editor.document.uri, false)
                : editor.document.fileName;
            const line = editor.selection.active.line + 1;

            const issue: ReviewIssue = {
                id: `user-${Date.now()}`,
                summary,
                details: details || '',
                position: { filePath, line, side: 'head' },
                status: 'draft',
                source: 'user',
                createdAt: new Date(),
            };

            sessionService.addIssue(issue);

            if (workspaceFolder) {
                await commentController.showIssues(sessionService.getIssues(), workspaceFolder.uri);
            }

            vscode.window.showInformationMessage(`Created draft issue: ${summary}`);
        }),

        vscode.commands.registerCommand('codepilotReview.goToIssue', async (issue) => {
            if (!issue) { return; }
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) { return; }

            const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, issue.position.filePath);
            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const line = Math.max(0, issue.position.line - 1);
                await vscode.window.showTextDocument(doc, {
                    selection: new vscode.Range(line, 0, line, 0),
                });
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.acceptIssue', async (item) => {
            const issue = item?.issue;
            if (!issue) { return; }
            sessionService.acceptIssue(issue.id);
            reviewIssuesView.refresh();
        }),

        vscode.commands.registerCommand('codepilotReview.dismissIssue', (item) => {
            const issue = item?.issue;
            if (!issue) { return; }
            sessionService.dismissIssue(issue.id);
        }),

        vscode.commands.registerCommand('codepilotReview.challengeIssue', async (item) => {
            const issue = item?.issue;
            if (!issue) { return; }

            try {
                const explanation = await aiService.explainIssue(
                    issue, sessionService.getDiff()
                );
                // Show explanation in a new document
                const doc = await vscode.workspace.openTextDocument({
                    content: `# Is This Really an Issue?\n\n**${issue.summary}**\n\n${explanation}`,
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.fixIssue', async (item) => {
            const issue = item?.issue;
            if (!issue) { return; }

            try {
                if (issue.suggestedFix) {
                    switch (issue.suggestedFix.kind) {
                        case 'workspaceEdit':
                            await vscode.workspace.applyEdit(issue.suggestedFix.edit);
                            break;
                        case 'openChat':
                            await vscode.commands.executeCommand(
                                'codepilotReview.openChat', issue.suggestedFix.prompt
                            );
                            break;
                        case 'copyPatch':
                            await vscode.env.clipboard.writeText(issue.suggestedFix.patch);
                            vscode.window.showInformationMessage('Patch copied to clipboard');
                            break;
                        case 'suggestedChangeComment': {
                            // Apply the suggested content change directly
                            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                            if (workspaceFolder && issue.position) {
                                const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, issue.position.filePath);
                                const edit = new vscode.WorkspaceEdit();
                                const line = Math.max(0, issue.position.line - 1);
                                edit.replace(fileUri, new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), issue.suggestedFix.newContent);
                                await vscode.workspace.applyEdit(edit);
                                vscode.window.showInformationMessage('Fix applied');
                            }
                            break;
                        }
                    }
                } else {
                    // Ask AI for a fix and offer to apply it
                    const fix = await aiService.proposeFix(issue, sessionService.getDiff());

                    // Try to extract a code block from the fix and apply it
                    const codeBlockMatch = fix.match(/```[\w]*\n([\s\S]*?)```/);
                    if (codeBlockMatch) {
                        const suggestedCode = codeBlockMatch[1].trim();
                        const action = await vscode.window.showInformationMessage(
                            `Fix suggested for: ${issue.summary}`,
                            'Apply', 'Copy to Clipboard', 'View Details'
                        );
                        if (action === 'Apply') {
                            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                            if (workspaceFolder && issue.position) {
                                const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, issue.position.filePath);
                                const edit = new vscode.WorkspaceEdit();
                                const line = Math.max(0, issue.position.line - 1);
                                edit.replace(fileUri, new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), suggestedCode);
                                await vscode.workspace.applyEdit(edit);
                            }
                        } else if (action === 'Copy to Clipboard') {
                            await vscode.env.clipboard.writeText(suggestedCode);
                            vscode.window.showInformationMessage('Fix copied to clipboard');
                        } else if (action === 'View Details') {
                            const doc = await vscode.workspace.openTextDocument({
                                content: `# Suggested Fix\n\n**${issue.summary}**\n\n${fix}`,
                                language: 'markdown',
                            });
                            await vscode.window.showTextDocument(doc, { preview: true });
                        }
                    } else {
                        const doc = await vscode.workspace.openTextDocument({
                            content: `# Suggested Fix\n\n**${issue.summary}**\n\n${fix}`,
                            language: 'markdown',
                        });
                        await vscode.window.showTextDocument(doc, { preview: true });
                    }
                }
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.publishDraftComments', async () => {
            try {
                const count = await sessionService.publishAllDrafts();
                vscode.window.showInformationMessage(`Published ${count} draft comment(s)`);
            } catch (error) {
                showError(error);
            }
        }),

        // --- Partition Commands ---
        vscode.commands.registerCommand('codepilotReview.partitionByDependency', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) { vscode.window.showWarningMessage('Open a review first'); return; }

            try {
                const partitions = await partitionService.partitionByDependency(
                    prId, sessionService.getDiff()
                );
                partitionView.setPartitions(partitions);
                vscode.window.showInformationMessage(
                    `Created ${partitions.length} dependency partition(s)`
                );
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.partitionByOwnership', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) { vscode.window.showWarningMessage('Open a review first'); return; }
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

            try {
                const partitions = await partitionService.partitionByOwnership(
                    prId, sessionService.getDiff(), wsRoot
                );
                partitionView.setPartitions(partitions);
                vscode.window.showInformationMessage(
                    `Created ${partitions.length} ownership partition(s)`
                );
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.partitionCustom', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) { vscode.window.showWarningMessage('Open a review first'); return; }

            const criteria = await vscode.window.showInputBox({
                prompt: 'Describe how to partition this code change',
                placeHolder: 'e.g., separate upstream vs downstream changes',
            });
            if (!criteria) { return; }

            try {
                const partitions = await partitionService.partitionCustom(
                    prId, sessionService.getDiff(), criteria
                );
                partitionView.setPartitions(partitions);
                vscode.window.showInformationMessage(
                    `Created ${partitions.length} custom partition(s)`
                );
            } catch (error) {
                showError(error);
            }
        }),

        // --- Code Tour Commands ---
        vscode.commands.registerCommand('codepilotReview.startTour', async (partition) => {
            if (!partition) { return; }
            const prId = sessionService.getCurrentPrId();
            if (!prId) { return; }

            try {
                const tour = await tourService.generateTour(
                    prId, partition, sessionService.getDiff()
                );
                await tourService.startTour(tour);
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.nextTourStep', () => {
            tourService.nextStep();
        }),

        vscode.commands.registerCommand('codepilotReview.prevTourStep', () => {
            tourService.prevStep();
        }),

        // --- Reviewer Commands ---
        vscode.commands.registerCommand('codepilotReview.suggestReviewers', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) { vscode.window.showWarningMessage('Open a review first'); return; }
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) { return; }

            try {
                const reviewerService = new ReviewerSuggestionService(wsRoot);
                const suggestions = await reviewerService.suggestReviewers(
                    sessionService.getDiff()
                );

                if (suggestions.length === 0) {
                    vscode.window.showInformationMessage('No reviewer suggestions found');
                    return;
                }

                const items = suggestions.map(s => ({
                    label: s.name,
                    description: `${s.commitCount} commits, last: ${s.lastCommitDate.toLocaleDateString()}`,
                    detail: s.email,
                }));

                await vscode.window.showQuickPick(items, {
                    placeHolder: 'Suggested reviewers (based on git history)',
                    canPickMany: false,
                });
            } catch (error) {
                showError(error);
            }
        }),

        // --- Chat Command ---
        vscode.commands.registerCommand('codepilotReview.openChat', async (initialPrompt?: string) => {
            try {
                chatPanel.setContext(sessionService.getDiff(), sessionService.getIssues());
                await chatPanel.open(initialPrompt || undefined);
            } catch (error) {
                showError(error);
            }
        }),

        // --- Diff View Command ---
        vscode.commands.registerCommand('codepilotReview.viewDiff', async (file) => {
            if (!file) { return; }
            try {
                await openDiffView(
                    file.newPath || file.oldPath || '',
                    file.oldRevision || 'HEAD~1',
                    file.newRevision || 'HEAD',
                    sessionService.getCurrentPrId() || '',
                );
            } catch (error) {
                showError(error);
            }
        }),

        // --- Auth Commands ---
        vscode.commands.registerCommand('codepilotReview.signIn', async () => {
            if (currentProvider?.auth) {
                await authManager.ensureAuthenticated(currentProvider.name, currentProvider.auth);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.signOut', async () => {
            if (currentProvider?.auth) {
                await authManager.signOut(currentProvider.name, currentProvider.auth);
                vscode.window.showInformationMessage(`Signed out of ${currentProvider.name}`);
            }
        }),

        // --- Config Command ---
        vscode.commands.registerCommand('codepilotReview.openConfig', async () => {
            const scope = await vscode.window.showQuickPick(
                [
                    { label: 'Project', description: '.codepilotreview/config.json', value: 'project' as const },
                    { label: 'User', description: '~/.codepilotreview/config.json', value: 'user' as const },
                ],
                { placeHolder: 'Which config file to open?' },
            );
            if (scope) {
                await config.openConfigFile(scope.value);
            }
        }),

        // --- Open Settings Command ---
        vscode.commands.registerCommand('codepilotReview.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:codepilot-review.codepilot-review');
        }),

        // --- Generate Parse Pattern Command ---
        vscode.commands.registerCommand('codepilotReview.generateParsePattern', async () => {
            const toolName = await vscode.window.showInputBox({
                prompt: 'What tool does this parse pattern belong to?',
                placeHolder: 'e.g., eslint, mypy, cargo clippy',
            });
            if (!toolName) { return; }

            const exampleOutput = await vscode.window.showInputBox({
                prompt: 'Paste example output from the tool (or a few lines)',
                placeHolder: 'e.g., src/main.ts:42:5: error: unused variable \'x\'',
            });
            if (!exampleOutput) { return; }

            try {
                const result = await aiService.generateParsePattern(exampleOutput, toolName);
                const doc = await vscode.workspace.openTextDocument({
                    content: JSON.stringify({
                        name: toolName,
                        description: `Custom review tool: ${toolName}`,
                        command: `<your command here>`,
                        outputParsePattern: result.pattern,
                        ...(result.postParseScript ? { postParseScript: result.postParseScript } : {}),
                    }, null, 2),
                    language: 'json',
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                vscode.window.showInformationMessage(
                    'Generated parse pattern. Copy this into your config.json reviewTools array.'
                );
            } catch (error) {
                showError(error);
            }
        }),
    );

    // React to config changes
    config.onDidChange(async () => {
        const newProvider = config.getConfig().provider;
        if (currentProvider && currentProvider.name !== newProvider) {
            await initProvider(newProvider);
        }
    });

    // Listen for AI model availability changes
    vscode.lm.onDidChangeChatModels(async () => {
        const copilot = new CopilotAiService();
        if (await copilot.isAvailable()) {
            // Upgrade to real AI if it becomes available
            if (aiService instanceof StubAiService) {
                logger.info('Copilot became available, upgrading AI service');
            }
        }
    });

    // Cleanup
    context.subscriptions.push({
        dispose: () => {
            sessionService.dispose();
            partitionService.dispose();
            tourService.dispose();
            currentProvider?.dispose();
            logger.dispose();
        }
    });

    logger.info('CodepilotReview extension activated');
}

export function deactivate(): void {
    currentProvider?.dispose();
}
