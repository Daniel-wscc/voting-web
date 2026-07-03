// --- State and Constants ---
let polls = [];
let userVotes = {}; // Key: pollId, Value: optionId
let activePollId = null;
let ws = null;
let reconnectTimer = null;
let isManagingActivePoll = false;
let verifiedPollPassword = '';

// Voter Identification
let voterId = null;
let voterName = '匿名';
let voterAvatar = null; // Base64 image string

const inFlightVotes = new Set(); // Track polls with active in-flight voting API requests to prevent self-healing race conditions

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

// Nickname widget input
const elUsernameInput = document.getElementById('username-input');

// Buttons
const elBtnCreateSidebar = document.getElementById('btn-create-poll-sidebar');
const elBtnOpenCreate = document.getElementById('btn-open-create');
const elBtnOpenCreatePlaceholder = document.getElementById('btn-open-create-placeholder');
const elBtnCloseModal = document.getElementById('btn-close-modal');
const elBtnCancelPoll = document.getElementById('btn-cancel-poll');
const elBtnAddModalOption = document.getElementById('btn-add-modal-option');

const elToastContainer = document.getElementById('toast-container');

// Manage modal and buttons selectors
const elBtnManagePoll = document.getElementById('btn-manage-poll');
const elBtnDeletePoll = document.getElementById('btn-delete-poll');
const elBtnExitManagePoll = document.getElementById('btn-exit-manage-poll');
const elManageAuthModal = document.getElementById('manage-auth-modal');
const elManageAuthForm = document.getElementById('manage-auth-form');
const elManagePasswordInput = document.getElementById('manage-password-input');
const elAuthErrorMsg = document.getElementById('auth-error-msg');
const elBtnCloseAuthModal = document.getElementById('btn-close-auth-modal');
const elBtnCancelAuth = document.getElementById('btn-cancel-auth');

// Avatar selectors
const elProfileAvatarTrigger = document.getElementById('profile-avatar-trigger');
const elProfileAvatarInput = document.getElementById('profile-avatar-input');
const elProfileAvatarIcon = document.getElementById('profile-avatar-icon');
const elProfileAvatarPreview = document.getElementById('profile-avatar-preview');

// New settings selectors
const elPollAllowMultiple = document.getElementById('poll-allow-multiple');
const elPollAllowUserOptions = document.getElementById('poll-allow-user-options');
const elPollIsAnonymous = document.getElementById('poll-is-anonymous');
const elPollImageInput = document.getElementById('poll-image-input');
const elBtnTriggerUpload = document.getElementById('btn-trigger-upload');
const elUploadFileName = document.getElementById('upload-file-name');
const elBtnClearUpload = document.getElementById('btn-clear-upload');
const elImagePreviewContainer = document.getElementById('image-preview-container');
const elImagePreview = document.getElementById('image-preview');
const elPollImageContainer = document.getElementById('poll-image-container');
const elActivePollImage = document.getElementById('active-poll-image');

// --- Initialization ---
function init() {
    initVoterIdentity();
    loadLocalVotes();
    setupEventListeners();
    
    // Render static icons on page load immediately
    lucide.createIcons();
    
    fetchPolls().then(() => {
        if (!activePollId && polls.length > 0) {
            activePollId = polls[0].id;
        }
        updateUI();
    });
    connectWebSocket();
}

