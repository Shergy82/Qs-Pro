/**
 * QS Pro AI - Main Coordinator & State Manager
 * Safer full rewrite
 */

class QSProApp {
    constructor() {
        this.state = {
            activePanel: 'dashboard',
            pricingMode: 'company',
            targetMargin: 10.0,
            targetContingency: 3.0,

            workspaces: [],
            uploadedFiles: [],
            notifications: [],
            activeWorkspaceId: null,
            token: null,
            user: null
        };

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

        if (!path.startsWith('/')) {
            path = `/${path}`;
        }

        if (window.location.origin.includes('3001')) {
            return path;
        }

        return `${backendOrigin}${path}`;
    }

    async apiFetch(url, options = {}) {
        const fetchOptions = {
            ...options,
            headers: {
                ...(options.headers || {})
            }
        };

        if (this.state.token) {
            fetchOptions.headers.Authorization = `Bearer ${this.state.token}`;
        }

        const isFormData = fetchOptions.body instanceof FormData;

        if (!isFormData && fetchOptions.body && typeof fetchOptions.body === 'object') {
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(fetchOptions.body);
        }

        const response = await fetch(this.getApiUrl(url), fetchOptions);

        let data = null;
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
            data = await response.json().catch(() => null);
        } else {
            const text = await response.text().catch(() => '');
            data = text ? { error: text } : null;
        }

        if (!response.ok) {
            throw new Error(data?.error || data?.message || `HTTP error: ${response.status}`);
        }

