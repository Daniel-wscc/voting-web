// --- State and Constants ---
let polls = [];
let userVotes = {}; // Key: pollId, Value: optionId
let activePollId = null;
let ws = null;
let reconnectTimer = null;

// --- DOM Selector Elements ---
const elPollsList = document.getElementById('polls-list');
const elSearchInput = document.getElementById('poll-search');
const elActiveSection = document.getElementById('active-poll-section');
const elNoPollSection = document.getElementById('no-poll-section');

const elPollTitle = document.getElementById('active-poll-title');
const elPollDesc = document.getElementById('active-poll-desc');
const elPollDate = document.getElementById('poll-date');
const elOptionsList = document.getElementById('options-list');
const elTotalVotes = document.getElementById('total-votes-count');
const elTotalOptions = document.getElementById('total-options-count');

const elAddOptionForm = document.getElementById('add-option-form');
const elNewOptionInput = document.getElementById('new-option-input');

const elCreateModal = document.getElementById('create-modal');
const elCreatePollForm = document.getElementById('create-poll-form');
const elModalOptionsList = document.getElementById('modal-options-list');

// Buttons
const elBtnCreateSidebar = document.getElementById('btn-create-poll-sidebar');
const elBtnOpenCreate = document.getElementById('btn-open-create');
const elBtnOpenCreatePlaceholder = document.getElementById('btn-open-create-placeholder');
const elBtnCloseModal = document.getElementById('btn-close-modal');
const elBtnCancelPoll = document.getElementById('btn-cancel-poll');
const elBtnAddModalOption = document.getElementById('btn-add-modal-option');

const elToastContainer = document.getElementById('toast-container');

// --- Initialization ---
function init() {
    loadLocalVotes();
    setupEventListeners();
    fetchPolls().then(() => {
        // Auto-select first poll if available and activePollId isn't set yet
        if (!activePollId && polls.length > 0) {
            activePollId = polls[0].id;
        }
        updateUI();
    });
    connectWebSocket();
}

// --- Local Storage User Votes ---
function loadLocalVotes() {
    try {
        const storedVotes = localStorage.getItem('decidely_user_votes');
        if (storedVotes) {
            userVotes = JSON.parse(storedVotes);
        }
    } catch (e) {
        console.error('讀取本機投票紀錄失敗:', e);
        userVotes = {};
    }
}

function saveLocalVotes() {
    try {
        localStorage.setItem('decidely_user_votes', JSON.stringify(userVotes));
    } catch (e) {
        console.error('寫入本機投票紀錄失敗:', e);
    }
}

// --- Fetch Polls from API ---
async function fetchPolls() {
    try {
        const response = await fetch('/api/polls');
        if (!response.ok) throw new Error('API 回應錯誤');
        polls = await response.json();
    } catch (e) {
        console.error('無法從伺服器取得投票列表:', e);
        showToast('與伺服器連線失敗，請檢查網路。', 'warning');
    }
}

