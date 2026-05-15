import * as vscode from 'vscode';
import { Configuration } from './config/configuration';
import { LocalProvider } from './providers/localProvider';
import { AzureDevOpsProvider } from './providers/adoProvider';
import { GitHubProvider } from './providers/githubProvider';
import { ChromiumProvider } from './providers/chromiumProvider';
import { ICodeReviewProvider } from './providers/provider';
import { PullRequestService } from './core/pullRequestService';
import { ReviewSessionService } from './core/reviewSessionService';
import { PrListViewProvider } from './views/prListView';
import { ReviewCommentController } from './comments/commentController';
import { ReviewToolManager } from './reviewTools/reviewToolManager';
import { ReviewStore } from './storage/reviewStore';
import { StubAiService } from './ai/aiService';
import { logger } from './logging/logger';

let currentProvider: ICodeReviewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.info('CodepilotReview extension activating...');

    // Initialize configuration
    const config = new Configuration();
    await config.initialize();
    context.subscriptions.push({ dispose: () => config.dispose() });

    // Initialize storage
    const store = new ReviewStore();
    store.initialize(context);

    // Initialize services
    const prService = new PullRequestService();
    const sessionService = new ReviewSessionService();
    const aiService = new StubAiService();
    const toolManager = new ReviewToolManager(config);

    // Initialize views
    const prListView = new PrListViewProvider(prService);
    const prTreeView = vscode.window.createTreeView('codepilotReview.prList', {
        treeDataProvider: prListView,
        showCollapseAll: true,
    });
    context.subscriptions.push(prTreeView);

    // Initialize comment controller
    const commentController = new ReviewCommentController(sessionService);
    context.subscriptions.push({ dispose: () => commentController.dispose() });

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

        prService.setProvider(currentProvider);
        sessionService.setProvider(currentProvider);

        prListView.refresh();
        logger.info(`Provider set to: ${currentProvider.name}`);
    };

    // Set initial provider
    const initialProvider = config.getConfig().provider;
    await initProvider(initialProvider);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('codepilotReview.openReview', async (pr) => {
            if (!pr) {
                vscode.window.showWarningMessage('No pull request selected');
                return;
            }
            try {
                await sessionService.openReview(pr.id);
                const issues = sessionService.getIssues();
                const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (workspaceUri) {
                    await commentController.showIssues(issues, workspaceUri);
                }
            } catch (error) {
                logger.error('Failed to open review', error);
                vscode.window.showErrorMessage(`Failed to open review: ${error}`);
            }
        }),

        vscode.commands.registerCommand('codepilotReview.refreshPRs', () => {
            prListView.refresh();
        }),

        vscode.commands.registerCommand('codepilotReview.runReviewTools', async () => {
            const prId = sessionService.getCurrentPrId();
            if (!prId) {
                vscode.window.showWarningMessage('Open a review first');
                return;
            }

            const diff = sessionService.getDiff();
            const existingIssues = sessionService.getIssues();

            const issues = await toolManager.runTools({
                pullRequestId: prId,
                diff,
                existingIssues,
            });

            for (const issue of issues) {
                sessionService.addIssue(issue);
            }

            const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (workspaceUri) {
                await commentController.showIssues(sessionService.getIssues(), workspaceUri);
            }

            vscode.window.showInformationMessage(
                `Review tools found ${issues.length} potential issue(s)`
            );
        }),

        vscode.commands.registerCommand('codepilotReview.publishDraftComments', async () => {
            const count = await sessionService.publishAllDrafts();
            vscode.window.showInformationMessage(`Published ${count} draft comment(s)`);
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
                vscode.window.showInformationMessage(
                    `Switched to ${selected.label} provider`
                );
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

    // Cleanup
    context.subscriptions.push({
        dispose: () => {
            sessionService.dispose();
            currentProvider?.dispose();
            logger.dispose();
        }
    });

    logger.info('CodepilotReview extension activated');
}

export function deactivate(): void {
    currentProvider?.dispose();
}
