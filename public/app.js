/**
 * Beget Mail Generator - Client-side JavaScript
 * Gothic Theme Edition
 */

// Global state
let mailboxes = [];
let domains = [];
let selectedMailboxes = new Set();

// DOM Elements
const domainSelect = document.getElementById('domainSelect');
const countInput = document.getElementById('countInput');
const generateForm = document.getElementById('generateForm');
const generateBtn = document.getElementById('generateBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const mailboxesTable = document.getElementById('mailboxesTable');
const connectionStatus = document.getElementById('connectionStatus');
const alertsContainer = document.getElementById('alertsContainer');
const filterDomain = document.getElementById('filterDomain');
const searchInput = document.getElementById('searchInput');
const checkAll = document.getElementById('checkAll');
const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
const deleteAllBtn = document.getElementById('deleteAllBtn');
const copySelectedBtn = document.getElementById('copySelectedBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const totalCreated = document.getElementById('totalCreated');
const todayCreated = document.getElementById('todayCreated');
const shownCount = document.getElementById('shownCount');
const totalCount = document.getElementById('totalCount');
const lastResultsCard = document.getElementById('lastResultsCard');
const lastResultsText = document.getElementById('lastResultsText');
const lastSuccessCount = document.getElementById('lastSuccessCount');
const lastErrorCount = document.getElementById('lastErrorCount');
const deleteModal = document.getElementById('deleteModal');
const deleteCount = document.getElementById('deleteCount');
const deleteModalMessage = document.getElementById('deleteModalMessage');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkConnection();
    loadDomains();
    loadLocalMailboxes();
    setupEventListeners();
});

// Setup event listeners
function setupEventListeners() {
    // Generate form
    generateForm.addEventListener('submit', handleGenerate);
    
    // Refresh domains
    document.getElementById('refreshDomainsBtn').addEventListener('click', loadDomains);
    
    // Load Beget mailboxes
    document.getElementById('loadBegetMailboxesBtn').addEventListener('click', loadBegetMailboxes);

    // Delete every mailbox currently displayed by the filters
    deleteAllBtn.addEventListener('click', selectDisplayedForDeletion);
    
    // Export all
    document.getElementById('exportAllBtn').addEventListener('click', exportAll);
    
    // Filter and search
    filterDomain.addEventListener('change', renderMailboxes);
    searchInput.addEventListener('input', debounce(renderMailboxes, 300));
    
    // Checkbox events
    checkAll.addEventListener('change', toggleAllCheckboxes);
    selectAllBtn.addEventListener('click', () => {
        checkAll.checked = !checkAll.checked;
        toggleAllCheckboxes();
    });
    
    // Delete selected
    deleteSelectedBtn.addEventListener('click', () => {
        deleteModalMessage.textContent = 'Вы уверены, что хотите удалить выбранные почтовые ящики?';
        deleteCount.textContent = selectedMailboxes.size;
        showModal();
    });
    
    document.getElementById('confirmDeleteBtn').addEventListener('click', deleteSelected);
    document.getElementById('cancelDeleteBtn').addEventListener('click', hideModal);
    
    // Close modal on overlay click
    deleteModal.querySelector('.modal-overlay').addEventListener('click', hideModal);
    
    // Copy selected
    copySelectedBtn.addEventListener('click', copySelected);
    
    // Copy last results
    document.getElementById('copyLastResultsBtn').addEventListener('click', () => {
        copyToClipboard(lastResultsText.value);
        showAlert('Скопировано в буфер обмена!', 'success');
    });
}

