/**
 * QS Pro AI - Proposal & Client Quote Generator Component
 */

class ProposalComponent {
    constructor() {
        this.veOpportunities = [];
        this.lastWorkspaceId = null;
        this.initializedMarkup = false;
        this.veWorkspaceId = null;
        this.veLoadingWorkspaceId = null;
    }

    init() {
        this.setupEventListeners();

        // Force proposal document to populate as soon as the component loads
        requestAnimationFrame(() => {
            this.ensureExecutiveSummarySection();
            this.render();
        });

        // Second pass in case pricing/workspace data arrives a moment later
        setTimeout(() => {
            this.ensureExecutiveSummarySection();
            this.render();
        }, 300);

        // Third pass for slower project/pricing hydration
        setTimeout(() => {
            this.ensureExecutiveSummarySection();
            this.render();
        }, 1000);
    }

    safelyAddListener(id, eventName, handler) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener(eventName, handler);
    }

    setText(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = value;
    }

    ensureExecutiveSummarySection() {
        const sheet = document.querySelector('.document-sheet');
        if (!sheet) return;

        const existingIntro = document.getElementById('preview-doc-intro');
        if (existingIntro) return;

        const section = document.createElement('div');
        section.id = 'preview-executive-summary-section';
        section.className = 'doc-section';

        section.innerHTML = `
            <h5>Executive Summary</h5>
            <p id="preview-doc-intro" style="line-height: 1.6; color: #334155; margin-top: 12px;">
                Following review of your tender drawings and architectural specification, we are pleased to submit our quote proposal for the proposed works. Our cost summary outlines the measured schedule items and associated tender value for your review.
            </p>
        `;

        const breakdownSection = document.getElementById('preview-breakdown-section');

        if (breakdownSection && breakdownSection.parentNode === sheet) {
            sheet.insertBefore(section, breakdownSection);
        } else {
            sheet.appendChild(section);
        }
    }

    setupEventListeners() {
        // Form inputs live binding
        this.safelyAddListener('proposal-company-name', 'input', (e) => {
            this.setText('preview-brand-name', e.target.value);

            const logo = document.querySelector('.doc-brand-logo');
            if (logo && e.target.value.length > 0) {
                logo.innerText = e.target.value.charAt(0).toUpperCase();
            }
        });

        this.safelyAddListener('proposal-reference', 'input', (e) => {
            this.setText('preview-doc-ref', e.target.value);
        });

        this.safelyAddListener('proposal-contact-person', 'input', (e) => {
            this.setText('preview-doc-contact', e.target.value);
        });

        this.safelyAddListener('proposal-intro-text', 'input', (e) => {
            this.ensureExecutiveSummarySection();
            this.setText('preview-doc-intro', e.target.value);
        });

        // Checkbox toggles
        this.safelyAddListener('chk-include-breakdown', 'change', (e) => {
            const section = document.getElementById('preview-breakdown-section');
            if (section) {
                section.style.display = e.target.checked ? 'block' : 'none';
            }
        });

        this.safelyAddListener('chk-include-ve', 'change', (e) => {
            const section = document.getElementById('preview-ve-section');
            if (section) {
                section.style.display = e.target.checked ? 'block' : 'none';
            }
        });

        // Print trigger
        this.safelyAddListener('btn-print-proposal', 'click', () => {
            window.print();
        });

        // Markup controls event listeners
        const sliderMarkup = document.getElementById('slider-proposal-markup');
        const inputMarkup = document.getElementById('input-proposal-markup');
        const chkApplyMarkup = document.getElementById('chk-apply-markup-to-rates');

        if (sliderMarkup && inputMarkup) {
            sliderMarkup.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;

                inputMarkup.value = val.toFixed(1);
                this.setText('lbl-proposal-markup-val', val.toFixed(1) + '%');

                if (window.app && app.state && app.state.activeWorkspaceId) {
                    localStorage.setItem(`proposal_markup_${app.state.activeWorkspaceId}`, val);
                }

                this.renderBreakdownTable();
                this.renderValueEngineering();
            });

            inputMarkup.addEventListener('input', (e) => {
                let val = parseFloat(e.target.value) || 0;

                if (val < 0) val = 0;
                if (val > 100) val = 100;

                sliderMarkup.value = val;
                this.setText('lbl-proposal-markup-val', val.toFixed(1) + '%');

                if (window.app && app.state && app.state.activeWorkspaceId) {
                    localStorage.setItem(`proposal_markup_${app.state.activeWorkspaceId}`, val);
                }

                this.renderBreakdownTable();
                this.renderValueEngineering();
            });
        }

        if (chkApplyMarkup) {
            chkApplyMarkup.addEventListener('change', (e) => {
                if (window.app && app.state && app.state.activeWorkspaceId) {
                    localStorage.setItem(`proposal_apply_markup_${app.state.activeWorkspaceId}`, e.target.checked ? 'true' : 'false');
                }

                this.renderBreakdownTable();
                this.renderValueEngineering();
            });
        }
    }

    getCombinedMarkup() {
        if (!window.app || !app.state) return 0;

        const contingency = app.state.targetContingency || 0;
        const margin = app.state.targetMargin || 0;

        if (margin >= 100) return contingency;

        const factor = (1 + contingency / 100) / (1 - margin / 100);
        return (factor - 1) * 100;
    }

    render() {
        this.ensureExecutiveSummarySection();

        if (!window.app || !app.state) return;

        if (this.lastWorkspaceId !== app.state.activeWorkspaceId) {
            this.lastWorkspaceId = app.state.activeWorkspaceId;
            this.initializedMarkup = false;
            this.veOpportunities = [];
            this.veWorkspaceId = null;
            this.veLoadingWorkspaceId = null;
        }

        // Auto-populate defaults if not set or default
        const companyInput = document.getElementById('proposal-company-name');
        const contactInput = document.getElementById('proposal-contact-person');
        const refInput = document.getElementById('proposal-reference');

        if (companyInput && (!companyInput.value || companyInput.value === 'Apex Builders Ltd')) {
            companyInput.value = (app.state.user && app.state.user.companyName) || 'GVD Contracts';
        }

        if (contactInput && (!contactInput.value || contactInput.value === 'Phil Estimator')) {
            contactInput.value = (app.state.user && app.state.user.estimatorName) || 'Phil Shergold';
        }

        if (refInput && (!refInput.value || refInput.value === 'TEN-2026-042' || refInput.value.startsWith('TEN-2026-042'))) {
            const activeWorkspace = Array.isArray(app.state.workspaces)
                ? app.state.workspaces.find(w => String(w.id) === String(app.state.activeWorkspaceId))
                : null;

            if (activeWorkspace) {
                let cleanName = activeWorkspace.name || 'TENDER';

                cleanName = cleanName
                    .replace(/ - AI Take-off/gi, '')
                    .replace(/Schedule of Works/gi, '')
                    .replace(/Works/gi, '')
                    .replace(/Specification/gi, '')
                    .replace(/Quote/gi, '')
                    .replace(/Tender/gi, '')
                    .trim();

                if (cleanName.includes('-')) {
                    cleanName = cleanName.split('-')[0].trim();
                }

                if (cleanName.includes('_')) {
                    cleanName = cleanName.split('_')[0].trim();
                }

                if (cleanName.length === 0) {
                    cleanName = 'TENDER';
                }

                const randomNum = Math.floor(100 + Math.random() * 900);
                refInput.value = `TEN-${cleanName.replace(/\s+/g, '-').toUpperCase()}-${randomNum}`;
            }
        }

        // Initialize markup inputs
        const sliderMarkup = document.getElementById('slider-proposal-markup');
        const inputMarkup = document.getElementById('input-proposal-markup');
        const chkApplyMarkup = document.getElementById('chk-apply-markup-to-rates');

        if (sliderMarkup && inputMarkup && !this.initializedMarkup) {
            let savedMarkup = null;
            let savedApply = null;

            if (app.state.activeWorkspaceId) {
                savedMarkup = localStorage.getItem(`proposal_markup_${app.state.activeWorkspaceId}`);
                savedApply = localStorage.getItem(`proposal_apply_markup_${app.state.activeWorkspaceId}`);
            }

            const defaultMarkup = savedMarkup !== null ? parseFloat(savedMarkup) : this.getCombinedMarkup();
            const defaultApply = savedApply !== null ? savedApply === 'true' : true;
            const safeMarkup = Number.isFinite(defaultMarkup) ? defaultMarkup : 0;

            sliderMarkup.value = safeMarkup.toFixed(1);
            inputMarkup.value = safeMarkup.toFixed(1);
            this.setText('lbl-proposal-markup-val', safeMarkup.toFixed(1) + '%');

            if (chkApplyMarkup) {
                chkApplyMarkup.checked = defaultApply;
            }

            this.initializedMarkup = true;
        }

        this.syncInputsToPreview();
        this.renderBreakdownTable();
        this.generateAIVeOpportunities();
        this.renderValueEngineering();
    }

    async generateAIVeOpportunities() {
        if (!window.app || !app.state || !app.state.activeWorkspaceId) return;

        const workspaceId = app.state.activeWorkspaceId;

        if (this.veWorkspaceId === workspaceId && this.veOpportunities.length > 0) return;
        if (this.veLoadingWorkspaceId === workspaceId) return;

        this.veLoadingWorkspaceId = workspaceId;

        try {
            const response = await app.apiFetch('/api/chat', {
                method: 'POST',
                body: {
                    message: "Analyze this project's estimate and suggest exactly 3 Value Engineering opportunities with estimated cost savings. Return a JSON array of objects. Format: [{\"id\": \"ve-1\", \"title\": \"...\", \"desc\": \"...\", \"saving\": number}]. Do not wrap in markdown code blocks.",
                    projectId: workspaceId
                }
            });

            const text = response && response.text ? response.text : '';
            const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const list = JSON.parse(jsonStr);

            if (Array.isArray(list) && list.length > 0) {
                this.veOpportunities = list;
                this.veWorkspaceId = workspaceId;
                this.renderValueEngineering();
            }
        } catch (err) {
            console.error('Error generating AI VE opportunities:', err);

            // Offline fallback
            this.veOpportunities = [
                {
                    id: 've-err',
                    title: 'Value Engineering Offline',
                    desc: 'Could not connect to the advisor API to generate optimizations. Please try again.',
                    saving: 0
                }
            ];

            this.veWorkspaceId = workspaceId;
            this.renderValueEngineering();
        } finally {
            this.veLoadingWorkspaceId = null;
        }
    }

    syncInputsToPreview() {
        this.ensureExecutiveSummarySection();

        // Set dates
        const date = new Date();
        const options = { year: 'numeric', month: 'long', day: 'numeric' };
        this.setText('preview-doc-date', date.toLocaleDateString('en-GB', options));

        const companyInput = document.getElementById('proposal-company-name');
        const refInput = document.getElementById('proposal-reference');
        const contactInput = document.getElementById('proposal-contact-person');
        const introInput = document.getElementById('proposal-intro-text');

        const companyNameVal = companyInput ? companyInput.value : '';
        const refVal = refInput ? refInput.value : '';
        const contactVal = contactInput ? contactInput.value : '';

        this.setText('preview-brand-name', companyNameVal);
        this.setText('preview-doc-ref', refVal);
        this.setText('preview-doc-contact', contactVal);

        const logo = document.querySelector('.doc-brand-logo');
        if (logo && companyNameVal.length > 0) {
            logo.innerText = companyNameVal.charAt(0).toUpperCase();
        }

        const defaultIntro = 'Following review of your tender drawings and architectural specification, we are pleased to submit our quote proposal for the proposed works. Our cost summary outlines the measured schedule items and associated tender value for your review.';

        const introPreview = document.getElementById('preview-doc-intro');
        if (introPreview) {
            introPreview.innerText = introInput && introInput.value && introInput.value.trim()
                ? introInput.value
                : defaultIntro;
        }
    }

    renderBreakdownTable() {
        const tbody = document.getElementById('preview-breakdown-tbody');
        if (!tbody) return;

        if (!window.app || !app.pricing || !Array.isArray(app.pricing.rates)) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-3">No cost items configured with quantities.</td></tr>`;
            return;
        }

        tbody.innerHTML = '';

        // Loop active pricing items that have a quantity > 0
        const items = app.pricing.rates.filter(r => Number(r.qty) > 0);

        if (items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-3">No cost items configured with quantities.</td></tr>`;
            return;
        }

        const chkApplyMarkup = document.getElementById('chk-apply-markup-to-rates');
        const applyMarkup = chkApplyMarkup ? chkApplyMarkup.checked : true;

        const sliderMarkup = document.getElementById('slider-proposal-markup');
        const markupPercent = sliderMarkup ? parseFloat(sliderMarkup.value) || 0 : 0;

        let totalBase = 0;
        let totalMarkedUp = 0;

        items.forEach(item => {
            const qty = Number(item.qty) || 0;
            const current = Number(item.current) || 0;

            const rowBaseTotal = qty * current;
            totalBase += rowBaseTotal;

            const rateDisplayed = applyMarkup ? current * (1 + markupPercent / 100) : current;
            const rowTotalDisplayed = qty * rateDisplayed;
            totalMarkedUp += rowTotalDisplayed;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <div class="font-bold" style="color: #0f172a;">${item.desc || ''}</div>
                </td>
                <td>${item.unit || ''}</td>
                <td>${qty}</td>
                <td class="text-right">£${rateDisplayed.toFixed(2)}</td>
                <td class="text-right font-semibold">£${rowTotalDisplayed.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            `;

            tbody.appendChild(tr);
        });

        // Set summary values
        const contingency = window.app && app.state ? Number(app.state.targetContingency) || 0 : 0;
        const margin = window.app && app.state ? Number(app.state.targetMargin) || 0 : 0;

        const contingencyAmt = totalBase * (contingency / 100);
        const divisor = 1 - (margin / 100);
        const finalBid = divisor > 0 ? (totalBase + contingencyAmt) / divisor : (totalBase + contingencyAmt);

        const table = document.querySelector('#preview-breakdown-section table');
        const contingencyRow = document.getElementById('preview-doc-contingency')?.closest('tr');
        const subtotalLabelTd = document.getElementById('preview-doc-subtotal')?.previousElementSibling;

        if (applyMarkup) {
            // Update column headers to reflect Gross Rates
            if (table) {
                const headers = table.querySelectorAll('thead th');
                if (headers.length >= 5) {
                    headers[4].innerText = 'Total (£)';
                }
            }

            // Hide contingency row
            if (contingencyRow) {
                contingencyRow.style.display = 'none';
            }

            // Update subtotal label and values
            if (subtotalLabelTd) {
                subtotalLabelTd.innerText = 'Subtotal (Gross Cost):';
            }

            this.setText('preview-doc-subtotal', '£' + totalMarkedUp.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            this.setText('preview-doc-total', '£' + totalMarkedUp.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        } else {
            // Reset column headers to default Net Rates
            if (table) {
                const headers = table.querySelectorAll('thead th');
                if (headers.length >= 5) {
                    headers[4].innerText = 'Net Total (£)';
                }
            }

            // Show contingency row
            if (contingencyRow) {
                contingencyRow.style.display = '';
            }

            // Update subtotal label and values
            if (subtotalLabelTd) {
                subtotalLabelTd.innerText = 'Subtotal (Net Cost):';
            }

            this.setText('preview-doc-subtotal', '£' + totalBase.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            this.setText('preview-doc-contingency', '£' + contingencyAmt.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            this.setText('preview-doc-total', '£' + finalBid.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        }
    }

    getProposalMarkupMultiplier() {
        const chkApplyMarkup = document.getElementById('chk-apply-markup-to-rates');
        const applyMarkup = chkApplyMarkup ? chkApplyMarkup.checked : true;

        const sliderMarkup = document.getElementById('slider-proposal-markup');
        const markupPercent = sliderMarkup ? parseFloat(sliderMarkup.value) || 0 : 0;

        return applyMarkup ? (1 + markupPercent / 100) : 1;
    }

    getLiveVeSaving(ve) {
        const multiplier = this.getProposalMarkupMultiplier();
        return Math.round((Number(ve.saving) || 0) * multiplier);
    }

    renderValueEngineering() {
        const list = document.getElementById('preview-ve-list');
        if (!list) return;

        list.innerHTML = '';

        if (!Array.isArray(this.veOpportunities) || this.veOpportunities.length === 0) {
            list.innerHTML = `
                <div class="ve-item">
                    <div class="ve-title font-bold">
                        <span>Value Engineering</span>
                        <span>Saving: £0</span>
                    </div>
                    <p class="ve-desc">Value engineering opportunities will appear here once the project analysis has completed.</p>
                </div>
            `;
            return;
        }

        this.veOpportunities.forEach(ve => {
            const div = document.createElement('div');
            div.className = 've-item';

            const liveSaving = this.getLiveVeSaving(ve);

            div.innerHTML = `
                <div class="ve-title font-bold">
                    <span>${ve.title || 'Value Engineering Opportunity'}</span>
                    <span>Saving: &pound;${liveSaving.toLocaleString('en-GB')}</span>
                </div>
                <p class="ve-desc">${ve.desc || ''}</p>
            `;

            list.appendChild(div);
        });
    }
}

// Instantiate and expose globally
const proposalComponent = new ProposalComponent();
window.proposalComponent = proposalComponent;

// Run init once the DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        proposalComponent.init();
    });
} else {
    proposalComponent.init();
}