// --- Voter Identity Generation & Loading ---
function initVoterIdentity() {
    try {
        // 1. Get or generate Voter UUID
        let id = localStorage.getItem('decidely_voter_id');
        if (!id) {
            id = `voter_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            localStorage.setItem('decidely_voter_id', id);
        }
        voterId = id;
        
        // 2. Get or set default Voter Name
        let name = localStorage.getItem('decidely_voter_name');
        if (!name) {
            name = '匿名';
            localStorage.setItem('decidely_voter_name', name);
        }
        voterName = name;
        
        // 3. Get Voter Avatar
        let avatar = localStorage.getItem('decidely_voter_avatar');
        if (avatar) {
            voterAvatar = avatar;
            renderVoterAvatarHeader();
        }
        
        // Populate input field
        if (elUsernameInput) {
            elUsernameInput.value = voterName;
        }
    } catch (e) {
        console.error('初始化使用者識別碼時發生錯誤:', e);
        voterId = `voter_fallback_${Date.now()}`;
    }
}

function renderVoterAvatarHeader() {
    if (voterAvatar) {
        elProfileAvatarPreview.src = voterAvatar;
        elProfileAvatarPreview.classList.remove('hidden');
        elProfileAvatarIcon.classList.add('hidden');
    } else {
        elProfileAvatarPreview.src = '';
        elProfileAvatarPreview.classList.add('hidden');
        elProfileAvatarIcon.classList.remove('hidden');
    }
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
    
    // --- Self Healing of Local Votes ---
    let selectedOptionIds = userVotes[activePoll.id];
    if (inFlightVotes.has(activePoll.id)) {
        console.log('投票同步中，暫停本機狀態自我修復檢查...');
    } else if (selectedOptionIds) {
        if (activePoll.allowMultiple) {
            // For multiple choice, check each voted option
            if (!Array.isArray(selectedOptionIds)) {
                selectedOptionIds = [selectedOptionIds];
                userVotes[activePoll.id] = selectedOptionIds;
            }
            
            const validVotedIds = [];
            selectedOptionIds.forEach(optId => {
                const opt = activePoll.options.find(o => o.id === optId);
                const userVotedInDb = opt && opt.voters.some(v => v.voterId === voterId);
                if (userVotedInDb) {
                    validVotedIds.push(optId);
                }
            });
            
            if (validVotedIds.length !== selectedOptionIds.length) {
                console.log('部分選票已被剔除，更新本機顯示狀態...');
                if (validVotedIds.length > 0) {
                    userVotes[activePoll.id] = validVotedIds;
                } else {
                    delete userVotes[activePoll.id];
                }
                saveLocalVotes();
                selectedOptionIds = userVotes[activePoll.id];
            }
        } else {
            // Single choice self-healing
            if (Array.isArray(selectedOptionIds)) {
                selectedOptionIds = selectedOptionIds[0] || null;
                userVotes[activePoll.id] = selectedOptionIds;
            }
            if (selectedOptionIds) {
                const activeOption = activePoll.options.find(opt => opt.id === selectedOptionIds);
                const userVotedInDb = activeOption && activeOption.voters.some(v => v.voterId === voterId);
                if (!userVotedInDb) {
                    console.log('檢測到本機投票已被剔除或同步不一致，正在重設本機投票狀態...');
                    delete userVotes[activePoll.id];
                    saveLocalVotes();
                    selectedOptionIds = null;
                }
            }
        }
    } else {
        // Heal from DB if there's an entry but local is empty
        if (activePoll.allowMultiple) {
            const dbVotedOptions = activePoll.options.filter(opt => opt.voters.some(v => v.voterId === voterId));
            if (dbVotedOptions.length > 0) {
                userVotes[activePoll.id] = dbVotedOptions.map(opt => opt.id);
                saveLocalVotes();
                selectedOptionIds = userVotes[activePoll.id];
            }
        } else {
            const dbVotedOption = activePoll.options.find(opt => opt.voters.some(v => v.voterId === voterId));
            if (dbVotedOption) {
                userVotes[activePoll.id] = dbVotedOption.id;
                saveLocalVotes();
                selectedOptionIds = dbVotedOption.id;
            }
        }
    }
    
    // Set Header details
    elPollTitle.textContent = activePoll.title;
    
    // Render type badges
    const elActivePollBadges = document.getElementById('active-poll-badges');
    if (elActivePollBadges) {
        elActivePollBadges.innerHTML = '';
        
        // 1. Multiple or Single Choice Badge
        const badgeChoice = document.createElement('span');
        badgeChoice.className = 'badge-pill';
        if (activePoll.allowMultiple) {
            badgeChoice.classList.add('badge-pill-multi');
            badgeChoice.textContent = '複選投票';
        } else {
            badgeChoice.classList.add('badge-pill-single');
            badgeChoice.textContent = '單選投票';
        }
        elActivePollBadges.appendChild(badgeChoice);
        
        // 2. User options badge
        const badgeOpts = document.createElement('span');
        badgeOpts.className = 'badge-pill';
        if (activePoll.allowUserOptions) {
            badgeOpts.classList.add('badge-pill-user-opts');
            badgeOpts.textContent = '任何人可新增選項';
        } else {
            badgeOpts.classList.add('badge-pill-single');
            badgeOpts.textContent = '僅限管理員新增選項';
        }
        elActivePollBadges.appendChild(badgeOpts);
        
        // 3. Anonymous Poll Badge
        if (activePoll.isAnonymous) {
            const badgeAnon = document.createElement('span');
            badgeAnon.className = 'badge-pill';
            badgeAnon.style.background = 'rgba(239, 68, 68, 0.12)';
            badgeAnon.style.border = '1px solid rgba(239, 68, 68, 0.3)';
            badgeAnon.style.color = '#fca5a5';
            badgeAnon.textContent = '匿名投票';
            elActivePollBadges.appendChild(badgeAnon);
        }
    }
    if (activePoll.description && activePoll.description.trim() !== '') {
        elPollDesc.textContent = activePoll.description;
        elPollDesc.classList.remove('hidden');
    } else {
        elPollDesc.textContent = '';
        elPollDesc.classList.add('hidden');
    }
    
    // Render description image if present
    if (activePoll.imageUrl) {
        elActivePollImage.src = activePoll.imageUrl;
        elPollImageContainer.classList.remove('hidden');
    } else {
        elPollImageContainer.classList.add('hidden');
        elActivePollImage.src = '';
    }
    
    // Toggle managing class based on management state
    if (isManagingActivePoll) {
        elActiveSection.classList.add('managing');
    } else {
        elActiveSection.classList.remove('managing');
    }
    
    // Toggle user options restriction class
    if (activePoll.allowUserOptions) {
        elActiveSection.classList.remove('user-options-disabled');
    } else {
        elActiveSection.classList.add('user-options-disabled');
    }
    
    const createdDate = new Date(activePoll.createdAt);
    elPollDate.textContent = `建立於: ${createdDate.getFullYear()}-${String(createdDate.getMonth() + 1).padStart(2, '0')}-${String(createdDate.getDate()).padStart(2, '0')}`;
    
    // Compute votes metrics
    const totalVotes = activePoll.options.reduce((sum, opt) => sum + opt.votes, 0);
    elTotalVotes.textContent = totalVotes.toLocaleString();
    elTotalOptions.textContent = activePoll.options.length.toString();
    
    // Render options list with in-place DOM updates to prevent progress bar animation flickering
    const existingCards = elOptionsList.querySelectorAll('.option-card');
    const canUpdateInPlace = existingCards.length === activePoll.options.length && 
                             existingCards.length > 0 &&
                             existingCards[0].dataset.optionId === activePoll.options[0].id;
                             
    if (!canUpdateInPlace) {
        elOptionsList.innerHTML = '';
    }
    
    activePoll.options.forEach((option, idx) => {
        const pct = totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0;
        
        let isVoted = false;
        if (selectedOptionIds) {
            if (Array.isArray(selectedOptionIds)) {
                isVoted = selectedOptionIds.includes(option.id);
            } else {
                isVoted = selectedOptionIds === option.id;
            }
        }
        
        if (canUpdateInPlace) {
            // Update existing DOM nodes in-place
            const optCard = existingCards[idx];
            
            // Toggle voted class
            if (isVoted) {
                optCard.classList.add('voted');
            } else {
                optCard.classList.remove('voted');
            }
            
            // Update percentage and vote count
            const elPct = optCard.querySelector('.option-percentage');
            if (elPct) elPct.textContent = `${pct.toFixed(0)}%`;
            
            const elVotes = optCard.querySelector('.option-votes');
            if (elVotes) elVotes.textContent = `${option.votes} 票`;
            
            // Update progress bar width directly in place (retains current width, avoiding resetting animation!)
            const progressBar = optCard.querySelector('.option-progress-bar');
            if (progressBar) {
                progressBar.style.width = `${pct}%`;
            }
            
            // Show/hide option delete button dynamically in place
            const statsWrapper = optCard.querySelector('.option-stats-wrapper');
            if (statsWrapper) {
                let btnDel = statsWrapper.querySelector('.btn-delete-option');
                if (isManagingActivePoll) {
                    if (!btnDel) {
                        btnDel = document.createElement('button');
                        btnDel.type = 'button';
                        btnDel.className = 'btn-delete-option';
                        btnDel.title = '刪除此選項及所有選票';
                        btnDel.innerHTML = `<i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>`;
                        statsWrapper.appendChild(btnDel);
                        
                        btnDel.addEventListener('click', (e) => {
                            e.stopPropagation();
                            handleDeleteOption(activePoll.id, option.id, option.text);
                        });
                        lucide.createIcons({ node: btnDel });
                    }
                } else {
                    if (btnDel) btnDel.remove();
                }
            }
            
            // Re-render voters list (clear and rebuild inside existing container to avoid flicker)
            let votersList = optCard.querySelector('.option-voters-list');
            if (activePoll.isAnonymous || !option.voters || option.voters.length === 0) {
                if (votersList) votersList.remove();
            } else {
                if (!votersList) {
                    votersList = document.createElement('div');
                    votersList.className = 'option-voters-list';
                    optCard.appendChild(votersList);
                }
                
                votersList.innerHTML = '';
                option.voters.forEach(v => {
                    const badge = document.createElement('span');
                    badge.className = 'voter-badge';
                    let avatarHTML = '';
                    if (v.avatarUrl) {
                        avatarHTML = `<img src="${v.avatarUrl}" alt="Avatar" class="voter-badge-avatar" style="width: 16px; height: 16px; border-radius: 50%; object-fit: cover; margin-right: 6px;">`;
                    } else {
                        avatarHTML = `<i data-lucide="user" class="voter-badge-avatar-icon" style="width: 12px; height: 12px; margin-right: 6px; color: var(--text-muted);"></i>`;
                    }
                    
                    badge.innerHTML = `
                        <div class="voter-badge-content" style="display: flex; align-items: center;">
                            ${avatarHTML}
                            <span>${escapeHTML(v.username)}</span>
                        </div>
                        <button type="button" class="btn-delete-vote" title="剔除此選票">
                            <i data-lucide="x"></i>
                        </button>
                    `;
                    
                    const btnDelVote = badge.querySelector('.btn-delete-vote');
                    btnDelVote.addEventListener('click', (e) => {
                        e.stopPropagation();
                        handleDeleteVote(activePoll.id, option.id, v.voterId, v.username, activePoll.hasPassword);
                    });
                    
                    votersList.appendChild(badge);
                });
            }
        } else {
            // Render option card from scratch
            const optCard = document.createElement('div');
            optCard.className = `option-card ${isVoted ? 'voted' : ''}`;
            optCard.dataset.optionId = option.id; // Store optionId for identification
            
            // Option main content (row layout)
            const cardMain = document.createElement('div');
            cardMain.className = 'option-card-main';
            cardMain.innerHTML = `
                <div class="option-content">
                    <div class="vote-checkbox">
                        <i data-lucide="check"></i>
                    </div>
                    <span class="option-text">${escapeHTML(option.text)}</span>
                </div>
                <div class="option-stats-wrapper" style="display: flex; align-items: center;">
                    <div class="option-stats">
                        <span class="option-percentage">${pct.toFixed(0)}%</span>
                        <span class="option-votes">${option.votes} 票</span>
                    </div>
                </div>
            `;
            
            // Append delete option trash button if managing
            const statsWrapper = cardMain.querySelector('.option-stats-wrapper');
            if (isManagingActivePoll && statsWrapper) {
                const btnDel = document.createElement('button');
                btnDel.type = 'button';
                btnDel.className = 'btn-delete-option';
                btnDel.title = '刪除此選項及所有選票';
                btnDel.innerHTML = `<i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>`;
                statsWrapper.appendChild(btnDel);
                
                btnDel.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleDeleteOption(activePoll.id, option.id, option.text);
                });
            }
            
            // Click to vote trigger
            cardMain.addEventListener('click', () => {
                handleVote(activePoll.id, option.id);
            });
            
            optCard.appendChild(cardMain);
            
            // Background progress bar
            const progressBar = document.createElement('div');
            progressBar.className = 'option-progress-bar';
            progressBar.style.width = '0%';
            optCard.appendChild(progressBar);
            
            // Render voters lists below main if any (and if not anonymous)
            if (!activePoll.isAnonymous && option.voters && option.voters.length > 0) {
                const votersList = document.createElement('div');
                votersList.className = 'option-voters-list';
                
                option.voters.forEach(v => {
                    const badge = document.createElement('span');
                    badge.className = 'voter-badge';
                    let avatarHTML = '';
                    if (v.avatarUrl) {
                        avatarHTML = `<img src="${v.avatarUrl}" alt="Avatar" class="voter-badge-avatar" style="width: 16px; height: 16px; border-radius: 50%; object-fit: cover; margin-right: 6px;">`;
                    } else {
                        avatarHTML = `<i data-lucide="user" class="voter-badge-avatar-icon" style="width: 12px; height: 12px; margin-right: 6px; color: var(--text-muted);"></i>`;
                    }
                    
                    badge.innerHTML = `
                        <div class="voter-badge-content" style="display: flex; align-items: center;">
                            ${avatarHTML}
                            <span>${escapeHTML(v.username)}</span>
                        </div>
                        <button type="button" class="btn-delete-vote" title="剔除此選票">
                            <i data-lucide="x"></i>
                        </button>
                    `;
                    
                    const btnDelVote = badge.querySelector('.btn-delete-vote');
                    btnDelVote.addEventListener('click', (e) => {
                        e.stopPropagation();
                        handleDeleteVote(activePoll.id, option.id, v.voterId, v.username, activePoll.hasPassword);
                    });
                    
                    votersList.appendChild(badge);
                });
                
                optCard.appendChild(votersList);
            }
            
            elOptionsList.appendChild(optCard);
            
            // Animate width progress bar
            requestAnimationFrame(() => {
                progressBar.style.width = `${pct}%`;
            });
        }
    });
    
    lucide.createIcons();
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    // Nickname input change
    elUsernameInput.addEventListener('change', () => handleUpdateProfile(false));
    
    // Search input
    elSearchInput.addEventListener('input', (e) => {
        renderPollsList(e.target.value.trim());
    });

    // Modal triggers
    [elBtnCreateSidebar, elBtnOpenCreate, elBtnOpenCreatePlaceholder].forEach(btn => {
        if (btn) btn.addEventListener('click', openCreateModal);
    });

    // Close Modal
    if (elBtnCloseModal) elBtnCloseModal.addEventListener('click', closeCreateModal);
    if (elBtnCancelPoll) elBtnCancelPoll.addEventListener('click', handleCancelPollClick);
    
    // Add extra option row in modal
    elBtnAddModalOption.addEventListener('click', addModalOptionField);

    // Form submissions
    elCreatePollForm.addEventListener('submit', handleCreatePoll);
    elAddOptionForm.addEventListener('submit', handleAddOption);

    // Management bindings
    elBtnManagePoll.addEventListener('click', handleManagePollClick);
    elBtnExitManagePoll.addEventListener('click', handleExitManagePoll);
    elBtnDeletePoll.addEventListener('click', handleDeletePollClick);
    
    elBtnCloseAuthModal.addEventListener('click', closeAuthModal);
    elBtnCancelAuth.addEventListener('click', closeAuthModal);
    elManageAuthForm.addEventListener('submit', handleAuthSubmit);
    
    elManageAuthModal.addEventListener('click', (e) => {
        if (e.target === elManageAuthModal) {
            closeAuthModal();
        }
    });

    // Image upload bindings
    elBtnTriggerUpload.addEventListener('click', () => elPollImageInput.click());
    elPollImageInput.addEventListener('change', handleImageSelect);
    elBtnClearUpload.addEventListener('click', clearImageUpload);

    // Profile avatar bindings
    elProfileAvatarTrigger.addEventListener('click', () => elProfileAvatarInput.click());
    elProfileAvatarInput.addEventListener('change', handleProfileAvatarSelect);
}

// --- Action Handlers ---

// Handle profile picture select
function handleProfileAvatarSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // Limit to 150KB to keep network traffic and DB sizes highly efficient
    if (file.size > 150 * 1024) {
        showToast('頭像大小不能超過 150KB！', 'warning');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = async function(evt) {
        voterAvatar = evt.target.result;
        localStorage.setItem('decidely_voter_avatar', voterAvatar);
        renderVoterAvatarHeader();
        
        // Sync to backend immediately
        await handleUpdateProfile(true);
    };
    reader.onerror = function() {
        showToast('讀取頭像檔案失敗。', 'warning');
    };
    reader.readAsDataURL(file);
}

// Handle profile (username & avatar) updates
async function handleUpdateProfile(forceSync = false) {
    const newName = elUsernameInput.value.trim() || '匿名';
    elUsernameInput.value = newName;
    
    // If nothing changed and not forced, skip
    if (!forceSync && newName === voterName) return;
    
    try {
        const response = await fetch('/api/users/update-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                voterId,
                username: newName,
                avatarUrl: voterAvatar
            })
        });
        
        if (!response.ok) throw new Error('API 錯誤');
        
        voterName = newName;
        localStorage.setItem('decidely_voter_name', voterName);
        showToast('個人資料已更新！', 'success');
    } catch (e) {
        console.error('更新個人資料失敗:', e);
        showToast('更新個人資料失敗，請稍後再試。', 'warning');
        elUsernameInput.value = voterName; // Restore name
    }
}

// Handle Poll Select
function selectPoll(pollId) {
    activePollId = pollId;
    isManagingActivePoll = false;
    verifiedPollPassword = '';
    renderPollsList(elSearchInput.value.trim());
    renderActivePoll();
}

// Helper for Optimistic UI updates
function applyOptimisticVote(pollId, optionId, increment) {
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return;
    
    const option = poll.options.find(opt => opt.id === optionId);
    if (!option) return;
    
    // Update vote count (min 0)
    option.votes = Math.max(0, option.votes + increment);
    
    // Update voters list
    if (!option.voters) option.voters = [];
    if (increment === 1) {
        if (!option.voters.some(v => v.voterId === voterId)) {
            option.voters.push({
                voterId: voterId,
                username: poll.isAnonymous ? '匿名' : voterName,
                avatarUrl: poll.isAnonymous ? null : voterAvatar
            });
        }
    } else {
        option.voters = option.voters.filter(v => v.voterId !== voterId);
    }
}

// Handle voting on an option via API with Optimistic UI updates
async function handleVote(pollId, optionId) {
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return;
    
    const isMultiple = poll.allowMultiple;
    const votedVal = userVotes[pollId];
    
    // Check if voter has already voted for this option
    let currentlyVoted = false;
    if (isMultiple) {
        currentlyVoted = Array.isArray(votedVal) && votedVal.includes(optionId);
    } else {
        currentlyVoted = votedVal === optionId;
    }
    
    const increment = currentlyVoted ? -1 : 1;
    
    // 1. Back up original state
    const originalUserVotes = JSON.parse(JSON.stringify(userVotes));
    const originalPolls = JSON.parse(JSON.stringify(polls));
    
    // Mark this poll as in-flight to prevent self-healing race condition
    inFlightVotes.add(pollId);
    
    try {
        if (isMultiple) {
            // Update local votes list
            if (!Array.isArray(userVotes[pollId])) {
                userVotes[pollId] = votedVal ? [votedVal] : [];
            }
            if (increment === 1) {
                userVotes[pollId].push(optionId);
            } else {
                userVotes[pollId] = userVotes[pollId].filter(id => id !== optionId);
            }
            if (userVotes[pollId].length === 0) {
                delete userVotes[pollId];
            }
            
            // Update in-memory option votes count and voters list
            applyOptimisticVote(pollId, optionId, increment);
            
            // Render UI immediately!
            saveLocalVotes();
            updateUI();
            
            // Send request in background
            const response = await fetch(`/api/polls/${pollId}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ optionId, voterId, username: voterName, increment, avatarUrl: voterAvatar })
            });
            if (!response.ok) throw new Error('API 錯誤');
            
            showToast(increment === 1 ? '投票成功！' : '已取消該選項的投票');
            
        } else {
            // Single-choice voting
            if (currentlyVoted) {
                // Retract vote
                delete userVotes[pollId];
                applyOptimisticVote(pollId, optionId, -1);
                
                saveLocalVotes();
                updateUI();
                
                const response = await fetch(`/api/polls/${pollId}/vote`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ optionId, voterId, username: voterName, increment: -1, avatarUrl: voterAvatar })
                });
                if (!response.ok) throw new Error('API 錯誤');
                
                showToast('已取消投票');
            } else {
                // Switch vote
                const previousVoteOptionId = Array.isArray(votedVal) ? votedVal[0] : votedVal;
                
                // Optimistically change local state
                userVotes[pollId] = optionId;
                if (previousVoteOptionId) {
                    applyOptimisticVote(pollId, previousVoteOptionId, -1);
                }
                applyOptimisticVote(pollId, optionId, 1);
                
                saveLocalVotes();
                updateUI();
                
                // Send single cast request (server handles retracting the previous vote automatically)
                const castResp = await fetch(`/api/polls/${pollId}/vote`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ optionId, voterId, username: voterName, increment: 1, avatarUrl: voterAvatar })
                });
                if (!castResp.ok) throw new Error('投票失敗');
                
                showToast('投票成功！');
            }
        }
    } catch (e) {
        console.error('投票失敗，正在還原狀態:', e);
        // Rollback state on error
        userVotes = originalUserVotes;
        polls = originalPolls;
        saveLocalVotes();
        updateUI();
        showToast('投票同步失敗，已還原狀態。', 'warning');
    } finally {
        // Clear from in-flight list after a small buffer to let WebSocket messages settle
        setTimeout(() => {
            inFlightVotes.delete(pollId);
        }, 800);
    }
}

