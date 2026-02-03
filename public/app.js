/**
 * Beget Mail Generator - Client-side JavaScript
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
const deleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
const deleteCount = document.getElementById('deleteCount');

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
        deleteCount.textContent = selectedMailboxes.size;
        deleteModal.show();
    });
    
    document.getElementById('confirmDeleteBtn').addEventListener('click', deleteSelected);
    
    // Copy selected
    copySelectedBtn.addEventListener('click', copySelected);
    
    // Copy last results
    document.getElementById('copyLastResultsBtn').addEventListener('click', () => {
        copyToClipboard(lastResultsText.value);
        showAlert('Скопировано в буфер обмена!', 'success');
    });
}

// Check API connection
async function checkConnection() {
    try {
        const response = await fetch('/api/check-connection');
        const data = await response.json();
        
        if (data.success) {
            connectionStatus.className = 'badge bg-success me-3';
            connectionStatus.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i>Подключено';
        } else {
            connectionStatus.className = 'badge bg-danger me-3';
            connectionStatus.innerHTML = '<i class="bi bi-x-circle-fill me-1"></i>Ошибка API';
        }
    } catch (error) {
        connectionStatus.className = 'badge bg-danger me-3';
        connectionStatus.innerHTML = '<i class="bi bi-x-circle-fill me-1"></i>Нет связи';
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
            showAlert(data.error || 'Не удалось загрузить домены', 'danger');
        }
    } catch (error) {
        domainSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        showAlert('Ошибка подключения к серверу', 'danger');
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
            renderMailboxes();
            updateStats();
        }
    } catch (error) {
        showAlert('Ошибка загрузки локальных данных', 'danger');
    }
}

// Load mailboxes from Beget
async function loadBegetMailboxes() {
    const domain = domainSelect.value;
    if (!domain) {
        showAlert('Выберите домен для загрузки', 'warning');
        return;
    }
    
    try {
        const response = await fetch(`/api/mailboxes/${domain}`);
        const data = await response.json();
        
        if (data.success) {
            showAlert(`На Beget найдено ${data.mailboxes.length} ящиков для ${domain}`, 'info');
        } else {
            showAlert(data.error || 'Ошибка загрузки', 'danger');
        }
    } catch (error) {
        showAlert('Ошибка подключения', 'danger');
    }
}

// Handle generate form submit
async function handleGenerate(e) {
    e.preventDefault();
    
    const domain = domainSelect.value;
    const count = parseInt(countInput.value);
    
    if (!domain) {
        showAlert('Пожалуйста, выберите домен', 'warning');
        return;
    }
    
    if (count < 1 || count > 50) {
        showAlert('Количество должно быть от 1 до 50', 'warning');
        return;
    }
    
    // Show progress
    generateBtn.disabled = true;
    generateBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Генерация...';
    progressContainer.classList.remove('d-none');
    progressBar.style.width = '0%';
    progressBar.textContent = '0%';
    progressText.textContent = `Создание ${count} почтовых ящиков...`;
    
    // Simulate progress (actual API is sequential)
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress > 95) progress = 95;
        progressBar.style.width = `${progress}%`;
        progressBar.textContent = `${Math.round(progress)}%`;
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
        progressBar.textContent = '100%';
        
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
                showAlert(`Ошибок: ${data.failed}. Проверьте консоль для деталей.`, 'warning');
            }
            
            // Reload mailboxes
            await loadLocalMailboxes();
        } else {
            showAlert(data.error || 'Ошибка генерации', 'danger');
        }
    } catch (error) {
        clearInterval(progressInterval);
        showAlert('Ошибка подключения к серверу', 'danger');
    } finally {
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<i class="bi bi-magic me-2"></i>Генерировать';
        
        setTimeout(() => {
            progressContainer.classList.add('d-none');
        }, 2000);
    }
}

// Render mailboxes table
function renderMailboxes() {
    const filter = filterDomain.value;
    const search = searchInput.value.toLowerCase();
    
    let filtered = mailboxes;
    
    if (filter) {
        filtered = filtered.filter(m => m.domain === filter);
    }
    
    if (search) {
        filtered = filtered.filter(m => m.email.toLowerCase().includes(search));
    }
    
    totalCount.textContent = mailboxes.length;
    shownCount.textContent = filtered.length;
    
    if (filtered.length === 0) {
        mailboxesTable.innerHTML = `
            <tr>
                <td colspan="5" class="text-center text-muted py-4">
                    <i class="bi bi-inbox fs-1 d-block mb-2"></i>
                    ${mailboxes.length === 0 ? 'Нет созданных почтовых ящиков' : 'Ничего не найдено'}
                </td>
            </tr>
        `;
        return;
    }
    
    mailboxesTable.innerHTML = filtered.map(mailbox => `
        <tr class="fade-in ${selectedMailboxes.has(mailbox.id) ? 'selected' : ''}" data-id="${mailbox.id}">
            <td>
                <input type="checkbox" class="form-check-input mailbox-check" 
                       data-id="${mailbox.id}" ${selectedMailboxes.has(mailbox.id) ? 'checked' : ''}>
            </td>
            <td>
                <span class="fw-medium">${mailbox.email}</span>
            </td>
            <td>
                <span class="password-cell">${mailbox.password}</span>
            </td>
            <td>
                <small class="text-muted">${formatDate(mailbox.created_at)}</small>
            </td>
            <td>
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-primary copy-btn" 
                            onclick="copyMailbox('${mailbox.email}', '${mailbox.password}')" title="Копировать">
                        <i class="bi bi-clipboard"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger" 
                            onclick="deleteSingle('${mailbox.domain}', '${mailbox.mailbox_name}')" title="Удалить">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
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
    
    if (hasSelection) {
        deleteSelectedBtn.innerHTML = `<i class="bi bi-trash me-1"></i>Удалить (${selectedMailboxes.size})`;
        copySelectedBtn.innerHTML = `<i class="bi bi-clipboard me-1"></i>Копировать (${selectedMailboxes.size})`;
    } else {
        deleteSelectedBtn.innerHTML = '<i class="bi bi-trash me-1"></i>Удалить выбранные';
        copySelectedBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Копировать';
    }
}

// Delete selected mailboxes
async function deleteSelected() {
    deleteModal.hide();
    
    const toDelete = mailboxes
        .filter(m => selectedMailboxes.has(m.id))
        .map(m => ({ domain: m.domain, mailbox: m.mailbox_name }));
    
    if (toDelete.length === 0) return;
    
    deleteSelectedBtn.disabled = true;
    deleteSelectedBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Удаление...';
    
    try {
        const response = await fetch('/api/mailboxes/delete-multiple', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailboxes: toDelete })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showAlert(`Удалено ${data.total} ящиков`, 'success');
            selectedMailboxes.clear();
            checkAll.checked = false;
            await loadLocalMailboxes();
        } else {
            showAlert(data.error || 'Ошибка удаления', 'danger');
        }
    } catch (error) {
        showAlert('Ошибка подключения', 'danger');
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
            showAlert(data.error || 'Ошибка удаления', 'danger');
        }
    } catch (error) {
        showAlert('Ошибка подключения', 'danger');
    }
}

// Copy selected to clipboard
function copySelected() {
    const selected = mailboxes.filter(m => selectedMailboxes.has(m.id));
    const text = selected.map(m => `${m.email}:${m.password}`).join('\n');
    copyToClipboard(text);
    showAlert(`Скопировано ${selected.length} записей`, 'success');
}

// Copy single mailbox
function copyMailbox(email, password) {
    copyToClipboard(`${email}:${password}`);
    showAlert('Скопировано!', 'success');
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
            showAlert('Нет данных для экспорта', 'warning');
        }
    } catch (error) {
        showAlert('Ошибка экспорта', 'danger');
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

// Show alert
function showAlert(message, type = 'info') {
    const alert = document.createElement('div');
    alert.className = `alert alert-${type} alert-dismissible fade show fade-in`;
    alert.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    alertsContainer.appendChild(alert);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        alert.classList.remove('show');
        setTimeout(() => alert.remove(), 150);
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