// Modal functions
function showModal() {
    deleteModal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function hideModal() {
    deleteModal.classList.remove('show');
    document.body.style.overflow = '';
}

// Check API connection
async function checkConnection() {
    try {
        const response = await fetch('/api/check-connection');
        const data = await response.json();
        
        if (data.success) {
            connectionStatus.classList.add('connected');
            connectionStatus.classList.remove('error');
            connectionStatus.querySelector('.status-text').textContent = 'Подключено';
        } else {
            connectionStatus.classList.add('error');
            connectionStatus.classList.remove('connected');
            connectionStatus.querySelector('.status-text').textContent = 'Ошибка API';
        }
    } catch (error) {
        connectionStatus.classList.add('error');
        connectionStatus.classList.remove('connected');
        connectionStatus.querySelector('.status-text').textContent = 'Нет связи';
    }
}

// Load domains from Beget
async function loadDomains() {
    try {
        domainSelect.innerHTML = '<option value="">Загрузка...</option>';
        domainSelect.disabled = true;
        
        const response = await fetch('/api/domains');
        const data = await response.json();
        
        if (data.success && data.domains) {
            domains = data.domains;
            
            domainSelect.innerHTML = '<option value="">Выберите домен...</option>';
            filterDomain.innerHTML = '<option value="">Все домены</option>';
            
            domains.forEach(domain => {
                domainSelect.innerHTML += `<option value="${domain.fqdn}">${domain.fqdn}</option>`;
                filterDomain.innerHTML += `<option value="${domain.fqdn}">${domain.fqdn}</option>`;
            });
            
            showAlert(`Загружено ${domains.length} доменов`, 'success');
        } else {
            domainSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
            showAlert(data.error || 'Не удалось загрузить домены', 'error');
        }
    } catch (error) {
        domainSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        showAlert('Ошибка подключения к серверу', 'error');
    } finally {
        domainSelect.disabled = false;
    }
}

// Load local mailboxes
async function loadLocalMailboxes() {
    try {
        const response = await fetch('/api/local-mailboxes');
        const data = await response.json();
        
        if (data.success) {
            mailboxes = data.mailboxes;
            const existingIds = new Set(mailboxes.map(mailbox => mailbox.id));
            selectedMailboxes = new Set(
                [...selectedMailboxes].filter(id => existingIds.has(id))
            );
            checkAll.checked = false;
            renderMailboxes();
            updateStats();
            updateSelectionButtons();
        }
    } catch (error) {
        showAlert('Ошибка загрузки локальных данных', 'error');
    }
}

// Load mailboxes from Beget
async function loadBegetMailboxes() {
    const domain = domainSelect.value;
    if (!domain) {
        showAlert('Выберите домен для загрузки', 'info');
        return;
    }
    
    const button = document.getElementById('loadBegetMailboxesBtn');
    const originalContent = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Обновление...';

    try {
        const response = await fetch('/api/mailboxes/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain })
        });
        const data = await response.json();

        if (data.success) {
            selectedMailboxes.clear();
            await loadLocalMailboxes();
            filterDomain.value = domain;
            renderMailboxes();
            showAlert(
                `Список обновлён: ${data.total} ящиков, добавлено ${data.imported}, убрано ${data.removed}`,
                'success'
            );
        } else {
            showAlert(data.error || 'Ошибка загрузки', 'error');
        }
    } catch (error) {
        showAlert('Ошибка подключения', 'error');
    } finally {
        button.disabled = false;
        button.innerHTML = originalContent;
    }
}

// Handle generate form submit
async function handleGenerate(e) {
    e.preventDefault();
    
    const domain = domainSelect.value;
    const count = parseInt(countInput.value);
    
    if (!domain) {
        showAlert('Пожалуйста, выберите домен', 'info');
        return;
    }
    
    if (count < 1 || count > 50) {
        showAlert('Количество должно быть от 1 до 50', 'info');
        return;
    }
    
    // Show progress
    generateBtn.disabled = true;
    generateBtn.innerHTML = '⏳ Генерация...';
    progressContainer.classList.remove('d-none');
    progressBar.style.width = '0%';
    progressText.textContent = `Создание ${count} почтовых ящиков...`;
    
    // Simulate progress (actual API is sequential)
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress > 95) progress = 95;
        progressBar.style.width = `${progress}%`;
    }, 1000);
    
    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, count })
        });

        const data = await response.json();

        clearInterval(progressInterval);
        progressBar.style.width = '100%';
        
        if (data.success) {
            // Show results
            lastResultsCard.style.display = 'block';
            lastSuccessCount.textContent = data.total;
            lastErrorCount.textContent = data.failed;
            
            const resultsText = data.created.map(m => `${m.email}:${m.password}`).join('\n');
            lastResultsText.value = resultsText;
            
            if (data.total > 0) {
                showAlert(`Успешно создано ${data.total} почтовых ящиков!`, 'success');
            }
            
            if (data.failed > 0) {
                console.log('Errors:', data.errors);
                showAlert(`Ошибок: ${data.failed}. Проверьте консоль для деталей.`, 'info');
            }
            
            // Reload mailboxes
            await loadLocalMailboxes();
        } else {
            showAlert(data.error || 'Ошибка генерации', 'error');
        }
    } catch (error) {
        clearInterval(progressInterval);
        showAlert('Ошибка подключения к серверу', 'error');
    } finally {
        generateBtn.disabled = false;
        generateBtn.innerHTML = '⚔ Генерировать';
        
        setTimeout(() => {
            progressContainer.classList.add('d-none');
        }, 2000);
    }
}

