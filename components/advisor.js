/**
 * QS Pro AI - AI Commercial Advisor & Risk Component
 */

class AdvisorComponent {
    constructor() {
        this.checklist = [];
        this.chatHistory = [
            { sender: 'advisor', message: "Welcome to the AI Commercial Advisor. I will monitor compliance risks, rate exposure, and contingency values once you upload drawings and calculate estimates." }
        ];
    }

    init() {
        this.setupEventListeners();
        this.recalculateTenderTotals();
        this.generateAIChecklist();
        this.render();
    }

    async generateAIChecklist() {
        if (!app.state.activeWorkspaceId) return;
        try {
            const response = await app.apiFetch('/api/chat', {
                method: 'POST',
                body: {
                    message: "Analyze this project's estimate and generate exactly 4 critical commercial risk checklist items tailored specifically to the estimate items. Return a JSON array of objects. Format: [{\"id\": \"chk-1\", \"title\": \"...\", \"desc\": \"...\", \"risk\": \"high\" | \"medium\" | \"low\", \"checked\": false}]. Do not wrap in markdown code blocks.",
                    projectId: app.state.activeWorkspaceId
                }
            });
            
            const jsonStr = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
            const list = JSON.parse(jsonStr);
            if (Array.isArray(list) && list.length > 0) {
                this.checklist = list;
                this.renderChecklist();
                this.updateHealthGauge();
                this.populateDashboardQuickList();
            }
        } catch (err) {
            console.error('Error generating AI checklist:', err);
            this.checklist = [
                { id: 'chk-err', title: 'Risk Checklist Offline', desc: 'Could not connect to the advisor API to analyze risks. Please retry.', risk: 'low', checked: false }
            ];
            this.renderChecklist();
            this.updateHealthGauge();
            this.populateDashboardQuickList();
        }
    }

