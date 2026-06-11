/**
 * QS Pro AI - Price Library & Rate Book Component
 */

class LibraryComponent {
    constructor() {
        this.activeTab = 'rates'; // rates, labour
        this.rates = [];
        this.labourRates = [];
        this.editingRate = null;
    }

    init() {
        // Component will load initial rates
        this.loadRates();
        this.loadLabourRates();
    }

    async loadRates() {
        try {
            this.rates = await app.apiFetch('/api/rates');
            if (this.activeTab === 'rates') {
                this.render();
            }
        } catch (err) {
            console.error('Error fetching global rates for library:', err);
        }
    }

    async loadLabourRates() {
        try {
            this.labourRates = await app.apiFetch('/api/labour-rates');
            if (this.activeTab === 'labour') {
                this.render();
            }
        } catch (err) {
            console.error('Error fetching global labour rates for library:', err);
        }
    }

    switchTab(tabName) {
        this.activeTab = tabName;
        
        // Update tabs active button visual state
        const btnRates = document.getElementById('btn-lib-tab-rates');
        const btnLabour = document.getElementById('btn-lib-tab-labour');
        const contentRates = document.getElementById('lib-tab-rates-content');
        const contentLabour = document.getElementById('lib-tab-labour-content');

        if (tabName === 'rates') {
            btnRates.classList.add('active');
            btnLabour.classList.remove('active');
            contentRates.style.display = 'block';
            contentLabour.style.display = 'none';
        } else {
            btnRates.classList.remove('active');
            btnLabour.classList.add('active');
            contentRates.style.display = 'none';
            contentLabour.style.display = 'block';
        }

        this.render();
    }

    render() {
        if (this.activeTab === 'rates') {
            this.renderRates();
        } else {
            this.renderLabourRates();
        }
    }

