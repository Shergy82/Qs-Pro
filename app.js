/**
 * QS Pro AI - Main Coordinator & State Manager
 */

class QSProApp {
    constructor() {
        // App State Database
        this.state = {
            activePanel: 'dashboard',
            pricingMode: 'company', // company, market, hybrid
            targetMargin: 10.0, // %
            targetContingency: 3.0, // %
            
            workspaces: [],
            uploadedFiles: [],
            notifications: [],
            activeWorkspaceId: null,
            token: null,
            user: null
        };
        
        // Component References
        this.takeoff = null;
        this.pricing = null;
        this.advisor = null;
        this.proposal = null;
        this.library = null;
    }

    async init() {
        this.setupEventListeners();
        this.setupDragAndDrop();
        this.initRouter();
        
        const loggedIn = await this.autoLogin();
        if (loggedIn) {
            await this.loadInitialData();
        } else {
            this.renderAll();
        }
    }

    getApiUrl(path) {
        const backendOrigin = 'http://localhost:3001';
        if (window.location.origin.includes('3001')) {
            return path;
        }
        return backendOrigin + path;
    }

    async apiFetch(url, options = {}) {
        if (!options.headers) {
            options.headers = {};
        }
        if (this.state.token) {
            options.headers['Authorization'] = `Bearer ${this.state.token}`;
        }
        if (!(options.body instanceof FormData) && typeof options.body === 'object') {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }
        
        const response = await fetch(this.getApiUrl(url), options);
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `HTTP error! status: ${response.status}`);
        }
        return response.json();
    }

    async autoLogin() {
        console.log('QS Pro AI - Initializing automatic login...');
        try {
            const loginData = await this.apiFetch('/api/auth/login', {
                method: 'POST',
                body: { email: 'demo@truecostqs.com', password: 'password123' }
            });
            this.state.token = loginData.token;
            this.state.user = loginData.user;
            console.log('Login successful for demo user:', this.state.user.email);
        } catch (err) {
            console.warn('Login failed, attempting auto-registration...', err.message);
            try {
                const registerData = await this.apiFetch('/api/auth/register', {
                    method: 'POST',
                    body: {
                        email: 'demo@truecostqs.com',
                        password: 'password123',
                        companyName: 'Apex Builders Ltd',
                        estimatorName: 'Phil Estimator'
                    }
                });
                this.state.token = registerData.token;
                this.state.user = registerData.user;
                console.log('Auto-registration & login successful:', this.state.user.email);
            } catch (regErr) {
                console.error('Auto-login and Auto-registration failed:', regErr);
                alert('Connection to backend failed. Please verify the backend server is running on http://localhost:3001');
                return false;
            }
        }
        
        if (this.state.user) {
            this.state.targetMargin = this.state.user.margin || 10.0;
            this.state.targetContingency = this.state.user.contingency || 3.0;
        }
        return true;
    }

    async loadInitialData() {
        try {
            const projects = await this.apiFetch('/api/projects');
            this.state.workspaces = projects.map(proj => ({
                id: proj.id,
                name: proj.name,
                client: proj.client || 'Client Pending',
                dueDate: proj.startDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                baseCost: proj.totalCost || 0,
                value: proj.sellPrice || 0,
                status: proj.status || 'Draft',
                health: 98,
                margin: proj.margin || 10.0,
                contingency: proj.contingency || 3.0
            }));

            if (this.state.workspaces.length > 0) {
                this.state.activeWorkspaceId = this.state.workspaces[0].id;
                
                const activeProj = projects.find(p => p.id === this.state.activeWorkspaceId);
                if (activeProj) {
                    this.state.targetMargin = activeProj.margin || 10.0;
                    this.state.targetContingency = activeProj.contingency || 3.0;
                }
            }
            
            if (this.pricing) {
                await this.pricing.loadRatesFromBackend();
                await this.pricing.loadSupplierFeeds();
                await this.pricing.loadHistoricalTenders();
            }

            if (this.state.activeWorkspaceId) {
                await this.loadActiveWorkspaceEstimate();
            }

            this.renderAll();
        } catch (err) {
            console.error('Error loading initial data from backend:', err);
        }
    }

    async loadActiveWorkspaceEstimate() {
        if (!this.state.activeWorkspaceId) return;
        try {
            const estimates = await this.apiFetch(`/api/projects/${this.state.activeWorkspaceId}/estimates`);
            
            if (this.pricing) {
                this.pricing.syncRatesFromEstimates(estimates);
            }
            
            if (this.advisor) {
                this.advisor.generateAIChecklist();
                this.advisor.recalculateTenderTotals();
            }

            if (this.proposal) {
                this.proposal.veOpportunities = [];
            }
        } catch (err) {
            console.error('Error loading estimate items:', err);
        }
    }

    setupEventListeners() {
        // Sidebar Navigation
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const panelName = item.getAttribute('data-panel');
                this.switchPanel(panelName);
            });
        });

        // Notifications Toggle Drawer
        const alertBell = document.getElementById('alert-bell');
        const drawer = document.getElementById('notifications-drawer');
        
        alertBell.addEventListener('click', (e) => {
            e.stopPropagation();
            drawer.classList.toggle('active');
        });

        document.addEventListener('click', (e) => {
            if (!drawer.contains(e.target) && e.target !== alertBell && !alertBell.contains(e.target)) {
                drawer.classList.remove('active');
            }
        });

        document.getElementById('mark-all-read').addEventListener('click', () => {
            this.state.notifications = [];
            this.renderNotifications();
            this.updateNotificationCount();
        });

        // Process File Scanning Button
        const btnProcess = document.getElementById('btn-process-files');
        btnProcess.addEventListener('click', () => this.simulateFileAnalysis());

        // File browser input
        const fileInput = document.getElementById('file-input');
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
    }

    initRouter() {
        // Handle initial hash routing
        const hash = window.location.hash.replace('#', '');
        if (hash && document.getElementById(`${hash}-panel`)) {
            this.switchPanel(hash);
        } else {
            this.switchPanel('dashboard');
        }

        // Handle browser back/forward
        window.addEventListener('hashchange', () => {
            const currentHash = window.location.hash.replace('#', '');
            if (currentHash && document.getElementById(`${currentHash}-panel`)) {
                this.switchPanel(currentHash, false);
            }
        });
    }

    switchPanel(panelName, updateHash = true) {
        if (this.state.activePanel === panelName) return;

        // Hide current active panel
        const currentActive = document.querySelector('.panel.active');
        if (currentActive) currentActive.classList.remove('active');

        // Show new panel
        const targetPanel = document.getElementById(`${panelName}-panel`);
        if (targetPanel) {
            targetPanel.classList.add('active');
            this.state.activePanel = panelName;
        }

        // Update sidebar active menu highlight
        document.querySelectorAll('.menu-item').forEach(item => {
            if (item.getAttribute('data-panel') === panelName) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // Update Topbar titles
        const titles = {
            dashboard: { title: 'Dashboard', subtitle: 'Welcome back, here is your estimation pipeline overview.' },
            upload: { title: 'Tender Upload & Document Center', subtitle: 'Upload drawings, specifications, bills of quantities, and schedule of rates.' },
            takeoff: { title: 'AI Quantity Take-Off & Measurements', subtitle: 'Click on plans to measure area dimensions and map architectural scopes.' },
            pricing: { title: 'Intelligent Pricing Engine', subtitle: 'Compare company pricing against live market indices and regional supplier databases.' },
            library: { title: 'Global Price Library & Rate Book', subtitle: 'Remember and update materials, plant, subcontractor element prices, and trade daily rates.' },
            sor: { title: 'Automated Schedule of Rates Pricing', subtitle: 'Map client items to pricing databases instantly using cognitive matching.' },
            risk: { title: 'Profit & Risk Commercial Advisor', subtitle: 'Review omissions checklist, inflation risk, and calibrate project margin targets.' },
            proposal: { title: 'Proposal & Client Quotation Generator', subtitle: 'Brand, compile, and finalize the professional commercial quote submission.' }
        };

        const titleData = titles[panelName] || { title: 'QS Pro AI', subtitle: 'Quantity Surveying Platform' };
        document.getElementById('current-panel-title').innerText = titleData.title;
        document.getElementById('current-panel-subtitle').innerText = titleData.subtitle;

        if (updateHash) {
            window.location.hash = panelName;
        }

        // Trigger panel specific loads
        this.triggerPanelCallback(panelName);
    }

    triggerPanelCallback(panelName) {
        if (panelName === 'takeoff' && this.takeoff) {
            this.takeoff.onPanelShow();
        } else if (panelName === 'pricing' && this.pricing) {
            this.pricing.render();
        } else if (panelName === 'library' && this.library) {
            this.library.render();
        } else if (panelName === 'sor' && this.pricing) {
            this.pricing.renderSOR();
        } else if (panelName === 'risk' && this.advisor) {
            this.advisor.render();
        } else if (panelName === 'proposal' && this.proposal) {
            this.proposal.render();
        }
    }

    renderAll() {
        this.renderWorkspaceTable();
        this.renderNotifications();
        this.renderFileList();
        this.updateGlobalMetrics();
        this.updateNotificationCount();
    }

    // --- Metrics & Data Rendering ---
    updateGlobalMetrics() {
        // Calculate total estimating/pending pipeline value (including Draft, Estimating, Pending, Review)
        const pipelineBids = this.state.workspaces.filter(ws => 
            ['Draft', 'Estimating', 'Pending', 'Review'].includes(ws.status)
        );
        const total = pipelineBids.reduce((sum, ws) => sum + (ws.value || 0), 0);
        
        const globalPipelineValEl = document.getElementById('global-pipeline-val');
        if (globalPipelineValEl) {
            globalPipelineValEl.innerText = this.formatCurrency(total);
        }
        
        // Calculate Win Rate (won vs won + lost/submitted)
        const wonBids = this.state.workspaces.filter(ws => ws.status === 'Won');
        const wonCount = wonBids.length;
        const totalClosed = this.state.workspaces.filter(ws => 
            ['Won', 'Lost', 'Submitted'].includes(ws.status)
        ).length;
        const winRate = totalClosed > 0 ? (wonCount / totalClosed * 100) : 0.0;
        
        const globalWinRateEl = document.getElementById('global-win-rate');
        if (globalWinRateEl) {
            globalWinRateEl.innerText = winRate.toFixed(1) + '%';
        }

        // Update Dashboard Stats Row Elements
        const liveBidsVal = document.getElementById('stat-live-bids-val');
        const liveBidsTrend = document.getElementById('stat-live-bids-trend');
        if (liveBidsVal) {
            liveBidsVal.innerText = `${pipelineBids.length} Bid${pipelineBids.length === 1 ? '' : 's'}`;
        }
        if (liveBidsTrend) {
            liveBidsTrend.innerText = pipelineBids.length > 0 ? 
                `Pipeline: ${this.formatCurrency(total)}` : 
                'No active bids';
        }

        const wonVal = document.getElementById('stat-won-val');
        const wonTrend = document.getElementById('stat-won-trend');
        const wonTotal = wonBids.reduce((sum, ws) => sum + (ws.value || 0), 0);
        if (wonVal) {
            wonVal.innerText = this.formatCurrency(wonTotal);
        }
        if (wonTrend) {
            wonTrend.innerText = `${winRate.toFixed(1)}% win rate YTD`;
        }

        const avgMarginVal = document.getElementById('stat-avg-margin');
        const avgMarginTrend = document.getElementById('stat-avg-margin-trend');
        const avgMargin = this.state.workspaces.length > 0 ? 
            (this.state.workspaces.reduce((sum, ws) => sum + (ws.margin || 10.0), 0) / this.state.workspaces.length) : 
            this.state.targetMargin;
        
        if (avgMarginVal) {
            avgMarginVal.innerText = `${avgMargin.toFixed(1)}%`;
        }
        if (avgMarginTrend) {
            const uncheckedHigh = (this.advisor && this.advisor.checklist) ? 
                this.advisor.checklist.filter(c => !c.checked && c.risk === 'high').length : 0;
            avgMarginTrend.innerText = uncheckedHigh > 0 ? 
                `${uncheckedHigh} high risk exposure` : 
                'Target margin optimized';
        }

        // Update Average Tender Health banner gauge
        const avgHealth = this.state.workspaces.length > 0 ? 
            Math.round(this.state.workspaces.reduce((sum, ws) => sum + (ws.health || 0), 0) / this.state.workspaces.length) : 
            0;
        const heroHealthVal = document.getElementById('hero-health-val');
        const heroHealthCircle = document.getElementById('hero-health-circle');
        if (heroHealthVal) {
            heroHealthVal.innerText = avgHealth > 0 ? `${avgHealth}%` : '--%';
        }
        if (heroHealthCircle) {
            heroHealthCircle.setAttribute('stroke-dasharray', `${avgHealth}, 100`);
            if (avgHealth > 85) {
                heroHealthCircle.style.stroke = 'var(--color-emerald)';
            } else if (avgHealth > 65) {
                heroHealthCircle.style.stroke = 'var(--color-amber)';
            } else if (avgHealth > 0) {
                heroHealthCircle.style.stroke = 'var(--color-red)';
            } else {
                heroHealthCircle.style.stroke = 'rgba(255, 255, 255, 0.1)';
            }
        }
    }

    updateNotificationCount() {
        const unreadCount = this.state.notifications.filter(n => !n.read).length;
        const bell = document.getElementById('alert-bell');
        const indicator = bell.querySelector('.pulse-indicator');
        
        if (unreadCount > 0) {
            indicator.style.display = 'block';
        } else {
            indicator.style.display = 'none';
        }
    }

    renderWorkspaceTable() {
        const tbody = document.getElementById('active-workspaces-tbody');
        tbody.innerHTML = '';
        
        if (this.state.workspaces.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-secondary py-8">
                        No active tender workspaces found. Upload drawing sheets in the Document Center to initialize a new estimate.
                    </td>
                </tr>
            `;
            return;
        }
        
        this.state.workspaces.forEach(ws => {
            let statusBadge = '';
            if (ws.status === 'Estimating') statusBadge = '<span class="badge badge-amber">Estimating</span>';
            else if (ws.status === 'Won') statusBadge = '<span class="badge badge-emerald">Won</span>';
            else if (ws.status === 'Submitted') statusBadge = '<span class="badge badge-blue">Submitted</span>';
            else statusBadge = '<span class="badge badge-gray">Pending</span>';

            let healthClass = 'text-emerald';
            if (ws.health < 80) healthClass = 'text-amber';
            if (ws.health < 60) healthClass = 'text-red';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="font-semibold">${ws.name}</td>
                <td class="text-secondary">${ws.client}</td>
                <td>${this.formatDate(ws.dueDate)}</td>
                <td class="font-bold">${this.formatCurrency(ws.value)}</td>
                <td>${statusBadge}</td>
                <td class="${healthClass} font-bold">${ws.health}%</td>
                <td>
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-secondary py-1 px-3 text-xs" onclick="app.loadWorkspace('${ws.id}')">Open</button>
                        <button class="btn btn-secondary py-1 px-3 text-xs text-red" style="border-color: rgba(239, 68, 68, 0.2);" onclick="app.deleteProject('${ws.id}')">Delete</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    renderNotifications() {
        const list = document.getElementById('notifications-list');
        list.innerHTML = '';
        
        if (this.state.notifications.length === 0) {
            list.innerHTML = `<div class="text-center text-secondary py-5 text-xs">No active alerts</div>`;
            return;
        }

        this.state.notifications.forEach(n => {
            const div = document.createElement('div');
            div.className = `notification-item ${n.read ? '' : 'unread'}`;
            div.innerHTML = `
                <div class="notification-header">
                    <span class="notification-title font-semibold">${n.title}</span>
                    <span class="notification-time">${n.time}</span>
                </div>
                <div class="notification-body">${n.body}</div>
            `;
            div.addEventListener('click', () => {
                n.read = true;
                this.updateNotificationCount();
                this.switchPanel('risk');
            });
            list.appendChild(div);
        });
    }

    renderFileList() {
        const tbody = document.getElementById('file-list-tbody');
        tbody.innerHTML = '';
        
        const badge = document.getElementById('upload-badge');
        const pendingFilesCount = this.state.uploadedFiles.filter(f => f.status === 'Pending').length;
        
        if (pendingFilesCount > 0) {
            badge.style.display = 'inline-block';
            badge.innerText = pendingFilesCount;
        } else {
            badge.style.display = 'none';
        }

        document.getElementById('uploaded-count').innerText = `${this.state.uploadedFiles.length} Files`;

        const btnProcess = document.getElementById('btn-process-files');
        btnProcess.disabled = pendingFilesCount === 0;

        if (this.state.uploadedFiles.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center text-secondary py-5">
                        No files uploaded yet. Drag files in or browse to begin.
                    </td>
                </tr>
            `;
            return;
        }

        this.state.uploadedFiles.forEach((file, index) => {
            let statusPill = '';
            if (file.status === 'Analysed') {
                statusPill = `<span class="status-pill status-analyzed"><span class="dot"></span>Analysed</span>`;
            } else if (file.status === 'Analyzing') {
                statusPill = `<span class="status-pill status-analyzing"><span class="dot dot-pulse"></span>Scanning...</span>`;
            } else {
                statusPill = `<span class="status-pill status-pending"><span class="dot"></span>Pending</span>`;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="font-semibold">${file.name}</td>
                <td class="text-secondary">${file.size}</td>
                <td><span class="badge badge-gray">${file.type}</span></td>
                <td><span class="text-secondary text-xs">${file.details || 'Awaiting analysis'}</span></td>
                <td>${statusPill}</td>
                <td class="text-right">
                    <button class="text-button text-red font-semibold text-xs" onclick="app.deleteFile(${index})">Remove</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // --- Drag and Drop File Simulation ---
    setupDragAndDrop() {
        const dropZone = document.getElementById('drop-zone');
        
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'var(--color-blue)';
                dropZone.style.backgroundColor = 'rgba(99, 102, 241, 0.05)';
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                dropZone.style.backgroundColor = 'rgba(255, 255, 255, 0.01)';
            }, false);
        });

        dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            this.addUploadedFiles(files);
        });
    }

    handleFileSelect(e) {
        const files = e.target.files;
        this.addUploadedFiles(files);
    }

    addUploadedFiles(files) {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const sizeMB = (f.size / (1024 * 1024)).toFixed(1);
            let detectedType = 'Supporting Spec';
            
            if (f.name.toLowerCase().endsWith('.pdf')) {
                if (f.name.toLowerCase().includes('plan') || f.name.toLowerCase().includes('layout') || f.name.toLowerCase().includes('drawing')) {
                    detectedType = 'Architectural Drawing';
                } else {
                    detectedType = 'Tender Specification';
                }
            } else if (f.name.toLowerCase().endsWith('.xlsx') || f.name.toLowerCase().endsWith('.xls') || f.name.toLowerCase().endsWith('.csv')) {
                if (f.name.toLowerCase().includes('sor') || f.name.toLowerCase().includes('rates')) {
                    detectedType = 'SOR Sheet';
                } else {
                    detectedType = 'Bill of Quantities';
                }
            }

            this.state.uploadedFiles.push({
                name: f.name,
                size: `${sizeMB} MB`,
                rawSize: f.size,
                type: detectedType,
                status: 'Pending',
                details: 'File uploaded. Ready for AI processing.',
                fileRef: f
            });
        }
        
        this.renderFileList();
    }

    deleteFile(index) {
        this.state.uploadedFiles.splice(index, 1);
        this.renderFileList();
    }

    async simulateFileAnalysis() {
        const pendingFiles = this.state.uploadedFiles.filter(f => f.status === 'Pending');
        if (pendingFiles.length === 0) return;

        document.getElementById('btn-process-files').disabled = true;

        pendingFiles.forEach((file) => {
            file.status = 'Analyzing';
        });
        this.renderFileList();

        let count = 0;
        for (const fileObj of pendingFiles) {
            try {
                const rawFile = fileObj.fileRef;
                if (!rawFile) {
                    throw new Error('Raw file reference missing.');
                }
                
                const formData = new FormData();
                formData.append('file', rawFile);
                
                const result = await this.apiFetch('/api/analyze-document', {
                    method: 'POST',
                    body: formData
                });
                
                if (result.success) {
                    const wsId = result.projectId;
                    
                    // Update UI status to reflect repricing process
                    fileObj.details = `Extracted ${result.itemsCount} items. Running AI pricing engine...`;
                    this.renderFileList();
                    
                    // Call backend repricer to apply AI rates to the new project estimate
                    await this.apiFetch(`/api/projects/${wsId}/reprice`, {
                        method: 'POST',
                        body: { forceLocal: false }
                    });
                    
                    fileObj.status = 'Analysed';
                    fileObj.details = `Calculated GIA, scale verified, and priced ${result.itemsCount} items with AI.`;
                    
                    // Refetch projects and reload data
                    await this.loadInitialData();
                    // Load the newly created workspace
                    this.loadWorkspace(wsId);
                    
                    count++;
                } else {
                    throw new Error(result.error || 'Failed analysis');
                }
            } catch (err) {
                console.error('Failed to analyze file:', err);
                fileObj.status = 'Pending';
                fileObj.details = `Error: ${err.message}`;
            }
            this.renderFileList();
        }

        if (count > 0) {
            this.state.notifications.unshift({
                id: 'n-' + Date.now(),
                title: 'Analysis Completed',
                body: `${count} tender documents successfully categorized & indexed. Map rates now.`,
                time: 'Just now',
                read: false
            });
            this.renderNotifications();
            this.updateNotificationCount();
            
            setTimeout(() => {
                if (confirm("AI Classification complete! Would you like to view the quantity take-off viewer for measurement validation?")) {
                    this.switchPanel('takeoff');
                }
            }, 300);
        }
    }

    // --- Workspace Selector simulation ---
    loadWorkspace(wsId) {
        this.state.activeWorkspaceId = wsId;
        const workspace = this.state.workspaces.find(w => w.id === wsId);
        
        this.state.targetMargin = 10.0;
        this.state.targetContingency = 3.0;
        
        // Show status load alert
        alert(`Switched to active workspace: ${workspace.name}`);
        
        // Load actual project details from database
        this.loadActiveWorkspaceEstimate().then(() => {
            this.apiFetch(`/api/projects/${wsId}`).then(proj => {
                this.state.targetMargin = proj.margin || 10.0;
                this.state.targetContingency = proj.contingency || 3.0;
                
                // Sync sliders and recalculate tender totals with the correct project parameters
                if (this.advisor) {
                    this.advisor.updateAdjusterSliders();
                    this.advisor.recalculateTenderTotals();
                }
                
                // Switch directly to pricing panel and re-render
                this.switchPanel('pricing');
                this.renderAll();
            }).catch(err => {
                console.error('Error loading project details:', err);
                this.switchPanel('pricing');
                this.renderAll();
            });
        });
    }

    openNewProjectModal() {
        document.getElementById('create-project-modal').style.display = 'flex';
        document.getElementById('new-proj-start').value = new Date().toISOString().split('T')[0];
    }

    closeNewProjectModal() {
        document.getElementById('create-project-modal').style.display = 'none';
        document.getElementById('new-proj-name').value = '';
        document.getElementById('new-proj-client').value = '';
        document.getElementById('new-proj-address').value = '';
        document.getElementById('new-proj-ref').value = '';
        document.getElementById('new-proj-notes').value = '';
        document.getElementById('new-proj-duration').value = '';
    }

    async saveNewProject() {
        const name = document.getElementById('new-proj-name').value.trim();
        const client = document.getElementById('new-proj-client').value.trim();
        const address = document.getElementById('new-proj-address').value.trim();
        const tenderRef = document.getElementById('new-proj-ref').value.trim();
        const tradeCategory = document.getElementById('new-proj-category').value;
        const startDate = document.getElementById('new-proj-start').value;
        const duration = document.getElementById('new-proj-duration').value.trim();
        const notes = document.getElementById('new-proj-notes').value.trim();

        if (!name) {
            alert('Project Name is required.');
            return;
        }

        try {
            const newProj = await this.apiFetch('/api/projects', {
                method: 'POST',
                body: {
                    name,
                    client,
                    address,
                    tenderRef,
                    tradeCategory,
                    startDate,
                    duration,
                    notes
                }
            });

            this.closeNewProjectModal();
            alert(`Tender project "${name}" created successfully.`);
            
            await this.loadInitialData();
            this.loadWorkspace(newProj.id);
        } catch (err) {
            console.error('Error creating project:', err);
            alert('Failed to create project: ' + err.message);
        }
    }

    async deleteProject(wsId) {
        const workspace = this.state.workspaces.find(w => w.id === wsId);
        const name = workspace ? workspace.name : 'this project';
        if (!confirm(`Are you sure you want to delete the tender workspace "${name}"? This will permanently remove all items, calculations, and estimates.`)) return;
        
        try {
            await this.apiFetch(`/api/projects/${wsId}`, {
                method: 'DELETE'
            });
            alert('Project deleted successfully.');
            
            if (this.state.activeWorkspaceId === wsId) {
                this.state.activeWorkspaceId = null;
            }
            
            await this.loadInitialData();
            
            if (this.state.workspaces.length > 0) {
                this.loadWorkspace(this.state.workspaces[0].id);
            } else {
                this.renderAll();
            }
        } catch (err) {
            console.error('Error deleting project:', err);
            alert('Failed to delete project: ' + err.message);
        }
    }

    // --- Helper Formatters ---
    formatCurrency(amount) {
        return new Intl.NumberFormat('en-GB', {
            style: 'currency',
            currency: 'GBP',
            maximumFractionDigits: 0
        }).format(amount);
    }

    formatDate(dateString) {
        const options = { year: 'numeric', month: 'short', day: 'numeric' };
        return new Date(dateString).toLocaleDateString('en-GB', options);
    }
}

// Initialise App on Load
const app = new QSProApp();
window.addEventListener('DOMContentLoaded', () => {
    // Bind modules once they load
    app.takeoff = window.takeoffComponent;
    app.pricing = window.pricingComponent;
    app.advisor = window.advisorComponent;
    app.proposal = window.proposalComponent;
    app.library = window.libraryComponent;
    
    // Initialize component instances
    if (app.pricing) app.pricing.init();
    if (app.advisor) app.advisor.init();
    if (app.library) app.library.init();
    
    app.init();
    
    // Setup Advisor items on dashboard
    if (app.advisor) {
        app.advisor.populateDashboardQuickList();
    }
});
window.app = app;