// Moderated delete vote action
async function handleDeleteVote(pollId, optionId, targetVoterId, targetVoterName, hasPassword) {
    const confirmDelete = confirm(`確定要剔除「${targetVoterName}」在此選項的投票嗎？`);
    if (!confirmDelete) return;
    
    try {
        const response = await fetch(`/api/polls/${pollId}/votes/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                optionId,
                voterId: targetVoterId,
                password: verifiedPollPassword
            })
        });
        
        if (response.status === 403) {
            showToast('密碼驗證失敗，無法剔除此投票！', 'warning');
            return;
        }
        
        if (!response.ok) throw new Error('API 錯誤');
        
        showToast(`已成功剔除「${targetVoterName}」的投票選票。`, 'success');
    } catch (e) {
        console.error('剔除選票失敗:', e);
        showToast('剔除選票失敗，請稍後再試。', 'warning');
    }
}

// Moderated delete option action
async function handleDeleteOption(pollId, optionId, optionText) {
    const confirmDelete = confirm(`確定要刪除整個選項「${optionText}」以及其所擁有的所有選票嗎？`);
    if (!confirmDelete) return;
    
    try {
        const response = await fetch(`/api/polls/${pollId}/options/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                optionId,
                password: verifiedPollPassword
            })
        });
        
        if (response.status === 403) {
            showToast('密碼驗證失敗，無法刪除此選項！', 'warning');
            return;
        }
        
        if (response.status === 400) {
            const data = await response.json();
            showToast(data.error || '無法刪除選項！', 'warning');
            return;
        }
        
        if (!response.ok) throw new Error('API 錯誤');
        
        showToast('已成功刪除該選項。', 'success');
    } catch (e) {
        console.error('刪除選項失敗:', e);
        showToast('刪除選項失敗，請稍後再試。', 'warning');
    }
}

