/* global window, document, navigator, alert, confirm, MissionDoctor, fetchWithCsrf */
const urlParams = new URLSearchParams(window.location.search);
const serverId = urlParams.get('server');

// Utility function to escape HTML special characters
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

console.log('Server ID from URL:', serverId);

if (!serverId || serverId === 'null') {
    alert('No server ID provided. Please go back to the dashboard and click "Edit Mission Files" on a specific server.');
    window.location.href = '/';
    throw new Error('No server ID'); // Stop execution
}

let currentFile = null;
let currentLockId = null;
let originalHash = null;
let conflictServerHash = null;
let fileList = {};
let hasUnsavedChanges = false;
let fileLoaded = false;
let fileOperationPending = false;
let editorContextVersion = 0;
let currentDocumentType;
let currentSource;

const editor = document.getElementById('editor');
const saveBtn = document.getElementById('saveBtn');
const formatBtn = document.getElementById('formatBtn');
const reloadBtn = document.getElementById('reloadBtn');
const backupBtn = document.getElementById('backupBtn');
const diffBtn = document.getElementById('diffBtn');
const releaseLockBtn = document.getElementById('releaseLockBtn');
const refreshFilesBtn = document.getElementById('refreshFilesBtn');
const statusText = document.getElementById('statusText');
const fileSize = document.getElementById('fileSize');
const fileInfo = document.getElementById('fileInfo');
const fileInfoText = document.getElementById('fileInfoText');
const refreshIndicator = document.getElementById('refreshIndicator');

const doctor = MissionDoctor.create({
    button: document.getElementById('doctorBtn'),
    report: document.getElementById('doctorReport'),
    source: document.getElementById('doctorSource'),
    request: (...args) => fetchWithCsrf(...args),
    getDraft: () => fileLoaded && !fileOperationPending ? {
        fileName: currentFile, content: editor.value, documentType: currentDocumentType,
        contextVersion: editorContextVersion, loadedHash: originalHash, source: currentSource,
    } : null,
});

function updateEditorControls() {
    editor.disabled = !fileLoaded || fileOperationPending;
    releaseLockBtn.disabled = fileOperationPending;
    for (const button of [saveBtn, formatBtn, reloadBtn, backupBtn, diffBtn]) {
        button.disabled = !fileLoaded || fileOperationPending;
    }
    saveBtn.disabled = saveBtn.disabled || !currentLockId;
    doctor.invalidate();
}

