import * as vscode from 'vscode';
import { Partition } from '../types';
import { PartitionService } from '../core/partitionService';
import { CodeTourService } from '../core/codeTourService';
import { logger } from '../logging/logger';

/**
 * TreeDataProvider for the Partition view.
 * Shows partitions as top-level items with file chunks as children.
 */
export class PartitionViewProvider implements vscode.TreeDataProvider<PartitionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PartitionTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private partitions: Partition[] = [];

    constructor(
        private partitionService: PartitionService,
        private tourService: CodeTourService,
    ) {
        partitionService.onDidChangePartitions(() => this.refresh());
    }

    setPartitions(partitions: Partition[]): void {
        this.partitions = partitions;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PartitionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PartitionTreeItem): Promise<PartitionTreeItem[]> {
        if (!element) {
            if (this.partitions.length === 0) {
                return [PartitionTreeItem.message('No partitions. Use commands to partition the code change.')];
            }
            return this.partitions.map((p, i) => PartitionTreeItem.partition(p, i));
        }

        if (element.partition) {
            const items: PartitionTreeItem[] = [];

            // Description
            if (element.partition.description) {
                items.push(PartitionTreeItem.detail(`📋 ${element.partition.description}`));
            }

            // Dependencies
            if (element.partition.dependsOn.length > 0) {
                items.push(PartitionTreeItem.detail(
                    `⬆️ Depends on: ${element.partition.dependsOn.join(', ')}`
                ));
            }

            // File chunks
            for (const chunk of element.partition.chunks) {
                const rangeStr = chunk.lineRanges
                    ? ` (${chunk.lineRanges.map(r => `L${r.start}-${r.end}`).join(', ')})`
                    : '';
                items.push(PartitionTreeItem.file(chunk.filePath + rangeStr, chunk.filePath));
            }

            // Tour action
            items.push(PartitionTreeItem.action(
                '🚶 Start Code Tour',
                'codepilotReview.startTour',
                [element.partition]
            ));

            return items;
        }

        return [];
    }
}

export class PartitionTreeItem extends vscode.TreeItem {
    partition?: Partition;

    static partition(p: Partition, index: number): PartitionTreeItem {
        const item = new PartitionTreeItem(
            `${index + 1}. ${p.name}`,
            vscode.TreeItemCollapsibleState.Expanded
        );
        item.partition = p;
        item.description = `${p.chunks.length} file(s)`;
        item.iconPath = new vscode.ThemeIcon('layers');
        item.contextValue = 'partition';
        return item;
    }

    static file(label: string, filePath: string): PartitionTreeItem {
        const item = new PartitionTreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('file');
        item.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [vscode.Uri.file(filePath)],
        };
        return item;
    }

    static detail(label: string): PartitionTreeItem {
        return new PartitionTreeItem(label, vscode.TreeItemCollapsibleState.None);
    }

    static action(label: string, command: string, args: unknown[]): PartitionTreeItem {
        const item = new PartitionTreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.command = { command, title: label, arguments: args };
        item.iconPath = new vscode.ThemeIcon('play');
        return item;
    }

    static message(text: string): PartitionTreeItem {
        const item = new PartitionTreeItem(text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
    }
}