        return data;
    }

    async autoLogin() {
        console.log('QS Pro AI - attempting automatic login...');

        try {
            const loginData = await this.apiFetch('/api/auth/login', {
                method: 'POST',
                body: {
                    email: 'demo@truecostqs.com',
                    password: 'password123'
                }
            });

            this.state.token = loginData.token;
            this.state.user = loginData.user;

            console.log('Login successful:', this.state.user?.email);
        } catch (loginErr) {
            console.warn('Login failed. Trying demo registration...', loginErr.message);

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

                console.log('Registration/login successful:', this.state.user?.email);
            } catch (regErr) {
                console.error('Auto-login and registration failed:', regErr);

                alert(
                    'Connection to backend failed. Please check the backend server is running on http://localhost:3001'
                );

                return false;
            }
        }

        if (this.state.user) {
            this.state.targetMargin = Number(this.state.user.margin) || 10.0;
            this.state.targetContingency = Number(this.state.user.contingency) || 3.0;
        }

        return true;
    }

    async loadInitialData() {
        try {
            const projects = await this.apiFetch('/api/projects');

            this.state.workspaces = Array.isArray(projects)
                ? projects.map((proj) => ({
                    id: proj.id,
                    name: proj.name || 'Untitled Tender',
                    client: proj.client || 'Client Pending',
                    dueDate:
                        proj.startDate ||
                        new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
                            .toISOString()
                            .split('T')[0],
                    baseCost: Number(proj.totalCost) || 0,
                    value: Number(proj.sellPrice) || 0,
                    status: proj.status || 'Draft',
                    health: Number(proj.health) || 98,
                    margin: Number(proj.margin) || 10.0,
                    contingency: Number(proj.contingency) || 3.0
                }))
                : [];

            if (this.state.workspaces.length > 0 && !this.state.activeWorkspaceId) {
                this.state.activeWorkspaceId = this.state.workspaces[0].id;
            }

            const activeWorkspace = this.state.workspaces.find(
                (w) => w.id === this.state.activeWorkspaceId
            );

            if (activeWorkspace) {
                this.state.targetMargin = activeWorkspace.margin || 10.0;
                this.state.targetContingency = activeWorkspace.contingency || 3.0;
            }

            if (this.pricing) {
                if (typeof this.pricing.loadRatesFromBackend === 'function') {
                    await this.pricing.loadRatesFromBackend();
                }

                if (typeof this.pricing.loadSupplierFeeds === 'function') {
                    await this.pricing.loadSupplierFeeds();
                }

                if (typeof this.pricing.loadHistoricalTenders === 'function') {
                    await this.pricing.loadHistoricalTenders();
                }
            }

            if (this.state.activeWorkspaceId) {
                await this.loadActiveWorkspaceEstimate();
            }

            this.renderAll();
        } catch (err) {
            console.error('Error loading initial data:', err);
            this.renderAll();
        }
    }

    async loadActiveWorkspaceEstimate() {
        if (!this.state.activeWorkspaceId) return;

        try {
            const estimates = await this.apiFetch(
                `/api/projects/${this.state.activeWorkspaceId}/estimates`
            );

            if (this.pricing && typeof this.pricing.syncRatesFromEstimates === 'function') {
                this.pricing.syncRatesFromEstimates(estimates || []);
            }

            if (this.advisor) {
                if (typeof this.advisor.generateAIChecklist === 'function') {
                    this.advisor.generateAIChecklist();
                }

                if (typeof this.advisor.recalculateTenderTotals === 'function') {
                    this.advisor.recalculateTenderTotals();
                }
            }

            if (this.proposal) {
                this.proposal.veOpportunities = [];
            }
        } catch (err) {
            console.error('Error loading active workspace estimate:', err);
        }
    }

    setupEventListeners() {
        document.querySelectorAll('.menu-item').forEach((item) => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const panelName = item.getAttribute('data-panel');
                if (panelName) this.switchPanel(panelName);
            });
        });

        const alertBell = document.getElementById('alert-bell');
        const drawer = document.getElementById('notifications-drawer');

        if (alertBell && drawer) {
            alertBell.addEventListener('click', (e) => {
                e.stopPropagation();
                drawer.classList.toggle('active');
            });

            document.addEventListener('click', (e) => {
                if (
                    drawer &&
                    !drawer.contains(e.target) &&
                    e.target !== alertBell &&
                    !alertBell.contains(e.target)
                ) {
                    drawer.classList.remove('active');
                }
            });
        }

        const markAllRead = document.getElementById('mark-all-read');
        if (markAllRead) {
            markAllRead.addEventListener('click', () => {
                this.state.notifications = [];
                this.renderNotifications();
                this.updateNotificationCount();
            });
        }

        const btnProcess = document.getElementById('btn-process-files');
        if (btnProcess) {
            btnProcess.addEventListener('click', () => this.simulateFileAnalysis());
        }

        const fileInput = document.getElementById('file-input');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        }
    }

    initRouter() {
        const hash = window.location.hash.replace('#', '');

        if (hash && document.getElementById(`${hash}-panel`)) {
            this.switchPanel(hash, false);
        } else {
            this.switchPanel('dashboard', false);
        }

        window.addEventListener('hashchange', () => {
            const currentHash = window.location.hash.replace('#', '');

            if (currentHash && document.getElementById(`${currentHash}-panel`)) {
                this.switchPanel(currentHash, false);
            }
        });
    }

    switchPanel(panelName, updateHash = true) {
        if (!panelName) return;

        const targetPanel = document.getElementById(`${panelName}-panel`);
        if (!targetPanel) {
            console.warn(`Panel not found: ${panelName}`);
            return;
        }

        document.querySelectorAll('.panel').forEach((panel) => {
            panel.classList.remove('active');
        });

        targetPanel.classList.add('active');
        this.state.activePanel = panelName;

        document.querySelectorAll('.menu-item').forEach((item) => {
            item.classList.toggle('active', item.getAttribute('data-panel') === panelName);
        });

        const titles = {
            dashboard: {
                title: 'Dashboard',
                subtitle: 'Welcome back, here is your estimation pipeline overview.'
            },
            upload: {
                title: 'Tender Upload & Document Center',
                subtitle: 'Upload drawings, specifications, bills of quantities, and schedule of rates.'
            },
            takeoff: {
                title: 'AI Quantity Take-Off & Measurements',
                subtitle: 'Click on plans to measure area dimensions and map architectural scopes.'
            },
            pricing: {
                title: 'Intelligent Pricing Engine',
                subtitle: 'Compare company pricing against live market indices and regional supplier databases.'
            },
            library: {
                title: 'Global Price Library & Rate Book',
                subtitle: 'Remember and update materials, plant, subcontractor element prices, and trade daily rates.'
            },
            sor: {
                title: 'Automated Schedule of Rates Pricing',
                subtitle: 'Map client items to pricing databases instantly using cognitive matching.'
            },
            risk: {
                title: 'Profit & Risk Commercial Advisor',
                subtitle: 'Review omissions checklist, inflation risk, and calibrate project margin targets.'
            },
            proposal: {
                title: 'Proposal & Client Quotation Generator',
                subtitle: 'Brand, compile, and finalize the professional commercial quote submission.'
            }
        };

        const titleData = titles[panelName] || {
            title: 'QS Pro AI',
            subtitle: 'Quantity Surveying Platform'
        };

        const titleEl = document.getElementById('current-panel-title');
        const subtitleEl = document.getElementById('current-panel-subtitle');

        if (titleEl) titleEl.innerText = titleData.title;
        if (subtitleEl) subtitleEl.innerText = titleData.subtitle;

        if (updateHash && window.location.hash !== `#${panelName}`) {
            window.location.hash = panelName;
        }

        this.triggerPanelCallback(panelName);
    }

    triggerPanelCallback(panelName) {
        if (panelName === 'takeoff' && this.takeoff?.onPanelShow) {
            this.takeoff.onPanelShow();
        }

        if (panelName === 'pricing' && this.pricing?.render) {
            this.pricing.render();
        }

        if (panelName === 'library' && this.library?.render) {
            this.library.render();
        }

        if (panelName === 'sor' && this.pricing?.renderSOR) {
            this.pricing.renderSOR();
        }

        if (panelName === 'risk' && this.advisor?.render) {
            this.advisor.render();
        }

        if (panelName === 'proposal' && this.proposal?.render) {
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

    updateGlobalMetrics() {
        const pipelineBids = this.state.workspaces.filter((ws) =>
            ['Draft', 'Estimating', 'Pending', 'Review'].includes(ws.status)
        );

        const total = pipelineBids.reduce((sum, ws) => sum + (Number(ws.value) || 0), 0);

        const globalPipelineValEl = document.getElementById('global-pipeline-val');
        if (globalPipelineValEl) {
            globalPipelineValEl.innerText = this.formatCurrency(total);
        }

        const wonBids = this.state.workspaces.filter((ws) => ws.status === 'Won');
        const totalClosed = this.state.workspaces.filter((ws) =>
            ['Won', 'Lost', 'Submitted'].includes(ws.status)
        ).length;

        const winRate = totalClosed > 0 ? (wonBids.length / totalClosed) * 100 : 0;

        const globalWinRateEl = document.getElementById('global-win-rate');
        if (globalWinRateEl) {
            globalWinRateEl.innerText = `${winRate.toFixed(1)}%`;
        }

        const liveBidsVal = document.getElementById('stat-live-bids-val');
        if (liveBidsVal) {
            liveBidsVal.innerText = `${pipelineBids.length} Bid${pipelineBids.length === 1 ? '' : 's'
                }`;
        }

        const liveBidsTrend = document.getElementById('stat-live-bids-trend');
        if (liveBidsTrend) {
            liveBidsTrend.innerText =
                pipelineBids.length > 0 ? `Pipeline: ${this.formatCurrency(total)}` : 'No active bids';
        }

        const wonTotal = wonBids.reduce((sum, ws) => sum + (Number(ws.value) || 0), 0);

        const wonVal = document.getElementById('stat-won-val');
        if (wonVal) wonVal.innerText = this.formatCurrency(wonTotal);

        const wonTrend = document.getElementById('stat-won-trend');
        if (wonTrend) wonTrend.innerText = `${winRate.toFixed(1)}% win rate YTD`;

        const avgMargin =
            this.state.workspaces.length > 0
                ? this.state.workspaces.reduce(
                    (sum, ws) => sum + (Number(ws.margin) || this.state.targetMargin),
                    0
                ) / this.state.workspaces.length
                : this.state.targetMargin;

        const avgMarginVal = document.getElementById('stat-avg-margin');
        if (avgMarginVal) avgMarginVal.innerText = `${avgMargin.toFixed(1)}%`;

        const uncheckedHigh =
            this.advisor?.checklist?.filter((c) => !c.checked && c.risk === 'high').length || 0;

        const avgMarginTrend = document.getElementById('stat-avg-margin-trend');
        if (avgMarginTrend) {
            avgMarginTrend.innerText =
                uncheckedHigh > 0 ? `${uncheckedHigh} high risk exposure` : 'Target margin optimized';
        }

        const avgHealth =
            this.state.workspaces.length > 0
                ? Math.round(
                    this.state.workspaces.reduce(
                        (sum, ws) => sum + (Number(ws.health) || 0),
                        0
                    ) / this.state.workspaces.length
                )
                : 0;

        const heroHealthVal = document.getElementById('hero-health-val');
        if (heroHealthVal) {
            heroHealthVal.innerText = avgHealth > 0 ? `${avgHealth}%` : '--%';
        }

        const heroHealthCircle = document.getElementById('hero-health-circle');
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
        const unreadCount = this.state.notifications.filter((n) => !n.read).length;
        const bell = document.getElementById('alert-bell');
        const indicator = bell?.querySelector('.pulse-indicator');

        if (!indicator) return;

        indicator.style.display = unreadCount > 0 ? 'block' : 'none';
    }

    renderWorkspaceTable() {
        const tbody = document.getElementById('active-workspaces-tbody');
        if (!tbody) return;

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

        this.state.workspaces.forEach((ws) => {
            let statusBadge = '<span class="badge badge-gray">Pending</span>';

            if (ws.status === 'Estimating') {
                statusBadge = '<span class="badge badge-amber">Estimating</span>';
            } else if (ws.status === 'Won') {
                statusBadge = '<span class="badge badge-emerald">Won</span>';
            } else if (ws.status === 'Submitted') {
                statusBadge = '<span class="badge badge-blue">Submitted</span>';
            } else if (ws.status === 'Draft') {
                statusBadge = '<span class="badge badge-gray">Draft</span>';
            }

            let healthClass = 'text-emerald';
            if (ws.health < 80) healthClass = 'text-amber';
            if (ws.health < 60) healthClass = 'text-red';

            const tr = document.createElement('tr');

            tr.innerHTML = `
                <td class="font-semibold">${this.escapeHtml(ws.name)}</td>
                <td class="text-secondary">${this.escapeHtml(ws.client)}</td>
                <td>${this.formatDate(ws.dueDate)}</td>
                <td class="font-bold">${this.formatCurrency(ws.value)}</td>
                <td>${statusBadge}</td>
                <td class="${healthClass} font-bold">${Number(ws.health) || 0}%</td>
                <td>
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-secondary py-1 px-3 text-xs" data-open-workspace="${ws.id}">Open</button>
                        <button class="btn btn-secondary py-1 px-3 text-xs text-red" style="border-color: rgba(239, 68, 68, 0.2);" data-delete-workspace="${ws.id}">Delete</button>
                    </div>
                </td>
            `;

            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('[data-open-workspace]').forEach((button) => {
            button.addEventListener('click', () => {
                this.loadWorkspace(button.getAttribute('data-open-workspace'));
            });
        });

        tbody.querySelectorAll('[data-delete-workspace]').forEach((button) => {
            button.addEventListener('click', () => {
                this.deleteProject(button.getAttribute('data-delete-workspace'));
            });
        });
    }

    renderNotifications() {
        const list = document.getElementById('notifications-list');
        if (!list) return;

        list.innerHTML = '';

        if (this.state.notifications.length === 0) {
            list.innerHTML = `<div class="text-center text-secondary py-5 text-xs">No active alerts</div>`;
            return;
        }

        this.state.notifications.forEach((n) => {
            const div = document.createElement('div');
            div.className = `notification-item ${n.read ? '' : 'unread'}`;

            div.innerHTML = `
                <div class="notification-header">
                    <span class="notification-title font-semibold">${this.escapeHtml(n.title)}</span>
                    <span class="notification-time">${this.escapeHtml(n.time)}</span>
                </div>
                <div class="notification-body">${this.escapeHtml(n.body)}</div>
            `;

            div.addEventListener('click', () => {
                n.read = true;
                this.renderNotifications();
                this.updateNotificationCount();
                this.switchPanel('risk');
            });

            list.appendChild(div);
        });
    }

    renderFileList() {
        const tbody = document.getElementById('file-list-tbody');
        if (!tbody) return;

        tbody.innerHTML = '';

        const pendingFilesCount = this.state.uploadedFiles.filter(
            (f) => f.status === 'Pending'
        ).length;

        const badge = document.getElementById('upload-badge');
        if (badge) {
            badge.style.display = pendingFilesCount > 0 ? 'inline-block' : 'none';
            badge.innerText = String(pendingFilesCount);
        }

        const uploadedCount = document.getElementById('uploaded-count');
        if (uploadedCount) {
            uploadedCount.innerText = `${this.state.uploadedFiles.length} Files`;
        }

        const btnProcess = document.getElementById('btn-process-files');
        if (btnProcess) {
            btnProcess.disabled = pendingFilesCount === 0;
        }

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
            let statusPill = `<span class="status-pill status-pending"><span class="dot"></span>Pending</span>`;

            if (file.status === 'Analysed') {
                statusPill = `<span class="status-pill status-analyzed"><span class="dot"></span>Analysed</span>`;
            } else if (file.status === 'Analyzing') {
                statusPill = `<span class="status-pill status-analyzing"><span class="dot dot-pulse"></span>Scanning...</span>`;
            }

            const tr = document.createElement('tr');

            tr.innerHTML = `
                <td class="font-semibold">${this.escapeHtml(file.name)}</td>
                <td class="text-secondary">${this.escapeHtml(file.size)}</td>
                <td><span class="badge badge-gray">${this.escapeHtml(file.type)}</span></td>
                <td><span class="text-secondary text-xs">${this.escapeHtml(
                file.details || 'Awaiting analysis'
            )}</span></td>
                <td>${statusPill}</td>
                <td class="text-right">
                    <button class="text-button text-red font-semibold text-xs" data-delete-file="${index}">Remove</button>
                </td>
            `;

            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('[data-delete-file]').forEach((button) => {
            button.addEventListener('click', () => {
                const index = Number(button.getAttribute('data-delete-file'));
                this.deleteFile(index);
            });
        });
    }

    setupDragAndDrop() {
        const dropZone = document.getElementById('drop-zone');
        if (!dropZone) return;

        ['dragenter', 'dragover'].forEach((eventName) => {
            dropZone.addEventListener(
                eventName,
                (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropZone.style.borderColor = 'var(--color-blue)';
                    dropZone.style.backgroundColor = 'rgba(99, 102, 241, 0.05)';
                },
                false
            );
        });

        ['dragleave', 'drop'].forEach((eventName) => {
            dropZone.addEventListener(
                eventName,
                (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropZone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                    dropZone.style.backgroundColor = 'rgba(255, 255, 255, 0.01)';
                },
                false
            );
        });

        dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer?.files;
            if (files?.length) {
                this.addUploadedFiles(files);
            }
        });
    }

    handleFileSelect(e) {
        const files = e.target?.files;
        if (files?.length) {
            this.addUploadedFiles(files);
        }

        if (e.target) {
            e.target.value = '';
        }
    }

    addUploadedFiles(files) {
        Array.from(files).forEach((f) => {
            const sizeMB = (f.size / (1024 * 1024)).toFixed(1);
            const lowerName = f.name.toLowerCase();

            let detectedType = 'Supporting Spec';

            if (lowerName.endsWith('.pdf')) {
                if (
                    lowerName.includes('plan') ||
                    lowerName.includes('layout') ||
                    lowerName.includes('drawing')
                ) {
                    detectedType = 'Architectural Drawing';
                } else {
                    detectedType = 'Tender Specification';
                }
            } else if (
                lowerName.endsWith('.xlsx') ||
                lowerName.endsWith('.xls') ||
                lowerName.endsWith('.csv')
            ) {
                if (lowerName.includes('sor') || lowerName.includes('rates')) {
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
        });

        this.renderFileList();
    }

    deleteFile(index) {
        if (Number.isNaN(index)) return;

        this.state.uploadedFiles.splice(index, 1);
        this.renderFileList();
    }

    async simulateFileAnalysis() {
        const pendingFiles = this.state.uploadedFiles.filter((f) => f.status === 'Pending');
        if (pendingFiles.length === 0) return;

        const btnProcess = document.getElementById('btn-process-files');
        if (btnProcess) btnProcess.disabled = true;

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

                if (!result?.success) {
                    throw new Error(result?.error || 'Document analysis failed.');
                }

                const wsId = result.projectId;

                fileObj.details = `Extracted ${result.itemsCount || 0} items. Running AI pricing engine...`;
                this.renderFileList();

                if (wsId) {
                    await this.apiFetch(`/api/projects/${wsId}/reprice`, {
                        method: 'POST',
                        body: {
                            forceLocal: false
                        }
                    });
                }

                fileObj.status = 'Analysed';
                fileObj.details = `Calculated GIA, scale verified, and priced ${result.itemsCount || 0
                    } items with AI.`;

                await this.loadInitialData();

                if (wsId) {
                    await this.loadWorkspace(wsId, false);
                }

                count++;
            } catch (err) {
                console.error('Failed to analyse file:', err);

                fileObj.status = 'Pending';
                fileObj.details = `Error: ${err.message}`;
            }

            this.renderFileList();
        }

        if (count > 0) {
            this.state.notifications.unshift({
                id: `n-${Date.now()}`,
                title: 'Analysis Completed',
                body: `${count} tender document${count === 1 ? '' : 's'} successfully categorised, indexed and priced.`,
                time: 'Just now',
                read: false
            });

            this.renderNotifications();
            this.updateNotificationCount();

            setTimeout(() => {
                const goToTakeoff = confirm(
                    'AI classification complete. Would you like to view the quantity take-off viewer for measurement validation?'
                );

                if (goToTakeoff) {
                    this.switchPanel('takeoff');
                }
            }, 300);
        }

        this.renderFileList();
    }

    async loadWorkspace(wsId, showAlert = true) {
        if (!wsId) return;

        this.state.activeWorkspaceId = wsId;

        const workspace = this.state.workspaces.find((w) => String(w.id) === String(wsId));

        this.state.targetMargin = workspace?.margin || 10.0;
        this.state.targetContingency = workspace?.contingency || 3.0;

        if (workspace && showAlert) {
            alert(`Switched to active workspace: ${workspace.name}`);
        }

        try {
            await this.loadActiveWorkspaceEstimate();

            const proj = await this.apiFetch(`/api/projects/${wsId}`);

            this.state.targetMargin = Number(proj.margin) || 10.0;
            this.state.targetContingency = Number(proj.contingency) || 3.0;

            if (this.advisor) {
                if (typeof this.advisor.updateAdjusterSliders === 'function') {
                    this.advisor.updateAdjusterSliders();
                }

                if (typeof this.advisor.recalculateTenderTotals === 'function') {
                    this.advisor.recalculateTenderTotals();
                }
            }

            this.switchPanel('pricing');
            this.renderAll();
        } catch (err) {
            console.error('Error loading workspace details:', err);

            this.switchPanel('pricing');
            this.renderAll();
        }
    }

    openNewProjectModal() {
        const modal = document.getElementById('create-project-modal');
        if (modal) modal.style.display = 'flex';

        const start = document.getElementById('new-proj-start');
        if (start) start.value = new Date().toISOString().split('T')[0];
    }

    closeNewProjectModal() {
        const modal = document.getElementById('create-project-modal');
        if (modal) modal.style.display = 'none';

        [
            'new-proj-name',
            'new-proj-client',
            'new-proj-address',
            'new-proj-ref',
            'new-proj-notes',
            'new-proj-duration'
        ].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    }

    async saveNewProject() {
        const name = document.getElementById('new-proj-name')?.value.trim() || '';
        const client = document.getElementById('new-proj-client')?.value.trim() || '';
        const address = document.getElementById('new-proj-address')?.value.trim() || '';
        const tenderRef = document.getElementById('new-proj-ref')?.value.trim() || '';
        const tradeCategory = document.getElementById('new-proj-category')?.value || '';
        const startDate = document.getElementById('new-proj-start')?.value || '';
        const duration = document.getElementById('new-proj-duration')?.value.trim() || '';
        const notes = document.getElementById('new-proj-notes')?.value.trim() || '';

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

            if (newProj?.id) {
                await this.loadWorkspace(newProj.id);
            }
        } catch (err) {
            console.error('Error creating project:', err);
            alert(`Failed to create project: ${err.message}`);
        }
    }

    async deleteProject(wsId) {
        if (!wsId) return;

        const workspace = this.state.workspaces.find((w) => String(w.id) === String(wsId));
        const name = workspace?.name || 'this project';

        const confirmed = confirm(
            `Are you sure you want to delete the tender workspace "${name}"? This will permanently remove all items, calculations, and estimates.`
        );

        if (!confirmed) return;

        try {
            await this.apiFetch(`/api/projects/${wsId}`, {
                method: 'DELETE'
            });

            alert('Project deleted successfully.');

            if (String(this.state.activeWorkspaceId) === String(wsId)) {
                this.state.activeWorkspaceId = null;
            }

            await this.loadInitialData();

            if (this.state.workspaces.length > 0) {
                await this.loadWorkspace(this.state.workspaces[0].id, false);
            } else {
                this.renderAll();
                this.switchPanel('dashboard');
            }
        } catch (err) {
            console.error('Error deleting project:', err);
            alert(`Failed to delete project: ${err.message}`);
        }
    }

    formatCurrency(amount) {
        return new Intl.NumberFormat('en-GB', {
            style: 'currency',
            currency: 'GBP',
            maximumFractionDigits: 0
        }).format(Number(amount) || 0);
    }

    formatDate(dateString) {
        if (!dateString) return '-';

        const date = new Date(dateString);

        if (Number.isNaN(date.getTime())) {
            return '-';
        }

        return date.toLocaleDateString('en-GB', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }
}

const app = new QSProApp();

window.app = app;

window.addEventListener('DOMContentLoaded', () => {
    app.takeoff = window.takeoffComponent || null;
    app.pricing = window.pricingComponent || null;
    app.advisor = window.advisorComponent || null;
    app.proposal = window.proposalComponent || null;
    app.library = window.libraryComponent || null;

    if (app.pricing?.init) app.pricing.init();
    if (app.advisor?.init) app.advisor.init();
    if (app.library?.init) app.library.init();

    app.init();

    if (app.advisor?.populateDashboardQuickList) {
        app.advisor.populateDashboardQuickList();
    }
});