    renderRates() {
        const tbody = document.getElementById('library-rates-tbody');
        if (!tbody) return;

        tbody.innerHTML = '';
        
        const searchQuery = document.getElementById('library-search').value.toLowerCase().trim();
        const categoryFilter = document.getElementById('library-category-filter').value;

        const filtered = this.rates.filter(r => {
            const matchesSearch = r.name.toLowerCase().includes(searchQuery) || (r.trade && r.trade.toLowerCase().includes(searchQuery));
            const matchesCategory = categoryFilter === 'all' || r.category === categoryFilter;
            return matchesSearch && matchesCategory;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-8">No library elements found matching search.</td></tr>`;
            return;
        }

        filtered.forEach(r => {
            const tr = document.createElement('tr');
            const urlLink = r.sourceUrl ? `<a href="${r.sourceUrl}" target="_blank" class="text-button text-xs" style="text-decoration: none;">View Source ↗</a>` : '<span class="text-muted text-xs">Direct / Manual</span>';
            const updatedDate = r.lastUpdated ? r.lastUpdated : 'N/A';
            tr.innerHTML = `
                <td><div class="font-semibold">${r.name}</div></td>
                <td><span class="badge badge-gray text-xs">${r.category}</span></td>
                <td><span class="text-secondary text-xs">${r.trade || 'General'}</span></td>
                <td class="font-semibold text-xs">${r.unit}</td>
                <td class="text-right font-bold text-emerald">£${r.costRate.toFixed(2)}</td>
                <td><span class="text-secondary text-xs">${r.supplier || 'N/A'}</span></td>
                <td><span class="text-secondary text-xs">${updatedDate}</span></td>
                <td class="text-right">
                    <div style="display: flex; gap: 6px; justify-content: flex-end;">
                        <button class="btn btn-secondary py-1 px-3 text-xs" onclick="libraryComponent.openEditElementModal('${r.id}')">Edit</button>
                        <button class="btn btn-secondary py-1 px-3 text-xs text-red" style="border-color: rgba(239, 68, 68, 0.2);" onclick="libraryComponent.deleteElement('${r.id}')">Delete</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    renderLabourRates() {
        const tbody = document.getElementById('library-labour-tbody');
        if (!tbody) return;

        tbody.innerHTML = '';

        if (this.labourRates.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-secondary py-8">No labour rates configured.</td></tr>`;
            return;
        }

        this.labourRates.forEach((l, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><div class="font-bold">${l.trade}</div></td>
                <td class="text-right">
                    <input type="number" id="lbl-hourly-${index}" class="form-input text-xs" style="width: 80px; text-align: right; margin-left: auto;" value="${l.hourlyRate.toFixed(2)}" step="any" oninput="libraryComponent.calcLabourDaily(${index})">
                </td>
                <td class="text-right">
                    <input type="number" id="lbl-daily-${index}" class="form-input text-xs" style="width: 100px; text-align: right; margin-left: auto; font-weight: bold;" value="${l.dailyRate.toFixed(2)}" step="any">
                </td>
                <td class="text-right">
                    <input type="number" id="lbl-prod-${index}" class="form-input text-xs" style="width: 80px; text-align: right; margin-left: auto;" value="${l.productivityRate}" step="0.1">
                </td>
                <td class="text-right">
                    <input type="number" id="lbl-diff-${index}" class="form-input text-xs" style="width: 80px; text-align: right; margin-left: auto;" value="${l.difficultyFactor}" step="0.1">
                </td>
                <td class="text-right">
                    <button class="btn btn-primary py-1 px-3 text-xs" onclick="libraryComponent.saveLabourRate(${index})">Save Row</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    calcLabourDaily(index) {
        const hr = parseFloat(document.getElementById(`lbl-hourly-${index}`).value) || 0;
        // Assume 8 hour day standard UK shift
        document.getElementById(`lbl-daily-${index}`).value = (hr * 8).toFixed(2);
    }

    openAddElementModal() {
        this.editingRate = null;
        document.getElementById('library-modal-title').innerText = 'Add Element to Price Book';
        document.getElementById('library-item-id').value = '';
        document.getElementById('library-item-name').value = '';
        document.getElementById('library-item-category').value = 'Material';
        document.getElementById('library-item-trade').value = '';
        document.getElementById('library-item-unit').value = 'Nr';
        document.getElementById('library-item-cost').value = '';
        document.getElementById('library-item-supplier').value = '';
        document.getElementById('library-item-url').value = '';
        
        document.getElementById('library-item-modal').style.display = 'flex';
    }

    openEditElementModal(id) {
        const rate = this.rates.find(r => r.id === id);
        if (!rate) return;

        this.editingRate = rate;
        document.getElementById('library-modal-title').innerText = 'Adjust Price Book Element';
        document.getElementById('library-item-id').value = rate.id;
        document.getElementById('library-item-name').value = rate.name;
        document.getElementById('library-item-category').value = rate.category || 'Material';
        document.getElementById('library-item-trade').value = rate.trade || '';
        document.getElementById('library-item-unit').value = rate.unit || 'Nr';
        document.getElementById('library-item-cost').value = rate.costRate;
        document.getElementById('library-item-supplier').value = rate.supplier || '';
        document.getElementById('library-item-url').value = rate.sourceUrl || '';

        document.getElementById('library-item-modal').style.display = 'flex';
    }

    closeModal() {
        document.getElementById('library-item-modal').style.display = 'none';
        this.editingRate = null;
    }

    async saveElement() {
        const id = document.getElementById('library-item-id').value;
        const name = document.getElementById('library-item-name').value.trim();
        const category = document.getElementById('library-item-category').value;
        const trade = document.getElementById('library-item-trade').value.trim();
        const unit = document.getElementById('library-item-unit').value;
        const costRateStr = document.getElementById('library-item-cost').value;
        const supplier = document.getElementById('library-item-supplier').value.trim();
        const sourceUrl = document.getElementById('library-item-url').value.trim();

        if (!name || !costRateStr) {
            alert('Element Name and Standard Cost Rate are required.');
            return;
        }

        const costRate = parseFloat(costRateStr);
        if (isNaN(costRate) || costRate < 0) {
            alert('Please enter a valid cost rate.');
            return;
        }

        const payload = {
            name,
            category,
            trade: trade || 'General',
            unit,
            costRate,
            supplier,
            sourceUrl,
            lastUpdated: new Date().toISOString().split('T')[0]
        };

        try {
            if (id) {
                // Update
                await app.apiFetch(`/api/rates/${id}`, {
                    method: 'PUT',
                    body: payload
                });
                alert('Price book element updated.');
            } else {
                // Create
                await app.apiFetch('/api/rates', {
                    method: 'POST',
                    body: payload
                });
                alert('Price book element added.');
            }
            this.closeModal();
            await this.loadRates();
            
            // Also notify pricing engine to load latest if needed
            if (app.pricing) {
                await app.pricing.loadRatesFromBackend();
            }
        } catch (err) {
            console.error('Error saving library item:', err);
            alert('Error saving price book item: ' + err.message);
        }
    }

    async deleteElement(id) {
        if (!confirm('Are you sure you want to delete this price book element?')) return;
        try {
            await app.apiFetch(`/api/rates/${id}`, {
                method: 'DELETE'
            });
            alert('Price book element deleted.');
            await this.loadRates();
            
            // Refresh pricing engine catalog
            if (app.pricing) {
                await app.pricing.loadRatesFromBackend();
            }
        } catch (err) {
            console.error('Error deleting library item:', err);
            alert('Error deleting element: ' + err.message);
        }
    }

    async saveLabourRate(index) {
        const row = this.labourRates[index];
        if (!row) return;

        const hourlyRate = parseFloat(document.getElementById(`lbl-hourly-${index}`).value) || 0;
        const dailyRate = parseFloat(document.getElementById(`lbl-daily-${index}`).value) || 0;
        const productivityRate = parseFloat(document.getElementById(`lbl-prod-${index}`).value) || 1.0;
        const difficultyFactor = parseFloat(document.getElementById(`lbl-diff-${index}`).value) || 1.0;

        try {
            await app.apiFetch(`/api/labour-rates/${encodeURIComponent(row.trade)}`, {
                method: 'PUT',
                body: {
                    hourlyRate,
                    dailyRate,
                    productivityRate,
                    difficultyFactor
                }
            });
            alert(`Standard labour rate for "${row.trade}" saved successfully.`);
            await this.loadLabourRates();
        } catch (err) {
            console.error('Error saving labour rate:', err);
            alert('Error saving labour rate: ' + err.message);
        }
    }
}

// Instantiate and expose globally
const libraryComponent = new LibraryComponent();
window.libraryComponent = libraryComponent;
