/**
 * Beget Mail Generator - Client-side JavaScript
 * Gothic Theme Edition
 */

// Global state
let mailboxes = [];
let domains = [];
let selectedMailboxes = new Set();
let passwordMailbox = null;
let currentRole = null;
let inactiveMailboxes = [];
let inactiveSelection = new Set();
let appInitialized = false;

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
const authGate = document.getElementById('authGate');
const appShell = document.getElementById('appShell');
const authForm = document.getElementById('authForm');
const authGateMessage = document.getElementById('authGateMessage');
const adminTab = document.getElementById('adminTab');
let authExpiredHandled = false;

// A protected request can outlive the page that initiated it. Keep the shell
// from displaying a misleading API error when the invite session has expired.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (response.status === 401 && requestUrl.startsWith('/api/') && !requestUrl.startsWith('/api/auth/')) {
        handleAuthExpired();
    }
    return response;
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    setupAuthListeners();
    await checkAuth();
});

function setupAuthListeners() {
    authForm.addEventListener('submit', async event => {
        event.preventDefault();
        const button = authForm.querySelector('button');
        button.disabled = true;
        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: document.getElementById('inviteCodeInput').value })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Не удалось войти');
            document.getElementById('inviteCodeInput').value = '';
            authExpiredHandled = false;
            openGenerator(data.role);
        } catch (error) {
            authGateMessage.textContent = error.message;
            authGateMessage.classList.add('auth-error');
        } finally {
            button.disabled = false;
        }
    });
    document.getElementById('logoutBtn').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        appShell.classList.add('d-none');
        authGate.classList.remove('d-none');
        currentRole = null;
        authExpiredHandled = false;
    });
}

function handleAuthExpired() {
    if (authExpiredHandled) return;
    authExpiredHandled = true;
    currentRole = null;
    appShell.classList.add('d-none');
    authGate.classList.remove('d-none');
    authGateMessage.textContent = 'Сессия истекла. Введите код приглашения ещё раз.';
    authGateMessage.classList.add('auth-error');
    document.getElementById('inviteCodeInput').focus();
}

async function checkAuth() {
    try {
        const response = await fetch('/api/auth/status');
        const data = await response.json();
        if (data.authenticated) openGenerator(data.role);
    } catch {
        authGateMessage.textContent = 'Сервис авторизации недоступен';
        authGateMessage.classList.add('auth-error');
    }
}

function openGenerator(role) {
    currentRole = role;
    authGate.classList.add('d-none');
    appShell.classList.remove('d-none');
    adminTab.classList.toggle('d-none', role !== 'admin');
    document.getElementById('adminPanel').classList.toggle('d-none', role !== 'admin');
    checkConnection();
    loadDomains();
    loadLocalMailboxes();
    loadDomainHealth();
    setupEventListeners();
    if (role === 'admin') {
        loadInactiveMailboxes();
        loadInvitations();
    }
    setPanel('generatorPanel');
}

