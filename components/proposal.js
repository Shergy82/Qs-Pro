/**
 * QS Pro AI - Proposal & Client Quote Generator Component
 */

class ProposalComponent {
    constructor() {
        this.veOpportunities = [];
    }

    init() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Form inputs live binding
        document.getElementById('proposal-company-name').addEventListener('input', (e) => {
            document.getElementById('preview-brand-name').innerText = e.target.value;
            const logo = document.querySelector('.doc-brand-logo');
            if (logo && e.target.value.length > 0) {
                logo.innerText = e.target.value.charAt(0).toUpperCase();
            }
        });

        document.getElementById('proposal-reference').addEventListener('input', (e) => {
            document.getElementById('preview-doc-ref').innerText = e.target.value;
        });

        document.getElementById('proposal-contact-person').addEventListener('input', (e) => {
            document.getElementById('preview-doc-contact').innerText = e.target.value;
        });

        document.getElementById('proposal-intro-text').addEventListener('input', (e) => {
            document.getElementById('preview-doc-intro').innerText = e.target.value;
        });

        // Checkboxes toggles
        document.getElementById('chk-include-breakdown').addEventListener('change', (e) => {
            const section = document.getElementById('preview-breakdown-section');
            section.style.display = e.target.checked ? 'block' : 'none';
        });

        document.getElementById('chk-include-ve').addEventListener('change', (e) => {
            const section = document.getElementById('preview-ve-section');
            section.style.display = e.target.checked ? 'block' : 'none';
        });

        // Print trigger
        document.getElementById('btn-print-proposal').addEventListener('click', () => {
            window.print();
        });
    }

    render() {
        this.syncInputsToPreview();
        this.renderBreakdownTable();
        this.generateAIVeOpportunities();
        this.renderValueEngineering();
    }

    async generateAIVeOpportunities() {
        if (!app.state.activeWorkspaceId || this.veOpportunities.length > 0) return;
        try {
            const response = await app.apiFetch('/api/chat', {
                method: 'POST',
                body: {
                    message: "Analyze this project's estimate and suggest exactly 3 Value Engineering opportunities with estimated cost savings. Return a JSON array of objects. Format: [{\"id\": \"ve-1\", \"title\": \"...\", \"desc\": \"...\", \"saving\": number}]. Do not wrap in markdown code blocks.",
                    projectId: app.state.activeWorkspaceId
                }
            });
            
            const jsonStr = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
            const list = JSON.parse(jsonStr);
            if (Array.isArray(list) && list.length > 0) {
                this.veOpportunities = list;
                this.renderValueEngineering();
            }
        } catch (err) {
            console.error('Error generating AI VE opportunities:', err);
            // Offline fallback
            this.veOpportunities = [
                { id: 've-err', title: 'Value Engineering Offline', desc: 'Could not connect to the advisor API to generate optimizations. Please try again.', saving: 0 }
            ];
            this.renderValueEngineering();
        }
    }

    syncInputsToPreview() {
        // Set dates
        const date = new Date();
        const options = { year: 'numeric', month: 'long', day: 'numeric' };
        document.getElementById('preview-doc-date').innerText = date.toLocaleDateString('en-GB', options);

        // Bind text
        document.getElementById('preview-brand-name').innerText = document.getElementById('proposal-company-name').value;
        
        const logo = document.querySelector('.doc-brand-logo');
        const companyNameVal = document.getElementById('proposal-company-name').value;
        if (logo && companyNameVal.length > 0) {
            logo.innerText = companyNameVal.charAt(0).toUpperCase();
        }

        document.getElementById('preview-doc-ref').innerText = document.getElementById('proposal-reference').value;
        document.getElementById('preview-doc-contact').innerText = document.getElementById('proposal-contact-person').value;
        document.getElementById('preview-doc-intro').innerText = document.getElementById('proposal-intro-text').value;
    }

    renderBreakdownTable() {
        const tbody = document.getElementById('preview-breakdown-tbody');
        if (!tbody || !app.pricing) return;

        tbody.innerHTML = '';
        
        // Loop active pricing items that have a quantity > 0
        const items = app.pricing.rates.filter(r => r.qty > 0);

        if (items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-3">No cost items configured with quantities.</td></tr>`;
            return;
        }

        let totalBase = 0;

        items.forEach(item => {
            const rowTotal = item.qty * item.current;
            totalBase += rowTotal;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <div class="font-bold" style="color: #0f172a;">${item.desc}</div>
                    <div class="text-xs text-secondary">${item.code} - ${item.category}</div>
                </td>
                <td>${item.unit}</td>
                <td>${item.qty}</td>
                <td class="text-right">£${item.current.toFixed(2)}</td>
                <td class="text-right font-semibold">£${rowTotal.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
            `;
            tbody.appendChild(tr);
        });

        // Set summary values
        const contingencyAmt = totalBase * (app.state.targetContingency / 100);
        const divisor = 1 - (app.state.targetMargin / 100);
        const finalBid = divisor > 0 ? (totalBase + contingencyAmt) / divisor : (totalBase + contingencyAmt);

        document.getElementById('preview-doc-subtotal').innerText = '£' + totalBase.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        document.getElementById('preview-doc-contingency').innerText = '£' + contingencyAmt.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        document.getElementById('preview-doc-total').innerText = '£' + finalBid.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }

    renderValueEngineering() {
        const list = document.getElementById('preview-ve-list');
        if (!list) return;

        list.innerHTML = '';

        this.veOpportunities.forEach(ve => {
            const div = document.createElement('div');
            div.className = 've-item';
            div.innerHTML = `
                <div class="ve-title font-bold">
                    <span>${ve.title}</span>
                    <span>Saving: £${ve.saving.toLocaleString()}</span>
                </div>
                <p class="ve-desc">${ve.desc}</p>
            `;
            list.appendChild(div);
        });
    }
}

// Instantiate and expose globally
const proposalComponent = new ProposalComponent();
window.proposalComponent = proposalComponent;
// Run init immediately to enable events
proposalComponent.init();
