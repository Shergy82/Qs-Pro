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

        // Mobile-friendly PDF download trigger
        this.safelyAddListener('btn-print-proposal', 'click', () => {
            this.downloadProposalPdf();
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

    escapePdfText(value) {
        return String(value ?? '')
            .replace(/£/g, 'GBP ')
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/[–—]/g, '-')
            .replace(/\\/g, '\\\\')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/[^\x20-\x7E]/g, ' ')
            .trim();
    }

    wrapPdfText(value, maxChars = 86) {
        const words = this.escapePdfText(value).split(/\s+/).filter(Boolean);
        const lines = [];
        let line = '';

        words.forEach(word => {
            const next = line ? `${line} ${word}` : word;
            if (next.length > maxChars && line) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        });

        if (line) lines.push(line);
        return lines.length ? lines : [''];
    }

    getProposalPdfLines() {
        this.render();

        const ref = document.getElementById('preview-doc-ref')?.innerText || 'Proposal';
        const date = document.getElementById('preview-doc-date')?.innerText || new Date().toLocaleDateString('en-GB');
        const intro = document.getElementById('preview-doc-intro')?.innerText || '';
        const contact = document.getElementById('preview-doc-contact')?.innerText || 'Estimator';
        const totals = this.calculateProposalTotals();

        const lines = [];
        lines.push('QUOTE PROPOSAL');
        lines.push(`Reference: ${ref}`);
        lines.push(`Date: ${date}`);
        lines.push('');
        lines.push('1. EXECUTIVE SUMMARY');
        lines.push(...this.wrapPdfText(intro, 92));
        lines.push('');
        lines.push('2. COST SUMMARY');
        lines.push('Description                                                     Unit   Qty     Rate        Total');
        lines.push('----------------------------------------------------------------------------------------------');

        if (totals.items.length === 0) {
            lines.push('No cost items configured with quantities.');
        } else {
            totals.items.forEach(item => {
                const qty = this.safePdfNumber(item.qty);
                const rate = this.getCostItemBaseRate(item) * totals.multiplier;
                const rowTotal = qty * rate;
                const desc = item.sorDesc || item.desc || '';
                const descLines = this.wrapPdfText(desc, 58);
                const firstDesc = descLines.shift() || '';
                const row = `${firstDesc.padEnd(60).slice(0, 60)} ${(item.unit || 'Item').padEnd(5).slice(0, 5)} ${String(qty).padStart(5)} ${('GBP ' + rate.toFixed(2)).padStart(11)} ${('GBP ' + rowTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).padStart(14)}`;
                lines.push(row);
                descLines.forEach(extra => lines.push(`  ${extra}`));
            });
        }

        lines.push('');
        lines.push(`Cost to Company: ${this.formatProposalMoney(totals.costTotal).replace(/£/g, 'GBP ')}`);
        lines.push(`Markup / Uplift: ${totals.markupPercent.toFixed(1)}%`);
        lines.push(`Profit: ${this.formatProposalMoney(totals.profit).replace(/£/g, 'GBP ')}`);
        lines.push(`Margin: ${totals.marginPercent.toFixed(1)}%`);
        lines.push(`Total Proposed Tender Value: ${this.formatProposalMoney(totals.sellTotal).replace(/£/g, 'GBP ')}`);
        lines.push('');
        lines.push('3. VALUE ENGINEERING OPPORTUNITIES');

        if (!Array.isArray(this.veOpportunities) || this.veOpportunities.length === 0) {
            lines.push('Value engineering opportunities will appear once project analysis has completed.');
        } else {
            this.veOpportunities.forEach((ve, index) => {
                lines.push(`${index + 1}. ${ve.title || 'Value Engineering Opportunity'} - Saving GBP ${this.getLiveVeSaving(ve).toLocaleString('en-GB')}`);
                lines.push(...this.wrapPdfText(ve.desc || '', 92));
            });
        }

        lines.push('');
        lines.push(`Approved for submission by ${contact}`);
        return lines;
    }

    escapePdfLiteral(value) {
        return String(value ?? '')
            .replace(/£/g, '__POUND_SIGN__')
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/[–—]/g, '-')
            .replace(/&/g, 'and')
            .replace(/\\/g, '\\\\')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/[^\x20-\x7E]|__POUND_SIGN__/g, (match) => match === '__POUND_SIGN__' ? '\\243' : ' ')
            .trim();
    }

    wrapPdfTextForWidth(value, maxWidth, fontSize = 9) {
        const clean = String(value ?? '')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!clean) return [''];

        const avgCharWidth = fontSize * 0.52;
        const maxChars = Math.max(18, Math.floor(maxWidth / avgCharWidth));
        return this.wrapPdfText(clean, maxChars);
    }


    getPdfTextWidth(value, fontSize = 9) {
        return this.escapePdfLiteral(value).replace(/\\243/g, '£').length * fontSize * 0.52;
    }

    safePdfNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
    }

    formatProposalMoney(value) {
        return '£' + this.safePdfNumber(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    getProposalMarkupPercent() {
        const sliderMarkup = document.getElementById('slider-proposal-markup');
        const inputMarkup = document.getElementById('input-proposal-markup');
        const value = sliderMarkup ? sliderMarkup.value : (inputMarkup ? inputMarkup.value : 0);
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }

    shouldApplyProposalMarkup() {
        const chkApplyMarkup = document.getElementById('chk-apply-markup-to-rates');
        return chkApplyMarkup ? chkApplyMarkup.checked : true;
    }

    getCostItemBaseRate(item) {
        const componentTotal = this.safePdfNumber(item.materialRate) +
            this.safePdfNumber(item.labourRate) +
            this.safePdfNumber(item.plantRate) +
            this.safePdfNumber(item.subRate);

        if (componentTotal > 0) return componentTotal;
        if (Number.isFinite(Number(item.company))) return this.safePdfNumber(item.company);
        return this.safePdfNumber(item.current);
    }

    getOrderedCostItems() {
        if (!window.app || !app.pricing || !Array.isArray(app.pricing.rates)) return [];

        return app.pricing.rates
            .map((item, index) => ({ ...item, __originalIndex: index }))
            .filter(item => this.safePdfNumber(item.qty) > 0)
            .sort((a, b) => {
                const aSor = Number(a.sorOrderIndex ?? a.sourceOrder ?? a.sortOrder ?? a.orderIndex ?? a.lineNumber);
                const bSor = Number(b.sorOrderIndex ?? b.sourceOrder ?? b.sortOrder ?? b.orderIndex ?? b.lineNumber);
                const aHasSor = Number.isFinite(aSor);
                const bHasSor = Number.isFinite(bSor);

                if (aHasSor && bHasSor && aSor !== bSor) return aSor - bSor;
                if (aHasSor && !bHasSor) return -1;
                if (!aHasSor && bHasSor) return 1;
                return a.__originalIndex - b.__originalIndex;
            });
    }

    calculateProposalTotals() {
        const items = this.getOrderedCostItems();
        const markupPercent = this.shouldApplyProposalMarkup() ? this.getProposalMarkupPercent() : 0;
        const multiplier = 1 + (markupPercent / 100);
        let costTotal = 0;
        let sellTotal = 0;

        items.forEach(item => {
            const qty = this.safePdfNumber(item.qty);
            const costRate = this.getCostItemBaseRate(item);
            const sellRate = costRate * multiplier;
            costTotal += qty * costRate;
            sellTotal += qty * sellRate;
        });

        const profit = sellTotal - costTotal;
        const marginPercent = sellTotal > 0 ? (profit / sellTotal) * 100 : 0;

        return {
            items,
            markupPercent,
            multiplier,
            costTotal,
            sellTotal,
            profit,
            marginPercent
        };
    }

    async loadProposalLogoForPdf() {
        const logoImg = document.querySelector('.doc-brand-logo-img');
        const src = logoImg?.currentSrc || logoImg?.src || logoImg?.getAttribute('src');

        if (!src) return null;

        return new Promise((resolve) => {
            const image = new Image();
            image.crossOrigin = 'anonymous';

            image.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const maxWidth = 520;
                    const ratio = image.naturalWidth > maxWidth ? maxWidth / image.naturalWidth : 1;
                    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
                    const height = Math.max(1, Math.round(image.naturalHeight * ratio));

                    canvas.width = width;
                    canvas.height = height;

                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(image, 0, 0, width, height);

                    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
                    const base64 = dataUrl.split(',')[1];
                    const binary = atob(base64);
                    let hex = '';

                    for (let i = 0; i < binary.length; i += 1) {
                        hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
                    }

                    resolve({ width, height, hex });
                } catch (err) {
                    console.warn('Unable to prepare logo for PDF export:', err);
                    resolve(null);
                }
            };

            image.onerror = () => resolve(null);
            image.src = src;
        });
    }

    async buildProposalDocumentPdfBlob() {
        this.render();
        const logoData = await this.loadProposalLogoForPdf();

        const encoder = new TextEncoder();
        const pageWidth = 595;
        const pageHeight = 842;
        const margin = 42;
        const bottomMargin = 58;
        const rightMargin = pageWidth - margin;
        const pages = [];
        let commands = [];
        let y = pageHeight - 48;

        const money = (value) => `£${(Number(value) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const safeNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

        const add = (cmd) => commands.push(cmd);
        const text = (value, x, textY, size = 9, font = 'F1') => {
            add(`BT /${font} ${size} Tf ${x.toFixed(2)} ${textY.toFixed(2)} Td (${this.escapePdfLiteral(value)}) Tj ET`);
        };
        const textRight = (value, rightX, textY, size = 9, font = 'F1') => {
            const x = rightX - this.getPdfTextWidth(value, size);
            text(value, x, textY, size, font);
        };
        const line = (x1, y1, x2, y2) => add(`0.75 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
        const rectFill = (x, rectY, width, height, gray = 0.94) => add(`q ${gray} g ${x.toFixed(2)} ${rectY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f Q`);
        const drawLogo = (x, drawY, width, height) => {
            if (logoData) add(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${drawY.toFixed(2)} cm /Logo Do Q`);
        };

        const finishPage = () => {
            if (commands.length) pages.push(commands.join('\n'));
            commands = [];
            y = pageHeight - 48;
        };

        const ensureSpace = (heightNeeded) => {
            if (y - heightNeeded < bottomMargin) {
                finishPage();
            }
        };

        const paragraph = (value, x, width, size = 9, leading = 12, font = 'F1') => {
            const lines = this.wrapPdfTextForWidth(value, width, size);
            ensureSpace((lines.length * leading) + 8);
            lines.forEach((lineText) => {
                text(lineText, x, y, size, font);
                y -= leading;
            });
            return lines.length;
        };

        const ref = document.getElementById('preview-doc-ref')?.innerText || 'Quote Proposal';
        const date = document.getElementById('preview-doc-date')?.innerText || new Date().toLocaleDateString('en-GB');
        const intro = document.getElementById('preview-doc-intro')?.innerText || '';
        const contact = document.getElementById('preview-doc-contact')?.innerText || 'Estimator';
        const companyName = document.getElementById('proposal-company-name')?.value
            || document.getElementById('preview-brand-name')?.innerText
            || 'GVD Contracts';

        if (logoData) {
            const logoWidth = 128;
            const logoHeight = Math.min(58, logoWidth * (logoData.height / logoData.width));
            drawLogo(margin, y - logoHeight + 4, logoWidth, logoHeight);
        } else {
            text(companyName, margin, y - 8, 14, 'F2');
            text('QUOTE PROPOSAL', margin, y - 26, 9, 'F1');
        }

        textRight('QUOTE PROPOSAL', rightMargin, y - 2, 15, 'F2');
        textRight(`Reference: ${ref}`, rightMargin, y - 22, 9.5, 'F1');
        textRight(`Date: ${date}`, rightMargin, y - 36, 9.5, 'F1');
        y -= 76;
        line(margin, y, rightMargin, y);
        y -= 24;

        text('1. EXECUTIVE SUMMARY', margin, y, 12, 'F2');
        y -= 18;
        paragraph(intro, margin, rightMargin - margin, 9.5, 13, 'F1');
        y -= 14;

        ensureSpace(60);
        text('2. COST SUMMARY', margin, y, 12, 'F2');
        y -= 22;

        const totals = this.calculateProposalTotals();
        const items = totals.items;
        const descX = margin;
        const unitX = 346;
        const qtyX = 386;
        const rateRightX = 482;
        const totalRightX = rightMargin - 2;
        const descWidth = 286;
        const rowGap = 6;
        let runningTotal = 0;

        const drawTableHeader = () => {
            ensureSpace(38);
            rectFill(margin, y - 18, rightMargin - margin, 26, 0.93);
            text('Description', descX, y - 8, 8.5, 'F2');
            text('Unit', unitX, y - 8, 8.5, 'F2');
            text('Qty', qtyX, y - 8, 8.5, 'F2');
            textRight('Rate', rateRightX, y - 8, 8.5, 'F2');
            textRight('Total', totalRightX, y - 8, 8.5, 'F2');
            y -= 30;
            line(margin, y + 7, rightMargin, y + 7);
        };

        if (items.length === 0) {
            paragraph('No cost items configured with quantities.', margin, rightMargin - margin, 10, 13, 'F1');
        } else {
            drawTableHeader();

            items.forEach((item) => {
                const qty = safeNumber(item.qty);
                const rate = this.getCostItemBaseRate(item) * totals.multiplier;
                const rowTotal = qty * rate;
                runningTotal += rowTotal;

                const descLines = this.wrapPdfTextForWidth(item.sorDesc || item.desc || '', descWidth, 8.6);
                const lineCount = Math.max(descLines.length, 1);
                const rowHeight = Math.max(24, (lineCount * 11) + 10);

                if (y - rowHeight < bottomMargin) {
                    finishPage();
                    drawTableHeader();
                }

                let rowY = y;
                descLines.forEach((descLine, index) => {
                    text(descLine, descX, rowY, 8.6, index === 0 ? 'F2' : 'F1');
                    rowY -= 11;
                });

                text(item.unit || 'Item', unitX, y, 8.6, 'F1');
                text(String(qty), qtyX, y, 8.6, 'F1');
                textRight(money(rate), rateRightX, y, 8.6, 'F1');
                textRight(money(rowTotal), totalRightX, y, 8.6, 'F1');

                y -= rowHeight;
                line(margin, y + 4, rightMargin, y + 4);
                y -= rowGap;
            });
        }

        ensureSpace(118);
        y -= 4;
        const summaryLeft = 286;
        const summaryLabelRight = 450;
        const summaryValueRight = rightMargin - 4;
        line(summaryLeft, y, rightMargin, y);
        y -= 16;
        textRight('Cost to Company', summaryLabelRight, y, 9.5, 'F2');
        textRight(money(totals.costTotal), summaryValueRight, y, 9.5, 'F2');
        y -= 15;
        textRight('Markup / Uplift', summaryLabelRight, y, 9.2, 'F1');
        textRight(`${totals.markupPercent.toFixed(1)}%`, summaryValueRight, y, 9.2, 'F1');
        y -= 15;
        textRight('Profit', summaryLabelRight, y, 9.2, 'F1');
        textRight(money(totals.profit), summaryValueRight, y, 9.2, 'F1');
        y -= 15;
        textRight('Margin', summaryLabelRight, y, 9.2, 'F1');
        textRight(`${totals.marginPercent.toFixed(1)}%`, summaryValueRight, y, 9.2, 'F1');
        y -= 18;
        line(summaryLeft, y + 8, rightMargin, y + 8);
        textRight('Total Proposed Tender Value', summaryLabelRight, y, 10.5, 'F2');
        textRight(money(totals.sellTotal), summaryValueRight, y, 10.5, 'F2');
        y -= 32;

        ensureSpace(46);
        text('3. VALUE ENGINEERING OPPORTUNITIES', margin, y, 12, 'F2');
        y -= 18;

        if (!Array.isArray(this.veOpportunities) || this.veOpportunities.length === 0) {
            paragraph('Value engineering opportunities will appear once project analysis has completed.', margin, rightMargin - margin, 9, 12, 'F1');
        } else {
            this.veOpportunities.forEach((ve, index) => {
                const saving = money(this.getLiveVeSaving(ve));
                ensureSpace(42);
                text(`${index + 1}. ${ve.title || 'Value Engineering Opportunity'} - Saving ${saving}`, margin, y, 9.5, 'F2');
                y -= 13;
                paragraph(ve.desc || '', margin + 12, rightMargin - margin - 12, 8.8, 12, 'F1');
                y -= 6;
            });
        }

        ensureSpace(30);
        y -= 8;
        text(`Approved for submission by ${contact}`, margin, y, 9.5, 'F1');
        finishPage();

        const numberedPages = pages.map((pageCommands, index) => {
            const footer = [
                `0.75 w ${margin.toFixed(2)} 35.00 m ${rightMargin.toFixed(2)} 35.00 l S`,
                `BT /F1 8 Tf ${margin.toFixed(2)} 22.00 Td (Page ${index + 1} of ${pages.length}) Tj ET`
            ].join('\n');
            return `${pageCommands}\n${footer}`;
        });

        const objects = [];
        const hasLogo = Boolean(logoData);
        const firstPageObjectId = hasLogo ? 6 : 5;
        const pageIds = numberedPages.map((_, index) => firstPageObjectId + index * 2);
        const contentIds = numberedPages.map((_, index) => firstPageObjectId + 1 + index * 2);

        objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${numberedPages.length} >>`;
        objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

        if (hasLogo) {
            const imageStream = `${logoData.hex}>`;
            objects[5] = `<< /Type /XObject /Subtype /Image /Width ${logoData.width} /Height ${logoData.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`;
        }

        numberedPages.forEach((stream, index) => {
            const pageId = pageIds[index];
            const contentId = contentIds[index];
            const xObjectResources = hasLogo ? ' /XObject << /Logo 5 0 R >>' : '';
            objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xObjectResources} >> /Contents ${contentId} 0 R >>`;
            objects[contentId] = `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`;
        });

        let pdf = '%PDF-1.4\n';
        const offsets = [0];

        for (let i = 1; i < objects.length; i += 1) {
            offsets[i] = encoder.encode(pdf).length;
            pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
        }

        const xrefOffset = encoder.encode(pdf).length;
        pdf += `xref\n0 ${objects.length}\n`;
        pdf += '0000000000 65535 f \n';

        for (let i = 1; i < objects.length; i += 1) {
            pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
        }

        pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

        return new Blob([encoder.encode(pdf)], { type: 'application/pdf' });
    }

    async downloadProposalPdf() {
        try {
            const blob = await this.buildProposalDocumentPdfBlob();
            const ref = (document.getElementById('preview-doc-ref')?.innerText || 'quote-proposal')
                .replace(/[^a-z0-9-]+/gi, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '') || 'quote-proposal';

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${ref}.pdf`;
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            link.remove();

            setTimeout(() => URL.revokeObjectURL(url), 3000);
        } catch (err) {
            console.error('PDF download failed, opening print dialog instead:', err);
            window.print();
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

        const items = this.getOrderedCostItems();
        tbody.innerHTML = '';

        if (items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-3">No cost items configured with quantities.</td></tr>`;
            return;
        }

        const totals = this.calculateProposalTotals();

        items.forEach(item => {
            const qty = this.safePdfNumber(item.qty);
            const costRate = this.getCostItemBaseRate(item);
            const rateDisplayed = costRate * totals.multiplier;
            const rowTotalDisplayed = qty * rateDisplayed;
            const description = item.sorDesc || item.desc || '';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <div class="font-bold" style="color: #0f172a;">${description}</div>
                </td>
                <td>${item.unit || 'Item'}</td>
                <td>${qty}</td>
                <td class="text-right">£${rateDisplayed.toFixed(2)}</td>
                <td class="text-right font-semibold">£${rowTotalDisplayed.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            `;

            tbody.appendChild(tr);
        });

        const table = document.querySelector('#preview-breakdown-section table');
        const subtotalLabelTd = document.getElementById('preview-doc-subtotal')?.previousElementSibling;

        if (table) {
            const headers = table.querySelectorAll('thead th');
            if (headers.length >= 5) {
                headers[3].innerText = totals.markupPercent > 0 ? 'Unit Sell Rate (£)' : 'Unit Cost (£)';
                headers[4].innerText = totals.markupPercent > 0 ? 'Sell Total (£)' : 'Cost Total (£)';
            }
        }

        if (subtotalLabelTd) {
            subtotalLabelTd.innerText = 'Cost to Company (0% Markup):';
        }

        this.setText('preview-doc-subtotal', this.formatProposalMoney(totals.costTotal));
        this.setText('preview-doc-markup', `${totals.markupPercent.toFixed(1)}%`);
        this.setText('preview-doc-profit', this.formatProposalMoney(totals.profit));
        this.setText('preview-doc-margin', `${totals.marginPercent.toFixed(1)}%`);
        this.setText('preview-doc-total', this.formatProposalMoney(totals.sellTotal));
    }

    getProposalMarkupMultiplier() {
        const markupPercent = this.shouldApplyProposalMarkup() ? this.getProposalMarkupPercent() : 0;
        return 1 + (markupPercent / 100);
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