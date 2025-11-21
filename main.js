/*
THIS IS A COMPILED VERSION FOR DIRECT USE.
Place this in .obsidian/plugins/canvas-node-window/main.js
*/

const obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    enabled: true,
    pinnedByDefault: true,
    focusOnOpen: false,
    savedLeafId: null
};

class CanvasNodeWindowPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.nodeLeaf = null;
    }

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new CanvasNodeWindowSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.recoverNodeLeaf();
        });
        
        this.registerWindowListeners(window);
        this.registerEvent(this.app.workspace.on('window-open', (win) => {
            this.registerWindowListeners(win.win);
        }));

        this.addCommand({
            id: 'toggle-canvas-node-window',
            name: 'Toggle Node Window',
            callback: () => {
                this.settings.enabled = !this.settings.enabled;
                this.saveSettings();
            }
        });
    }

    async recoverNodeLeaf() {
        if (this.settings.savedLeafId) {
            const existingLeaf = this.app.workspace.getLeafById(this.settings.savedLeafId);
            if (existingLeaf) {
                this.nodeLeaf = existingLeaf;
                this.styleNodeLeaf(this.nodeLeaf);
            } else {
                this.settings.savedLeafId = null;
                this.saveSettings();
            }
        }
    }

    registerWindowListeners(win) {
        this.registerDomEvent(win.document, 'mouseup', (evt) => {
            if (!this.settings.enabled) return;
            // Optimization: Early exit if not clicking a canvas node
            if (!evt.target.closest('.canvas-node')) return;
            
            this.handleCanvasClick(evt);
        });
    }

    async handleCanvasClick(evt) {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf || activeLeaf.view.getViewType() !== 'canvas') return;
        
        // Small delay still needed for Obsidian selection state to update
        setTimeout(() => this.processCanvasSelection(activeLeaf.view), 50);
    }

    async processCanvasSelection(canvasView) {
        if (!canvasView.canvas || !canvasView.canvas.selection) return;
        const selection = canvasView.canvas.selection;
        if (selection.size === 0) return;

        const node = selection.values().next().value;
        if (!node || !node.file || !(node.file instanceof obsidian.TFile)) return;

        await this.openInNodeLeaf(node.file);
    }

    async openInNodeLeaf(file) {
        // Validate existing leaf
        if (this.nodeLeaf && !this.app.workspace.getLeafById(this.nodeLeaf.id)) {
            this.nodeLeaf = null;
        }

        let isNewLeaf = false;

        // Create if missing
        if (!this.nodeLeaf) {
            this.nodeLeaf = this.app.workspace.getLeaf('split', 'vertical');
            isNewLeaf = true;
            if (this.settings.pinnedByDefault) {
                this.nodeLeaf.setPinned(true);
            }
        }

        // Optimization: Only write to disk if ID actually changed
        if (this.settings.savedLeafId !== this.nodeLeaf.id) {
            this.settings.savedLeafId = this.nodeLeaf.id;
            await this.saveSettings();
        }

        // Optimization: Don't reload if it's already the open file
        const currentFile = this.nodeLeaf.view.file;
        if (!isNewLeaf && currentFile && currentFile.path === file.path) {
            if (this.settings.focusOnOpen) {
                this.app.workspace.setActiveLeaf(this.nodeLeaf, { focus: true });
            }
            return;
        }

        await this.nodeLeaf.openFile(file, { active: this.settings.focusOnOpen });
        
        this.styleNodeLeaf(this.nodeLeaf);
    }

    styleNodeLeaf(leaf) {
        if (!leaf) return;

        if (leaf.tabHeaderEl) leaf.tabHeaderEl.addClass('canvas-node-window');
        leaf.containerEl.addClass('canvas-node-window');

        if (this.settings.pinnedByDefault && !leaf.pinned) {
            leaf.setPinned(true);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class CanvasNodeWindowSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Canvas Node Window' });

        new obsidian.Setting(containerEl)
            .setName('Enable Plugin')
            .addToggle(t => t.setValue(this.plugin.settings.enabled).onChange(async v => {
                this.plugin.settings.enabled = v;
                await this.plugin.saveSettings();
            }));

        new obsidian.Setting(containerEl)
            .setName('Pin Tab by Default')
            .setDesc('Keep the node window pinned?')
            .addToggle(t => t.setValue(this.plugin.settings.pinnedByDefault).onChange(async v => {
                this.plugin.settings.pinnedByDefault = v;
                await this.plugin.saveSettings();
            }));

        new obsidian.Setting(containerEl)
            .setName('Focus Node Window')
            .setDesc('Focus the window immediately on click?')
            .addToggle(t => t.setValue(this.plugin.settings.focusOnOpen).onChange(async v => {
                this.plugin.settings.focusOnOpen = v;
                await this.plugin.saveSettings();
            }));
            
        new obsidian.Setting(containerEl)
            .setName('Reset Connection')
            .setDesc('Click this if the window isn\'t updating correctly.')
            .addButton(btn => btn
                .setButtonText('Reset ID')
                .onClick(async () => {
                    this.plugin.settings.savedLeafId = null;
                    await this.plugin.saveSettings();
                    this.plugin.nodeLeaf = null;
                    btn.setButtonText('Reset!');
                    setTimeout(() => btn.setButtonText('Reset ID'), 1000);
                }));
    }
}

module.exports = CanvasNodeWindowPlugin;