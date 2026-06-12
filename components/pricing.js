/**
 * QS Pro AI - Pricing Engine & SOR Matcher Component
 */

class PricingComponent {
    constructor() {
        this.rates = [];
        this.supplierFeeds = [];
        this.historicalTenders = [];
        this.sorItems = [];
        this.priceLibrary = [];
        this.addMode = 'library';
    }

    init() {
        this.setupEventListeners();
        this.loadSupplierFeeds();
        this.loadHistoricalTenders();
        this.loadPriceLibrary();
    }

    async loadSupplierFeeds() {
        try {
            const dbRates = await app.apiFetch('/api/rates');
            if (dbRates.length > 0) {
                this.supplierFeeds = dbRates.slice(0, 5).map((r) => {
                    const hashVal = r.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                    const changePercent = ((hashVal % 30) - 15) / 10;
                    const changeText = changePercent === 0 ? 'Stable' : (changePercent > 0 ? `+${changePercent.toFixed(1)}%` : `${changePercent.toFixed(1)}%`);
                    const trend = changePercent === 0 ? 'stable' : (changePercent > 0 ? 'up' : 'down');
                    return {
                        name: r.name,
                        price: `£${r.costRate.toFixed(2)} / ${r.unit}`,
                        change: changeText,
                        trend: trend
                    };
                });
            }
            this.renderSupplierFeeds();
        } catch (err) {
            console.error('Error loading supplier feeds:', err);
        }
    }

    async loadHistoricalTenders() {
        try {
            const projects = await app.apiFetch('/api/projects');
            const historical = projects.filter(p => p.status === 'Won' || p.status === 'Submitted' || p.status === 'Priced');
            this.historicalTenders = historical.map(p => ({
                id: p.id,
                name: p.name,
                match: p.tradeCategory || 'General',
                value: app.formatCurrency(p.sellPrice),
                margin: `${p.margin}%`
            }));
            this.renderHistoricalTenders();
        } catch (err) {
            console.error('Error loading historical tenders:', err);
        }
    }

