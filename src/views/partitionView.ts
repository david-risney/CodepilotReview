import * as vscode from 'vscode';
import { Partition, PartitionScheme } from '../types';
import { PartitionService } from '../core/partitionService';
import { CodeTourService } from '../core/codeTourService';
import { logger } from '../logging/logger';

type TreeNode = SchemeTreeNode | PartitionTreeNode | FileTreeNode | DetailTreeNode;

/**
 * TreeDataProvider for the Partition view.
 * Shows Scheme → Partitions → Files hierarchy.
 */
export class PartitionViewProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private partitionService: PartitionService,
        private tourService: CodeTourService,
    ) {
        partitionService.onDidChangePartitions(() => this.refresh());
    }

    /** @deprecated Use partitionService.initForReview() instead */
    setPartitions(_partitions: Partition[]): void {
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            const scheme = this.partitionService.getActiveScheme();
            if (!scheme) {
                const schemes = this.partitionService.getSchemes();
                if (schemes.length === 0) {
                    return [DetailTreeNode.message('Select a pull request to see partitions.')];
                }
                return [DetailTreeNode.message('Select a partition scheme.')];
            }

            if (!scheme.isLoaded) {
                return [DetailTreeNode.message('$(loading~spin) Generating partitions...')];
            }
            if (scheme.partitions.length === 0) {
                return [DetailTreeNode.message('No partitions generated.')];
            }
            return scheme.partitions.map((p, i) => new PartitionTreeNode(p, i));
        }

        if (element instanceof PartitionTreeNode) {
            const p = element.partition;
            const items: TreeNode[] = [];

            if (p.description) {
                items.push(DetailTreeNode.info(`📋 ${p.description}`));
            }
            if (p.dependsOn.length > 0) {
                items.push(DetailTreeNode.info(`⬆️ Depends on: ${p.dependsOn.join(', ')}`));
            }

            for (const chunk of p.chunks) {
                const rangeStr = chunk.lineRanges
                    ? ` (${chunk.lineRanges.map(r => `L${r.start}-${r.end}`).join(', ')})`
                    : '';
                items.push(new FileTreeNode(chunk.filePath + rangeStr, chunk.filePath));
            }

            return items;
        }

        return [];
    }
}

export class SchemeTreeNode extends vscode.TreeItem {
    constructor(public readonly scheme: PartitionScheme) {
        super(scheme.label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = scheme.type === 'custom' ? 'partitionSchemeCustom' : 'partitionScheme';
        this.description = scheme.isLoaded
            ? `${scheme.partitions.length} partition(s)`
            : 'loading...';

        switch (scheme.type) {
            case 'all':
                this.iconPath = new vscode.ThemeIcon('list-flat');
                break;
            case 'dependencies':
                this.iconPath = new vscode.ThemeIcon('type-hierarchy');
                break;
            case 'custom':
                this.iconPath = new vscode.ThemeIcon('sparkle');
                break;
        }
    }
}

export class PartitionTreeNode extends vscode.TreeItem {
    constructor(
        public readonly partition: Partition,
        index: number,
    ) {
        super(`${index + 1}. ${partition.name}`, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `${partition.chunks.length} file(s)`;
        this.iconPath = new vscode.ThemeIcon('layers');
        this.contextValue = 'partition';
    }
}

class FileTreeNode extends vscode.TreeItem {
    constructor(label: string, public readonly filePath: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('file');
        this.command = {
            command: 'codepilotReview.openFileDiff',
            title: 'Open File Diff',
            arguments: [filePath],
        };
    }
}

class DetailTreeNode extends vscode.TreeItem {
    static message(text: string): DetailTreeNode {
        const item = new DetailTreeNode(text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
    }

    static info(text: string): DetailTreeNode {
        return new DetailTreeNode(text, vscode.TreeItemCollapsibleState.None);
    }

    static action(label: string, command: string, args: unknown[]): DetailTreeNode {
        const item = new DetailTreeNode(label, vscode.TreeItemCollapsibleState.None);
        item.command = { command, title: label, arguments: args };
        item.iconPath = new vscode.ThemeIcon('play');
        return item;
    }
}

// Backward compat
export { PartitionTreeNode as PartitionTreeItem };
