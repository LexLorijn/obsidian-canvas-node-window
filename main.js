'use strict';

var obsidian = require('obsidian');

class CanvasFocusPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.currentCanvas = null;
        this.focusLeafId = null;
        this.lastSelection = null;
        this.pollInterval = null;
        this.isEnabled = true; // Track if plugin is active
        this.windowWasClosed = false; // Track if user manually closed the window
    }
    
    async onload() {
        console.log('Loading Canvas Focus Window plugin');
        
        // Add command to toggle the plugin on/off
        this.addCommand({
            id: 'toggle-canvas-focus',
            name: 'Toggle Canvas Focus Window',
            callback: () => {
                this.isEnabled = !this.isEnabled;
                const status = this.isEnabled ? 'enabled' : 'disabled';
                new obsidian.Notice(`Canvas Focus Window ${status}`);
                console.log(`Canvas Focus Window ${status}`);
                
                // If disabling, close the window and cleanup
                if (!this.isEnabled) {
                    this.closeWindow();
                    this.cleanup();
                } else {
                    // If enabling, restart monitoring if we're on a canvas
                    const activeLeaf = this.app.workspace.activeLeaf;
                    if (activeLeaf) {
                        this.setupCanvasListener(activeLeaf);
                    }
                }
            }
        });
        
        // Register an event for when the active leaf (tab) changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (this.isEnabled) {
                    this.setupCanvasListener(leaf);
                }
            })
        );
        
        // Monitor when windows are closed
        this.registerEvent(
            this.app.workspace.on('window-close', (win) => {
                // Check if the closed window was our focus window
                if (this.focusLeafId) {
                    const focusLeaf = this.app.workspace.getLeafById(this.focusLeafId);
                    if (!focusLeaf) {
                        // Our window was closed
                        console.log('Focus window was closed by user');
                        this.windowWasClosed = true;
                        this.focusLeafId = null;
                    }
                }
            })
        );
        
        // Also set up listener for currently active leaf on load
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf && this.isEnabled) {
            this.setupCanvasListener(activeLeaf);
        }
    }
    
    setupCanvasListener(leaf) {
        // Clean up any old polling first
        this.cleanup();

        // Check if the new active leaf is a canvas
        if (leaf?.view?.getViewType() === 'canvas') {
            const canvasView = leaf.view;
            
            // Wait a bit for the canvas to be ready
            setTimeout(() => {
                if (canvasView.canvas) {
                    this.currentCanvas = canvasView.canvas;
                    console.log('Canvas detected, starting selection monitor');
                    
                    // Start polling for selection changes
                    this.pollInterval = this.registerInterval(
                        window.setInterval(() => {
                            this.checkSelection();
                        }, 300)
                    );
                } else {
                    console.log('Canvas view found but canvas object not ready');
                }
            }, 100);
        }
    }
    
    cleanup() {
        if (this.pollInterval) {
            window.clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.currentCanvas = null;
        this.lastSelection = null;
    }
    
    closeWindow() {
        if (this.focusLeafId) {
            const focusLeaf = this.app.workspace.getLeafById(this.focusLeafId);
            if (focusLeaf) {
                focusLeaf.detach();
            }
            this.focusLeafId = null;
        }
    }
    
    checkSelection() {
        if (!this.isEnabled || !this.currentCanvas || !this.currentCanvas.selection) {
            return;
        }
        
        const selection = this.currentCanvas.selection;
        
        // Get the selected nodes
        let selectedNodes = [];
        
        if (selection instanceof Set) {
            selectedNodes = Array.from(selection);
        } else if (selection.size !== undefined) {
            // It's a Set-like object
            selectedNodes = Array.from(selection);
        } else if (Array.isArray(selection)) {
            selectedNodes = selection;
        }
        
        // Check if exactly one node is selected
        if (selectedNodes.length !== 1) {
            this.lastSelection = null;
            return;
        }
        
        const node = selectedNodes[0];
        
        // Check if this is a new selection (avoid processing the same node repeatedly)
        const nodeId = node.id || node.file;
        if (this.lastSelection === nodeId) {
            return;
        }
        
        // This is a new selection - clear the "window was closed" flag
        this.windowWasClosed = false;
        this.lastSelection = nodeId;
        console.log('New node selected:', node);
        
        // Process the selection
        this.processSelection(node);
    }
    
    async processSelection(node) {
        try {
            // If user closed the window manually, don't reopen until new selection
            // (this check happens after lastSelection changes, so new nodes will work)
            if (this.windowWasClosed) {
                console.log('Window was closed by user, skipping reopen');
                return;
            }
            
            // Log the full node to understand its structure
            console.log('Node structure:', {
                type: node.type,
                file: node.file,
                filePath: node.filePath,
                allKeys: Object.keys(node)
            });
            
            // Check if it's a file node - try different property names
            const isFileNode = node.type === 'file' || 
                              node.file !== undefined || 
                              node.filePath !== undefined;
            
            if (!isFileNode) {
                console.log('Not a file node');
                return;
            }
            
            // Get the file path - try multiple possible properties
            let filePath = null;
            
            if (node.file) {
                if (typeof node.file === 'string') {
                    filePath = node.file;
                } else if (node.file.path) {
                    filePath = node.file.path;
                } else if (node.file.name) {
                    filePath = node.file.name;
                }
            }
            
            if (!filePath && node.filePath) {
                filePath = node.filePath;
            }
            
            if (!filePath) {
                console.log('No file path found for node. Node keys:', Object.keys(node));
                return;
            }
            
            console.log('Opening file:', filePath);
            
            // Get the TFile object from the vault
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof obsidian.TFile)) {
                console.log('File not found in vault:', filePath);
                return;
            }
            
            // Find or create our pop-out window
            let focusLeaf = null;
            
            // Try to find our existing pop-out leaf
            if (this.focusLeafId) {
                focusLeaf = this.app.workspace.getLeafById(this.focusLeafId);
                if (focusLeaf) {
                    console.log('Reusing existing pop-out window');
                }
            }
            
            // If we didn't find it, create a new one
            if (!focusLeaf) {
                console.log('Creating new pop-out window');
                focusLeaf = this.app.workspace.openPopoutLeaf();
                this.focusLeafId = focusLeaf.id;
                this.windowWasClosed = false; // Reset flag when creating new window
            }
            
            // Open the file in our focus leaf
            await focusLeaf.openFile(file, { active: true });
            
            console.log('File opened successfully');
            
        } catch (e) {
            console.error('Canvas Focus Plugin Error:', e);
            // Reset the leaf ID if there was an error
            this.focusLeafId = null;
        }
    }
    
    onunload() {
        console.log('Unloading Canvas Focus Window plugin');
        this.closeWindow();
        this.cleanup();
    }
}

module.exports = CanvasFocusPlugin;