// Load file list
async function loadFileList() {
    try {
        const response = await fetch(`/api/mission-files/list/${serverId}`);
        const data = await response.json();

        if (data.success) {
            fileList = data.files;
            const diagnostics = (data.diagnostics || []).map(item => item.message).filter(Boolean).join(' ');
            document.getElementById('fileListStatus').textContent =
                `${data.truncated ? 'Incomplete discovery. ' : ''}Synchronized working copies; provider freshness unknown. ${diagnostics}`;
            renderFileTree();
        } else {
            document.getElementById('fileTree').innerHTML = `
                <div style="padding: 20px; text-align: center; color: #dc3545;">
                    <p>❌ ${escapeHtml(data.error || 'Unknown error')}</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('Failed to load files:', error);
        const message = escapeHtml(error.message || 'Unknown error');
        document.getElementById('fileTree').innerHTML = `
            <div style="padding: 20px; text-align: center; color: #dc3545;">
                <p>❌ Failed to load files: ${message}</p>
                <p style="font-size: 12px; margin-top: 10px;">Please try refreshing the page or contact support if the issue persists.</p>
            </div>
        `;
    }
}

function encodedFilePath(fileName) {
    return fileName.split('/').map(encodeURIComponent).join('/');
}

// Render file tree with directories
function renderFileTree() {
    const tree = Object.create(null);

    // Organize files by directory
    Object.keys(fileList).forEach(filePath => {
        const file = fileList[filePath];
        const parts = filePath.split('/');

        // Skip log files and other non-editable files
        const fileName = parts[parts.length - 1].toLowerCase();
        if (fileName.endsWith('.log') || 
            fileName.endsWith('.rpt') || 
            fileName.endsWith('.adm') ||
            fileName.endsWith('.mdmp') ||
            fileName.startsWith('console_')) {
            return;
        }

        if (parts.length === 1) {
            // Root level file
            if (!tree['_root']) tree['_root'] = [];
            tree['_root'].push({ path: filePath, file });
        } else {
            // File in a directory
            const dir = parts[0];
            if (!tree[dir]) tree[dir] = [];
            tree[dir].push({ path: filePath, file });
        }
    });

    // Render the tree
    let html = '<ul class="file-tree">';

    // Sort directories
    const dirs = Object.keys(tree).sort((a, b) => {
        if (a === '_root') return -1;
        if (b === '_root') return 1;
        return a.localeCompare(b);
    });

    dirs.forEach(dir => {
        const files = tree[dir];

        if (dir === '_root') {
            // Render root level files
            files.forEach(({ path, file }) => {
                html += renderFileItem(path, file);
            });
        } else {
            // Render directory with files
            html += `
                <li class="file-tree-folder">
                    <div class="folder-header" data-folder-toggle>
                        <span class="folder-icon">▶</span>
                        📁 ${escapeHtml(dir)}
                        <span class="badge badge-xml">${files.length}</span>
                    </div>
                    <ul class="folder-files">
                        ${files.map(({ path, file }) => renderFileItem(path, file)).join('')}
                    </ul>
                </li>
            `;
        }
    });

    html += '</ul>';
    document.getElementById('fileTree').innerHTML = html;
}

function renderFileItem(path) {
    const fileName = path.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();
    let icon = '📄';
    let badgeClass = 'badge-txt';

    if (ext === 'xml') {
        icon = '📋';
        badgeClass = 'badge-xml';
    } else if (ext === 'json') {
        icon = '📊';
        badgeClass = 'badge-json';
    }

    return `
        <li class="file-item" data-file-path="${escapeHtml(path)}">
            <span>
                <span class="file-icon">${icon}</span>
                ${escapeHtml(fileName)}
            </span>
            <span class="badge ${badgeClass}">${ext.toUpperCase()}</span>
        </li>
    `;
}

function toggleFolder(element) {
    element.classList.toggle('expanded');
    const filesContainer = element.nextElementSibling;
    filesContainer.classList.toggle('expanded');
}

// Select and load a file
async function selectFile(fileName, clickedElement) {
    if (fileOperationPending) return;
    if (hasUnsavedChanges) {
        if (!confirm('You have unsaved changes. Do you want to discard them?')) {
            return;
        }
    }

    fileOperationPending = true;
    fileLoaded = false;
    editorContextVersion++;
    conflictServerHash = null;
    document.getElementById('conflictModal').classList.remove('active');
    editor.value = '';
    currentDocumentType = undefined;
    currentSource = undefined;
    updateEditorControls();
    // Capture and release the previous lock before loading another file.
    try {
        if (currentLockId) await releaseLock();
    } catch (error) {
        fileOperationPending = false;
        statusText.textContent = 'Could not release the previous file lock. Try again.';
        updateEditorControls();
        return;
    }

    // Update UI
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('active');
    });
    if (clickedElement) {
        clickedElement.classList.add('active');
    }

    currentFile = fileName;
    statusText.textContent = 'Loading...';
    
    try {
        // Read file
        const response = await fetch(`/api/mission-files/${serverId}/${encodedFilePath(fileName)}`);
        const data = await response.json();

        if (data.success) {
            editor.value = data.content;
            currentDocumentType = data.documentType || undefined;
            currentSource = data.source;
            fileLoaded = true;
            originalHash = data.hash;
            conflictServerHash = null;
            hasUnsavedChanges = false;

            // Acquire lock
            const lockResponse = await fetchWithCsrf(`/api/mission-files/${serverId}/${encodedFilePath(fileName)}/lock`, {
                method: 'POST',
                body: JSON.stringify({ lockHolder: 'dashboard', timeoutMs: 300000 })
            });

            const lockData = await lockResponse.json();
            if (lockData.success) {
                currentLockId = lockData.lockId;
                statusText.textContent = `Editing: ${fileName}`;
                fileInfoText.textContent = `Editing: ${fileName} (Lock expires in 5 minutes)`;
                fileInfo.style.display = 'flex';
            } else {
                statusText.textContent = `⚠️ ${lockData.error}`;
                fileInfoText.textContent = lockData.error;
                fileInfo.style.display = 'flex';
            }

            // Update file size
            fileSize.textContent = formatBytes(data.content.length);

            // Enable buttons
            saveBtn.disabled = false;
            formatBtn.disabled = false;
            reloadBtn.disabled = false;
            backupBtn.disabled = false;
            diffBtn.disabled = false;

        } else {
            alert('Failed to load file: ' + data.error);
        }
    } catch (error) {
        console.error('Failed to load file:', error);
        const message = error.message || 'Unknown error';
        alert(`Failed to load file: ${message}\n\nPlease try refreshing the page or contact support if the issue persists.`);
    } finally {
        fileOperationPending = false;
        updateEditorControls();
    }
}

// Format / Lint file
formatBtn.addEventListener('click', async () => {
    if (!fileLoaded || fileOperationPending) return;
    doctor.invalidate();

    try {
        const content = editor.value;
        const ext = currentFile.split('.').pop().toLowerCase();

        if (ext === 'json') {
            // Pretty print JSON
            const parsed = JSON.parse(content);
            editor.value = JSON.stringify(parsed, null, 2);
            hasUnsavedChanges = true;
            statusText.textContent = '✨ JSON formatted';
        } else if (ext === 'xml') {
            // Basic XML formatting
            const formatted = formatXML(content);
            editor.value = formatted;
            hasUnsavedChanges = true;
            statusText.textContent = '✨ XML formatted';
        } else {
            alert('Formatting is only available for JSON and XML files');
        }
    } catch (error) {
        alert('Failed to format: ' + error.message);
    }
});

// Simple XML formatter
function formatXML(xml) {
    const PADDING = '  ';
    const reg = /(>)(<)(\/*)/g;
    let pad = 0;

    xml = xml.replace(reg, '$1\r\n$2$3');

    return xml.split('\r\n').map((node) => {
        let indent = 0;
        if (node.match(/.+<\/\w[^>]*>$/)) {
            indent = 0;
        } else if (node.match(/^<\/\w/) && pad > 0) {
            pad -= 1;
        } else if (node.match(/^<\w[^>]*[^/]>.*$/)) {
            indent = 1;
        } else {
            indent = 0;
        }

        pad += indent;

        return PADDING.repeat(pad - indent) + node;
    }).join('\r\n');
}

// Track changes
editor.addEventListener('input', () => {
    doctor.invalidate();
    if (currentFile) {
        hasUnsavedChanges = true;
        statusText.textContent = '✏️ Modified (unsaved)';
        fileSize.textContent = formatBytes(editor.value.length);
    }
});

// Save file
saveBtn.addEventListener('click', async () => {
    if (!fileLoaded || !currentFile || !currentLockId || fileOperationPending) return;
    fileOperationPending = true;
    updateEditorControls();

    statusText.textContent = 'Saving...';
    saveBtn.disabled = true;

    try {
        // Check for conflicts
        const conflictResponse = await fetchWithCsrf(`/api/mission-files/${serverId}/${encodedFilePath(currentFile)}/check-conflict`, {
            method: 'POST',
            body: JSON.stringify({ expectedHash: originalHash })
        });

        const conflictData = await conflictResponse.json();

        if (conflictData.hasConflict) {
            conflictServerHash = conflictData.currentHash;
            document.getElementById('conflictModal').classList.add('active');
            return;
        }

        // Save file
        const response = await fetchWithCsrf(`/api/mission-files/${serverId}/${encodedFilePath(currentFile)}`, {
            method: 'PUT',
            body: JSON.stringify({
                content: editor.value,
                lockId: currentLockId,
                createBackup: true,
                uploadToNitrado: true,
                expectedHash: originalHash
            })
        });

        const data = await response.json();

        if (data.success) {
            originalHash = data.hash;
            conflictServerHash = null;
            hasUnsavedChanges = false;
            statusText.textContent = '✅ Saved and verified on Nitrado';
            
            currentSource = undefined;
            // Show success indicator
            refreshIndicator.classList.add('active');
            setTimeout(() => {
                refreshIndicator.classList.remove('active');
            }, 3000);
        } else {
            alert('Failed to save: ' + data.error);
            statusText.textContent = '❌ Save failed';
        }
    } catch (error) {
        console.error('Failed to save:', error);
        const message = error.message || 'Unknown error';
        alert(`Failed to save file: ${message}\n\nPlease try again or contact support if the issue persists.`);
        statusText.textContent = '❌ Save failed';
    } finally {
        fileOperationPending = false;
        updateEditorControls();
    }
});

// Reload file
reloadBtn.addEventListener('click', async () => {
    if (!currentFile) return;

    if (hasUnsavedChanges) {
        if (!confirm('Discard unsaved changes and reload the local working copy?')) {
            return;
        }
    }

    await selectFile(currentFile);
});

// Check for changes
diffBtn.addEventListener('click', async () => {
    if (!currentFile) return;

    statusText.textContent = 'Checking for changes...';

    try {
        const response = await fetchWithCsrf(`/api/mission-files/${serverId}/${encodedFilePath(currentFile)}/check-conflict`, {
            method: 'POST',
            body: JSON.stringify({ expectedHash: originalHash })
        });

        const data = await response.json();

        if (data.hasConflict) {
            alert('⚠️ The local working copy has changed!\n\nExpected hash: ' + data.expectedHash + '\nCurrent hash: ' + data.currentHash);
        } else {
            alert('✅ No changes detected in the local working copy; provider freshness is unknown');
        }

        statusText.textContent = 'Ready';
    } catch (error) {
        console.error('Failed to check for changes:', error);
        const message = error.message || 'Unknown error';
        alert(`Failed to check for changes: ${message}\n\nPlease try again.`);
    }
});

// Release lock
async function releaseLock() {
    if (currentLockId && currentFile) {
        await fetchWithCsrf(`/api/mission-files/${serverId}/${encodedFilePath(currentFile)}/unlock`, {
            method: 'POST',
            body: JSON.stringify({ lockId: currentLockId })
        });
        currentLockId = null;
    }
}

// Release all locks
releaseLockBtn.addEventListener('click', async () => {
    if (fileOperationPending) return;
    if (!confirm('Release all locks on this server? This will allow other users to edit files.')) {
        return;
    }

    fileOperationPending = true;
    updateEditorControls();
    try {
        const response = await fetchWithCsrf('/api/mission-files/release-all-locks', {
            method: 'POST',
            body: JSON.stringify({ serverId })
        });

        const data = await response.json();
        alert(`Released ${data.released} locks`);
        currentLockId = null;
    } catch (error) {
        console.error('Failed to release locks:', error);
        const message = error.message || 'Unknown error';
        alert(`Failed to release locks: ${message}\n\nPlease try again.`);
    } finally {
        fileOperationPending = false;
        updateEditorControls();
    }
});

// Refresh file list
refreshFilesBtn.addEventListener('click', () => {
    loadFileList();
});

// Back button
document.getElementById('backButton').addEventListener('click', () => {
    window.location.href = '/dashboard';
});

// Conflict modal buttons - event delegation
document.getElementById('conflictModal').addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (button) {
        const action = button.dataset.action;
        resolveConflict(action);
    }
});

// File tree - event delegation for folder toggles and file selection
document.getElementById('fileTree').addEventListener('click', (e) => {
    // Handle folder toggle
    const folderHeader = e.target.closest('[data-folder-toggle]');
    if (folderHeader) {
        toggleFolder(folderHeader);
        return;
    }

    // Handle file selection
    const fileItem = e.target.closest('[data-file-path]');
    if (fileItem) {
        const filePath = fileItem.dataset.filePath;
        selectFile(filePath, fileItem);
        return;
    }
});

// Conflict resolution
async function resolveConflict(action) {
    document.getElementById('conflictModal').classList.remove('active');

    if (!fileLoaded || fileOperationPending) return;
    if (action === 'overwrite') {
        if (!currentLockId || !conflictServerHash) return;
        fileOperationPending = true;
        updateEditorControls();
        try {
            // Save with both the local conflict hash and provider verification.
            const response = await fetchWithCsrf(`/api/mission-files/${serverId}/${encodedFilePath(currentFile)}`, {
                method: 'PUT',
                body: JSON.stringify({
                    content: editor.value,
                    lockId: currentLockId,
                    createBackup: true,
                    uploadToNitrado: true,
                    expectedHash: conflictServerHash
                })
            });

            const data = await response.json();
            if (data.success) {
                originalHash = data.hash;
                conflictServerHash = null;
                hasUnsavedChanges = false;
                currentSource = undefined;
                statusText.textContent = '✅ Saved and verified on Nitrado';
            } else {
                throw new Error(data.error || 'Save failed');
            }
        } catch (error) {
            statusText.textContent = '❌ Save failed';
            alert('Failed to save: ' + error.message);
        } finally {
            fileOperationPending = false;
            updateEditorControls();
        }
    } else if (action === 'reload') {
        await selectFile(currentFile, null);
    }
}

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Warn before leaving with unsaved changes
window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Release lock on page unload
window.addEventListener('unload', () => {
    if (currentLockId) {
        navigator.sendBeacon(`/api/mission-files/${serverId}/${encodedFilePath(currentFile)}/unlock`,
            JSON.stringify({ lockId: currentLockId }));
    }
});

// Initialize
updateEditorControls();
loadFileList();