// Handle adding custom option to active poll
async function handleAddOption(e) {
    e.preventDefault();
    
    const text = elNewOptionInput.value.trim();
    if (!text) return;
    
    const activePoll = polls.find(p => p.id === activePollId);
    if (!activePoll) return;
    
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
        
        elNewOptionInput.value = '';
        showToast('已成功新增選項！', 'success');
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
    const deletePassword = document.getElementById('poll-password-input').value.trim();
    const allowMultiple = elPollAllowMultiple ? elPollAllowMultiple.checked : false;
    const allowUserOptions = elPollAllowUserOptions ? elPollAllowUserOptions.checked : true;
    const isAnonymous = elPollIsAnonymous ? elPollIsAnonymous.checked : false;
    const image = selectedBase64Image;
    
    // Extract option inputs
    const optionInputs = elModalOptionsList.querySelectorAll('.modal-option-input');
    const options = [];
    
    optionInputs.forEach(input => {
        const txt = input.value.trim();
        if (txt) {
            options.push(txt);
        }
    });
    
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
                options,
                deletePassword,
                allowMultiple,
                allowUserOptions,
                isAnonymous,
                image
            })
        });
        
        if (!response.ok) throw new Error('API 錯誤');
        
        const createdPoll = await response.json();
        activePollId = createdPoll.id;
        
        closeCreateModal();
        resetCreateForm();
        elSearchInput.value = '';
        showToast('新投票主題已發佈！', 'success');
    } catch (e) {
        console.error('建立投票主題失敗:', e);
        showToast('發佈投票失敗，請稍後再試。', 'warning');
    }
}