    setupEventListeners() {
        // Pricing mode toggles
        document.querySelectorAll('.pricing-mode-toggles .btn-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.pricing-mode-toggles .btn-toggle').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                const mode = btn.getAttribute('data-mode');
                app.state.pricingMode = mode;
                this.updateRatesByMode(mode);
                this.render();
                
                // Alert advisor to update calculations
                if (app.advisor) {
                    app.advisor.recalculateTenderTotals();
                }
            });
        });

        // Search rate filter
        document.getElementById('pricing-search').addEventListener('input', (e) => {
            this.render(e.target.value, document.getElementById('pricing-category-filter').value);
        });

        // Category filter
        document.getElementById('pricing-category-filter').addEventListener('change', (e) => {
            this.render(document.getElementById('pricing-search').value, e.target.value);
        });

        // SOR Load sample button
        document.getElementById('btn-load-sample-sor').addEventListener('click', () => {
            this.loadSampleSOR();
        });

        // SOR Apply rates button
        document.getElementById('btn-apply-sor-rates').addEventListener('click', () => {
            this.applySORRatesToEstimate();
        });

        // Modal AI Lookup button
        document.getElementById('btn-trigger-ai-lookup').addEventListener('click', () => {
            this.lookupAIPriceForModal();
        });

        // Modal AI Apply button
        document.getElementById('btn-apply-ai-rate').addEventListener('click', () => {
            this.applyAISuggestionToModal();
        });

        // Room Calculator unit change for add modal custom unit
        const addUnit = document.getElementById('add-item-unit');
        if (addUnit) {
            addUnit.addEventListener('change', () => {
                this.handleUnitChange('add-item', addUnit.value);
            });
        }

        // Room Calculator unit change for adjust modal unit
        const adjustUnit = document.getElementById('rate-unit-select');
        if (adjustUnit) {
            adjustUnit.addEventListener('change', () => {
                this.handleUnitChange('adjust', adjustUnit.value);
            });
        }

        // Bind keyup/change for add-item calculator inputs
        ['add-item-calc-width', 'add-item-calc-length', 'add-item-calc-height', 'add-item-calc-type'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => this.runCalculation('add-item'));
                el.addEventListener('change', () => this.runCalculation('add-item'));
            }
        });

        // Bind keyup/change for adjust calculator inputs
        ['adjust-calc-width', 'adjust-calc-length', 'adjust-calc-height', 'adjust-calc-type'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => this.runCalculation('adjust'));
                el.addEventListener('change', () => this.runCalculation('adjust'));
            }
        });
    }

    async updateRatesByMode(mode) {
        this.rates.forEach(r => {
            if (mode === 'company') {
                r.current = r.company;
            } else if (mode === 'market') {
                r.current = r.market;
            } else if (mode === 'hybrid') {
                // Hybrid is company + 40% of the market delta
                r.current = Math.round(r.company + (r.market - r.company) * 0.4);
            }
        });
        
        const promises = this.rates.filter(r => r.qty > 0).map(r => this.saveRateToBackend(r));
        await Promise.all(promises);
    }

    render(searchQuery = '', categoryFilter = 'all') {
        const tbody = document.getElementById('pricing-rates-tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';

        const filtered = this.rates.filter(rate => {
            const matchesSearch = rate.desc.toLowerCase().includes(searchQuery.toLowerCase()) || rate.code.toLowerCase().includes(searchQuery.toLowerCase());
            const matchesCategory = categoryFilter === 'all' || rate.category === categoryFilter;
            return matchesSearch && matchesCategory;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-secondary py-5">No rates match search filter</td></tr>`;
            return;
        }

        filtered.forEach((r, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <div class="font-semibold">${r.desc}</div>
                </td>
                <td><span class="badge badge-gray text-xs">${r.category}</span></td>
                <td>
                    <select class="form-input text-xs" style="background: #0e1422; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; width: 80px; color: var(--text-primary); outline: none; display: inline-block;" onchange="pricingComponent.updateRateUnit('${r.code}', this.value)">
                        <option value="Nr" ${r.unit === 'Nr' ? 'selected' : ''}>Nr</option>
                        <option value="m2" ${r.unit === 'm2' || r.unit === 'sqm' ? 'selected' : ''}>m²</option>
                        <option value="m3" ${r.unit === 'm3' || r.unit === 'cum' ? 'selected' : ''}>m³</option>
                        <option value="m" ${r.unit === 'm' || r.unit === 'lm' || r.unit === 'linear' ? 'selected' : ''}>m</option>
                        <option value="Item" ${r.unit === 'Item' ? 'selected' : ''}>Item</option>
                        <option value="Sum" ${r.unit === 'Sum' ? 'selected' : ''}>Sum</option>
                        <option value="hr" ${r.unit === 'hr' || r.unit === 'hour' ? 'selected' : ''}>hr</option>
                        <option value="day" ${r.unit === 'day' ? 'selected' : ''}>day</option>
                        <option value="t" ${r.unit === 't' || r.unit === 'ton' ? 'selected' : ''}>t</option>
                    </select>
                </td>
                <td class="text-right">
                    <input type="number" class="form-input text-xs" style="background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; width: 80px; text-align: right; color: var(--text-primary); outline: none; margin-left: auto;" value="${r.qty}" step="any" onchange="pricingComponent.updateRateQty('${r.code}', this.value)">
                </td>
                <td class="text-right">£${r.current.toFixed(2)}</td>
                <td class="text-right font-bold text-emerald">£${(r.qty * r.current).toFixed(2)}</td>
                <td class="text-right">
                    <button class="btn btn-secondary py-1 px-3 text-xs" onclick="pricingComponent.editRate('${r.code}')">Adjust</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        this.renderSupplierFeeds();
        this.renderHistoricalTenders();
    }

    renderSupplierFeeds() {
        const list = document.getElementById('supplier-list');
        list.innerHTML = '';
        
        this.supplierFeeds.forEach(feed => {
            let trendClass = 'trend-stable';
            let arrow = '→';
            if (feed.trend === 'up') {
                trendClass = 'trend-up';
                arrow = '↑';
            } else if (feed.trend === 'down') {
                trendClass = 'trend-down';
                arrow = '↓';
            }

            const div = document.createElement('div');
            div.className = 'supplier-item';
            div.innerHTML = `
                <div class="flex flex-col">
                    <span class="supplier-name">${feed.name}</span>
                    <span class="${trendClass} text-xs font-semibold">${arrow} ${feed.change} today</span>
                </div>
                <span class="supplier-price font-bold">${feed.price}</span>
            `;
            list.appendChild(div);
        });
    }

    renderHistoricalTenders() {
        const list = document.getElementById('historical-project-list');
        list.innerHTML = '';
        
        if (this.historicalTenders.length === 0) {
            list.innerHTML = `<div class="text-secondary text-center text-xs py-5">No completed historical projects found in your database library.</div>`;
            return;
        }
        
        this.historicalTenders.forEach(hist => {
            const div = document.createElement('div');
            div.className = 'historical-project-item';
            div.innerHTML = `
                <div class="hist-proj-header">
                    <span>${hist.name}</span>
                    <span class="badge badge-blue">${hist.match}</span>
                </div>
                <div class="hist-proj-details">
                    <span>Bid: ${hist.value}</span>
                    <span class="text-emerald">Margin: ${hist.margin}</span>
                </div>
            `;
            div.addEventListener('click', async () => {
                try {
                    const estimates = await app.apiFetch(`/api/projects/${hist.id}/estimates`);
                    const pricedItem = estimates.find(est => est.quantity > 0 && (est.materialRate || est.labourRate || est.plantRate || est.subRate));
                    if (pricedItem) {
                        const rate = (pricedItem.materialRate || 0) + (pricedItem.labourRate || 0) + (pricedItem.plantRate || 0) + (pricedItem.subRate || 0);
                        alert(`Loaded historical rates from ${hist.name} as comparator. Benchmark item: "${pricedItem.description}" at £${rate.toFixed(2)}/${pricedItem.unit || 'Item'}.`);
                    } else {
                        alert(`Loaded historical rates from ${hist.name} as comparator. No priced items found in this project.`);
                    }
                } catch (err) {
                    console.error('Error fetching historical rates:', err);
                    alert(`Loaded historical project: ${hist.name}. Bid value: ${hist.value}.`);
                }
            });
            list.appendChild(div);
        });
    }

    editRate(code) {
        const rate = this.rates.find(r => r.code === code);
        if (!rate) return;

        this.activeRateModal = rate;
        
        // Populate modal data
        document.getElementById('modal-item-title').innerText = `Adjust Rate Build-up`;
        document.getElementById('modal-item-desc').innerText = rate.desc;
        document.getElementById('modal-item-unit').innerText = rate.unit;
        document.getElementById('modal-item-qty').innerText = rate.qty;
        
        // Populate editable quantity
        document.getElementById('rate-qty-input').value = rate.qty;

        // Set unit dropdown value
        const unitSelect = document.getElementById('rate-unit-select');
        const unitMap = {
            'Nr': 'Nr', 'm2': 'm2', 'sqm': 'm2', 'm3': 'm3', 'cum': 'm3',
            'm': 'm', 'lm': 'm', 'linear': 'm', 'Item': 'Item', 'Sum': 'Sum',
            'hr': 'hr', 'hour': 'hr', 'day': 'day', 't': 't', 'ton': 't'
        };
        const mappedUnit = unitMap[rate.unit] || 'Nr';
        if (unitSelect) {
            unitSelect.value = mappedUnit;
        }

        // Check for remembered room measurements
        let remembered = null;
        if (this.roomMeasurements && rate.section) {
            remembered = this.roomMeasurements[rate.section.toLowerCase()];
        }

        this.handleUnitChange('adjust', mappedUnit);

        // Populate calculator inputs from memory if available
        if (remembered) {
            document.getElementById('adjust-calc-width').value = remembered.width || '';
            document.getElementById('adjust-calc-length').value = remembered.length || '';
            document.getElementById('adjust-calc-height').value = remembered.height || '';
            
            const calcTypeSelect = document.getElementById('adjust-calc-type');
            if (calcTypeSelect) {
                if (mappedUnit === 'm2') {
                    calcTypeSelect.value = (remembered.height > 0) ? 'walls' : 'floor';
                } else if (mappedUnit === 'm') {
                    calcTypeSelect.value = 'perimeter';
                }
            }
            this.runCalculation('adjust');
        } else {
            // Reset calculator inputs if no memory
            document.getElementById('adjust-calc-width').value = '';
            document.getElementById('adjust-calc-length').value = '';
            document.getElementById('adjust-calc-height').value = '';
            document.getElementById('adjust-calc-formula').innerText = '-';
        }
        
        document.getElementById('rate-material').value = rate.materialRate || 0;
        document.getElementById('rate-labour').value = rate.labourRate || 0;
        document.getElementById('rate-plant').value = rate.plantRate || 0;
        document.getElementById('rate-sub').value = rate.subRate || 0;
        
        this.calcModalTotal();

        // Reset AI suggest panel
        document.getElementById('ai-lookup-results').style.display = 'none';
        document.getElementById('ai-lookup-loading').style.display = 'none';
        document.getElementById('btn-trigger-ai-lookup').style.display = 'block';
        
        // Show modal
        document.getElementById('rate-adjustment-modal').style.display = 'flex';
    }

    calcModalTotal() {
        const mat = parseFloat(document.getElementById('rate-material').value) || 0;
        const lab = parseFloat(document.getElementById('rate-labour').value) || 0;
        const plant = parseFloat(document.getElementById('rate-plant').value) || 0;
        const sub = parseFloat(document.getElementById('rate-sub').value) || 0;
        
        const total = mat + lab + plant + sub;
        document.getElementById('rate-total-calc').innerText = total.toFixed(2);
    }

    closeAdjustModal() {
        document.getElementById('rate-adjustment-modal').style.display = 'none';
        this.activeRateModal = null;
    }

    saveAdjustModal() {
        if (!this.activeRateModal) return;
        const rate = this.activeRateModal;
        
        rate.qty = parseFloat(document.getElementById('rate-qty-input').value) || 0;
        const selectEl = document.getElementById('rate-unit-select');
        if (selectEl) {
            rate.unit = selectEl.value;
        }

        rate.materialRate = parseFloat(document.getElementById('rate-material').value) || 0;
        rate.labourRate = parseFloat(document.getElementById('rate-labour').value) || 0;
        rate.plantRate = parseFloat(document.getElementById('rate-plant').value) || 0;
        rate.subRate = parseFloat(document.getElementById('rate-sub').value) || 0;
        
        rate.current = rate.materialRate + rate.labourRate + rate.plantRate + rate.subRate;

        // Remember room calculator measurements and propagate
        const width = parseFloat(document.getElementById('adjust-calc-width').value) || 0;
        const length = parseFloat(document.getElementById('adjust-calc-length').value) || 0;
        const height = parseFloat(document.getElementById('adjust-calc-height').value) || 0;

        if (rate.section && width > 0 && length > 0) {
            if (!this.roomMeasurements) {
                this.roomMeasurements = {};
            }
            const roomKey = rate.section.toLowerCase();
            this.roomMeasurements[roomKey] = { width, length, height };

            if (app.state.activeWorkspaceId) {
                localStorage.setItem(`qs_pro_room_measurements_${app.state.activeWorkspaceId}`, JSON.stringify(this.roomMeasurements));
            }

            // Propagate to all other items in the same room/section
            this.rates.forEach(otherRate => {
                if (otherRate.code === rate.code) return; // skip self
                if (otherRate.section && otherRate.section.toLowerCase() === roomKey) {
                    const mappedUnit = otherRate.unit;
                    let calculatedQty = 0;
                    if (mappedUnit === 'm2') {
                        const descLower = (otherRate.desc || '').toLowerCase();
                        if (descLower.includes('ceiling') || descLower.includes('floor')) {
                            calculatedQty = width * length;
                        } else {
                            calculatedQty = (height > 0) ? (2 * (width + length) * height) : (width * length);
                        }
                    } else if (mappedUnit === 'm') {
                        const descLower = (otherRate.desc || '').toLowerCase();
                        if (descLower.includes('skirting') || descLower.includes('perimeter') || descLower.includes('cornice')) {
                            calculatedQty = 2 * (width + length);
                        } else {
                            calculatedQty = width + length;
                        }
                    }

                    if (calculatedQty > 0) {
                        otherRate.qty = parseFloat(calculatedQty.toFixed(2));
                        otherRate.current = (otherRate.materialRate || 0) + (otherRate.labourRate || 0) + (otherRate.plantRate || 0) + (otherRate.subRate || 0);
                        this.saveRateToBackend(otherRate);
                    }
                }
            });
        }
        
        this.render(
            document.getElementById('pricing-search').value,
            document.getElementById('pricing-category-filter').value
        );
        
        this.saveRateToBackend(rate).then(() => {
            if (app.advisor) {
                app.advisor.recalculateTenderTotals();
            }
        });
        
        this.closeAdjustModal();
    }

    async lookupAIPriceForModal() {
        if (!this.activeRateModal) return;
        const rate = this.activeRateModal;
        
        const btnText = document.getElementById('btn-trigger-ai-lookup');
        const loadingDiv = document.getElementById('ai-lookup-loading');
        const resultsDiv = document.getElementById('ai-lookup-results');
        
        btnText.style.display = 'none';
        loadingDiv.style.display = 'block';
        resultsDiv.style.display = 'none';
        
        try {
            const data = await app.apiFetch('/api/ai/price-suggest', {
                method: 'POST',
                body: {
                    description: rate.desc,
                    unit: rate.unit
                }
            });
            
            if (data && data.success) {
                document.getElementById('ai-suggested-val').innerText = `£${data.recommendedRate.toFixed(2)}`;
                document.getElementById('ai-suggested-range').innerText = `£${data.minPrice.toFixed(2)} - £${data.maxPrice.toFixed(2)} per ${rate.unit}`;
                document.getElementById('ai-suggested-explain').innerText = data.explanation;
                document.getElementById('ai-suggested-source').innerText = data.source || 'Standard UK Construction Index';
                
                this.modalAISuggestedRate = data.recommendedRate;
                
                loadingDiv.style.display = 'none';
                resultsDiv.style.display = 'block';
            } else {
                throw new Error("Invalid AI response");
            }
        } catch (err) {
            console.error('AI lookup error:', err);
            alert("AI Rate lookup failed. Please try again.");
            btnText.style.display = 'block';
            loadingDiv.style.display = 'none';
        }
    }

    applyAISuggestionToModal() {
        if (this.modalAISuggestedRate === undefined || !this.activeRateModal) return;
        const rate = this.activeRateModal;
        
        if (rate.category === 'labor') {
            document.getElementById('rate-labour').value = this.modalAISuggestedRate.toFixed(2);
            document.getElementById('rate-material').value = '0.00';
            document.getElementById('rate-plant').value = '0.00';
            document.getElementById('rate-sub').value = '0.00';
        } else if (rate.category === 'subcontractor') {
            document.getElementById('rate-sub').value = this.modalAISuggestedRate.toFixed(2);
            document.getElementById('rate-material').value = '0.00';
            document.getElementById('rate-labour').value = '0.00';
            document.getElementById('rate-plant').value = '0.00';
        } else {
            document.getElementById('rate-material').value = this.modalAISuggestedRate.toFixed(2);
            document.getElementById('rate-labour').value = '0.00';
            document.getElementById('rate-plant').value = '0.00';
            document.getElementById('rate-sub').value = '0.00';
        }
        
        this.calcModalTotal();
    }

    updateRateQty(code, newQty) {
        const rate = this.rates.find(r => r.code === code);
        if (rate) {
            rate.qty = parseFloat(newQty) || 0;
            this.render(
                document.getElementById('pricing-search').value,
                document.getElementById('pricing-category-filter').value
            );
            this.saveRateToBackend(rate).then(() => {
                if (app.advisor) {
                    app.advisor.recalculateTenderTotals();
                }
            });
        }
    }

    updateRateUnit(code, newUnit) {
        const rate = this.rates.find(r => r.code === code);
        if (rate) {
            rate.unit = newUnit;
            this.render(
                document.getElementById('pricing-search').value,
                document.getElementById('pricing-category-filter').value
            );
            this.saveRateToBackend(rate).then(() => {
                if (app.advisor) {
                    app.advisor.recalculateTenderTotals();
                }
            });
        }
    }

    // --- Take-off Synchronization Hook ---
    syncFromTakeoff(data) {
        // Map GIA Area to excavation and Concrete Volume
        const excavation = this.rates.find(r => r.code === 'SUB-401');
        if (excavation && data.area > 0) {
            // Excavate depth 1m assumed
            excavation.qty = parseFloat((data.area * 1.2).toFixed(1)); 
        }

        const concrete = this.rates.find(r => r.code === 'MAT-102');
        if (concrete && data.area > 0) {
            // Assume concrete thickness 250mm => area * 0.25
            concrete.qty = parseFloat((data.area * 0.25).toFixed(1));
        }

        // Map length to Timber truss framework or cabling runs
        const timber = this.rates.find(r => r.code === 'MAT-101');
        if (timber && data.length > 0) {
            timber.qty = parseFloat((data.length * 0.8).toFixed(1));
        }

        // Map count to fire doors
        const doors = this.rates.find(r => r.code === 'MAT-105');
        if (doors && data.count > 0) {
            doors.qty = data.count;
        }

        this.render();
        
        const promises = this.rates.filter(r => r.qty > 0).map(r => this.saveRateToBackend(r));
        Promise.all(promises).then(() => {
            if (app.advisor) {
                app.advisor.recalculateTenderTotals();
            }
        });
    }

    // --- Schedule of Rates (SOR) Matcher logic ---
    loadSampleSOR() {
        this.sorItems = [
            { ref: 'SOR-1.04', desc: 'Excavation of foundation trenches depth not exceeding 1.50m. Bulk cart away.', qty: 450, unit: 'm³', matchCode: 'SUB-401', confidence: 95, approved: false },
            { ref: 'SOR-2.11', desc: 'Structural softwood roof joists kiln dried C24 size 50 x 150mm spacing.', qty: 320, unit: 'm', matchCode: 'MAT-101', confidence: 88, approved: false },
            { ref: 'SOR-3.02', desc: 'In-situ reinforced concrete floor slab thickness 250mm using C30/37.', qty: 124, unit: 'm³', matchCode: 'MAT-102', confidence: 92, approved: false },
            { ref: 'SOR-4.15', desc: 'Standard internal solid core door leaf 44mm thick with oak veneer lining.', qty: 12, unit: 'qty', matchCode: 'MAT-105', confidence: 48, approved: false },
            { ref: 'SOR-5.01', desc: 'Mineral fiber wool insulation batts size 100mm cavity friction fit.', qty: 168, unit: 'm²', matchCode: 'MAT-104', confidence: 91, approved: false }
        ];

        this.renderSOR();
        
        // Add notice to system
        app.state.notifications.unshift({
            id: 'n-' + Date.now(),
            title: 'SOR Sheet Loaded',
            body: 'Loaded 5 line-items from CSV. AI completed mapping with 1 low confidence item.',
            time: 'Just now',
            read: false
        });
        app.renderNotifications();
        app.updateNotificationCount();
    }

    renderSOR() {
        const tbody = document.getElementById('sor-table-tbody');
        if (!tbody) return;

        if (this.sorItems.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" class="text-center text-secondary py-8">
                        No SOR sheets loaded. Click "Load Sample SOR Sheet" above to simulate.
                    </td>
                </tr>
            `;
            document.getElementById('sor-mapped-count').innerText = '0/0 Mapped';
            document.getElementById('btn-apply-sor-rates').disabled = true;
            return;
        }

        tbody.innerHTML = '';
        let mappedCount = 0;

        this.sorItems.forEach((item, index) => {
            const matchingRate = this.rates.find(r => r.code === item.matchCode);
            const rateVal = matchingRate ? matchingRate.current : 0;
            const total = item.qty * rateVal;

            if (item.approved) mappedCount++;

            const isLowConf = item.confidence < 60;
            const rowClass = item.approved ? 'sor-mapped-highlight' : (isLowConf ? 'sor-low-confidence' : '');

            const tr = document.createElement('tr');
            tr.className = rowClass;
            tr.innerHTML = `
                <td class="font-bold text-xs">${item.ref}</td>
                <td>${item.desc}</td>
                <td>${item.qty}</td>
                <td>${item.unit}</td>
                <td>
                    <div class="flex items-center gap-2">
                        <span class="font-semibold text-xs">${matchingRate ? matchingRate.desc : 'None'}</span>
                    </div>
                </td>
                <td>
                    <span class="font-bold ${isLowConf ? 'text-amber' : 'text-emerald'}">${item.confidence}%</span>
                    <span class="text-xs text-secondary">${isLowConf ? '(Verify)' : '(Auto)'}</span>
                </td>
                <td class="text-right font-bold">£${rateVal.toFixed(2)}</td>
                <td class="text-right font-bold text-blue">£${total.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                <td class="text-center">
                    <input type="checkbox" class="form-checkbox cursor-pointer" ${item.approved ? 'checked' : ''} onclick="pricingComponent.toggleSORApprove(${index})">
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('sor-mapped-count').innerText = `${mappedCount}/${this.sorItems.length} Mapped`;
        document.getElementById('btn-apply-sor-rates').disabled = mappedCount === 0;
    }

    toggleSORApprove(index) {
        this.sorItems[index].approved = !this.sorItems[index].approved;
        this.renderSOR();
    }

    applySORRatesToEstimate() {
        let appliedCount = 0;
        const promises = [];
        this.sorItems.forEach(item => {
            if (item.approved) {
                const targetRate = this.rates.find(r => r.code === item.matchCode);
                if (targetRate) {
                    targetRate.qty = item.qty;
                    appliedCount++;
                    promises.push(this.saveRateToBackend(targetRate));
                }
            }
        });

        Promise.all(promises).then(() => {
            alert(`Successfully imported ${appliedCount} line items from Schedule of Rates directly into active Tender Estimate totals!`);
            this.render();
            
            if (app.advisor) {
                app.advisor.recalculateTenderTotals();
            }
            app.switchPanel('pricing');
        });
    }

    async loadRatesFromBackend() {
        try {
            const dbRates = await app.apiFetch('/api/rates');
            if (dbRates.length > 0) {
                this.rates = dbRates.map(r => ({
                    code: r.id,
                    desc: r.name,
                    category: (r.category || 'materials').toLowerCase(),
                    unit: r.unit || 'm',
                    company: r.costRate || 0,
                    market: Math.round((r.costRate || 0) * 1.15),
                    current: r.costRate || 0,
                    qty: 0,
                    materialRate: (r.category || '').toLowerCase() === 'materials' ? r.costRate : 0,
                    labourRate: (r.category || '').toLowerCase() === 'labor' ? r.costRate : 0,
                    plantRate: (r.category || '').toLowerCase() === 'plant' ? r.costRate : 0,
                    subRate: (r.category || '').toLowerCase() === 'subcontractor' ? r.costRate : 0
                }));
            }
            this.render();
        } catch (err) {
            console.error('Error loading rates from price book:', err);
        }
    }

    syncRatesFromEstimates(estimates) {
        if (!estimates || estimates.length === 0) {
            this.rates.forEach(r => r.qty = 0);
            this.render();
            return;
        }

        if (app.state.activeWorkspaceId) {
            try {
                this.roomMeasurements = JSON.parse(localStorage.getItem(`qs_pro_room_measurements_${app.state.activeWorkspaceId}`) || '{}');
            } catch (e) {
                this.roomMeasurements = {};
            }
        } else {
            this.roomMeasurements = {};
        }

        this.rates = estimates.map(est => {
            const unitRate = (est.materialRate || 0) + (est.labourRate || 0) + (est.plantRate || 0) + (est.subRate || 0);
            
            let category = 'materials';
            if (est.labourRate > 0) category = 'labor';
            else if (est.plantRate > 0) category = 'plant';
            else if (est.subRate > 0) category = 'subcontractor';
            
            return {
                code: est.id,
                backendId: est.id,
                desc: est.description,
                section: est.section || 'General',
                category: category,
                unit: est.unit || 'Item',
                company: unitRate,
                market: Math.round(unitRate * 1.15),
                current: unitRate,
                qty: est.quantity || 0,
                materialRate: est.materialRate || 0,
                labourRate: est.labourRate || 0,
                plantRate: est.plantRate || 0,
                subRate: est.subRate || 0
            };
        });
        
        this.render();
    }

    async saveRateToBackend(rate) {
        if (!app.state.activeWorkspaceId) return;
        try {
            if (rate.backendId) {
                await app.apiFetch(`/api/estimate-items/${rate.backendId}`, {
                    method: 'PUT',
                    body: {
                        quantity: rate.qty,
                        materialRate: rate.materialRate || 0,
                        labourRate: rate.labourRate || 0,
                        plantRate: rate.plantRate || 0,
                        subRate: rate.subRate || 0,
                        description: rate.desc,
                        unit: rate.unit,
                        section: rate.section || 'General'
                    }
                });
            } else {
                const newItem = await app.apiFetch('/api/estimate-items', {
                    method: 'POST',
                    body: {
                        project_id: app.state.activeWorkspaceId,
                        section: rate.section || 'General',
                        description: rate.desc,
                        quantity: rate.qty,
                        unit: rate.unit,
                        materialRate: rate.materialRate || 0,
                        labourRate: rate.labourRate || 0,
                        plantRate: rate.plantRate || 0,
                        subRate: rate.subRate || 0
                    }
                });
                rate.backendId = newItem.id;
            }
        } catch (err) {
            console.error('Error saving rate to backend:', err);
        }
    }

    async loadPriceLibrary() {
        try {
            this.priceLibrary = await app.apiFetch('/api/rates');
        } catch (err) {
            console.error('Error loading price library:', err);
        }
    }

    async syncTenderRatesWithLibrary() {
        if (!app.state.activeWorkspaceId) {
            alert('Please open a tender project first.');
            return;
        }
        if (this.rates.length === 0) {
            alert('No items in the active project estimate to sync.');
            return;
        }

        await this.loadPriceLibrary();

        let updatedCount = 0;
        const promises = [];

        for (const item of this.rates) {
            const libMatch = this.priceLibrary.find(l => l.name.toLowerCase().trim() === item.desc.toLowerCase().trim());
            if (libMatch) {
                const cost = libMatch.costRate;
                let mat = 0, lab = 0, plt = 0, sub = 0;
                if (libMatch.category === 'Material') mat = cost;
                else if (libMatch.category === 'Plant') plt = cost;
                else if (libMatch.category === 'Labour' || libMatch.category === 'labor') lab = cost;
                else sub = cost;

                if (item.materialRate !== mat || item.labourRate !== lab || item.plantRate !== plt || item.subRate !== sub) {
                    item.materialRate = mat;
                    item.labourRate = lab;
                    item.plantRate = plt;
                    item.subRate = sub;
                    item.current = cost;
                    
                    updatedCount++;
                    promises.push(this.saveRateToBackend(item));
                }
            }
        }

        if (updatedCount > 0) {
            await Promise.all(promises);
            alert(`Successfully synchronized ${updatedCount} items in the project estimate with the latest Price Library rates!`);
            this.render();
            if (app.advisor) {
                app.advisor.recalculateTenderTotals();
            }
        } else {
            alert('All items in the project estimate are already up-to-date with the Price Library.');
        }
    }

    async openAddEstimateItemModal() {
        if (!app.state.activeWorkspaceId) {
            alert('Please select or create an active tender workspace first.');
            return;
        }
        await this.loadPriceLibrary();
        
        const select = document.getElementById('add-item-library-select');
        select.innerHTML = '';
        
        if (this.priceLibrary.length === 0) {
            select.innerHTML = '<option value="">No items in global Price Library</option>';
        } else {
            this.priceLibrary.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r.id;
                opt.innerText = `${r.name} (${r.category}) - £${r.costRate.toFixed(2)}/${r.unit}`;
                select.appendChild(opt);
            });
        }

        // Reset calculator inputs
        document.getElementById('add-item-calc-width').value = '';
        document.getElementById('add-item-calc-length').value = '';
        document.getElementById('add-item-calc-height').value = '';
        document.getElementById('add-item-calc-formula').innerText = '-';
        document.getElementById('add-item-calculator-container').style.display = 'none';

        this.setAddMode('library');
        
        document.getElementById('add-estimate-item-modal').style.display = 'flex';
        this.onLibrarySelectChange();
    }

    closeAddEstimateItemModal() {
        document.getElementById('add-estimate-item-modal').style.display = 'none';
        document.getElementById('add-item-desc').value = '';
        document.getElementById('add-item-rate').value = '';
        document.getElementById('add-item-qty').value = '1.00';
    }

    setAddMode(mode) {
        this.addMode = mode;
        const btnLib = document.getElementById('btn-add-mode-library');
        const btnCustom = document.getElementById('btn-add-mode-custom');
        const fieldsLib = document.getElementById('add-item-library-fields');
        const fieldsCustom = document.getElementById('add-item-custom-fields');

        if (mode === 'library') {
            btnLib.classList.add('active');
            btnCustom.classList.remove('active');
            fieldsLib.style.display = 'flex';
            fieldsCustom.style.display = 'none';
            this.onLibrarySelectChange();
        } else {
            btnLib.classList.remove('active');
            btnCustom.classList.add('active');
            fieldsLib.style.display = 'none';
            fieldsCustom.style.display = 'flex';
            const selectUnit = document.getElementById('add-item-unit');
            if (selectUnit) {
                this.handleUnitChange('add-item', selectUnit.value);
            }
        }
    }

    onLibrarySelectChange() {
        const id = document.getElementById('add-item-library-select').value;
        const rate = this.priceLibrary.find(r => r.id === id);
        
        const previewCat = document.getElementById('add-item-lib-category');
        const previewCost = document.getElementById('add-item-lib-cost');
        const previewUnit = document.getElementById('add-item-lib-unit');

        if (rate) {
            previewCat.innerText = rate.category;
            previewCost.innerText = `£${rate.costRate.toFixed(2)}`;
            previewUnit.innerText = rate.unit;
            this.handleUnitChange('add-item', rate.unit);
        } else {
            previewCat.innerText = '-';
            previewCost.innerText = '£0.00';
            previewUnit.innerText = '-';
            document.getElementById('add-item-calculator-container').style.display = 'none';
        }
    }

    async saveEstimateItem() {
        if (!app.state.activeWorkspaceId) return;

        const qtyStr = document.getElementById('add-item-qty').value;
        const qty = parseFloat(qtyStr);
        if (isNaN(qty) || qty <= 0) {
            alert('Please enter a valid quantity.');
            return;
        }

        let payload = {};
        if (this.addMode === 'library') {
            const libId = document.getElementById('add-item-library-select').value;
            const rate = this.priceLibrary.find(r => r.id === libId);
            if (!rate) {
                alert('Please select a valid Price Library element.');
                return;
            }

            const cost = rate.costRate;
            let mat = 0, lab = 0, plt = 0, sub = 0;
            if (rate.category === 'Material') mat = cost;
            else if (rate.category === 'Plant') plt = cost;
            else if (rate.category === 'Labour' || rate.category === 'labor') lab = cost;
            else sub = cost;

            payload = {
                project_id: app.state.activeWorkspaceId,
                section: 'General',
                description: rate.name,
                quantity: qty,
                unit: rate.unit,
                materialRate: mat,
                labourRate: lab,
                plantRate: plt,
                subRate: sub,
                confidence: 'High',
                assumptions: `Added from Price Library: "${rate.name}"`
            };
        } else {
            const desc = document.getElementById('add-item-desc').value.trim();
            const category = document.getElementById('add-item-category').value;
            const unit = document.getElementById('add-item-unit').value;
            const rateStr = document.getElementById('add-item-rate').value;
            
            if (!desc || !rateStr) {
                alert('Description and Cost Rate are required.');
                return;
            }

            const cost = parseFloat(rateStr);
            if (isNaN(cost) || cost < 0) {
                alert('Please enter a valid unit cost rate.');
                return;
            }

            let mat = 0, lab = 0, plt = 0, sub = 0;
            if (category === 'materials') mat = cost;
            else if (category === 'labor') lab = cost;
            else if (category === 'plant') plt = cost;
            else sub = cost;

            payload = {
                project_id: app.state.activeWorkspaceId,
                section: 'General',
                description: desc,
                quantity: qty,
                unit: unit,
                materialRate: mat,
                labourRate: lab,
                plantRate: plt,
                subRate: sub,
                confidence: 'Medium',
                assumptions: 'Manually added custom estimate item'
            };
        }

        try {
            await app.apiFetch('/api/estimate-items', {
                method: 'POST',
                body: payload
            });

            this.closeAddEstimateItemModal();
            alert('Item successfully added to estimate.');
            
            await app.loadActiveWorkspaceEstimate();
        } catch (err) {
            console.error('Error adding estimate item:', err);
            alert('Error adding item: ' + err.message);
        }
    }

    // --- Calculator Helpers ---
    handleUnitChange(prefix, unit) {
        const container = document.getElementById(`${prefix}-calculator-container`);
        const typeSelect = document.getElementById(`${prefix}-calc-type`);
        const heightGroup = document.getElementById(`${prefix}-calc-height-group`);
        if (!container || !typeSelect) return;
        
        const cleanUnit = (unit || '').toLowerCase().trim();
        const isM2 = cleanUnit === 'm2' || cleanUnit === 'sqm' || cleanUnit === 'm²';
        const isM = cleanUnit === 'm' || cleanUnit === 'lm' || cleanUnit === 'linear';

        if (isM2) {
            container.style.display = 'block';
            if (heightGroup) heightGroup.style.display = 'block';
            
            // Populate m2 calculation types
            const prevVal = typeSelect.value;
            typeSelect.innerHTML = `
                <option value="walls">Wall Area: 2 * (W + L) * H</option>
                <option value="floor">Floor / Ceiling Area: W * L</option>
                <option value="total">Walls + Ceiling: 2 * (W + L) * H + (W * L)</option>
            `;
            if (['walls', 'floor', 'total'].includes(prevVal)) {
                typeSelect.value = prevVal;
            } else {
                typeSelect.value = 'walls';
            }
            this.runCalculation(prefix);
        } else if (isM) {
            container.style.display = 'block';
            if (heightGroup) heightGroup.style.display = 'none';
            
            // Populate m/lm calculation types
            const prevVal = typeSelect.value;
            typeSelect.innerHTML = `
                <option value="perimeter">Perimeter: 2 * (W + L)</option>
                <option value="half">Width + Length: W + L</option>
            `;
            if (['perimeter', 'half'].includes(prevVal)) {
                typeSelect.value = prevVal;
            } else {
                typeSelect.value = 'perimeter';
            }
            this.runCalculation(prefix);
        } else {
            container.style.display = 'none';
        }
    }

    runCalculation(prefix) {
        const widthVal = document.getElementById(`${prefix}-calc-width`);
        const lengthVal = document.getElementById(`${prefix}-calc-length`);
        const heightVal = document.getElementById(`${prefix}-calc-height`);
        const typeSelect = document.getElementById(`${prefix}-calc-type`);
        const formulaEl = document.getElementById(`${prefix}-calc-formula`);
        const qtyInput = document.getElementById(prefix === 'add-item' ? 'add-item-qty' : 'rate-qty-input');
        
        if (!widthVal || !lengthVal || !typeSelect || !formulaEl || !qtyInput) return;

        const width = parseFloat(widthVal.value) || 0;
        const length = parseFloat(lengthVal.value) || 0;
        const height = heightVal ? (parseFloat(heightVal.value) || 0) : 0;
        const calcType = typeSelect.value;

        let result = 0;
        let formulaText = '-';

        if (calcType === 'walls') {
            result = 2 * (width + length) * height;
            formulaText = `2 * (${width.toFixed(2)} + ${length.toFixed(2)}) * ${height.toFixed(2)} = ${result.toFixed(2)} m²`;
        } else if (calcType === 'floor') {
            result = width * length;
            formulaText = `${width.toFixed(2)} * ${length.toFixed(2)} = ${result.toFixed(2)} m²`;
        } else if (calcType === 'total') {
            result = 2 * (width + length) * height + (width * length);
            formulaText = `2 * (${width.toFixed(2)} + ${length.toFixed(2)}) * ${height.toFixed(2)} + (${width.toFixed(2)} * ${length.toFixed(2)}) = ${result.toFixed(2)} m²`;
        } else if (calcType === 'perimeter') {
            result = 2 * (width + length);
            formulaText = `2 * (${width.toFixed(2)} + ${length.toFixed(2)}) = ${result.toFixed(2)} m`;
        } else if (calcType === 'half') {
            result = width + length;
            formulaText = `${width.toFixed(2)} + ${length.toFixed(2)} = ${result.toFixed(2)} m`;
        }

        if (result > 0) {
            qtyInput.value = result.toFixed(2);
            formulaEl.innerText = formulaText;
        } else {
            formulaEl.innerText = '-';
        }
    }
}

// Instantiate and expose globally
const pricingComponent = new PricingComponent();
window.pricingComponent = pricingComponent;
