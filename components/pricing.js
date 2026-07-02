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
        this.sorAppliedOrder = [];
        this.windowDoorGroupSeq = 0;
    }

    init() {
        this.setupEventListeners();
        this.loadSupplierFeeds();
        this.loadHistoricalTenders();
        this.loadPriceLibrary();
    }

    normaliseUnit(unit) {
        const clean = String(unit || '').trim().toLowerCase();
        if (['m2', 'm²', 'sqm', 'sq m', 'square metre', 'square metres'].includes(clean)) return 'm2';
        if (['m3', 'm³', 'cum', 'cu m', 'cubic metre', 'cubic metres'].includes(clean)) return 'm3';
        if (['m', 'lm', 'linear', 'linear metre', 'linear metres'].includes(clean)) return 'm';
        if (['nr', 'no', 'number', 'qty'].includes(clean)) return 'Nr';
        if (['item', 'each', 'ea'].includes(clean)) return 'Item';
        if (['sum', 'ls', 'lump sum'].includes(clean)) return 'Sum';
        if (['hr', 'hour', 'hours'].includes(clean)) return 'hr';
        if (['day', 'days'].includes(clean)) return 'day';
        if (['t', 'ton', 'tonne', 'tonnes'].includes(clean)) return 't';
        return unit || 'Item';
    }

    displayUnit(unit) {
        const normalised = this.normaliseUnit(unit);
        if (normalised === 'm2') return 'm²';
        if (normalised === 'm3') return 'm³';
        return normalised;
    }

    normaliseMatchText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/[£$€]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\b(ref|reference|line|item|no|number)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    getRateCost(rate) {
        if (!rate) return 0;
        const componentCost = (Number(rate.materialRate) || 0) +
            (Number(rate.labourRate) || 0) +
            (Number(rate.plantRate) || 0) +
            (Number(rate.subRate) || 0);
        if (componentCost > 0) return componentCost;
        if (Number.isFinite(Number(rate.company))) return Number(rate.company) || 0;
        return Number(rate.current) || 0;
    }

    applyUnitCostToRate(rate, unitCost) {
        const cost = Math.max(0, Number(unitCost) || 0);
        const isSubcontracted = this.isRateSubcontracted(rate);
        rate.materialRate = 0;
        rate.labourRate = 0;
        rate.plantRate = 0;
        rate.subRate = 0;

        if (isSubcontracted) {
            rate.subRate = cost;
            rate.category = 'subcontractor';
            rate.subcontracted = true;
        } else if (rate.category === 'labor' || rate.category === 'labour') {
            rate.labourRate = cost;
        } else if (rate.category === 'plant') {
            rate.plantRate = cost;
        } else if (rate.category === 'subcontractor') {
            rate.subRate = cost;
        } else {
            rate.materialRate = cost;
        }

        rate.current = cost;
        rate.company = cost;
        rate.market = cost;
    }

    isRateSubcontracted(rate) {
        if (!rate) return false;
        if (rate.subcontracted === true || rate.isSubcontracted === true || rate.subcontractedItem === true) return true;
        if (String(rate.category || '').toLowerCase() === 'subcontractor') return true;
        const sub = Number(rate.subRate) || 0;
        const mat = Number(rate.materialRate) || 0;
        const lab = Number(rate.labourRate) || 0;
        const plant = Number(rate.plantRate) || 0;
        return sub > 0 && mat === 0 && lab === 0 && plant === 0;
    }

    isModalSubcontracted() {
        const cb = document.getElementById('rate-subcontracted');
        return !!cb?.checked;
    }

    updateSubcontractMode(mergeExisting = false) {
        const checked = this.isModalSubcontracted();
        const matEl = document.getElementById('rate-material');
        const labEl = document.getElementById('rate-labour');
        const plantEl = document.getElementById('rate-plant');
        const subEl = document.getElementById('rate-sub');
        const helpEl = document.getElementById('ai-pricing-mode-help');
        const suggestedLabel = document.getElementById('ai-suggested-label');
        const lookupBtnText = document.getElementById('ai-lookup-btn-text');

        if (checked && mergeExisting && matEl && labEl && plantEl && subEl) {
            const mat = Number(matEl.value) || 0;
            const lab = Number(labEl.value) || 0;
            const plant = Number(plantEl.value) || 0;
            const sub = Number(subEl.value) || 0;
            const directTotal = mat + lab + plant;
            if (directTotal > 0 && sub <= 0) {
                subEl.value = (directTotal + sub).toFixed(2);
                matEl.value = '0.00';
                labEl.value = '0.00';
                plantEl.value = '0.00';
            }
        }

        if (helpEl) {
            helpEl.innerText = checked
                ? "Query AI for the subcontractor package cost to you. This may include the subcontractor's labour, materials, plant, overhead and profit, but still excludes your own markup, VAT, contingency and tender uplift."
                : 'Query AI for a direct company cost-only rate for this task and unit. Overheads, profit, VAT, contingency and tender markup are excluded because the proposal slider adds uplift later.';
        }
        if (suggestedLabel) {
            suggestedLabel.innerText = checked ? 'AI Suggested Subcontract Cost:' : 'AI Suggested Base Cost:';
        }
        if (lookupBtnText) {
            lookupBtnText.innerText = checked ? 'AI Subcontract Cost Lookup' : 'AI Cost Rate Lookup';
        }
        if (subEl) {
            subEl.closest('div')?.classList.toggle('subcontract-active-field', checked);
        }
        this.calcModalTotal();
    }

    getLibraryCategory(rate) {
        const category = String(rate?.category || '').toLowerCase();
        if (category === 'labor' || category === 'labour') return 'Labour';
        if (category === 'plant') return 'Plant';
        if (category === 'subcontractor' || this.isRateSubcontracted(rate)) return 'Subcontractor';
        return 'Material';
    }

    findLibraryMatchForRate(item) {
        const itemText = this.normaliseMatchText(item?.desc || item?.sorDesc || '');
        if (!itemText) return null;

        return this.priceLibrary.find(lib => {
            const libText = this.normaliseMatchText(lib.name || lib.description || '');
            if (!libText) return false;
            if (libText === itemText) return true;
            return libText.length > 18 && itemText.length > 18 && (libText.includes(itemText) || itemText.includes(libText));
        }) || null;
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    isWindowDoorItem(rate) {
        const text = `${rate?.desc || ''} ${rate?.section || ''} ${rate?.room || ''}`
            .toLowerCase()
            .replace(/[\/\-]+/g, ' ');

        // Only show the window/door configurator for actual replacement/supply/install
        // scopes. Do not trigger it for doorway render repairs, door openings, decoration,
        // making good around doors, or other incidental mentions of "door".
        const hasWindowOrDoorProduct = /\b(window|windows|door|doors|upvc|u\.?p\.?v\.?c|composite|glazing|glazed|casement|sash|french door|patio door|sliding door|entrance door|bi\s?fold)\b/.test(text);
        const hasReplacementScope = /\b(replace|replacement|renew|renewal|remove existing|supply|install|installation|fit|fitting|provide|new)\b/.test(text);
        const isIncidentalDoorWork = /\b(doorway|door way|door opening|opening|reveal|around the door|door repairs?|doorway repairs?|render repairs?|make good|redecorate|decoration|strip back|loose and failed render)\b/.test(text)
            && !/\b(upvc|u\.?p\.?v\.?c|composite|glazing|glazed|casement|sash|french door|patio door|sliding door|entrance door|bi\s?fold|replace|replacement|renew|supply|install|new)\b/.test(text);

        return hasWindowOrDoorProduct && hasReplacementScope && !isIncidentalDoorWork;
    }

    getWindowDoorStorageKey(rate) {
        const workspace = app?.state?.activeWorkspaceId || 'global';
        const rateKey = rate?.backendId || rate?.code || this.normaliseMatchText(rate?.desc || '').slice(0, 60);
        return `qs_pro_window_door_spec_${workspace}_${rateKey}`;
    }

    getSavedWindowDoorSpec(rate) {
        if (!rate) return null;
        if (rate.windowDoorSpec) return rate.windowDoorSpec;
        try {
            const raw = localStorage.getItem(this.getWindowDoorStorageKey(rate));
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    saveWindowDoorSpec(rate, spec) {
        if (!rate || !spec) return;
        rate.windowDoorSpec = spec;
        try {
            localStorage.setItem(this.getWindowDoorStorageKey(rate), JSON.stringify(spec));
        } catch (e) {
            console.warn('Could not save window/door pricing spec locally.', e);
        }
    }

    makeWindowDoorGroup(kind = 'window', qty = 1, enabled = true) {
        this.windowDoorGroupSeq += 1;
        return {
            id: `wd-${Date.now()}-${this.windowDoorGroupSeq}`,
            enabled,
            kind,
            qty: Number(qty) || 0,
            material: kind === 'door' ? 'Composite' : 'uPVC',
            glazing: kind === 'door' ? 'Part glazed' : 'Double glazed',
            style: kind === 'door' ? 'Entrance door' : 'Casement',
            notes: ''
        };
    }

    getDefaultWindowDoorSpec(rate) {
        const text = `${rate?.desc || ''} ${rate?.section || ''}`.toLowerCase();
        const qty = Math.max(1, Number(rate?.qty) || 1);
        const hasWindow = /\b(window|windows|upvc|u\.?p\.?v\.?c|casement|sash|glazing|glazed)\b/.test(text);
        const hasDoor = /\b(door|doors|composite|french door|patio door)\b/.test(text);
        const groups = [];

        if (hasWindow || !hasDoor) {
            groups.push(this.makeWindowDoorGroup('window', qty, true));
        }
        if (hasDoor) {
            groups.push(this.makeWindowDoorGroup('door', hasWindow ? 0 : qty, hasWindow ? false : true));
        }

        return {
            useQuantity: true,
            groups
        };
    }

    renderWindowDoorGroups(groups = []) {
        const list = document.getElementById('wd-groups-list');
        if (!list) return;
        list.innerHTML = '';

        groups.forEach(group => {
            const div = document.createElement('div');
            div.className = 'wd-config-row';
            div.dataset.wdGroupId = group.id || this.makeWindowDoorGroup(group.kind || 'window').id;

            const kind = group.kind || 'window';
            const materialOptions = ['uPVC', 'Composite', 'Timber', 'Aluminium', 'Steel', 'Other'];
            const glazingOptions = ['None', 'Single glazed', 'Double glazed', 'Triple glazed', 'Part glazed', 'Obscure glazed', 'Laminated / toughened'];
            const styleOptions = ['Casement', 'Sash', 'Fixed', 'Tilt & turn', 'Entrance door', 'French door', 'Patio / sliding door', 'Fire door', 'Other'];
            const rowId = this.escapeHtml(div.dataset.wdGroupId);

            div.innerHTML = `
                <label class="wd-include-label" title="Include this group" style="display:flex; align-items:center; justify-content:center; height:38px;">
                    <input type="checkbox" class="wd-enabled" ${group.enabled !== false ? 'checked' : ''} onchange="pricingComponent.updateWindowDoorSummary()">
                </label>
                <div class="wd-field">
                    <label>Item</label>
                    <select class="form-select wd-kind" onchange="pricingComponent.updateWindowDoorSummary()">
                        <option value="window" ${kind === 'window' ? 'selected' : ''}>Window</option>
                        <option value="door" ${kind === 'door' ? 'selected' : ''}>Door</option>
                    </select>
                </div>
                <div class="wd-field">
                    <label>Qty</label>
                    <input type="number" class="form-input wd-qty" value="${Number(group.qty) || 0}" min="0" step="1" oninput="pricingComponent.updateWindowDoorSummary()">
                </div>
                <div class="wd-field wd-wide">
                    <label>Material / Type</label>
                    <select class="form-select wd-material" onchange="pricingComponent.updateWindowDoorSummary()">
                        ${materialOptions.map(opt => `<option value="${this.escapeHtml(opt)}" ${String(group.material || '') === opt ? 'selected' : ''}>${this.escapeHtml(opt)}</option>`).join('')}
                    </select>
                </div>
                <div class="wd-field wd-wide">
                    <label>Glazing</label>
                    <select class="form-select wd-glazing" onchange="pricingComponent.updateWindowDoorSummary()">
                        ${glazingOptions.map(opt => `<option value="${this.escapeHtml(opt)}" ${String(group.glazing || '') === opt ? 'selected' : ''}>${this.escapeHtml(opt)}</option>`).join('')}
                    </select>
                </div>
                <div class="wd-field wd-wide">
                    <label>Style</label>
                    <select class="form-select wd-style" onchange="pricingComponent.updateWindowDoorSummary()">
                        ${styleOptions.map(opt => `<option value="${this.escapeHtml(opt)}" ${String(group.style || '') === opt ? 'selected' : ''}>${this.escapeHtml(opt)}</option>`).join('')}
                    </select>
                </div>
                <button type="button" class="btn btn-secondary text-xs wd-remove-btn" onclick="pricingComponent.removeWindowDoorGroup('${rowId}')">Remove</button>
                <div class="wd-field wd-notes-field">
                    <label>Notes / sizes</label>
                    <input type="text" class="form-input wd-notes" value="${this.escapeHtml(group.notes || '')}" placeholder="e.g. 1200 x 900, trickle vents, obscure glass" oninput="pricingComponent.updateWindowDoorSummary()">
                </div>
            `;
            list.appendChild(div);
        });

        this.updateWindowDoorSummary();
    }

    populateWindowDoorConfigurator(rate) {
        const container = document.getElementById('window-door-configurator');
        if (!container) return;

        const modal = document.getElementById('rate-adjustment-modal');
        if (!this.isWindowDoorItem(rate)) {
            container.style.display = 'none';
            if (modal) modal.classList.remove('window-door-mode');
            return;
        }

        container.style.display = 'block';
        if (modal) modal.classList.add('window-door-mode');
        const spec = this.getSavedWindowDoorSpec(rate) || this.getDefaultWindowDoorSpec(rate);
        const useQty = document.getElementById('wd-use-qty');
        if (useQty) useQty.checked = spec.useQuantity !== false;
        this.renderWindowDoorGroups(spec.groups || []);
    }

    addWindowDoorGroup(kind = 'window') {
        const spec = this.collectWindowDoorSpecFromModal({ allowEmpty: true }) || { useQuantity: true, groups: [] };
        spec.groups.push(this.makeWindowDoorGroup(kind, 1, true));
        this.renderWindowDoorGroups(spec.groups);
        const useQty = document.getElementById('wd-use-qty');
        if (useQty) useQty.checked = spec.useQuantity !== false;
    }

    removeWindowDoorGroup(id) {
        const row = Array.from(document.querySelectorAll('.wd-config-row')).find(el => String(el.dataset.wdGroupId) === String(id));
        if (row) row.remove();
        this.updateWindowDoorSummary();
    }

    collectWindowDoorSpecFromModal(options = {}) {
        const container = document.getElementById('window-door-configurator');
        if (!container || container.style.display === 'none') return null;

        const groups = Array.from(document.querySelectorAll('.wd-config-row')).map(row => ({
            id: row.dataset.wdGroupId || `wd-${Date.now()}`,
            enabled: !!row.querySelector('.wd-enabled')?.checked,
            kind: row.querySelector('.wd-kind')?.value || 'window',
            qty: Math.max(0, Number(row.querySelector('.wd-qty')?.value) || 0),
            material: row.querySelector('.wd-material')?.value || '',
            glazing: row.querySelector('.wd-glazing')?.value || '',
            style: row.querySelector('.wd-style')?.value || '',
            notes: row.querySelector('.wd-notes')?.value || ''
        }));

        if (!options.allowEmpty && groups.length === 0) return null;

        const totalQty = groups
            .filter(g => g.enabled)
            .reduce((sum, g) => sum + (Number(g.qty) || 0), 0);

        return {
            useQuantity: !!document.getElementById('wd-use-qty')?.checked,
            totalQty,
            groups
        };
    }

    buildWindowDoorScopeText(spec) {
        if (!spec || !Array.isArray(spec.groups)) return '';
        const included = spec.groups.filter(g => g.enabled && Number(g.qty) > 0);
        if (included.length === 0) return '';

        const lines = included.map(g => {
            const label = g.kind === 'door' ? 'door(s)' : 'window(s)';
            const notes = g.notes ? `, notes/sizes: ${g.notes}` : '';
            return `- ${g.qty} ${label}: ${g.material || 'type not selected'}, ${g.glazing || 'glazing not selected'}, ${g.style || 'style not selected'}${notes}`;
        });

        return `Window/door breakdown for AI pricing (cost-only):\n${lines.join('\n')}\nTotal checked units: ${included.reduce((sum, g) => sum + (Number(g.qty) || 0), 0)}.`;
    }

    updateWindowDoorSummary() {
        const spec = this.collectWindowDoorSpecFromModal({ allowEmpty: true });
        const summary = document.getElementById('wd-summary');
        if (!summary || !spec) return;

        const included = spec.groups.filter(g => g.enabled && Number(g.qty) > 0);
        const windowQty = included.filter(g => g.kind === 'window').reduce((sum, g) => sum + Number(g.qty || 0), 0);
        const doorQty = included.filter(g => g.kind === 'door').reduce((sum, g) => sum + Number(g.qty || 0), 0);
        const total = windowQty + doorQty;

        summary.innerText = total > 0
            ? `Selected for AI: ${windowQty} window(s), ${doorQty} door(s), ${total} total unit(s).${spec.useQuantity ? ' Save will also update the item quantity to this total.' : ''}`
            : 'No checked window/door quantities selected yet.';

        const qtyInput = document.getElementById('rate-qty-input');
        if (spec.useQuantity && total > 0 && qtyInput) {
            qtyInput.value = total;
        }
    }

    getCostOnlyAIRequestBody(rate) {
        const unit = this.normaliseUnit(rate.unit);
        const unitLabel = this.displayUnit(unit);

        let windowDoorSpec = this.getSavedWindowDoorSpec(rate);
        if (this.activeRateModal && String(this.activeRateModal.code) === String(rate.code)) {
            const modalSpec = this.collectWindowDoorSpecFromModal({ allowEmpty: true });
            if (modalSpec) {
                windowDoorSpec = modalSpec;
                rate.windowDoorSpec = modalSpec;
            }
        }
        const windowDoorScope = this.buildWindowDoorScopeText(windowDoorSpec);
        const subcontracted = this.activeRateModal && String(this.activeRateModal.code) === String(rate.code)
            ? this.isModalSubcontracted()
            : this.isRateSubcontracted(rate);

        const instruction = subcontracted
            ? `Return the subcontractor package unit cost payable by our company for this scope. Include the subcontractor's labour, materials, plant, normal waste, specialist attendance, subcontractor overhead and subcontractor profit because that is the true cost to us. Exclude only our own main-contractor markup/profit, tender contingency, VAT and client-facing uplift because the proposal markup/margin slider adds our uplift later. Return the cost per ${unitLabel}; do not convert it into a line total.`
            : `Return a direct company cost-only unit rate for this scope. Exclude subcontractor profit, main-contractor overheads, preliminaries, profit, risk allowance, contingency, VAT and tender markup. The proposal markup/margin slider will add uplift later. Return the rate per ${unitLabel}; do not convert it into a line total. If a window/door breakdown is supplied, use the selected quantities, material/type, glazing and style to assess the correct base cost.`;
        const description = `${rate.desc}${windowDoorScope ? `

${windowDoorScope}` : ''}

Pricing instruction: ${instruction}`;

        return {
            description,
            originalDescription: rate.desc,
            unit: unit,
            unitLabel: unitLabel,
            quantity: windowDoorSpec?.useQuantity && Number(windowDoorSpec?.totalQty) > 0 ? Number(windowDoorSpec.totalQty) : (Number(rate.qty) || 1),
            category: subcontracted ? 'subcontractor' : (rate.category || ''),
            pricingBasis: subcontracted ? 'subcontractor_package_cost_to_company_including_subcontractor_ohp_excluding_our_markup_vat' : 'direct_company_cost_only_excluding_overheads_profit_markup_vat',
            subcontracted,
            windowDoorSpec: windowDoorSpec || undefined
        };
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

        const btnClearAllPrices = document.getElementById('btn-clear-all-prices');
        if (btnClearAllPrices) {
            btnClearAllPrices.addEventListener('click', () => this.clearAllPrices());
        }

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

        const filtered = this.rates
            .filter(rate => {
                const matchesSearch = rate.desc.toLowerCase().includes(searchQuery.toLowerCase()) || rate.code.toLowerCase().includes(searchQuery.toLowerCase());
                const matchesCategory = categoryFilter === 'all' || rate.category === categoryFilter;
                return matchesSearch && matchesCategory;
            })
            .sort((a, b) => {
                const aOrder = Number(a.sorOrderIndex ?? a.sourceOrder ?? a.sortOrder ?? a.orderIndex);
                const bOrder = Number(b.sorOrderIndex ?? b.sourceOrder ?? b.sortOrder ?? b.orderIndex);
                const aHasOrder = Number.isFinite(aOrder);
                const bHasOrder = Number.isFinite(bOrder);
                if (aHasOrder && bHasOrder && aOrder !== bOrder) return aOrder - bOrder;
                if (aHasOrder && !bHasOrder) return -1;
                if (!aHasOrder && bHasOrder) return 1;
                return 0;
            });

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-5">No rates match search filter</td></tr>`;
            return;
        }

        const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;

        filtered.forEach((r) => {
            const tr = document.createElement('tr');
            const roomName = r.section || r.room || 'General';
            const shortDesc = (r.desc || '').length > 140 ? (r.desc || '').slice(0, 140).trim() + '…' : (r.desc || '');
            const selectedUnit = this.normaliseUnit(r.unit);
            const rateCost = this.getRateCost(r);
            const total = ((Number(r.qty) || 0) * rateCost).toFixed(2);
            const linkActive = this.pendingLinkRateCode && String(this.pendingLinkRateCode) === String(r.code);
            const adjustLabel = this.isWindowDoorItem(r) ? 'Configure' : 'Adjust';

            const unitOptions = `
                <option value="Nr" ${selectedUnit === 'Nr' ? 'selected' : ''}>Nr</option>
                <option value="m2" ${selectedUnit === 'm2' ? 'selected' : ''}>m²</option>
                <option value="m3" ${selectedUnit === 'm3' ? 'selected' : ''}>m³</option>
                <option value="m" ${selectedUnit === 'm' ? 'selected' : ''}>m</option>
                <option value="Item" ${selectedUnit === 'Item' ? 'selected' : ''}>Item</option>
                <option value="Sum" ${selectedUnit === 'Sum' ? 'selected' : ''}>Sum</option>
                <option value="hr" ${selectedUnit === 'hr' ? 'selected' : ''}>hr</option>
                <option value="day" ${selectedUnit === 'day' ? 'selected' : ''}>day</option>
                <option value="t" ${selectedUnit === 't' ? 'selected' : ''}>t</option>
            `;

            if (isMobile) {
                tr.className = 'mobile-pricing-card-row';
                tr.innerHTML = `
                    <td colspan="8">
                        <div class="mobile-pricing-card">
                            <div class="mobile-pricing-title">${shortDesc}</div>
                            <div class="mobile-pricing-room">${roomName}</div>
                            <div class="mobile-pricing-grid">
                                <label><span>Unit</span><select class="form-input text-xs" onchange="pricingComponent.updateRateUnit('${r.code}', this.value)">${unitOptions}</select></label>
                                <label><span>Qty</span><input type="number" class="form-input text-xs" value="${r.qty}" step="any" onchange="pricingComponent.updateRateQty('${r.code}', this.value)"></label>
                                <div><span>Rate</span><strong>£${rateCost.toFixed(2)}</strong></div>
                                <div><span>Total</span><strong class="text-emerald">£${total}</strong></div>
                            </div>
                            <div class="mobile-pricing-actions" style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:10px;">
                                <button class="btn btn-secondary mobile-pricing-adjust" onclick="pricingComponent.editRate('${r.code}')">${adjustLabel}</button>
                                <button class="btn btn-secondary mobile-pricing-adjust" onclick="pricingComponent.startOrCompleteLinkRate('${r.code}')">${linkActive ? 'Linking...' : 'Link Item'}</button>
                                <button class="btn btn-secondary mobile-pricing-adjust" onclick="pricingComponent.addRateToLibrary('${r.code}')">Add Library</button>
                                <button class="btn btn-secondary mobile-pricing-adjust" onclick="pricingComponent.removeRate('${r.code}')">Remove</button>
                            </div>
                        </div>
                    </td>
                `;
            } else {
                tr.innerHTML = `
                    <td><input type="checkbox" class="pricing-row-select" value="${r.code}"></td>
                    <td><span class="badge badge-gray text-xs">${roomName}</span></td>
                    <td><div class="font-semibold">${shortDesc}</div></td>
                    <td><select class="form-input text-xs" style="background: #0e1422; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; width: 80px; color: var(--text-primary); outline: none; display: inline-block;" onchange="pricingComponent.updateRateUnit('${r.code}', this.value)">${unitOptions}</select></td>
                    <td class="text-right"><input type="number" class="form-input text-xs" style="background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; width: 80px; text-align: right; color: var(--text-primary); outline: none; margin-left: auto;" value="${r.qty}" step="any" onchange="pricingComponent.updateRateQty('${r.code}', this.value)"></td>
                    <td class="text-right">£${rateCost.toFixed(2)}</td>
                    <td class="text-right font-bold text-emerald">£${total}</td>
                    <td class="text-right">
                        <div style="display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap;">
                            <button class="btn btn-secondary py-1 px-3 text-xs" onclick="pricingComponent.editRate('${r.code}')">${adjustLabel}</button>
                            <button class="btn btn-secondary py-1 px-3 text-xs" onclick="pricingComponent.startOrCompleteLinkRate('${r.code}')">${linkActive ? 'Linking...' : 'Link'}</button>
                            <button class="btn btn-secondary py-1 px-3 text-xs" onclick="pricingComponent.addRateToLibrary('${r.code}')">Library</button>
                            <button class="btn btn-secondary py-1 px-3 text-xs" onclick="pricingComponent.removeRate('${r.code}')">Remove</button>
                        </div>
                    </td>
                `;
            }

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
            'Nr': 'Nr', 'm2': 'm2', 'm²': 'm2', 'sqm': 'm2', 'm3': 'm3', 'm³': 'm3', 'cum': 'm3',
            'm': 'm', 'lm': 'm', 'linear': 'm', 'Item': 'Item', 'item': 'Item', 'Sum': 'Sum',
            'hr': 'hr', 'hour': 'hr', 'day': 'day', 't': 't', 'ton': 't'
        };
        const mappedUnit = unitMap[rate.unit] || this.normaliseUnit(rate.unit);
        if (unitSelect) {
            unitSelect.value = mappedUnit;
        }

        // Check for remembered room measurements
        let remembered = null;
        if (this.roomMeasurements && rate.section) {
            remembered = this.roomMeasurements[rate.section.toLowerCase()];
        }

        this.handleUnitChange('adjust', mappedUnit);
        this.populateWindowDoorConfigurator(rate);

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

        const subcontractedCheckbox = document.getElementById('rate-subcontracted');
        if (subcontractedCheckbox) {
            subcontractedCheckbox.checked = this.isRateSubcontracted(rate);
        }
        this.updateSubcontractMode(false);
        
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
        const modal = document.getElementById('rate-adjustment-modal');
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('window-door-mode');
        }
        this.activeRateModal = null;
    }

    saveAdjustModal() {
        if (!this.activeRateModal) return;
        const rate = this.activeRateModal;
        
        rate.qty = parseFloat(document.getElementById('rate-qty-input').value) || 0;
        const selectEl = document.getElementById('rate-unit-select');
        if (selectEl) {
            rate.unit = this.normaliseUnit(selectEl.value);
        }

        const windowDoorSpec = this.collectWindowDoorSpecFromModal({ allowEmpty: true });
        if (windowDoorSpec) {
            this.saveWindowDoorSpec(rate, windowDoorSpec);
            if (windowDoorSpec.useQuantity && Number(windowDoorSpec.totalQty) > 0) {
                rate.qty = Number(windowDoorSpec.totalQty);
                rate.unit = 'Item';
                const qtyInput = document.getElementById('rate-qty-input');
                const unitInput = document.getElementById('rate-unit-select');
                if (qtyInput) qtyInput.value = rate.qty;
                if (unitInput) unitInput.value = 'Item';
            }
        }

        const subcontracted = this.isModalSubcontracted();
        rate.subcontracted = subcontracted;
        if (subcontracted) {
            rate.category = 'subcontractor';
        }
        rate.materialRate = parseFloat(document.getElementById('rate-material').value) || 0;
        rate.labourRate = parseFloat(document.getElementById('rate-labour').value) || 0;
        rate.plantRate = parseFloat(document.getElementById('rate-plant').value) || 0;
        rate.subRate = parseFloat(document.getElementById('rate-sub').value) || 0;
        
        rate.current = rate.materialRate + rate.labourRate + rate.plantRate + rate.subRate;
        rate.company = rate.current;
        rate.market = rate.current;

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
                
                // Write room measurements to database!
                app.apiFetch(`/api/projects/${app.state.activeWorkspaceId}/room-measurements`, {
                    method: 'POST',
                    body: {
                        room: rate.section,
                        width: width,
                        length: length,
                        height: height
                    }
                }).catch(err => console.error('Failed to save room measurements to backend:', err));
            }

            // Propagate to all other items in the same room/section
            this.rates.forEach(otherRate => {
                if (otherRate.code === rate.code) return; // skip self
                if (otherRate.section && otherRate.section.toLowerCase() === roomKey) {
                    const calculatedQty = app.calculateQuantityFromDimensions(otherRate.desc, otherRate.unit, width, length, height);
                    if (calculatedQty !== null && calculatedQty > 0) {
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
                body: this.getCostOnlyAIRequestBody(rate)
            });
            
            if (data && data.success) {
                const displayUnit = this.displayUnit(rate.unit);
                const subcontracted = this.isModalSubcontracted();
                document.getElementById('ai-suggested-val').innerText = `£${data.recommendedRate.toFixed(2)}`;
                document.getElementById('ai-suggested-range').innerText = `£${data.minPrice.toFixed(2)} - £${data.maxPrice.toFixed(2)} per ${displayUnit}`;
                document.getElementById('ai-suggested-explain').innerText = data.explanation;
                document.getElementById('ai-suggested-source').innerText = subcontracted
                    ? `${data.source || 'Standard UK Construction Index'} — subcontract package cost to us, including subcontractor OH&P/profit, excluding our markup/VAT`
                    : `${data.source || 'Standard UK Construction Index'} — direct company cost only, excluding subcontractor profit/OH&P/markup/VAT`;
                
                this.modalAISuggestedRate = data.recommendedRate;

                if (data.detectedQuantity && Number(data.detectedQuantity) > 1 && (!rate.qty || Number(rate.qty) <= 1)) {
                    rate.qty = Number(data.detectedQuantity);
                    const qtyInput = document.getElementById('rate-qty-input');
                    if (qtyInput) qtyInput.value = rate.qty;
                }
                
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
        
        const suggestedCost = Number(this.modalAISuggestedRate) || 0;
        document.getElementById('rate-material').value = '0.00';
        document.getElementById('rate-labour').value = '0.00';
        document.getElementById('rate-plant').value = '0.00';
        document.getElementById('rate-sub').value = '0.00';

        if (this.isModalSubcontracted()) {
            document.getElementById('rate-sub').value = suggestedCost.toFixed(2);
            rate.category = 'subcontractor';
            rate.subcontracted = true;
        } else if (rate.category === 'labor' || rate.category === 'labour') {
            document.getElementById('rate-labour').value = suggestedCost.toFixed(2);
        } else if (rate.category === 'plant') {
            document.getElementById('rate-plant').value = suggestedCost.toFixed(2);
        } else if (rate.category === 'subcontractor') {
            document.getElementById('rate-sub').value = suggestedCost.toFixed(2);
        } else {
            document.getElementById('rate-material').value = suggestedCost.toFixed(2);
        }
        
        this.calcModalTotal();
    }

    toggleAllPricingRows(checked) {
        document.querySelectorAll('.pricing-row-select').forEach(cb => {
            cb.checked = checked;
        });
    }

    getSelectedRatesForAI() {
        const selectedCodes = Array.from(document.querySelectorAll('.pricing-row-select:checked')).map(cb => cb.value);
        return this.rates.filter(r => selectedCodes.includes(String(r.code)));
    }

    async applyAIPriceToRate(rate) {
        const data = await app.apiFetch('/api/ai/price-suggest', {
            method: 'POST',
            body: this.getCostOnlyAIRequestBody(rate)
        });

        if (!data || !data.success || !Number.isFinite(Number(data.recommendedRate))) {
            throw new Error('Invalid AI price response');
        }

        const aiRate = Number(data.recommendedRate);

        this.applyUnitCostToRate(rate, aiRate);

        if (data.detectedQuantity && Number(data.detectedQuantity) > 1 && (!rate.qty || Number(rate.qty) <= 1)) {
            rate.qty = Number(data.detectedQuantity);
        }

        await this.saveRateToBackend(rate);
        return data;
    }

    async quickAIPriceSelected() {
        const selectedRates = this.getSelectedRatesForAI();

        if (selectedRates.length === 0) {
            alert('Select at least one pricing item first.');
            return;
        }

        if (!confirm(`AI price ${selectedRates.length} selected item(s)? This will overwrite their current unit rates.`)) {
            return;
        }

        let updated = 0;
        let failed = 0;

        for (const rate of selectedRates) {
            try {
                await this.applyAIPriceToRate(rate);
                updated++;
            } catch (err) {
                failed++;
                console.error('Quick AI pricing failed for:', rate.desc, err);
            }
        }

        this.render();

        if (app.advisor) {
            app.advisor.recalculateTenderTotals();
        }

        alert(`Quick AI pricing complete. Updated: ${updated}. Failed: ${failed}.`);
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
            rate.unit = this.normaliseUnit(newUnit);
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
        this.sorAppliedOrder = [];

        this.sorItems.forEach((item, index) => {
            if (item.approved) {
                const targetRate = this.rates.find(r => r.code === item.matchCode);
                if (targetRate) {
                    targetRate.qty = item.qty;
                    targetRate.unit = item.unit || targetRate.unit || 'Item';
                    targetRate.sorOrderIndex = index;
                    targetRate.sorRef = item.ref || '';
                    targetRate.sorDesc = item.desc || targetRate.desc || '';
                    this.sorAppliedOrder.push(String(targetRate.code));
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
                    unit: this.normaliseUnit(r.unit || 'm'),
                    company: r.costRate || 0,
                    market: r.costRate || 0,
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

    syncRatesFromEstimates(estimates, roomMeas) {
        if (!estimates || estimates.length === 0) {
            this.rates.forEach(r => r.qty = 0);
            this.render();
            return;
        }

        if (roomMeas) {
            this.roomMeasurements = roomMeas;
        } else if (app.state.activeWorkspaceId) {
            try {
                this.roomMeasurements = JSON.parse(localStorage.getItem(`qs_pro_room_measurements_${app.state.activeWorkspaceId}`) || '{}');
            } catch (e) {
                this.roomMeasurements = {};
            }
        } else {
            this.roomMeasurements = {};
        }

        this.rates = estimates.map((est, index) => {
            const unitRate = (est.materialRate || 0) + (est.labourRate || 0) + (est.plantRate || 0) + (est.subRate || 0);
            
            let category = 'materials';
            if (est.labourRate > 0) category = 'labor';
            else if (est.plantRate > 0) category = 'plant';
            else if (est.subRate > 0) category = 'subcontractor';
            
            const parsedOrder = Number(est.sorOrderIndex ?? est.sourceOrder ?? est.sortOrder ?? est.orderIndex ?? est.lineNumber ?? index);

            return {
                code: est.id,
                backendId: est.id,
                desc: est.description,
                section: est.section || 'General',
                category: category,
                unit: this.normaliseUnit(est.unit || 'Item'),
                company: unitRate,
                market: unitRate,
                current: unitRate,
                qty: est.quantity || 0,
                materialRate: est.materialRate || 0,
                labourRate: est.labourRate || 0,
                plantRate: est.plantRate || 0,
                subRate: est.subRate || 0,
                subcontracted: !!(est.subcontracted || est.isSubcontracted || (Number(est.subRate) > 0 && !Number(est.materialRate) && !Number(est.labourRate) && !Number(est.plantRate))),
                sourceOrder: Number.isFinite(parsedOrder) ? parsedOrder : index,
                sorOrderIndex: Number.isFinite(parsedOrder) ? parsedOrder : index
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
                        unit: this.normaliseUnit(rate.unit),
                        section: rate.section || 'General',
                        sorOrderIndex: Number.isFinite(Number(rate.sorOrderIndex)) ? Number(rate.sorOrderIndex) : undefined,
                        sourceOrder: Number.isFinite(Number(rate.sourceOrder)) ? Number(rate.sourceOrder) : undefined,
                        sorRef: rate.sorRef || undefined
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
                        unit: this.normaliseUnit(rate.unit),
                        sorOrderIndex: Number.isFinite(Number(rate.sorOrderIndex)) ? Number(rate.sorOrderIndex) : undefined,
                        sourceOrder: Number.isFinite(Number(rate.sourceOrder)) ? Number(rate.sourceOrder) : undefined,
                        sorRef: rate.sorRef || undefined,
                        materialRate: rate.materialRate || 0,
                        labourRate: rate.labourRate || 0,
                        plantRate: rate.plantRate || 0,
                        subRate: rate.subRate || 0
                    }
                });
                rate.backendId = newItem.id;
            }

            if (window.app && typeof window.app.triggerBackupActiveProject === 'function') {
                window.app.triggerBackupActiveProject();
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
            const libMatch = this.findLibraryMatchForRate(item);
            if (libMatch) {
                const cost = Number(libMatch.costRate) || 0;
                const libCategory = String(libMatch.category || '').toLowerCase();
                let mat = 0, lab = 0, plt = 0, sub = 0;
                if (libCategory === 'material' || libCategory === 'materials') mat = cost;
                else if (libCategory === 'plant') plt = cost;
                else if (libCategory === 'labour' || libCategory === 'labor') lab = cost;
                else sub = cost;

                if (item.materialRate !== mat || item.labourRate !== lab || item.plantRate !== plt || item.subRate !== sub) {
                    item.materialRate = mat;
                    item.labourRate = lab;
                    item.plantRate = plt;
                    item.subRate = sub;
                    item.current = cost;
                    item.company = cost;
                    item.market = cost;
                    item.unit = this.normaliseUnit(libMatch.unit || item.unit);
                    
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

    async addRateToLibrary(code) {
        const rate = this.rates.find(r => String(r.code) === String(code));
        if (!rate) return;
        await this.saveRateAsLibraryItem(rate);
    }

    async addActiveRateToLibrary() {
        if (!this.activeRateModal) return;

        const rate = this.activeRateModal;
        rate.unit = this.normaliseUnit(document.getElementById('rate-unit-select')?.value || rate.unit);
        rate.subcontracted = this.isModalSubcontracted();
        if (rate.subcontracted) {
            rate.category = 'subcontractor';
        }
        rate.materialRate = parseFloat(document.getElementById('rate-material')?.value) || 0;
        rate.labourRate = parseFloat(document.getElementById('rate-labour')?.value) || 0;
        rate.plantRate = parseFloat(document.getElementById('rate-plant')?.value) || 0;
        rate.subRate = parseFloat(document.getElementById('rate-sub')?.value) || 0;
        rate.current = this.getRateCost(rate);
        rate.company = rate.current;
        rate.market = rate.current;

        await this.saveRateAsLibraryItem(rate);
    }

    async saveRateAsLibraryItem(rate) {
        if (!rate) return;
        const cost = this.getRateCost(rate);
        if (!cost || cost <= 0) {
            alert('Add a cost rate before saving this item to the library.');
            return;
        }

        const payload = {
            name: rate.desc,
            description: rate.desc,
            category: this.getLibraryCategory(rate),
            unit: this.normaliseUnit(rate.unit),
            costRate: cost,
            supplier: 'Saved from tender estimate',
            tradeScope: rate.section || 'General'
        };

        try {
            await app.apiFetch('/api/rates', {
                method: 'POST',
                body: payload
            });
            await this.loadPriceLibrary();
            alert('Saved this item to the Price Library. Future matching descriptions can now sync from the library.');
        } catch (err) {
            console.error('Add to library failed:', err);
            alert('Could not save this item to the library. If this repeats, the backend /api/rates POST route needs enabling.');
        }
    }

    async removeRate(code, skipConfirm = false) {
        const index = this.rates.findIndex(r => String(r.code) === String(code));
        if (index === -1) return;

        const rate = this.rates[index];
        if (!skipConfirm && !confirm(`Remove this item from the schedule?\n\n${rate.desc}`)) return;

        const removed = this.rates.splice(index, 1)[0];

        try {
            if (removed.backendId) {
                await app.apiFetch(`/api/estimate-items/${removed.backendId}`, { method: 'DELETE' });
            }
        } catch (err) {
            console.warn('Delete route failed; saving zero quantity as fallback.', err);
            removed.qty = 0;
            this.applyUnitCostToRate(removed, 0);
            await this.saveRateToBackend(removed);
        }

        this.render(
            document.getElementById('pricing-search')?.value || '',
            document.getElementById('pricing-category-filter')?.value || 'all'
        );

        if (app.advisor) {
            app.advisor.recalculateTenderTotals();
        }
    }

    async clearAllPrices() {
        if (this.rates.length === 0) {
            alert('There are no items to clear.');
            return;
        }

        if (!confirm('Clear every price in this document to £0.00? Quantities and descriptions will be kept.')) {
            return;
        }

        const promises = this.rates.map(rate => {
            this.applyUnitCostToRate(rate, 0);
            return this.saveRateToBackend(rate);
        });

        await Promise.all(promises);
        this.render(
            document.getElementById('pricing-search')?.value || '',
            document.getElementById('pricing-category-filter')?.value || 'all'
        );

        if (app.advisor) {
            app.advisor.recalculateTenderTotals();
        }

        alert('All prices have been reset to £0.00.');
    }

    async startOrCompleteLinkRate(code) {
        const selected = this.rates.find(r => String(r.code) === String(code));
        if (!selected) return;

        if (!this.pendingLinkRateCode) {
            this.pendingLinkRateCode = code;
            this.render(
                document.getElementById('pricing-search')?.value || '',
                document.getElementById('pricing-category-filter')?.value || 'all'
            );
            alert('Link mode started. Now press Link on the item that should receive this description and value.');
            return;
        }

        if (String(this.pendingLinkRateCode) === String(code)) {
            this.pendingLinkRateCode = null;
            this.render(
                document.getElementById('pricing-search')?.value || '',
                document.getElementById('pricing-category-filter')?.value || 'all'
            );
            alert('Link mode cancelled.');
            return;
        }

        const source = this.rates.find(r => String(r.code) === String(this.pendingLinkRateCode));
        const target = selected;
        this.pendingLinkRateCode = null;

        if (!source || !target) return;

        const sourceDesc = source.desc || '';
        const targetDesc = target.desc || '';
        target.desc = `${sourceDesc}\n${targetDesc}`.trim();

        const sourceTotal = (Number(source.qty) || 0) * this.getRateCost(source);
        const targetTotal = (Number(target.qty) || 0) * this.getRateCost(target);
        const targetQty = Number(target.qty) || 1;
        const combinedRate = (sourceTotal + targetTotal) / targetQty;
        this.applyUnitCostToRate(target, combinedRate);

        if (!Number.isFinite(Number(target.sorOrderIndex)) && Number.isFinite(Number(source.sorOrderIndex))) {
            target.sorOrderIndex = source.sorOrderIndex;
        }
        if (!target.sorRef && source.sorRef) target.sorRef = source.sorRef;

        await this.saveRateToBackend(target);
        await this.removeRate(source.code, true);

        this.render(
            document.getElementById('pricing-search')?.value || '',
            document.getElementById('pricing-category-filter')?.value || 'all'
        );

        if (app.advisor) {
            app.advisor.recalculateTenderTotals();
        }

        alert('Items linked into one schedule line. The combined line keeps the total value from both items.');
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