// Setup event listeners
function setupEventListeners() {
    if (appInitialized) return;
    appInitialized = true;
    document.querySelectorAll('.panel-tab').forEach(tab => {
        tab.addEventListener('click', () => setPanel(tab.dataset.panel));
    });
    // Generate form
    generateForm.addEventListener('submit', handleGenerate);
    
    // Refresh domains
    document.getElementById('refreshDomainsBtn').addEventListener('click', loadDomains);
    document.getElementById('refreshHealthBtn').addEventListener('click', () => loadDomainHealth(true));
    document.getElementById('addDomainForm').addEventListener('submit', addDomain);
    document.getElementById('passwordForm').addEventListener('submit', changePassword);
    document.getElementById('cancelPasswordBtn').addEventListener('click', hidePasswordModal);
    document.getElementById('copyPasswordResultBtn').addEventListener('click', () => {
        copyToClipboard(document.getElementById('passwordResultText').textContent);
        showAlert('Данные скопированы', 'success');
    });
    document.getElementById('passwordModal').querySelector('.modal-overlay')
        .addEventListener('click', hidePasswordModal);
    mailboxesTable.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const mailbox = mailboxes.find(item => item.id === Number(button.dataset.id));
        if (!mailbox) return;
        if (button.dataset.action === 'copy') copyMailbox(mailbox.email, mailbox.password);
        if (button.dataset.action === 'password') openPasswordModal(mailbox);
        if (button.dataset.action === 'delete') deleteSingle(mailbox.domain, mailbox.mailbox_name);
        if (button.dataset.action === 'reveal') {
            const value = button.closest('tr').querySelector('.password-value');
            const isHidden = value.dataset.hidden === 'true';
            value.textContent = isHidden ? mailbox.password : '••••••••';
            value.dataset.hidden = String(!isHidden);
            button.setAttribute('aria-label', isHidden ? 'Скрыть пароль' : 'Показать пароль');
            button.title = button.getAttribute('aria-label');
            button.querySelector('i').className = isHidden ? 'bi bi-eye-slash' : 'bi bi-eye';
        }
    });
    
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

    document.getElementById('refreshInactiveBtn').addEventListener('click', loadInactiveMailboxes);
    document.getElementById('inactiveDaysInput').addEventListener('change', loadInactiveMailboxes);
    document.getElementById('checkInactiveAll').addEventListener('change', toggleInactiveSelection);
    document.getElementById('deleteInactiveBtn').addEventListener('click', deleteInactiveMailboxes);
    document.getElementById('createInviteBtn').addEventListener('click', createInvitation);
    
    // Copy last results
    document.getElementById('copyLastResultsBtn').addEventListener('click', () => {
        copyToClipboard(lastResultsText.value);
        showAlert('Скопировано в буфер обмена!', 'success');
    });
}