// --- Modal Helper Functions ---
let selectedBase64Image = null;

function handleImageSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // Limit to 2MB to keep DB sizes optimal
    if (file.size > 2 * 1024 * 1024) {
        showToast('圖片大小不能超過 2MB！', 'warning');
        clearImageUpload();
        return;
    }
    
    elUploadFileName.textContent = file.name;
    elBtnClearUpload.classList.remove('hidden');
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        selectedBase64Image = evt.target.result;
        elImagePreview.src = selectedBase64Image;
        elImagePreviewContainer.classList.remove('hidden');
    };
    reader.onerror = function() {
        showToast('讀取圖片檔案失敗。', 'warning');
        clearImageUpload();
    };
    reader.readAsDataURL(file);
}

function clearImageUpload() {
    elPollImageInput.value = '';
    elUploadFileName.textContent = '未選擇檔案';
    elBtnClearUpload.classList.add('hidden');
    elImagePreviewContainer.classList.add('hidden');
    elImagePreview.src = '';
    selectedBase64Image = null;
}

function openCreateModal() {
    elCreateModal.classList.remove('hidden');
    document.getElementById('poll-title-input').focus();
}

function closeCreateModal() {
    elCreateModal.classList.add('hidden');
}

function resetCreateForm() {
    document.getElementById('poll-title-input').value = '';
    document.getElementById('poll-desc-input').value = '';
    document.getElementById('poll-password-input').value = '';
    
    // Reset Checkboxes
    if (elPollAllowMultiple) elPollAllowMultiple.checked = false;
    if (elPollAllowUserOptions) elPollAllowUserOptions.checked = true;
    if (elPollIsAnonymous) elPollIsAnonymous.checked = false;
    
    clearImageUpload();
    
    elModalOptionsList.innerHTML = `
        <div class="modal-option-row">
            <input type="text" class="modal-option-input" placeholder="選項 1" required maxlength="80" autocomplete="off">
            <span class="drag-placeholder"></span>
        </div>
        <div class="modal-option-row">
            <input type="text" class="modal-option-input" placeholder="選項 2" required maxlength="80" autocomplete="off">
            <span class="drag-placeholder"></span>
        </div>
    `;
}