// --- WebSocket Sync ---
function connectWebSocket() {
    if (ws) {
        ws.close();
    }

    // Determine WS protocol (ws or wss) based on page protocol
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}`;
    
    console.log('正在建立 WebSocket 即時同步連線...', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket 即時同步連線成功！');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'POLLS_UPDATED') {
                console.log('接收到伺服器即時廣播，正在更新投票資料...');
                polls = data.polls;
                
                // If the active poll was deleted (not supported yet, but safe-check)
                if (activePollId && !polls.some(p => p.id === activePollId)) {
                    activePollId = polls.length > 0 ? polls[0].id : null;
                }
                
                updateUI();
            }
        } catch (e) {
            console.error('解析 WebSocket 訊息失敗:', e);
        }
    };

    ws.onclose = () => {
        console.warn('WebSocket 連線中斷，將於 3 秒後嘗試重新連線...');
        ws = null;
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(connectWebSocket, 3000);
        }
    };

    ws.onerror = (err) => {
        console.error('WebSocket 錯誤:', err);
    };
}

// --- UI Rendering ---
function updateUI() {
    renderPollsList(elSearchInput.value.trim());
    renderActivePoll();
}

// Render Poll list in Sidebar
function renderPollsList(filterText = '') {
    elPollsList.innerHTML = '';
    
    const filteredPolls = polls.filter(poll => 
        poll.title.toLowerCase().includes(filterText.toLowerCase()) ||
        (poll.description && poll.description.toLowerCase().includes(filterText.toLowerCase()))
    );

    if (filteredPolls.length === 0) {
        elPollsList.innerHTML = `<div class="text-muted text-center py-8">找不到相符的投票項目</div>`;
        return;
    }

    filteredPolls.forEach(poll => {
        const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);
        const isActive = poll.id === activePollId;
        
        const pollBtn = document.createElement('button');
        pollBtn.className = `poll-item ${isActive ? 'active' : ''}`;
        pollBtn.dataset.id = poll.id;
        
        pollBtn.innerHTML = `
            <span class="poll-item-title">${escapeHTML(poll.title)}</span>
            <div class="poll-item-info">
                <span>${poll.options.length} 個選項</span>
                <span>${totalVotes} 票</span>
            </div>
        `;
        
        pollBtn.addEventListener('click', () => {
            selectPoll(poll.id);
        });
        
        elPollsList.appendChild(pollBtn);
    });
}

// Render active poll contents
function renderActivePoll() {
    const activePoll = polls.find(p => p.id === activePollId);
    
    if (!activePoll) {
        showPlaceholderView();
        return;
    }
    
    showActivePollView();
    
    // Set Header details
    elPollTitle.textContent = activePoll.title;
    elPollDesc.textContent = activePoll.description || '此投票沒有提供描述。';
    
    const createdDate = new Date(activePoll.createdAt);
    elPollDate.textContent = `建立於: ${createdDate.getFullYear()}-${String(createdDate.getMonth() + 1).padStart(2, '0')}-${String(createdDate.getDate()).padStart(2, '0')}`;
    
    // Compute votes metrics
    const totalVotes = activePoll.options.reduce((sum, opt) => sum + opt.votes, 0);
    elTotalVotes.textContent = totalVotes.toLocaleString();
    elTotalOptions.textContent = activePoll.options.length.toString();
    
    // Render options list
    elOptionsList.innerHTML = '';
    
    const selectedOptionId = userVotes[activePoll.id];
    
    activePoll.options.forEach(option => {
        const pct = totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0;
        const isVoted = selectedOptionId === option.id;
        
        const optCard = document.createElement('div');
        optCard.className = `option-card ${isVoted ? 'voted' : ''}`;
        optCard.dataset.id = option.id;
        
        optCard.innerHTML = `
            <div class="option-progress-bar" style="width: 0%;"></div>
            <div class="option-content">
                <div class="vote-checkbox">
                    <i data-lucide="check"></i>
                </div>
                <span class="option-text">${escapeHTML(option.text)}</span>
            </div>
            <div class="option-stats">
                <span class="option-percentage">${pct.toFixed(0)}%</span>
                <span class="option-votes">${option.votes} 票</span>
            </div>
        `;
        
        optCard.addEventListener('click', () => {
            handleVote(activePoll.id, option.id);
        });
        
        elOptionsList.appendChild(optCard);
        
        // Trigger width transition in next animation frame for visual grow effect
        requestAnimationFrame(() => {
            const bar = optCard.querySelector('.option-progress-bar');
            if (bar) bar.style.width = `${pct}%`;
        });
    });
    
    // Reinitialize newly added Lucide icons
    lucide.createIcons();
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    // Search input
    elSearchInput.addEventListener('input', (e) => {
        renderPollsList(e.target.value.trim());
    });

    // Sidebar & Placeholder button to open Create Poll Modal
    [elBtnCreateSidebar, elBtnOpenCreate, elBtnOpenCreatePlaceholder].forEach(btn => {
        if (btn) btn.addEventListener('click', openCreateModal);
    });

    // Close Modal
    [elBtnCloseModal, elBtnCancelPoll].forEach(btn => {
        if (btn) btn.addEventListener('click', closeCreateModal);
    });
    
    // Add extra option row in modal
    elBtnAddModalOption.addEventListener('click', addModalOptionField);

    // Form submission: Create Poll
    elCreatePollForm.addEventListener('submit', handleCreatePoll);

    // Form submission: Add Option to Active Poll
    elAddOptionForm.addEventListener('submit', handleAddOption);
    
    // Close modal on background click
    elCreateModal.addEventListener('click', (e) => {
        if (e.target === elCreateModal) {
            closeCreateModal();
        }
    });
}

// --- Action Handlers ---

// Handle Poll Select
function selectPoll(pollId) {
    activePollId = pollId;
    renderPollsList(elSearchInput.value.trim()); // update active styling in sidebar
    renderActivePoll();
}

// Handle voting on an option via APIs
async function handleVote(pollId, optionId) {
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return;
    
    const previousVoteOptionId = userVotes[pollId];
    
    try {
        if (previousVoteOptionId === optionId) {
            // Retract vote
            const response = await fetch(`/api/polls/${pollId}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ optionId, increment: -1 })
            });
            if (!response.ok) throw new Error('API 錯誤');
            
            delete userVotes[pollId];
            showToast('已取消投票');
        } else {
            // If already voted for another option, retract first
            if (previousVoteOptionId) {
                await fetch(`/api/polls/${pollId}/vote`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ optionId: previousVoteOptionId, increment: -1 })
                });
            }
            
            // Cast new vote
            const response = await fetch(`/api/polls/${pollId}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ optionId, increment: 1 })
            });
            if (!response.ok) throw new Error('API 錯誤');
            
            userVotes[pollId] = optionId;
            showToast('投票成功！');
        }
        
        saveLocalVotes();
        // UI will be updated via WebSocket broadcast, which happens instantly.
    } catch (e) {
        console.error('投票交易失敗:', e);
        showToast('投票處理失敗，請稍後再試。', 'warning');
    }
}

// Handle adding custom option to active poll
async function handleAddOption(e) {
    e.preventDefault();
    
    const text = elNewOptionInput.value.trim();
    if (!text) return;
    
    const activePoll = polls.find(p => p.id === activePollId);
    if (!activePoll) return;
    
    // Check for duplicate option locally first
    const duplicate = activePoll.options.some(opt => opt.text.toLowerCase() === text.toLowerCase());
    if (duplicate) {
        showToast('此選項已存在！', 'warning');
        return;
    }
    
    try {
        const response = await fetch(`/api/polls/${activePollId}/options`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        
        if (!response.ok) throw new Error('API 錯誤');
        
        // Reset Form
        elNewOptionInput.value = '';
        showToast('已成功新增選項！', 'success');
        // UI will update automatically via WebSocket
    } catch (e) {
        console.error('新增選項失敗:', e);
        showToast('新增選項失敗，請稍後再試。', 'warning');
    }
}

// Handle new poll form submission
async function handleCreatePoll(e) {
    e.preventDefault();
    
    const title = document.getElementById('poll-title-input').value.trim();
    const desc = document.getElementById('poll-desc-input').value.trim();
    
    // Extract option inputs
    const optionInputs = elModalOptionsList.querySelectorAll('.modal-option-input');
    const options = [];
    
    optionInputs.forEach(input => {
        const txt = input.value.trim();
        if (txt) {
            options.push(txt);
        }
    });
    
    // Validations
    if (!title) {
        showToast('請輸入投票問題！', 'warning');
        return;
    }
    if (options.length < 2) {
        showToast('請輸入至少兩個投票選項！', 'warning');
        return;
    }
    
    try {
        const response = await fetch('/api/polls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title,
                description: desc,
                options
            })
        });
        
        if (!response.ok) throw new Error('API 錯誤');
        
        const createdPoll = await response.json();
        
        // Focus the newly created poll
        activePollId = createdPoll.id;
        
        closeCreateModal();
        elSearchInput.value = '';
        showToast('新投票主題已發佈！', 'success');
        // UI will update automatically via WebSocket
    } catch (e) {
        console.error('建立投票主題失敗:', e);
        showToast('發佈投票失敗，請稍後再試。', 'warning');
    }
}

// --- Modal Helper Functions ---
function openCreateModal() {
    elCreateModal.classList.remove('hidden');
    document.getElementById('poll-title-input').focus();
    
    // Reset input fields
    document.getElementById('poll-title-input').value = '';
    document.getElementById('poll-desc-input').value = '';
    
    // Reset option fields back to just 2 blank fields
    elModalOptionsList.innerHTML = `
        <div class="modal-option-row">
            <input type="text" class="modal-option-input" placeholder="選項 1" required maxlength="80">
            <span class="drag-placeholder"></span>
        </div>
        <div class="modal-option-row">
            <input type="text" class="modal-option-input" placeholder="選項 2" required maxlength="80">
            <span class="drag-placeholder"></span>
        </div>
    `;
}

function closeCreateModal() {
    elCreateModal.classList.add('hidden');
}

function addModalOptionField() {
    const currentRows = elModalOptionsList.querySelectorAll('.modal-option-row');
    const index = currentRows.length + 1;
    
    const row = document.createElement('div');
    row.className = 'modal-option-row animate-scale-up';
    
    row.innerHTML = `
        <input type="text" class="modal-option-input" placeholder="選項 ${index}" required maxlength="80">
        <button type="button" class="btn-remove-option" title="刪除選項">
            <i data-lucide="trash-2"></i>
        </button>
    `;
    
    // Wire up delete button handler
    const btnRemove = row.querySelector('.btn-remove-option');
    btnRemove.addEventListener('click', () => {
        row.remove();
        updateModalOptionLabels();
    });
    
    elModalOptionsList.appendChild(row);
    lucide.createIcons();
    row.querySelector('.modal-option-input').focus();
}

function updateModalOptionLabels() {
    const inputs = elModalOptionsList.querySelectorAll('.modal-option-input');
    inputs.forEach((input, index) => {
        input.placeholder = `選項 ${index + 1}`;
    });
}

// --- Toggle layouts ---
function showActivePollView() {
    elActiveSection.classList.remove('hidden');
    elNoPollSection.classList.add('hidden');
}

function showPlaceholderView() {
    elActiveSection.classList.add('hidden');
    elNoPollSection.classList.remove('hidden');
}

// --- Toast Notifications ---
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconName = 'info';
    if (type === 'success') iconName = 'check-circle';
    if (type === 'warning') iconName = 'alert-triangle';
    
    toast.innerHTML = `
        <i data-lucide="${iconName}"></i>
        <span>${message}</span>
    `;
    
    elToastContainer.appendChild(toast);
    lucide.createIcons();
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'opacity 0.3s, transform 0.3s';
        
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3000);
}

// --- Safety Helpers ---
function escapeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- Run App ---
document.addEventListener('DOMContentLoaded', init);