function setPanel(panelId) {
    if (panelId === 'adminPanel' && currentRole !== 'admin') panelId = 'generatorPanel';
    document.querySelectorAll('.panel-view').forEach(panel => {
        panel.classList.toggle('d-none', panel.id !== panelId);
    });
    document.querySelectorAll('.panel-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.panel === panelId);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
        const selectedDomain = domainSelect.value;
        domainSelect.innerHTML = '<option value="">Загрузка...</option>';
        domainSelect.disabled = true;
        
        const response = await fetch('/api/domains');
        const data = await response.json();
        
        if (data.success && data.domains) {
            domains = data.domains;

            domainSelect.innerHTML = '<option value="">Выберите домен...</option>';
            domains.forEach(domain => {
                domainSelect.add(new Option(domain.fqdn, domain.fqdn));
            });
            if (domains.some(domain => domain.fqdn === selectedDomain)) domainSelect.value = selectedDomain;
            document.getElementById('domainCount').textContent = domains.length;
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

async function loadDomainHealth(force = false) {
    const container = document.getElementById('domainHealthList');
    container.innerHTML = '<p class="form-hint">Проверяем DNS, срок регистрации и ящики...</p>';
    try {
        const response = await fetch(`/api/domain-health${force ? '?refresh=1' : ''}`);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Не удалось проверить домены');
        renderDomainHealth(data.domains || []);
    } catch (error) {
        container.innerHTML = `<p class="health-error">${escapeHtml(error.message)}</p>`;
    }
}

function renderDomainHealth(items) {
    const container = document.getElementById('domainHealthList');
    if (!items.length) {
        container.innerHTML = '<p class="form-hint">В аккаунте Beget пока нет подключённых доменов.</p>';
        return;
    }
    container.innerHTML = items.map(item => {
        const expiryLabel = item.expiryState === 'expired'
            ? 'домен истёк'
            : item.expiryState === 'warning'
                ? `осталось ${item.daysRemaining} дн.`
                : item.daysRemaining === null
                    ? 'срок не определён'
                    : `осталось ${item.daysRemaining} дн.`;
        const expiryClass = item.expiryState === 'expired' ? 'health-expired' : item.expiryState === 'warning' ? 'health-warning' : '';
        const mxLabel = item.mxRecords?.length
            ? item.mxRecords.map(record => `${record.priority} ${record.exchange}`).join(', ')
            : 'MX не найден';
        const nsLabel = item.nameservers?.length ? item.nameservers.join(', ') : 'NS не найден';
        const mailLabel = item.remoteError ? 'Beget: ошибка проверки' : `Beget: ${item.mailboxCount} ящ.`;
        const expiryDate = item.expiresAt ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(item.expiresAt)) : 'не получена через RDAP';
        const registeredDate = item.registeredAt ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(item.registeredAt)) : '—';
        return `
            <article class="domain-health-row">
                <div class="health-heading"><strong>${escapeHtml(item.fqdn)}</strong><span class="health-pill ${expiryClass}">${escapeHtml(expiryLabel)}</span></div>
                <div class="health-meta"><span><i class="bi bi-diagram-3"></i>${escapeHtml(item.dnsProvider)}</span><span><i class="bi bi-inboxes"></i>${escapeHtml(mailLabel)}</span></div>
                <div class="health-detail"><span>Регистрация</span><code>${escapeHtml(registeredDate)}</code></div>
                <div class="health-detail"><span>Оплата до</span><code>${escapeHtml(expiryDate)}</code></div>
                <div class="health-detail"><span>NS</span><code>${escapeHtml(nsLabel)}</code></div>
                <div class="health-detail"><span>MX</span><code>${escapeHtml(mxLabel)}</code></div>
                ${item.cloudflare ? '<p class="health-note"><i class="bi bi-info-circle"></i> Cloudflare остаётся DNS-провайдером. Делегирование NS в Beget не требуется: добавьте MX/TXT в этой зоне.</p>' : ''}
                ${item.expiryState === 'warning' || item.expiryState === 'expired' ? '<p class="health-note health-warning"><i class="bi bi-exclamation-triangle"></i> Срок домена подходит к концу. Перенесите нужные данные ящиков заранее.</p>' : ''}
            </article>`;
    }).join('');
}

async function loadInactiveMailboxes() {
    const daysInput = document.getElementById('inactiveDaysInput');
    const days = Math.min(3650, Math.max(1, Number(daysInput.value) || 30));
    daysInput.value = days;
    const body = document.getElementById('inactiveTable');
    body.innerHTML = '<tr><td colspan="4" class="empty-state"><i class="bi bi-hourglass empty-icon"></i><p>Загрузка...</p></td></tr>';
    try {
        const response = await fetch(`/api/admin/inactive-mailboxes?days=${days}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить список');
        inactiveMailboxes = data.mailboxes || [];
        inactiveSelection = new Set();
        document.getElementById('checkInactiveAll').checked = false;
        renderInactiveMailboxes(days);
    } catch (error) {
        body.innerHTML = `<tr><td colspan="4" class="empty-state"><p class="health-error">${escapeHtml(error.message)}</p></td></tr>`;
    }
}

function renderInactiveMailboxes(days) {
    const body = document.getElementById('inactiveTable');
    const summary = document.getElementById('maintenanceSummary');
    summary.textContent = inactiveMailboxes.length
        ? `${inactiveMailboxes.length} ящиков не использовались ${days}+ дней`
        : `Нет ящиков без активности ${days}+ дней`;
    if (!inactiveMailboxes.length) {
        body.innerHTML = '<tr><td colspan="4" class="empty-state"><i class="bi bi-check2-circle empty-icon"></i><p>Список чист</p></td></tr>';
        document.getElementById('deleteInactiveBtn').disabled = true;
        return;
    }
    body.innerHTML = inactiveMailboxes.map(mailbox => `
        <tr data-id="${mailbox.id}">
            <td><input type="checkbox" class="gothic-checkbox inactive-check" data-id="${mailbox.id}" ${inactiveSelection.has(mailbox.id) ? 'checked' : ''}></td>
            <td class="email-cell">${escapeHtml(mailbox.email)}</td>
            <td class="date-cell">${escapeHtml(formatDate(mailbox.last_activity_at))}</td>
            <td class="date-cell">${escapeHtml(String(mailbox.days_inactive))} дн.</td>
        </tr>`).join('');
    body.querySelectorAll('.inactive-check').forEach(input => input.addEventListener('change', event => {
        const id = Number(event.target.dataset.id);
        if (event.target.checked) inactiveSelection.add(id);
        else inactiveSelection.delete(id);
        updateInactiveActions();
    }));
    updateInactiveActions();
}

function toggleInactiveSelection() {
    const checked = document.getElementById('checkInactiveAll').checked;
    inactiveSelection = checked ? new Set(inactiveMailboxes.map(item => item.id)) : new Set();
    document.querySelectorAll('.inactive-check').forEach(input => { input.checked = checked; });
    updateInactiveActions();
}

function updateInactiveActions() {
    document.getElementById('deleteInactiveBtn').disabled = inactiveSelection.size === 0;
}

async function deleteInactiveMailboxes() {
    const selected = inactiveMailboxes.filter(item => inactiveSelection.has(item.id));
    if (!selected.length || !confirm(`Удалить ${selected.length} неактивных ящиков с Beget?`)) return;
    const button = document.getElementById('deleteInactiveBtn');
    button.disabled = true;
    try {
        const response = await fetch('/api/admin/inactive-mailboxes/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailboxes: selected.map(item => ({ domain: item.domain, mailbox: item.mailbox_name })) })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось удалить ящики');
        showAlert(`Удалено: ${data.total}. Ошибок: ${data.failed}.`, data.failed ? 'error' : 'success');
        await Promise.all([loadInactiveMailboxes(), loadLocalMailboxes(), loadDomainHealth()]);
    } catch (error) {
        showAlert(error.message, 'error');
        updateInactiveActions();
    }
}

async function loadInvitations() {
    const container = document.getElementById('inviteList');
    try {
        const response = await fetch('/api/admin/invitations');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить приглашения');
        container.innerHTML = (data.invitations || []).map(item => `
            <div class="invite-row ${item.revoked_at ? 'is-revoked' : ''}">
                <span><strong>${escapeHtml(item.label || (item.role === 'admin' ? 'Администратор' : 'Пользователь'))}</strong><small>${item.revoked_at ? 'отозвано' : item.last_used_at ? `использовано ${escapeHtml(formatDate(item.last_used_at))}` : 'не использовано'}</small></span>
                ${item.revoked_at ? '' : `<button class="gothic-btn-icon gothic-btn-danger revoke-invite" data-id="${item.id}" title="Отозвать" aria-label="Отозвать"><i class="bi bi-x-lg"></i></button>`}
            </div>`).join('') || '<p class="form-hint">Приглашений пока нет.</p>';
        container.querySelectorAll('.revoke-invite').forEach(button => button.addEventListener('click', () => revokeInvitation(button.dataset.id)));
    } catch (error) {
        container.innerHTML = `<p class="health-error">${escapeHtml(error.message)}</p>`;
    }
}

async function createInvitation() {
    const label = window.prompt('Метка приглашения (необязательно):', '') ?? '';
    try {
        const response = await fetch('/api/admin/invitations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'user', label })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось создать приглашение');
        await copyToClipboard(data.code);
        showAlert(`Код создан и скопирован: ${data.code}`, 'success');
        loadInvitations();
    } catch (error) {
        showAlert(error.message, 'error');
    }
}

async function revokeInvitation(id) {
    if (!confirm('Отозвать это приглашение? Уже открытые сессии останутся действительными до истечения срока.')) return;
    const response = await fetch(`/api/admin/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) return showAlert(data.error || 'Не удалось отозвать приглашение', 'error');
    loadInvitations();
    showAlert('Приглашение отозвано', 'success');
}

async function addDomain(event) {
    event.preventDefault();
    const domain = document.getElementById('newDomainInput').value.trim().toLowerCase();
    const button = document.getElementById('addDomainBtn');
    button.disabled = true;
    try {
        const response = await fetch('/api/domains', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Не удалось добавить домен');
        await loadDomains();
        domainSelect.value = domain;
        document.getElementById('newDomainInput').value = '';
        const notice = document.getElementById('domainSetupNotice');
        notice.classList.remove('d-none');
        notice.textContent = `${domain} подключён к Beget. NS-зона остаётся в Cloudflare: добавьте там MX 10 mx1.beget.com и MX 20 mx2.beget.com, затем TXT SPF по инструкции Beget.`;
        showAlert(data.alreadyExists ? 'Домен уже подключён' : 'Домен добавлен', 'success');
    } catch (error) {
        showAlert(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

function openPasswordModal(mailbox) {
    passwordMailbox = mailbox;
    document.getElementById('passwordEmail').textContent = mailbox.email;
    document.getElementById('newPasswordInput').value = '';
    document.getElementById('passwordResult').classList.add('d-none');
    document.getElementById('passwordModal').classList.add('show');
    document.body.style.overflow = 'hidden';
    document.getElementById('newPasswordInput').focus();
}

function hidePasswordModal() {
    document.getElementById('passwordModal').classList.remove('show');
    document.getElementById('newPasswordInput').value = '';
    document.getElementById('passwordResultText').textContent = '';
    passwordMailbox = null;
    document.body.style.overflow = '';
}

async function changePassword(event) {
    event.preventDefault();
    if (!passwordMailbox) return;
    const button = document.getElementById('savePasswordBtn');
    button.disabled = true;
    try {
        const response = await fetch('/api/mailbox/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                domain: passwordMailbox.domain,
                mailbox: passwordMailbox.mailbox_name,
                password: document.getElementById('newPasswordInput').value
            })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Не удалось сменить пароль');
        document.getElementById('passwordResultText').textContent = `${data.email}:${data.password}`;
        document.getElementById('passwordResult').classList.remove('d-none');
        document.getElementById('newPasswordInput').value = '';
        await loadLocalMailboxes();
        showAlert('Пароль изменён', 'success');
    } catch (error) {
        showAlert(error.message, 'error');
    } finally {
        button.disabled = false;
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
    
    if (!Number.isInteger(count) || count < 1 || count > 50) {
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
        generateBtn.innerHTML = '<i class="bi bi-stars" aria-hidden="true"></i> Генерировать';
        
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
                    <i class="bi bi-inbox empty-icon" aria-hidden="true"></i>
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
                ? `<span class="password-value" data-hidden="true">••••••••</span><button class="gothic-btn-icon reveal-btn" data-action="reveal" data-id="${mailbox.id}" title="Показать пароль" aria-label="Показать пароль"><i class="bi bi-eye"></i></button>`
                : '<span title="Beget не возвращает пароли существующих ящиков">не сохранён</span>'}</td>
            <td class="date-cell">${formatDate(mailbox.created_at)}</td>
            <td class="actions-cell">
                <button class="gothic-btn-icon" data-action="copy" data-id="${mailbox.id}" title="${mailbox.password ? 'Копировать email и пароль' : 'Копировать email'}" aria-label="Копировать данные ящика">
                    <i class="bi bi-clipboard"></i>
                </button>
                <button class="gothic-btn-icon" data-action="password" data-id="${mailbox.id}" title="Сменить пароль" aria-label="Сменить пароль"><i class="bi bi-key"></i></button>
                <button class="gothic-btn-icon gothic-btn-danger" data-action="delete" data-id="${mailbox.id}" title="Удалить" aria-label="Удалить ящик">
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
        return navigator.clipboard.writeText(text);
    } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        return Promise.resolve();
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
    const icon = document.createElement('i');
    icon.className = `bi ${icons[type]} alert-icon`;
    const text = document.createElement('span');
    text.className = 'alert-message';
    text.textContent = message;
    const close = document.createElement('button');
    close.className = 'alert-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть уведомление');
    close.textContent = '×';
    close.addEventListener('click', () => alert.remove());
    alert.append(icon, text, close);
    
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