function handleCancelPollClick() {
    const title = document.getElementById('poll-title-input').value.trim();
    const desc = document.getElementById('poll-desc-input').value.trim();
    
    // Check if any option input is filled
    const optionInputs = elModalOptionsList.querySelectorAll('.modal-option-input');
    let hasOptionContent = false;
    optionInputs.forEach(input => {
        if (input.value.trim() !== '') hasOptionContent = true;
    });
    
    if (title || desc || hasOptionContent) {
        const confirmCancel = confirm('確定要取消並清除已輸入的投票內容嗎？');
        if (!confirmCancel) return;
    }
    
    resetCreateForm();
    closeCreateModal();
}

function addModalOptionField() {
    const currentRows = elModalOptionsList.querySelectorAll('.modal-option-row');
    const index = currentRows.length + 1;
    
    const row = document.createElement('div');
    row.className = 'modal-option-row animate-scale-up';
    
    row.innerHTML = `
        <input type="text" class="modal-option-input" placeholder="選項 ${index}" required maxlength="80" autocomplete="off">
        <button type="button" class="btn-remove-option" title="刪除選項">
            <i data-lucide="trash-2"></i>
        </button>
    `;
    
    const btnRemove = row.querySelector('.btn-remove-option');
    btnRemove.addEventListener('click', () => {
        row.remove();
        updateModalOptionLabels();
    });
    
    elModalOptionsList.appendChild(row);
    lucide.createIcons();
    
    // Auto-scroll options list to the bottom
    elModalOptionsList.scrollTop = elModalOptionsList.scrollHeight;
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

// --- Management Mode Handlers ---
function handleManagePollClick() {
    const activePoll = polls.find(p => p.id === activePollId);
    if (!activePoll) return;
    
    // If poll has no password set, enter management mode immediately
    if (!activePoll.hasPassword) {
        isManagingActivePoll = true;
        verifiedPollPassword = '';
        updateUI();
        showToast('已進入管理模式（此主題無密碼）。', 'success');
        return;
    }
    
    // Show password verification modal
    elManagePasswordInput.value = '';
    elAuthErrorMsg.classList.add('hidden');
    elManageAuthModal.classList.remove('hidden');
    setTimeout(() => elManagePasswordInput.focus(), 100);
}

function closeAuthModal() {
    elManageAuthModal.classList.add('hidden');
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const password = elManagePasswordInput.value;
    
    try {
        const response = await fetch(`/api/polls/${activePollId}/verify-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        
        if (response.status === 403) {
            elAuthErrorMsg.textContent = '密碼錯誤，請再試一次！';
            elAuthErrorMsg.classList.remove('hidden');
            return;
        }
        
        if (!response.ok) throw new Error('API 錯誤');
        
        isManagingActivePoll = true;
        verifiedPollPassword = password;
        closeAuthModal();
        updateUI();
        showToast('管理身分驗證成功，已啟用管理功能。', 'success');
    } catch (e) {
        console.error('驗證管理密碼失敗:', e);
        showToast('密碼驗證失敗，請稍後再試。', 'warning');
    }
}

function handleExitManagePoll() {
    isManagingActivePoll = false;
    verifiedPollPassword = '';
    updateUI();
    showToast('已退出管理模式。', 'info');
}

async function handleDeletePollClick() {
    const activePoll = polls.find(p => p.id === activePollId);
    if (!activePoll) return;
    
    const confirmDelete = confirm('⚠️ 警告：確定要永久刪除此投票主題嗎？\n此操作將同時刪除所有選項與投下的選票，且無法還原！');
    if (!confirmDelete) return;
    
    try {
        const response = await fetch(`/api/polls/${activePollId}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: verifiedPollPassword })
        });
        
        if (response.status === 403) {
            showToast('管理密碼驗證失敗，無法刪除主題！', 'warning');
            return;
        }
        
        if (!response.ok) throw new Error('API 錯誤');
        
        showToast('投票主題已成功刪除。', 'success');
        activePollId = null;
        isManagingActivePoll = false;
        verifiedPollPassword = '';
        
        // Retrieve updated poll lists
        fetchPolls().then(() => {
            if (polls.length > 0) {
                activePollId = polls[0].id;
            }
            updateUI();
        });
    } catch (e) {
        console.error('刪除投票主題失敗:', e);
        showToast('刪除投票主題失敗，請稍後再試。', 'warning');
    }
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
