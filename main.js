/*
THIS IS A COMPILED VERSION FOR DIRECT USE.
Place this in .obsidian/plugins/canvas-node-window/main.js
*/

const obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    enabled: true,
    pinnedByDefault: true,
    focusOnOpen: false,
    savedLeafId: null,
    tempFolderPath: 'canvas-nodes-temp'
};

// --- UTILITY ---
function debounce(func, wait) {
    let timeout;
    const debounced = function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
    debounced.cancel = () => clearTimeout(timeout);
    return debounced;
}

// --- MAIN PLUGIN ---

class CanvasNodeWindowPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.nodeLeaf = null;
        this.lastSelectedNodeId = null;
        this.currentTempFile = null;
        this.currentNode = null;
        
        // Locking flags to prevent infinite sync loops
        this.isUpdatingFromNode = false;
        this.isUpdatingFromFile = false;
        
        this.lastFileContent = '';
        this.lastNodeContent = '';
    }

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new CanvasNodeWindowSettingTab(this.app, this));
        
        // Add CSS
        this.addStyles();

        this.app.workspace.onLayoutReady(() => {
            this.recoverNodeLeaf();
            this.ensureTempFolder();
        });

        // --- HYBRID ARCHITECTURE (Performance + Reliability) ---
        
        // 1. Event-Driven: File -> Node (Instant)
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (this.currentTempFile && file.path === this.currentTempFile.path) {
                await this.syncFileToNode(file);
            }
        }));

        // 2. Polling: Check Selection (Robust)
        this.registerInterval(window.setInterval(() => {
            if (this.settings.enabled) this.checkSelection();
        }, 200));

        // 3. Polling: Node -> File (Reliable for typing)
        this.registerInterval(window.setInterval(() => {
            if (this.settings.enabled && this.currentNode) this.syncNodeToFile();
        }, 200));

        // Commands
        this.addCommand({
            id: 'toggle-canvas-node-window',
            name: 'Toggle Node Window',
            callback: () => {
                this.settings.enabled = !this.settings.enabled;
                this.saveSettings();
                if (!this.settings.enabled) {
                    this.currentNode = null;
                    this.currentTempFile = null;
                }
            }
        });
        
        this.addCommand({
            id: 'convert-node-to-file',
            name: 'Convert Node to File',
            hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'f' }],
            checkCallback: (checking) => {
                if (this.currentNode && this.currentTempFile) {
                    if (!checking) this.convertNodeToFile();
                    return true;
                }
                return false;
            }
        });
    }

    addStyles() {
        const style = document.createElement('style');
        style.id = 'canvas-node-window-styles';
        style.textContent = `
            .canvas-node-window.is-temp-file .view-header { display: none !important; }
            .canvas-node-window.is-temp-file .inline-title { display: none !important; }
            .canvas-node-window.is-temp-file .metadata-container { display: none !important; }
            .canvas-node-window.is-temp-file .frontmatter-container { display: none !important; }
            .convert-to-file-button {
                position: sticky; bottom: 0; left: 0; right: 0;
                padding: 12px;
                background: var(--background-primary);
                border-top: 1px solid var(--background-modifier-border);
                display: flex; justify-content: center; z-index: 10;
            }
            .convert-to-file-button button {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                border: none; padding: 8px 20px;
                border-radius: 4px; cursor: pointer; font-weight: 500;
            }
            .convert-to-file-button button:hover { opacity: 0.8; }
        `;
        document.head.appendChild(style);
    }

    async ensureTempFolder() {
        const folderPath = this.settings.tempFolderPath;
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            try { await this.app.vault.createFolder(folderPath); } 
            catch (e) { console.error('Failed to create temp folder:', e); }
        }
    }

    // --- SYNC LOGIC ---

    // File -> Node (Triggered by 'modify' event)
    async syncFileToNode(file) {
        if (!this.currentNode || this.isUpdatingFromNode) return;
        
        try {
            const fileContent = await this.app.vault.read(file);
            
            if (fileContent !== this.lastFileContent) {
                this.lastFileContent = fileContent;
                
                const nodeText = this.currentNode.text || '';
                if (fileContent !== nodeText) {
                    this.isUpdatingFromFile = true;
                    
                    this.currentNode.setText(fileContent);
                    this.lastNodeContent = fileContent;
                    
                    if (this.currentNode.canvas) {
                        this.currentNode.canvas.requestSave();
                    }
                    
                    this.isUpdatingFromFile = false;
                }
            }
        } catch (e) {
            console.error('Error syncing file to node:', e);
            this.isUpdatingFromFile = false;
        }
    }

    // Node -> File (Triggered by Interval)
    async syncNodeToFile() {
        if (!this.currentNode || !this.currentTempFile || this.isUpdatingFromFile) return;

        try {
            const nodeText = this.currentNode.text || '';
            
            if (nodeText !== this.lastNodeContent) {
                this.lastNodeContent = nodeText;
                
                if (nodeText !== this.lastFileContent) {
                    this.isUpdatingFromNode = true;
                    await this.app.vault.modify(this.currentTempFile, nodeText);
                    this.lastFileContent = nodeText;
                    this.isUpdatingFromNode = false;
                }
            }
        } catch (e) {
            console.error('Error syncing node to file:', e);
            this.isUpdatingFromNode = false;
        }
    }

    async checkSelection() {
        const leaves = this.app.workspace.getLeavesOfType('canvas');
        let selectedNode = null;

        for (const leaf of leaves) {
            if (leaf.view?.canvas?.selection?.size > 0) {
                selectedNode = leaf.view.canvas.selection.values().next().value;
                break;
            }
        }

        if (!selectedNode) return;
        if (this.lastSelectedNodeId === selectedNode.id) return;

        this.lastSelectedNodeId = selectedNode.id;
        await this.processNode(selectedNode);
    }

    async processNode(node) {
        if (node.file instanceof obsidian.TFile) {
            await this.openInNodeLeaf(node.file);
            this.currentNode = null;
            this.currentTempFile = null;
        } else {
            if (typeof node.text === 'string') {
                await this.openTextNodeWithTempFile(node);
            }
        }
    }

    async openTextNodeWithTempFile(node) {
        this.currentNode = node;
        
        const tempFileName = `${this.settings.tempFolderPath}/node-${node.id}.md`;
        let tempFile = this.app.vault.getAbstractFileByPath(tempFileName);
        
        const nodeText = node.text || '';
        this.lastFileContent = nodeText;
        this.lastNodeContent = nodeText;

        if (!tempFile) {
            tempFile = await this.app.vault.create(tempFileName, nodeText);
        } else {
            this.isUpdatingFromNode = true;
            await this.app.vault.modify(tempFile, nodeText);
            this.isUpdatingFromNode = false;
        }
        
        this.currentTempFile = tempFile;
        await this.openInNodeLeaf(tempFile);
    }

    async openInNodeLeaf(file) {
        await this.prepareLeaf();
        
        if (this.nodeLeaf.view.file?.path === file.path) return;
        
        const isTempFile = file.path.startsWith(this.settings.tempFolderPath + '/');
        await this.nodeLeaf.openFile(file, { active: this.settings.focusOnOpen });
        this.styleNodeLeaf(this.nodeLeaf, isTempFile);
        
        if (isTempFile && this.nodeLeaf.tabHeaderInnerTitleEl) {
            this.nodeLeaf.tabHeaderInnerTitleEl.setText('Node Editor');
        }
    }

    async prepareLeaf() {
        if (this.nodeLeaf && !this.app.workspace.getLeafById(this.nodeLeaf.id)) {
            this.nodeLeaf = null;
        }
        if (!this.nodeLeaf) {
            this.nodeLeaf = this.app.workspace.getLeaf('split', 'vertical');
            if (this.settings.pinnedByDefault) this.nodeLeaf.setPinned(true);
        }
        if (this.settings.savedLeafId !== this.nodeLeaf.id) {
            this.settings.savedLeafId = this.nodeLeaf.id;
            await this.saveSettings();
        }
    }

    styleNodeLeaf(leaf, isTempFile = false) {
        if (!leaf) return;
        leaf.containerEl.addClass('canvas-node-window');
        if (leaf.tabHeaderEl) leaf.tabHeaderEl.addClass('canvas-node-window');
        
        if (isTempFile) {
            leaf.containerEl.addClass('is-temp-file');
            if (leaf.tabHeaderEl) leaf.tabHeaderEl.addClass('is-temp-file');
            this.addConvertButton(leaf);
        } else {
            leaf.containerEl.removeClass('is-temp-file');
            if (leaf.tabHeaderEl) leaf.tabHeaderEl.removeClass('is-temp-file');
            this.removeConvertButton(leaf);
        }
    }

    addConvertButton(leaf) {
        this.removeConvertButton(leaf);
        const contentEl = leaf.view.contentEl;
        const buttonContainer = contentEl.createDiv({ cls: 'convert-to-file-button' });
        const button = buttonContainer.createEl('button');
        button.textContent = 'Convert to File';
        button.addEventListener('click', async () => {
            await this.convertNodeToFile();
        });
    }

    removeConvertButton(leaf) {
        const existing = leaf.view.contentEl.querySelector('.convert-to-file-button');
        if (existing) existing.remove();
    }

    async convertNodeToFile() {
        if (!this.currentNode || !this.currentTempFile) return;
        
        try {
            const content = await this.app.vault.read(this.currentTempFile);
            let filename = this.extractFirstHeader(content);
            
            if (!filename) {
                filename = await this.promptForFilename('Enter filename');
                if (!filename) return;
            }
            
            filename = this.sanitizeFilename(filename);
            let finalPath = `${filename}.md`;
            
            if (this.app.vault.getAbstractFileByPath(finalPath)) {
                const newName = await this.promptForFilename(`File "${filename}.md" already exists. Enter a different name`);
                if (!newName) return;
                finalPath = `${this.sanitizeFilename(newName)}.md`;
            }
            
            const newFile = await this.app.vault.create(finalPath, content);
            
            if (this.currentNode.canvas) {
                const canvas = this.currentNode.canvas;
                const { x, y, width, height } = this.currentNode;
                
                canvas.removeNode(this.currentNode);
                canvas.createFileNode({
                    file: newFile,
                    pos: { x, y },
                    size: { width, height },
                    save: true
                });
                
                canvas.requestSave();
                
                await this.app.vault.delete(this.currentTempFile);
                this.currentNode = null;
                this.currentTempFile = null;
                
                new obsidian.Notice(`Converted to file: ${finalPath}`);
            }
        } catch (e) {
            console.error('Error converting to file:', e);
            new obsidian.Notice('Failed to convert to file');
        }
    }

    extractFirstHeader(content) {
        const lines = content.split('\n');
        for (const line of lines) {
            const match = line.match(/^#+\s+(.+)$/);
            if (match) return match[1].trim();
        }
        return null;
    }

    sanitizeFilename(filename) {
        return filename.replace(/[\\/:*?"<>|]/g, '').trim();
    }

    async promptForFilename(message) {
        return new Promise((resolve) => {
            const modal = new obsidian.Modal(this.app);
            modal.titleEl.setText(message);
            const inputContainer = modal.contentEl.createDiv();
            const input = inputContainer.createEl('input', { type: 'text', placeholder: 'filename' });
            input.style.width = '100%';
            input.style.marginBottom = '10px';
            
            const buttonContainer = modal.contentEl.createDiv();
            buttonContainer.style.cssText = 'display:flex; gap:10px; justify-content:flex-end;';
            
            const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
            const confirmBtn = buttonContainer.createEl('button', { text: 'OK' });
            confirmBtn.style.background = 'var(--interactive-accent)';
            confirmBtn.style.color = 'var(--text-on-accent)';
            
            const finish = (value) => { modal.close(); resolve(value); };
            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', () => finish(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') finish(input.value);
                if (e.key === 'Escape') finish(null);
            });
            modal.open();
            input.focus();
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
                await this.saveSettings();
            }
        }
    }

    async onunload() {
        const styleEl = document.getElementById('canvas-node-window-styles');
        if (styleEl) styleEl.remove();
        await this.cleanupTempFiles();
    }

    async cleanupTempFiles() {
        const folder = this.app.vault.getAbstractFileByPath(this.settings.tempFolderPath);
        if (folder && folder.children) {
            for (const file of folder.children) {
                if (file instanceof obsidian.TFile) {
                    await this.app.vault.delete(file);
                }
            }
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
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Canvas Node Window Settings' });

        new obsidian.Setting(containerEl)
            .setName('Enable Plugin')
            .setDesc('Toggle the canvas node window plugin on/off')
            .addToggle(t => t.setValue(this.plugin.settings.enabled).onChange(async v => { this.plugin.settings.enabled = v; await this.plugin.saveSettings(); }));
        
        containerEl.createEl('h3', { text: 'Editor Settings' });
        
        // REPLACED: Unusable text field -> Button to real settings
        new obsidian.Setting(containerEl)
            .setName('Convert to File Hotkey')
            .setDesc('Hotkeys are managed in the main Obsidian settings. Default: Mod+Shift+F')
            .addButton(btn => btn
                .setButtonText('Open Hotkeys Settings')
                .onClick(() => {
                    this.app.setting.openTabById('hotkeys');
                }));
        
        new obsidian.Setting(containerEl)
            .setName('Temp Folder Path')
            .setDesc('Folder where temporary node files are stored')
            .addText(text => text.setPlaceholder('canvas-nodes-temp').setValue(this.plugin.settings.tempFolderPath).onChange(async (value) => {
                this.plugin.settings.tempFolderPath = value || 'canvas-nodes-temp';
                await this.plugin.saveSettings();
                await this.plugin.ensureTempFolder();
            }));
        
        new obsidian.Setting(containerEl)
            .setName('Pin Tab by Default')
            .addToggle(t => t.setValue(this.plugin.settings.pinnedByDefault).onChange(async v => { this.plugin.settings.pinnedByDefault = v; await this.plugin.saveSettings(); }));
            
        new obsidian.Setting(containerEl)
            .setName('Focus Node Window')
            .addToggle(t => t.setValue(this.plugin.settings.focusOnOpen).onChange(async v => { this.plugin.settings.focusOnOpen = v; await this.plugin.saveSettings(); }));
        
        containerEl.createEl('h3', { text: 'Advanced' });
        
        new obsidian.Setting(containerEl)
            .setName('Clean Up Temp Files')
            .addButton(btn => btn.setButtonText('Clean Up').onClick(async () => { await this.plugin.cleanupTempFiles(); new obsidian.Notice('Temp files cleaned up'); }));
            
        new obsidian.Setting(containerEl)
            .setName('Reset Connection')
            .addButton(btn => btn.setButtonText('Reset').onClick(async () => { 
                this.plugin.settings.savedLeafId = null; 
                await this.plugin.saveSettings(); 
                this.plugin.nodeLeaf = null;
                new obsidian.Notice('Connection reset');
            }));

        // --- SUPPORT SECTION ---
        containerEl.createEl('hr');
        containerEl.createEl('h3', { text: 'Support Development' });
        
        const supportContainer = containerEl.createDiv();
        supportContainer.style.cssText = 'display: flex; gap: 12px; margin-top: 10px; margin-bottom: 20px;';

        const createSupportBtn = (text, url, iconSvg, bgColor, textColor) => {
            const btn = supportContainer.createEl('a', { href: url });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                window.open(url); // Forces external browser
            });
            
            btn.style.cssText = `
                flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
                padding: 12px; border-radius: 6px; text-decoration: none; font-weight: 600;
                background-color: ${bgColor}; color: ${textColor}; transition: opacity 0.2s;
                border: 1px solid rgba(255,255,255,0.1);
            `;
            btn.innerHTML = `${iconSvg}<span>${text}</span>`;
            btn.onmouseenter = () => btn.style.opacity = '0.9';
            btn.onmouseleave = () => btn.style.opacity = '1';
        };

        // Buy Me a Coffee Button
        createSupportBtn(
            'Buy Me a Coffee',
            'https://www.buymeacoffee.com/Lexlorijn',
            `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>`,
            '#FFDD00',
            '#000000'
        );

        // GitHub Button
        createSupportBtn(
            'Follow on GitHub',
            'https://github.com/LexLorijn',
            `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>`,
            'var(--interactive-accent)',
            'var(--text-on-accent)'
        );
    }
}

module.exports = CanvasNodeWindowPlugin;