    setupEventListeners() {
        // Margin slider
        const sliderMargin = document.getElementById('slider-margin');
        sliderMargin.addEventListener('input', (e) => {
            app.state.targetMargin = parseFloat(e.target.value);
            document.getElementById('lbl-margin-val').innerText = app.state.targetMargin.toFixed(1) + '%';
            this.recalculateTenderTotals();
            this.saveProjectParameters();
        });

        // Contingency slider
        const sliderContingency = document.getElementById('slider-contingency');
        sliderContingency.addEventListener('input', (e) => {
            app.state.targetContingency = parseFloat(e.target.value);
            document.getElementById('lbl-contingency-val').innerText = app.state.targetContingency.toFixed(1) + '%';
            this.recalculateTenderTotals();
            this.saveProjectParameters();
        });

        // Chat send button
        document.getElementById('btn-chat-send').addEventListener('click', () => this.handleChatInput());
        document.getElementById('chat-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleChatInput();
            }
        });
    }

    async saveProjectParameters() {
        if (!app.state.activeWorkspaceId) return;
        try {
            await app.apiFetch(`/api/projects/${app.state.activeWorkspaceId}`, {
                method: 'PUT',
                body: {
                    margin: app.state.targetMargin,
                    contingency: app.state.targetContingency
                }
            });
        } catch (err) {
            console.error('Error saving project parameters:', err);
        }
    }

    render() {
        this.renderChecklist();
        this.renderChat();
        this.updateHealthGauge();
        this.updateAdjusterSliders();
    }

    // --- Dynamic Slider Values ---
    updateAdjusterSliders() {
        document.getElementById('slider-margin').value = app.state.targetMargin;
        document.getElementById('lbl-margin-val').innerText = app.state.targetMargin.toFixed(1) + '%';
        
        document.getElementById('slider-contingency').value = app.state.targetContingency;
        document.getElementById('lbl-contingency-val').innerText = app.state.targetContingency.toFixed(1) + '%';
    }

    // --- Math Calculations ---
    recalculateTenderTotals() {
        if (!app.pricing) return;

        // Base Cost = Sum of (current_rate * qty) for all items in catalog
        const baseCost = app.pricing.rates.reduce((sum, item) => sum + (item.current * item.qty), 0);
        
        // Contingency amount
        const contingencyAmt = baseCost * (app.state.targetContingency / 100);
        
        // Gross Marked-up cost (standard quantity surveying margin division formula)
        // Bid = (Base + Contingency) / (1 - Margin%)
        const divisor = 1 - (app.state.targetMargin / 100);
        const finalBid = divisor > 0 ? (baseCost + contingencyAmt) / divisor : (baseCost + contingencyAmt);
        const grossCost = finalBid - baseCost;

        // Update DOM displays
        document.getElementById('breakdown-base-cost').innerText = app.formatCurrency(baseCost);
        document.getElementById('breakdown-contingency-cost').innerText = app.formatCurrency(contingencyAmt);
        document.getElementById('breakdown-gross-cost').innerText = app.formatCurrency(grossCost - contingencyAmt);
        document.getElementById('breakdown-final-bid').innerText = app.formatCurrency(finalBid);

        // Update State workspace record
        const activeWs = app.state.workspaces.find(w => w.id === app.state.activeWorkspaceId);
        if (activeWs) {
            activeWs.baseCost = baseCost;
            activeWs.value = Math.round(finalBid);
        }

        // Refresh global displays
        app.updateGlobalMetrics();
        app.renderWorkspaceTable();
    }

    // --- Render Health Score Speedometer ---
    calculateHealthScore() {
        let score = 98;

        // Deducts based on unchecked high risk items
        const uncheckedHigh = this.checklist.filter(c => !c.checked && c.risk === 'high').length;
        const uncheckedMed = this.checklist.filter(c => !c.checked && c.risk === 'medium').length;

        score -= (uncheckedHigh * 12);
        score -= (uncheckedMed * 6);

        // Deducts if pricing mode is too volatile (e.g. Market rates or high risk)
        if (app.state.pricingMode === 'market') {
            score -= 5;
        }

        return Math.max(30, Math.min(99, score));
    }

    updateHealthGauge() {
        const score = this.calculateHealthScore();
        
        // Update active workspace health
        const activeWs = app.state.workspaces.find(w => w.id === app.state.activeWorkspaceId);
        if (activeWs) activeWs.health = score;

        // SVG gauge fill (stroke-dasharray="125.6" which represents semi-circle of r=40)
        const circumference = 125.6;
        const offset = circumference * (1 - score / 100);
        
        const fillPath = document.getElementById('risk-gauge-fill');
        if (fillPath) {
            fillPath.style.strokeDashoffset = offset;
            
            // Adjust gauge color dynamically
            if (score > 85) {
                fillPath.style.stroke = 'var(--color-emerald)';
            } else if (score > 65) {
                fillPath.style.stroke = 'var(--color-amber)';
            } else {
                fillPath.style.stroke = 'var(--color-red)';
            }
        }

        const scoreValDiv = document.getElementById('risk-gauge-value');
        if (scoreValDiv) {
            scoreValDiv.innerText = `${score}%`;
        }

        // Set descriptive text
        const desc = document.getElementById('health-description');
        if (desc) {
            if (score > 85) {
                desc.innerText = 'High Confidence. Commercial risks fully mitigated.';
                desc.className = 'text-center text-emerald text-sm font-semibold';
            } else if (score > 65) {
                desc.innerText = 'Moderate Risk. Review checklist to recover prelims & inflation.';
                desc.className = 'text-center text-amber text-sm font-semibold';
            } else {
                desc.innerText = 'Caution: High Exposure. Unrecovered preliminaries & materials inflation.';
                desc.className = 'text-center text-red text-sm font-semibold';
            }
        }
    }

    // --- Render Risk Checklist ---
    renderChecklist() {
        const container = document.getElementById('risk-checklist-items');
        if (!container) return;

        container.innerHTML = '';
        
        // Update badge on sidebar
        const uncompletedCount = this.checklist.filter(c => !c.checked).length;
        const badge = document.getElementById('risk-badge');
        if (uncompletedCount > 0) {
            badge.style.display = 'inline-block';
            badge.innerText = uncompletedCount;
        } else {
            badge.style.display = 'none';
        }

        this.checklist.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = `checklist-item risk-${item.risk}`;
            div.innerHTML = `
                <input type="checkbox" class="checklist-check cursor-pointer" ${item.checked ? 'checked' : ''} onchange="advisorComponent.toggleChecklist(${index})">
                <div class="flex-grow">
                    <span class="checklist-title font-semibold ${item.checked ? 'text-secondary line-through' : ''}">${item.title}</span>
                    <span class="badge badge-gray text-xs ml-2">${item.risk} risk</span>
                    <p class="checklist-desc">${item.desc}</p>
                </div>
            `;
            container.appendChild(div);
        });
    }

    toggleChecklist(index) {
        const item = this.checklist[index];
        item.checked = !item.checked;
        
        // Add chat feedback
        if (item.checked) {
            this.addMessage('advisor', `Resolved: <strong>${item.title}</strong> is marked as managed. Uplifting health score index.`);
        } else {
            this.addMessage('advisor', `Warning: <strong>${item.title}</strong> is now unmitigated. Review exposure values.`);
        }

        this.render();
        this.recalculateTenderTotals();
        this.populateDashboardQuickList();
    }

    // --- AI Chat Simulation ---
    renderChat() {
        const container = document.getElementById('advisory-chat-messages');
        if (!container) return;

        container.innerHTML = '';
        
        this.chatHistory.forEach(c => {
            const bubble = document.createElement('div');
            bubble.className = `chat-bubble bubble-${c.sender}`;
            bubble.innerHTML = c.message;
            container.appendChild(bubble);
        });

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    addMessage(sender, message) {
        this.chatHistory.push({ sender, message });
        this.renderChat();
    }

    async handleChatInput() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;

        // Render user message
        this.addMessage('user', text);
        input.value = '';

        // Add a typing indicator
        this.addMessage('advisor', '<span class="dot-pulse"></span> Thinking...');
        const messages = this.chatHistory;
        const typingBubbleIndex = messages.length - 1;

        try {
            const response = await app.apiFetch('/api/chat', {
                method: 'POST',
                body: {
                    message: text,
                    projectId: app.state.activeWorkspaceId
                }
            });
            
            // Replace typing bubble with response
            messages[typingBubbleIndex].message = response.text;
            this.renderChat();
        } catch (err) {
            console.error('Error in AI Advisor Chat:', err);
            messages[typingBubbleIndex].message = `Offline: Sorry, I had trouble connecting to the AI service. (${err.message})`;
            this.renderChat();
        }
    }

    // --- Dashboard Integration ---
    populateDashboardQuickList() {
        const container = document.getElementById('advisor-quick-list');
        if (!container) return;

        container.innerHTML = '';
        
        // Grab top 2 unchecked risk items
        const unchecked = this.checklist.filter(c => !c.checked).slice(0, 2);
        
        if (unchecked.length === 0) {
            container.innerHTML = `
                <div class="advisor-quick-item">
                    <svg class="advisor-quick-item-icon text-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    <div class="advisor-quick-item-content">
                        <span class="advisor-quick-title font-bold">All clear!</span>
                        <span class="advisor-quick-desc">Tender Health is optimized at maximum confidence score.</span>
                    </div>
                </div>
            `;
            return;
        }

        unchecked.forEach(item => {
            const iconColor = item.risk === 'high' ? 'text-red' : 'text-amber';
            const alertIcon = `<svg class="advisor-quick-item-icon ${iconColor}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

            const div = document.createElement('div');
            div.className = 'advisor-quick-item';
            div.innerHTML = `
                ${alertIcon}
                <div class="advisor-quick-item-content">
                    <span class="advisor-quick-title font-semibold">${item.title}</span>
                    <span class="advisor-quick-desc">${item.desc}</span>
                </div>
            `;
            container.appendChild(div);
        });
    }
}

// Instantiate and expose globally
const advisorComponent = new AdvisorComponent();
window.advisorComponent = advisorComponent;
