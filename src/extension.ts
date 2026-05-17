import * as vscode from 'vscode';
import { ReviewIssue, PullRequestStatus, ReviewPriority, UserNeedLevel, ProviderView, ProviderViewQuery, DiffFile } from './types';
import { Configuration } from './config/configuration';
import { ProviderManager } from './providers/providerManager';
import { PullRequestService } from './core/pullRequestService';
import { ReviewSessionService } from './core/reviewSessionService';
import { PartitionService } from './core/partitionService';
import { CodeTourService } from './core/codeTourService';
import { ReviewerSuggestionService } from './core/reviewerSuggestionService';
import { PrListViewProvider, ProviderTreeNode, ViewTreeNode } from './views/prListView';
import { ReviewIssuesViewProvider } from './views/reviewIssuesView';
import { PartitionViewProvider, SchemeTreeNode } from './views/partitionView';
import { CodeTourViewProvider } from './views/codeTourView';
import { CodeTourCodeLensProvider } from './views/codeTourCodeLens';
import { ChatPanel } from './views/chatPanel';
import { DiffContentProvider, openDiffView, openFileDiff, getMergeBase } from './views/diffContentProvider';
import { ReviewCommentController } from './comments/commentController';
import { ReviewToolManager } from './reviewTools/reviewToolManager';
import { ReviewStore } from './storage/reviewStore';
import { AuthManager } from './auth/authManager';
import { CopilotAiService, StubAiService, IAiService } from './ai/aiService';
import { CodepilotReviewError } from './errors';
import { logger } from './logging/logger';

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
    prService.onDidEnrich(() => prListView.refresh('AI enrichment complete'));

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

    // Update partition view description with active scheme name
    partitionService.onDidChangePartitions(() => {
        const active = partitionService.getActiveScheme();
        partitionTreeView.description = active ? active.label : undefined;
    });

    // Initialize Code Tour view and CodeLens
    const tourViewProvider = new CodeTourViewProvider(context.extensionUri, tourService);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CodeTourViewProvider.viewType, tourViewProvider)
    );

    const tourCodeLensProvider = new CodeTourCodeLensProvider(tourService);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, tourCodeLensProvider)
    );

    // Initialize comment controller
    const commentController = new ReviewCommentController(sessionService);
    context.subscriptions.push({ dispose: () => commentController.dispose() });

    // Initialize chat panel
    const chatPanel = new ChatPanel(aiService, context.extensionUri);
    context.subscriptions.push(chatPanel);

    // Register virtual document provider for read-only diff viewing
    const diffContentProvider = new DiffContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('codepilot-diff', diffContentProvider),
        vscode.workspace.registerTextDocumentContentProvider('codepilot-empty', diffContentProvider),
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

    // Initialize provider manager
    const providerManager = new ProviderManager();
    providerManager.setContext(context);
    providerManager.setAuthManager(authManager);
    context.subscriptions.push({ dispose: () => providerManager.dispose() });

    // Wire provider lookups into services
    const providerLookup = (id: string) => providerManager.getProvider(id);
    sessionService.setProviderLookup(providerLookup);
    diffContentProvider.setProviderLookup(providerLookup);

    // Sync providers to services when they change
    const syncProviders = () => {
        logger.info('syncProviders: providers changed, refreshing all services');
        const instances = providerManager.getAllProviders();
        prService.setProviders(instances);
        prListView.setProviders(instances);
        // Comment controller: allow local commenting if any provider is local type
        commentController.setLocalProvider(instances.some(p => p.type === 'local'));
        // Set context for welcome view
        vscode.commands.executeCommand('setContext', 'codepilotReview.noProviders', instances.length === 0);
        // Clear review state — selected PR may no longer be valid
        sessionService.clearReview();
        partitionService.clear();
        tourService.stopTour();
        vscode.commands.executeCommand('setContext', 'codepilotReview.hasActiveReview', false);
    };
    providerManager.onDidChangeProviders(syncProviders);

    // Initialize providers from config (fires onDidChangeProviders which calls syncProviders)
    await providerManager.initializeFromConfig();

    // Register commands
    context.subscriptions.push(
        // --- PR Commands ---
        vscode.commands.registerCommand('codepilotReview.openReview', async (pr) => {
            if (!pr) {
                vscode.window.showWarningMessage('No pull request selected');
                return;
            }
            try {
                await sessionService.openReview(pr);
                vscode.commands.executeCommand('setContext', 'codepilotReview.hasActiveReview', true);
                // Focus partitions view so it's prominent after selecting a review
                vscode.commands.executeCommand('codepilotReview.partitions.focus');
                await store.addReviewedPrId(pr.id);
                const issues = sessionService.getIssues();
                const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (workspaceUri) {
                    await commentController.showIssues(issues, workspaceUri);
                }
                // Initialize partition schemes for this PR
                const diff = sessionService.getDiff();
                if (diff.length > 0) {
                    await partitionService.initForReview(pr.id, diff);
                }
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.refreshPRs', () => {
            prListView.refresh('manual refresh command');
        }),

        vscode.commands.registerCommand('codepilotReview.selectProvider', async () => {
            const action = await vscode.window.showQuickPick(
                [
                    { label: '$(add) Add Provider', description: 'Add a new provider instance', value: 'add' },
                    { label: '$(trash) Remove Provider', description: 'Remove an active provider', value: 'remove' },
                    { label: '$(refresh) Reload All', description: 'Reinitialize from settings', value: 'reload' },
                ],
                { placeHolder: 'Manage code review providers' },
            );

            if (!action) { return; }

            switch (action.value) {
                case 'add': {
                    const typeItems = [
                        { label: 'Local', description: 'Git diff based review', value: 'local' as const },
                        { label: 'Azure DevOps', description: 'ADO pull requests', value: 'azureDevOps' as const },
                        { label: 'GitHub', description: 'GitHub pull requests', value: 'github' as const },
                        { label: 'Chromium', description: 'Gerrit code review', value: 'chromium' as const },
                    ];
                    const type = await vscode.window.showQuickPick(typeItems, { placeHolder: 'Provider type' });
                    if (!type) { return; }

                    const id = await vscode.window.showInputBox({
                        prompt: 'Unique ID for this provider instance',
                        placeHolder: `e.g. ${type.value}-myproject`,
                        validateInput: (v) => {
                            if (!v.trim()) { return 'ID is required'; }
                            if (providerManager.getProvider(v.trim())) { return 'ID already in use'; }
                            return undefined;
                        },
                    });
                    if (!id) { return; }

                    const label = await vscode.window.showInputBox({
                        prompt: 'Display label for this provider',
                        placeHolder: `e.g. My ${type.label} Project`,
                        value: `${type.label} (${id})`,
                    });
                    if (!label) { return; }

                    const cfg: any = { id: id.trim(), label, type: type.value };

                    // Collect type-specific fields
                    if (type.value === 'azureDevOps') {
                        cfg.organization = await vscode.window.showInputBox({ prompt: 'ADO Organization' }) || '';
                        cfg.project = await vscode.window.showInputBox({ prompt: 'ADO Project' }) || '';
                    } else if (type.value === 'github') {
                        cfg.owner = await vscode.window.showInputBox({ prompt: 'GitHub owner (user/org)' }) || '';
                        cfg.repo = await vscode.window.showInputBox({ prompt: 'GitHub repo name' }) || '';
                    } else if (type.value === 'chromium') {
                        cfg.host = await vscode.window.showInputBox({
                            prompt: 'Gerrit host URL',
                            value: 'https://chromium-review.googlesource.com',
                        }) || '';
                    } else if (type.value === 'local') {
                        cfg.baseBranch = await vscode.window.showInputBox({
                            prompt: 'Base branch',
                            value: 'main',
                        }) || 'main';
                    }

                    try {
                        await providerManager.addProvider(cfg);
                        await providerManager.persistConfig();
                        syncProviders();
                        vscode.window.showInformationMessage(`Added provider "${label}"`);
                    } catch (error) {
                        showError(error);
                    }
                    break;
                }
                case 'remove': {
                    const active = providerManager.getAllProviders();
                    if (active.length === 0) {
                        vscode.window.showInformationMessage('No active providers');
                        return;
                    }
                    const toRemove = await vscode.window.showQuickPick(
                        active.map(p => ({ label: p.displayName, description: `(${p.type}) ${p.id}`, value: p.id })),
                        { placeHolder: 'Select provider to remove' },
                    );
                    if (toRemove) {
                        providerManager.removeProvider(toRemove.value);
                        await providerManager.persistConfig();
                        syncProviders();
                        vscode.window.showInformationMessage(`Removed provider "${toRemove.label}"`);
                    }
                    break;
                }
                case 'reload':
                    await providerManager.initializeFromConfig();
                    syncProviders();
                    vscode.window.showInformationMessage('Providers reloaded from settings');
                    break;
            }
        }),

        // --- View Management Commands ---
        vscode.commands.registerCommand('codepilotReview.addView', async (node?: ProviderTreeNode) => {
            let providerId: string | undefined;
            if (node instanceof ProviderTreeNode) {
                providerId = node.instance.id;
            } else {
                // Pick a provider
                const active = providerManager.getAllProviders();
                if (active.length === 0) { return; }
                if (active.length === 1) {
                    providerId = active[0].id;
                } else {
                    const selected = await vscode.window.showQuickPick(
                        active.map(p => ({ label: p.displayName, description: p.id, value: p.id })),
                        { placeHolder: 'Add view to which provider?' },
                    );
                    if (!selected) { return; }
                    providerId = selected.value;
                }
            }

            const instance = providerManager.getProvider(providerId!);
            if (!instance) { return; }

            const label = await vscode.window.showInputBox({
                prompt: 'View label',
                placeHolder: 'e.g. My PRs, Needs Review',
            });
            if (!label) { return; }

            const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

            // Build query based on provider type
            let query: ProviderViewQuery | undefined;
            if (instance.type === 'azureDevOps') {
                const status = await vscode.window.showQuickPick(
                    ['', 'active', 'completed', 'abandoned'].map(s => ({ label: s || '(all)', value: s })),
                    { placeHolder: 'Filter by status?' },
                );
                const creatorId = await vscode.window.showInputBox({ prompt: 'Filter by creator? (leave empty for all)' });
                const reviewerId = await vscode.window.showInputBox({ prompt: 'Filter by reviewer? (leave empty for all)' });
                query = {
                    type: 'azureDevOps',
                    ...(status?.value ? { status: status.value } : {}),
                    ...(creatorId ? { creatorId } : {}),
                    ...(reviewerId ? { reviewerId } : {}),
                };
            } else if (instance.type === 'github') {
                const searchQuery = await vscode.window.showInputBox({
                    prompt: 'GitHub search query (leave empty for all)',
                    placeHolder: 'e.g. is:open review-requested:@me',
                });
                const state = await vscode.window.showQuickPick(
                    ['', 'open', 'closed', 'all'].map(s => ({ label: s || '(default: open)', value: s })),
                    { placeHolder: 'PR state?' },
                );
                query = {
                    type: 'github',
                    ...(searchQuery ? { searchQuery } : {}),
                    ...(state?.value ? { state: state.value } : {}),
                };
            } else if (instance.type === 'chromium') {
                const status = await vscode.window.showInputBox({ prompt: 'Gerrit status filter (leave empty for all)' });
                query = { type: 'chromium', ...(status ? { status } : {}) };
            } else {
                query = { type: 'local' };
            }

            const newView: ProviderView = { id, label, query };
            const views = [...instance.views, newView];
            providerManager.updateProviderViews(providerId!, views);
            await providerManager.persistConfig();
            vscode.window.showInformationMessage(`Added view "${label}"`);
        }),

        vscode.commands.registerCommand('codepilotReview.editView', async (node?: ViewTreeNode) => {
            if (!(node instanceof ViewTreeNode)) { return; }

            const view = node.view;
            const newLabel = await vscode.window.showInputBox({
                prompt: 'View label',
                value: view.label,
            });
            if (!newLabel) { return; }

            const instance = providerManager.getProvider(node.instance.id);
            if (!instance) { return; }

            const views = instance.views.map(v =>
                v.id === view.id ? { ...v, label: newLabel } : v
            );
            providerManager.updateProviderViews(node.instance.id, views);
            await providerManager.persistConfig();
        }),

        vscode.commands.registerCommand('codepilotReview.removeView', async (node?: ViewTreeNode) => {
            if (!(node instanceof ViewTreeNode)) { return; }

            const instance = providerManager.getProvider(node.instance.id);
            if (!instance) { return; }

            if (instance.views.length <= 1) {
                vscode.window.showWarningMessage('Cannot remove the last view');
                return;
            }

            const views = instance.views.filter(v => v.id !== node.view.id);
            providerManager.updateProviderViews(node.instance.id, views);
            await providerManager.persistConfig();
            vscode.window.showInformationMessage(`Removed view "${node.view.label}"`);
        }),

        // --- Provider node context menu commands ---
        vscode.commands.registerCommand('codepilotReview.editProvider', async (node?: ProviderTreeNode) => {
            if (!(node instanceof ProviderTreeNode)) { return; }

            const instance = node.instance;
            const newLabel = await vscode.window.showInputBox({
                prompt: 'Display label',
                value: instance.displayName,
            });
            if (!newLabel) { return; }

            // Allow editing type-specific fields
            const config = { ...instance.config, label: newLabel };

            if (instance.type === 'azureDevOps') {
                const org = await vscode.window.showInputBox({ prompt: 'ADO Organization', value: config.organization || '' });
                if (org === undefined) { return; }
                config.organization = org;
                const proj = await vscode.window.showInputBox({ prompt: 'ADO Project', value: config.project || '' });
                if (proj === undefined) { return; }
                config.project = proj;
                const repo = await vscode.window.showInputBox({ prompt: 'Repository ID (empty for all)', value: config.repositoryId || '' });
                if (repo === undefined) { return; }
                config.repositoryId = repo;
            } else if (instance.type === 'github') {
                const owner = await vscode.window.showInputBox({ prompt: 'GitHub owner', value: config.owner || '' });
                if (owner === undefined) { return; }
                config.owner = owner;
                const repo = await vscode.window.showInputBox({ prompt: 'GitHub repo', value: config.repo || '' });
                if (repo === undefined) { return; }
                config.repo = repo;
            } else if (instance.type === 'chromium') {
                const host = await vscode.window.showInputBox({ prompt: 'Gerrit host URL', value: config.host || 'https://chromium-review.googlesource.com' });
                if (host === undefined) { return; }
                config.host = host;
            } else if (instance.type === 'local') {
                const branch = await vscode.window.showInputBox({ prompt: 'Base branch', value: config.baseBranch || 'main' });
                if (branch === undefined) { return; }
                config.baseBranch = branch;
            }

            // Re-add provider with updated config (removes old, adds new)
            try {
                await providerManager.addProvider(config);
                await providerManager.persistConfig();
                syncProviders();
                vscode.window.showInformationMessage(`Updated provider "${newLabel}"`);
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.removeProviderNode', async (node?: ProviderTreeNode) => {
            if (!(node instanceof ProviderTreeNode)) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `Remove provider "${node.instance.displayName}"?`,
                { modal: true },
                'Remove',
            );
            if (confirm !== 'Remove') { return; }

            providerManager.removeProvider(node.instance.id);
            await providerManager.persistConfig();
            syncProviders();
            vscode.window.showInformationMessage(`Removed provider "${node.instance.displayName}"`);
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
        vscode.commands.registerCommand('codepilotReview.selectPartitionScheme', async () => {
            const schemes = partitionService.getSchemes();
            if (schemes.length === 0) {
                vscode.window.showWarningMessage('Open a review first');
                return;
            }

            const activeId = partitionService.getActiveSchemeId();
            const items = schemes.map(s => ({
                label: s.label,
                description: s.type === 'custom' ? s.prompt : s.type,
                picked: s.id === activeId,
                value: s.id,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select partition scheme',
            });
            if (selected) {
                partitionService.setActiveScheme(selected.value);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.partitionByDependency', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) { vscode.window.showWarningMessage('Open a review first'); return; }

            try {
                await partitionService.regenerateScheme('dependencies');
                vscode.window.showInformationMessage('Regenerated dependency partitions');
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

            const label = await vscode.window.showInputBox({
                prompt: 'Name for this partition scheme',
                placeHolder: 'e.g., Frontend vs Backend',
            });
            if (!label) { return; }

            const prompt = await vscode.window.showInputBox({
                prompt: 'Describe how Copilot should partition the code change',
                placeHolder: 'e.g., separate frontend UI changes from backend API changes',
            });
            if (!prompt) { return; }

            try {
                const scheme = await partitionService.addCustomScheme(label, prompt);
                vscode.window.showInformationMessage(
                    `Created "${label}" with ${scheme.partitions.length} partition(s)`
                );
            } catch (error) {
                showError(error);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.removePartitionScheme', async (node?: SchemeTreeNode) => {
            if (!(node instanceof SchemeTreeNode)) { return; }
            if (node.scheme.type !== 'custom') {
                vscode.window.showWarningMessage('Cannot remove built-in partition schemes');
                return;
            }
            partitionService.removeScheme(node.scheme.id);
            vscode.window.showInformationMessage(`Removed "${node.scheme.label}"`);
        }),

        vscode.commands.registerCommand('codepilotReview.regeneratePartitions', async (node?: SchemeTreeNode) => {
            if (!(node instanceof SchemeTreeNode)) { return; }
            try {
                await partitionService.regenerateScheme(node.scheme.id);
                vscode.window.showInformationMessage(`Regenerated "${node.scheme.label}"`);
            } catch (error) {
                showError(error);
            }
        }),

        // --- Code Tour Commands ---
        vscode.commands.registerCommand('codepilotReview.startTour', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) { vscode.window.showWarningMessage('Open a review first'); return; }
            const diff = sessionService.getDiff();
            if (diff.length === 0) { vscode.window.showWarningMessage('No diff available'); return; }

            try {
                const tour = await tourService.generateTour(prId, diff);
                await tourService.startTour(tour);
                // Focus the tour details pane so it's visible and prominent
                vscode.commands.executeCommand('codepilotReview.tourDetails.focus');
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

        vscode.commands.registerCommand('codepilotReview.stopTour', () => {
            tourService.stopTour();
        }),

        vscode.commands.registerCommand('codepilotReview.goToTourStep', (index: number) => {
            tourService.goToStep(index);
        }),

        vscode.commands.registerCommand('codepilotReview.showTourDetails', () => {
            // Focus the tour details webview in the sidebar
            vscode.commands.executeCommand('codepilotReview.tourDetails.focus');
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

        // --- Open File as Diff ---
        vscode.commands.registerCommand('codepilotReview.openFileDiff', async (filePath: string) => {
            const prId = sessionService.getCurrentPrId();
            const providerId = sessionService.getCurrentProviderId();
            const diff = sessionService.getDiff();
            const providerInstance = providerId ? providerManager.getProvider(providerId) : undefined;

            // Find the DiffFile for this path
            const diffFile = diff.find(f =>
                f.newPath === filePath || f.oldPath === filePath
            );

            if (diffFile && prId) {
                // Compute merge-base for local-branch-base side if needed
                let mergeBase: string | undefined;
                const providerType = providerInstance?.type;
                const diffModeConfig = vscode.workspace.getConfiguration('codepilotReview').get<any>('diffMode') || {};
                const needsBase = providerType === 'local'
                    || diffModeConfig.left === 'local-branch-base'
                    || diffModeConfig.right === 'local-branch-base';
                if (needsBase) {
                    mergeBase = await getMergeBase(
                        (providerInstance?.config as any)?.baseBranch
                    );
                }

                await openFileDiff(diffFile, prId, {
                    providerId,
                    providerType,
                    mergeBase,
                    preview: true,
                });
            } else {
                // Fallback: open the file normally
                const wsFolder = vscode.workspace.workspaceFolders?.[0];
                const fileUri = wsFolder
                    ? vscode.Uri.joinPath(wsFolder.uri, filePath)
                    : vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.open', fileUri);
            }
        }),

        // --- Auth Commands ---
        vscode.commands.registerCommand('codepilotReview.signIn', async () => {
            const providers = providerManager.getAllProviders()
                .filter(p => p.provider.capabilities.requiresAuthentication && p.provider.auth);
            if (providers.length === 0) {
                vscode.window.showInformationMessage('No providers require authentication');
                return;
            }
            // If multiple, let user choose
            let target = providers[0];
            if (providers.length > 1) {
                const selected = await vscode.window.showQuickPick(
                    providers.map(p => ({ label: p.displayName, description: p.id, value: p })),
                    { placeHolder: 'Sign in to which provider?' },
                );
                if (!selected) { return; }
                target = selected.value;
            }
            await authManager.ensureAuthenticated(target.id, target.provider.auth);
        }),

        vscode.commands.registerCommand('codepilotReview.signOut', async () => {
            const providers = providerManager.getAllProviders()
                .filter(p => p.provider.capabilities.requiresAuthentication && p.provider.auth);
            if (providers.length === 0) { return; }
            let target = providers[0];
            if (providers.length > 1) {
                const selected = await vscode.window.showQuickPick(
                    providers.map(p => ({ label: p.displayName, description: p.id, value: p })),
                    { placeHolder: 'Sign out of which provider?' },
                );
                if (!selected) { return; }
                target = selected.value;
            }
            await authManager.signOut(target.id, target.provider.auth);
            vscode.window.showInformationMessage(`Signed out of ${target.displayName}`);
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

    // React to config changes — reinitialize providers
    config.onDidChange(async () => {
        logger.info('config.onDidChange fired, reinitializing providers');
        await providerManager.initializeFromConfig();
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
            providerManager.dispose();
            logger.dispose();
        }
    });

    logger.info('CodepilotReview extension activated');
}

export function deactivate(): void {
    // Provider cleanup handled by context.subscriptions
}
