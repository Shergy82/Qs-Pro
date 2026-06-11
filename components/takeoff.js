/**
 * QS Pro AI - Quantity Take-Off Component
 */

class TakeoffComponent {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.currentTool = 'polygon'; // polygon, line, count
        
        // Scale settings
        this.scaleRatio = 100; // 1:100 default
        this.pxPerMeter = 20; // 20 pixels = 1 meter at 1:100
        
        // Active drawing state
        this.points = [];
        this.shapes = [];
        
        // Mouse hover state
        this.mousePos = { x: 0, y: 0 };
        this.isDrawing = false;
        
        // Canvas zoom
        this.zoomLevel = 1.0;
        this.canvasSize = { width: 700, height: 450 };
    }

    init() {
        this.canvas = document.getElementById('takeoff-canvas');
        if (!this.canvas) return;
        
        this.ctx = this.canvas.getContext('2d');
        
        this.setupCanvasSize();
        this.setupEventListeners();
        this.renderCanvas();
        this.renderMeasurementsList();
    }

    setupCanvasSize() {
        this.canvas.width = this.canvasSize.width;
        this.canvas.height = this.canvasSize.height;
    }

    setupEventListeners() {
        // Tool switcher
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.btn-tool').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentTool = btn.getAttribute('data-tool');
                this.resetActiveDrawing();
            });
        });

        // Scale change
        document.getElementById('takeoff-scale').addEventListener('change', (e) => {
            this.scaleRatio = parseInt(e.target.value);
            // 1:50 => 1m = 40px, 1:100 => 1m = 20px, 1:200 => 1m = 10px
            this.pxPerMeter = 20 * (100 / this.scaleRatio);
            this.recalculateAllValues();
            this.renderCanvas();
            this.renderMeasurementsList();
        });

        // Canvas mouse handlers
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        
        // Disable context menu for right-click closure
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.completeDrawing();
        });

        // Clear all
        document.getElementById('btn-clear-takeoff').addEventListener('click', () => {
            if (confirm("Are you sure you want to clear all quantity measurements?")) {
                this.shapes = [];
                this.resetActiveDrawing();
                this.renderCanvas();
                this.renderMeasurementsList();
            }
        });

        // Zoom keys and buttons
        document.getElementById('btn-zoom-in').addEventListener('click', () => this.zoom(0.1));
        document.getElementById('btn-zoom-out').addEventListener('click', () => this.zoom(-0.1));
        document.getElementById('btn-fit-screen').addEventListener('click', () => this.zoomReset());

        // Sync to Pricing
        document.getElementById('btn-sync-pricing').addEventListener('click', () => this.syncToPricing());

        // Toggle manual form display
        const btnToggleManualForm = document.getElementById('btn-toggle-manual-form');
        const manualFormFields = document.getElementById('manual-form-fields');
        if (btnToggleManualForm && manualFormFields) {
            btnToggleManualForm.addEventListener('click', () => {
                if (manualFormFields.style.display === 'none') {
                    manualFormFields.style.display = 'block';
                    btnToggleManualForm.querySelector('span').innerText = '- Hide Manual Form';
                    this.handleManualUnitChange();
                } else {
                    manualFormFields.style.display = 'none';
                    btnToggleManualForm.querySelector('span').innerText = '+ Add Manual Quantity';
                }
            });
        }

        // Add manual measurement button
        const btnAddManualMeasure = document.getElementById('btn-add-manual-measure');
        if (btnAddManualMeasure) {
            btnAddManualMeasure.addEventListener('click', () => {
                const nameInput = document.getElementById('manual-name');
                const valInput = document.getElementById('manual-value');
                const unitSelect = document.getElementById('manual-unit');
                
                if (!nameInput || !valInput || !unitSelect) return;
                
                const name = nameInput.value.trim();
                const val = parseFloat(valInput.value);
                const toolType = unitSelect.value;
                
                if (!name) {
                    alert("Please enter a description for the manual measurement.");
                    return;
                }
                if (isNaN(val) || val < 0) {
                    alert("Please enter a valid positive quantity.");
                    return;
                }
                
                let unit = '';
                let shapeColor = '';
                let strokeColor = '';
                
                if (toolType === 'polygon') {
                    unit = 'm²';
                    shapeColor = 'rgba(59, 130, 246, 0.25)';
                    strokeColor = 'var(--color-blue)';
                } else if (toolType === 'line') {
                    unit = 'm';
                    shapeColor = 'rgba(245, 158, 11, 0.25)';
                    strokeColor = 'var(--color-amber)';
                } else if (toolType === 'count') {
                    unit = 'qty';
                    shapeColor = 'rgba(16, 185, 129, 0.25)';
                    strokeColor = 'var(--color-emerald)';
                }
                
                this.shapes.push({
                    id: 'sh-' + Date.now(),
                    name: name,
                    type: toolType,
                    points: [],
                    color: shapeColor,
                    strokeColor: strokeColor,
                    value: val,
                    unit: unit,
                    isManual: true
                });
                
                // Clear inputs and calculator values
                nameInput.value = '';
                valInput.value = '';
                const widthEl = document.getElementById('manual-calc-width');
                if (widthEl) widthEl.value = '';
                const lengthEl = document.getElementById('manual-calc-length');
                if (lengthEl) lengthEl.value = '';
                const heightEl = document.getElementById('manual-calc-height');
                if (heightEl) heightEl.value = '';
                const formulaEl = document.getElementById('manual-calc-formula');
                if (formulaEl) formulaEl.innerText = '-';
                
                // Re-render
                this.renderCanvas();
                this.renderMeasurementsList();
            });
        }

        // Room Calculator unit change for manual takeoff
        const manualUnitSelect = document.getElementById('manual-unit');
        if (manualUnitSelect) {
            manualUnitSelect.addEventListener('change', () => {
                this.handleManualUnitChange();
            });
        }

        // Bind keyup/change for manual calculator inputs
        ['manual-calc-width', 'manual-calc-length', 'manual-calc-height', 'manual-calc-type'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => this.runManualCalculation());
                el.addEventListener('change', () => this.runManualCalculation());
            }
        });

        // Keyboard press Enter
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && app.state.activePanel === 'takeoff') {
                this.completeDrawing();
            } else if (e.key === 'Escape' && app.state.activePanel === 'takeoff') {
                this.resetActiveDrawing();
                this.renderCanvas();
            }
        });
    }

    onPanelShow() {
        if (!this.canvas) {
            this.init();
        } else {
            this.renderCanvas();
            this.renderMeasurementsList();
        }
    }

    zoom(delta) {
        this.zoomLevel = Math.max(0.5, Math.min(2.0, this.zoomLevel + delta));
        this.canvas.style.transform = `scale(${this.zoomLevel})`;
    }

    zoomReset() {
        this.zoomLevel = 1.0;
        this.canvas.style.transform = `scale(1.0)`;
    }

    resetActiveDrawing() {
        this.points = [];
        this.isDrawing = false;
    }

    getMouseCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        // Adjust for zoom scaling
        return {
            x: Math.round((e.clientX - rect.left) / this.zoomLevel),
            y: Math.round((e.clientY - rect.top) / this.zoomLevel)
        };
    }

    handleMouseDown(e) {
        const coords = this.getMouseCoords(e);
        
        // Left click
        if (e.button === 0) {
            this.isDrawing = true;
            this.points.push(coords);
            
            if (this.currentTool === 'count') {
                // Counts are single clicks
                this.completeDrawing();
            } else {
                this.renderCanvas();
            }
        }
    }

    handleMouseMove(e) {
        this.mousePos = this.getMouseCoords(e);
        if (this.isDrawing && this.currentTool !== 'count') {
            this.renderCanvas();
        }
    }

    completeDrawing() {
        if (!this.isDrawing || this.points.length === 0) return;
        
        let shapeName = '';
        let shapeColor = '';
        let strokeColor = '';
        let val = 0;
        let unit = '';

        if (this.currentTool === 'polygon') {
            if (this.points.length < 3) {
                alert("Area measurements require at least 3 points.");
                this.resetActiveDrawing();
                this.renderCanvas();
                return;
            }
            val = this.calculateArea(this.points);
            unit = 'm²';
            shapeName = `Area Block ${this.shapes.length + 1}`;
            shapeColor = 'rgba(59, 130, 246, 0.25)'; // Glassy Blue
            strokeColor = 'var(--color-blue)';
        } else if (this.currentTool === 'line') {
            if (this.points.length < 2) {
                alert("Linear runs require at least 2 points.");
                this.resetActiveDrawing();
                this.renderCanvas();
                return;
            }
            val = this.calculateLength(this.points);
            unit = 'm';
            shapeName = `Linear Run ${this.shapes.length + 1}`;
            shapeColor = 'rgba(245, 158, 11, 0.25)'; // Glassy Amber
            strokeColor = 'var(--color-amber)';
        } else if (this.currentTool === 'count') {
            val = 1;
            unit = 'qty';
            // Count can stack onto previous points or be a separate shape
            shapeName = `Point Mark ${this.shapes.length + 1}`;
            shapeColor = 'rgba(16, 185, 129, 0.25)'; // Glassy Emerald
            strokeColor = 'var(--color-emerald)';
        }

        this.shapes.push({
            id: 'sh-' + Date.now(),
            name: shapeName,
            type: this.currentTool,
            points: [...this.points],
            color: shapeColor,
            strokeColor: strokeColor,
            value: parseFloat(val.toFixed(2)),
            unit: unit
        });

        this.resetActiveDrawing();
        this.renderCanvas();
        this.renderMeasurementsList();
    }

    // --- Math Calculations ---
    calculateArea(points) {
        if (!points || points.length === 0) return 0;
        // Shoelace algorithm
        let area = 0;
        const j = points.length - 1;
        
        for (let i = 0; i < points.length; i++) {
            const prev = points[i === 0 ? j : i - 1];
            const curr = points[i];
            area += (prev.x + curr.x) * (prev.y - curr.y);
        }
        
        // Convert pixel area to actual meters squared
        const pixelArea = Math.abs(area / 2.0);
        return pixelArea / (this.pxPerMeter * this.pxPerMeter);
    }

    calculateLength(points) {
        if (!points || points.length === 0) return 0;
        let length = 0;
        for (let i = 1; i < points.length; i++) {
            const p1 = points[i - 1];
            const p2 = points[i];
            const dist = Math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2);
            length += dist;
        }
        // Convert pixels to meters
        return length / this.pxPerMeter;
    }

    recalculateAllValues() {
        this.shapes.forEach(shape => {
            if (shape.isManual) return;
            if (shape.type === 'polygon') {
                shape.value = parseFloat(this.calculateArea(shape.points).toFixed(2));
            } else if (shape.type === 'line') {
                shape.value = parseFloat(this.calculateLength(shape.points).toFixed(2));
            }
        });
    }

    deleteMeasurement(id) {
        this.shapes = this.shapes.filter(s => s.id !== id);
        this.renderCanvas();
        this.renderMeasurementsList();
    }

    // --- Drawing the Canvas ---
    renderCanvas() {
        if (!this.ctx) return;
        
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw blueprint background grid
        this.ctx.strokeStyle = '#e2e8f0';
        this.ctx.lineWidth = 0.5;
        const gridSpacing = 20;
        for (let x = 0; x < this.canvas.width; x += gridSpacing) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.canvas.height);
            this.ctx.stroke();
        }
        for (let y = 0; y < this.canvas.height; y += gridSpacing) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        }

        // Draw structural walls mockup (so user has something to click on!)
        this.ctx.strokeStyle = '#cbd5e1';
        this.ctx.lineWidth = 3;
        this.ctx.strokeRect(80, 80, 540, 290); // Outer walls
        
        // Inner corridor
        this.ctx.beginPath();
        this.ctx.moveTo(80, 220);
        this.ctx.lineTo(620, 220);
        this.ctx.stroke();

        // Offices
        this.ctx.beginPath();
        this.ctx.moveTo(250, 80);
        this.ctx.lineTo(250, 370);
        this.ctx.moveTo(480, 80);
        this.ctx.lineTo(480, 370);
        this.ctx.stroke();

        // Texts labelling layout
        this.ctx.font = '10px Inter';
        this.ctx.fillStyle = '#64748b';
        this.ctx.fillText("OFFICE 101", 100, 100);
        this.ctx.fillText("OFFICE 102", 270, 100);
        this.ctx.fillText("CONFERENCE A", 500, 100);
        this.ctx.fillText("RECEPTION", 100, 240);
        this.ctx.fillText("BREAKOUT", 270, 240);
        this.ctx.fillText("PLANT ROOM", 500, 240);

        // Draw saved shapes
        this.shapes.forEach(shape => {
            this.drawShape(shape);
        });

        // Draw active drawing in progress
        if (this.isDrawing && this.points.length > 0) {
            const activeShape = {
                type: this.currentTool,
                points: [...this.points, this.mousePos],
                color: this.currentTool === 'polygon' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(0,0,0,0)',
                strokeColor: this.currentTool === 'polygon' ? 'var(--color-blue)' : (this.currentTool === 'line' ? 'var(--color-amber)' : 'var(--color-emerald)')
            };
            
            // For count tool, just draw a temporary indicator at cursor
            if (this.currentTool === 'count') {
                this.drawCountMarker(this.mousePos, 'rgba(16, 185, 129, 0.7)');
            } else {
                this.drawShape(activeShape);
            }
        }
    }

    drawShape(shape) {
        if (shape.points.length === 0) return;

        this.ctx.lineWidth = 2;
        
        if (shape.type === 'polygon') {
            this.ctx.beginPath();
            this.ctx.moveTo(shape.points[0].x, shape.points[0].y);
            for (let i = 1; i < shape.points.length; i++) {
                this.ctx.lineTo(shape.points[i].x, shape.points[i].y);
            }
            this.ctx.closePath();
            this.ctx.fillStyle = shape.color;
            this.ctx.fill();
            this.ctx.strokeStyle = shape.strokeColor;
            this.ctx.stroke();
            
            // Draw vertex dots
            shape.points.forEach(pt => {
                this.ctx.beginPath();
                this.ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
                this.ctx.fillStyle = shape.strokeColor;
                this.ctx.fill();
            });
            
        } else if (shape.type === 'line') {
            this.ctx.beginPath();
            this.ctx.moveTo(shape.points[0].x, shape.points[0].y);
            for (let i = 1; i < shape.points.length; i++) {
                this.ctx.lineTo(shape.points[i].x, shape.points[i].y);
            }
            this.ctx.strokeStyle = shape.strokeColor;
            this.ctx.stroke();
            
            // Draw vertex dots
            shape.points.forEach(pt => {
                this.ctx.beginPath();
                this.ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
                this.ctx.fillStyle = shape.strokeColor;
                this.ctx.fill();
            });
            
        } else if (shape.type === 'count') {
            shape.points.forEach(pt => {
                this.drawCountMarker(pt, shape.strokeColor);
            });
        }
    }

    drawCountMarker(pt, color) {
        this.ctx.beginPath();
        this.ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
        
        this.ctx.beginPath();
        this.ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
        this.ctx.fillStyle = color;
        this.ctx.fill();
    }

    // --- Render Sidebar Measurements List ---
    renderMeasurementsList() {
        const list = document.getElementById('measurements-list');
        list.innerHTML = '';
        
        let totalArea = 0;
        let totalLength = 0;
        let totalCount = 0;

        if (this.shapes.length === 0) {
            list.innerHTML = `<div class="text-secondary text-center text-xs py-5">No measurements taken yet.</div>`;
            document.getElementById('summary-area').innerText = '0.00 m²';
            document.getElementById('summary-length').innerText = '0.00 m';
            document.getElementById('summary-count').innerText = '0 items';
            return;
        }

        this.shapes.forEach(shape => {
            if (shape.type === 'polygon') totalArea += shape.value;
            else if (shape.type === 'line') totalLength += shape.value;
            else if (shape.type === 'count') totalCount += shape.value;

            const div = document.createElement('div');
            div.className = 'measurement-item';
            
            let badgeBg = 'rgba(59, 130, 246, 0.2)';
            if (shape.type === 'line') badgeBg = 'rgba(245, 158, 11, 0.2)';
            if (shape.type === 'count') badgeBg = 'rgba(16, 185, 129, 0.2)';

            div.innerHTML = `
                <div class="measurement-color" style="background-color: ${shape.strokeColor}"></div>
                <div class="measurement-info" style="display: flex; flex-direction: column; width: 100%;">
                    <input type="text" class="measurement-label" style="background:none; border:none; outline:none; color:#f3f4f6; font-size: 0.8rem; font-weight:600; width: 100%;" value="${shape.name}" onchange="takeoffComponent.renameShape('${shape.id}', this.value)">
                    <div class="measurement-val-edit" style="display: flex; align-items: center; gap: 4px; margin-top: 4px;">
                        <input type="number" class="measurement-val-input" style="background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 6px; width: 80px; color: #10b981; font-size: 0.8rem; font-weight: 700; outline: none;" value="${shape.value}" step="any" onchange="takeoffComponent.updateShapeValue('${shape.id}', this.value)">
                        <span class="measurement-unit" style="color: var(--text-secondary); font-size: 0.75rem;">${shape.unit}</span>
                        ${shape.isManual ? '<span style="color: var(--color-amber); font-size: 0.65rem; font-weight: 600; margin-left: auto; text-transform: uppercase;">Manual</span>' : ''}
                    </div>
                </div>
                <button class="btn-delete-measure" onclick="takeoffComponent.deleteMeasurement('${shape.id}')">&times;</button>
            `;
            list.appendChild(div);
        });

        document.getElementById('summary-area').innerText = `${totalArea.toFixed(2)} m²`;
        document.getElementById('summary-length').innerText = `${totalLength.toFixed(2)} m`;
        document.getElementById('summary-count').innerText = `${totalCount} items`;
    }

    renameShape(id, newName) {
        const shape = this.shapes.find(s => s.id === id);
        if (shape) shape.name = newName;
    }

    updateShapeValue(id, newValue) {
        const shape = this.shapes.find(s => s.id === id);
        if (shape) {
            shape.value = parseFloat(newValue) || 0;
            shape.isManual = true;
            this.renderCanvas();
            this.renderMeasurementsList();
        }
    }

    syncToPricing() {
        let totalArea = 0;
        let totalLength = 0;
        let totalCount = 0;
        
        this.shapes.forEach(shape => {
            if (shape.type === 'polygon') totalArea += shape.value;
            else if (shape.type === 'line') totalLength += shape.value;
            else if (shape.type === 'count') totalCount += shape.value;
        });

        // Push values to pricing and advisor components
        if (app.pricing) {
            app.pricing.syncFromTakeoff({
                area: totalArea,
                length: totalLength,
                count: totalCount
            });
            alert("Quantity measurements successfully synced! Calculated items have been mapped to cost items in the Pricing Sheet.");
            app.switchPanel('pricing');
        } else {
            alert("Sync failed: pricing component not ready.");
        }
    }

    handleManualUnitChange() {
        const typeSelect = document.getElementById('manual-unit');
        const container = document.getElementById('manual-calculator-container');
        const calcType = document.getElementById('manual-calc-type');
        const heightGroup = document.getElementById('manual-calc-height-group');
        if (!typeSelect || !container || !calcType) return;

        const val = typeSelect.value;
        if (val === 'polygon') {
            container.style.display = 'block';
            if (heightGroup) heightGroup.style.display = 'block';
            
            const prevVal = calcType.value;
            calcType.innerHTML = `
                <option value="walls">Wall Area: 2 * (W + L) * H</option>
                <option value="floor">Floor / Ceiling Area: W * L</option>
                <option value="total">Walls + Ceiling: 2 * (W + L) * H + (W * L)</option>
            `;
            if (['walls', 'floor', 'total'].includes(prevVal)) {
                calcType.value = prevVal;
            } else {
                calcType.value = 'walls';
            }
            this.runManualCalculation();
        } else if (val === 'line') {
            container.style.display = 'block';
            if (heightGroup) heightGroup.style.display = 'none';
            
            const prevVal = calcType.value;
            calcType.innerHTML = `
                <option value="perimeter">Perimeter: 2 * (W + L)</option>
                <option value="half">Width + Length: W + L</option>
            `;
            if (['perimeter', 'half'].includes(prevVal)) {
                calcType.value = prevVal;
            } else {
                calcType.value = 'perimeter';
            }
            this.runManualCalculation();
        } else {
            container.style.display = 'none';
        }
    }

    runManualCalculation() {
        const widthVal = document.getElementById('manual-calc-width');
        const lengthVal = document.getElementById('manual-calc-length');
        const heightVal = document.getElementById('manual-calc-height');
        const typeSelect = document.getElementById('manual-calc-type');
        const formulaEl = document.getElementById('manual-calc-formula');
        const qtyInput = document.getElementById('manual-value');

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
const takeoffComponent = new TakeoffComponent();
window.takeoffComponent = takeoffComponent;