// Render mailboxes table
function renderMailboxes() {
    const filtered = getDisplayedMailboxes();
    
    totalCount.textContent = mailboxes.length;
    shownCount.textContent = filtered.length;
    
    if (filtered.length === 0) {
        mailboxesTable.innerHTML = `
            <tr>
                <td colspan="5" class="empty-state">
                    <div class="empty-icon">📜</div>
                    <p>${mailboxes.length === 0 ? 'Нет созданных почтовых ящиков' : 'Ничего не найдено'}</p>
                </td>
            </tr>
        `;
        return;
    }
    
    mailboxesTable.innerHTML = filtered.map(mailbox => `
        <tr class="${selectedMailboxes.has(mailbox.id) ? 'selected' : ''}" data-id="${mailbox.id}">
            <td class="text-center">
                <input type="checkbox" class="gothic-checkbox mailbox-check" 
                       data-id="${mailbox.id}" ${selectedMailboxes.has(mailbox.id) ? 'checked' : ''}>
            </td>
            <td class="email-cell">${escapeHtml(mailbox.email)}</td>
            <td class="password-cell">${mailbox.password
                ? escapeHtml(mailbox.password)
                : '<span title="Beget не возвращает пароли существующих ящиков">не сохранён</span>'}</td>
            <td class="date-cell">${formatDate(mailbox.created_at)}</td>
            <td class="actions-cell">
                <button class="gothic-btn-icon" onclick="copyMailbox('${escapeInlineJsString(mailbox.email)}', '${escapeInlineJsString(mailbox.password || '')}')" title="${mailbox.password ? 'Копировать email и пароль' : 'Копировать email'}">
                    <i class="bi bi-clipboard"></i>
                </button>
                <button class="gothic-btn-icon gothic-btn-danger" onclick="deleteSingle('${escapeInlineJsString(mailbox.domain)}', '${escapeInlineJsString(mailbox.mailbox_name)}')" title="Удалить">
                    <i class="bi bi-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
    
    // Add checkbox listeners
    document.querySelectorAll('.mailbox-check').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const id = parseInt(e.target.dataset.id);
            if (e.target.checked) {
                selectedMailboxes.add(id);
                e.target.closest('tr').classList.add('selected');
            } else {
                selectedMailboxes.delete(id);
                e.target.closest('tr').classList.remove('selected');
            }
            updateSelectionButtons();
        });
    });
}

function getDisplayedMailboxes() {
    const filter = filterDomain.value;
    const search = searchInput.value.trim().toLowerCase();
    let filtered = mailboxes;

    if (filter) {
        filtered = filtered.filter(mailbox => mailbox.domain === filter);
    }

    if (search) {
        filtered = filtered.filter(mailbox => mailbox.email.toLowerCase().includes(search));
    }

    return filtered;
}

// Update stats
function updateStats() {
    totalCreated.textContent = mailboxes.length;
    
    const today = new Date().toISOString().split('T')[0];
    const todayCount = mailboxes.filter(m => m.created_at && m.created_at.startsWith(today)).length;
    todayCreated.textContent = todayCount;
    
    // Update filter dropdown with unique domains
    const uniqueDomains = [...new Set(mailboxes.map(m => m.domain))];
    const currentFilter = filterDomain.value;
    
    filterDomain.innerHTML = '<option value="">Все домены</option>';
    uniqueDomains.forEach(domain => {
        filterDomain.innerHTML += `<option value="${domain}" ${domain === currentFilter ? 'selected' : ''}>${domain}</option>`;
    });
}

// Toggle all checkboxes
function toggleAllCheckboxes() {
    const checkboxes = document.querySelectorAll('.mailbox-check');
    checkboxes.forEach(checkbox => {
        checkbox.checked = checkAll.checked;
        const id = parseInt(checkbox.dataset.id);
        if (checkAll.checked) {
            selectedMailboxes.add(id);
            checkbox.closest('tr').classList.add('selected');
        } else {
            selectedMailboxes.delete(id);
            checkbox.closest('tr').classList.remove('selected');
        }
    });
    updateSelectionButtons();
}

// Update selection buttons
function updateSelectionButtons() {
    const hasSelection = selectedMailboxes.size > 0;
    deleteSelectedBtn.disabled = !hasSelection;
    copySelectedBtn.disabled = !hasSelection;
}

function selectDisplayedForDeletion() {
    const displayed = getDisplayedMailboxes();
    if (displayed.length === 0) {
        showAlert('В списке нет почтовых ящиков для удаления', 'info');
        return;
    }

    selectedMailboxes = new Set(displayed.map(mailbox => mailbox.id));
    checkAll.checked = true;
    renderMailboxes();
    updateSelectionButtons();
    deleteModalMessage.textContent = 'Удалить все отображаемые почтовые ящики с Beget?';
    deleteCount.textContent = displayed.length;
    showModal();
}

// Delete selected mailboxes
async function deleteSelected() {
    hideModal();
    
    const toDelete = mailboxes
        .filter(m => selectedMailboxes.has(m.id))
        .map(m => ({ domain: m.domain, mailbox: m.mailbox_name }));
    
    if (toDelete.length === 0) return;
    
    deleteSelectedBtn.disabled = true;
    
    try {
        const response = await fetch('/api/mailboxes/delete-multiple', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailboxes: toDelete })
        });
        
        const data = await response.json();

        if (data.success) {
            const failedEmails = new Set(data.errors.map(error => error.email));
            selectedMailboxes.clear();
            checkAll.checked = false;
            await loadLocalMailboxes();

            if (data.failed > 0) {
                selectedMailboxes = new Set(
                    mailboxes
                        .filter(mailbox => failedEmails.has(mailbox.email))
                        .map(mailbox => mailbox.id)
                );
                renderMailboxes();
                updateSelectionButtons();
                showAlert(`Удалено ${data.total}, не удалось удалить ${data.failed}`, 'error');
            } else {
                showAlert(`Удалено ${data.total} ящиков`, 'success');
            }
        } else {
            showAlert(data.error || 'Ошибка удаления', 'error');
        }
    } catch (error) {
        showAlert('Ошибка подключения', 'error');
    } finally {
        updateSelectionButtons();
    }
}

// Delete single mailbox
async function deleteSingle(domain, mailbox) {
    if (!confirm(`Удалить ${mailbox}@${domain}?`)) return;
    
    try {
        const response = await fetch('/api/mailbox', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, mailbox })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showAlert('Почтовый ящик удален', 'success');
            await loadLocalMailboxes();
        } else {
            showAlert(data.error || 'Ошибка удаления', 'error');
        }
    } catch (error) {
        showAlert('Ошибка подключения', 'error');
    }
}

// Copy selected to clipboard
function copySelected() {
    const selected = mailboxes.filter(m => selectedMailboxes.has(m.id));
    const text = selected.map(formatMailboxCredentials).join('\n');
    copyToClipboard(text);
    showAlert(`Скопировано ${selected.length} записей`, 'success');
}

// Copy single mailbox
function copyMailbox(email, password) {
    copyToClipboard(password ? `${email}:${password}` : email);
    showAlert(password ? 'Email и пароль скопированы!' : 'Email скопирован!', 'success');
}

function formatMailboxCredentials(mailbox) {
    return mailbox.password ? `${mailbox.email}:${mailbox.password}` : mailbox.email;
}

// Export all mailboxes
async function exportAll() {
    try {
        const response = await fetch('/api/export');
        const text = await response.text();
        
        if (text) {
            copyToClipboard(text);
            showAlert(`Экспортировано ${mailboxes.length} записей в буфер обмена`, 'success');
            
            // Also download as file
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `mailboxes_${new Date().toISOString().split('T')[0]}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            showAlert('Нет данных для экспорта', 'info');
        }
    } catch (error) {
        showAlert('Ошибка экспорта', 'error');
    }
}

// Copy to clipboard helper
function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text);
    } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    }
}

// Show alert - Gothic style
function showAlert(message, type = 'info') {
    const icons = {
        success: 'bi-check-circle',
        error: 'bi-x-circle',
        info: 'bi-info-circle'
    };
    
    const alert = document.createElement('div');
    alert.className = `gothic-alert gothic-alert-${type}`;
    alert.innerHTML = `
        <i class="bi ${icons[type]} alert-icon"></i>
        <span class="alert-message">${message}</span>
        <button class="alert-close" onclick="this.parentElement.remove()">×</button>
    `;
    
    alertsContainer.appendChild(alert);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        if (alert.parentElement) {
            alert.style.opacity = '0';
            alert.style.transform = 'translateY(-10px)';
            setTimeout(() => alert.remove(), 300);
        }
    }, 5000);
}

// Format date
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function escapeJsString(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function escapeInlineJsString(value) {
    return escapeHtml(escapeJsString(value));
}

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}
