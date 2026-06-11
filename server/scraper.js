const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function scrapePrice(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const page = await browser.newPage();
    
    // Set a realistic user agent to avoid basic bot blocking
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set extra headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8'
    });

    console.log(`Navigating to ${url}...`);
    // Wait until network is mostly idle to ensure dynamic pricing loads
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Method 1: Check for JSON-LD structured data (Most reliable for e-commerce)
    console.log('Checking for JSON-LD schema...');
    const jsonLdPrice = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.innerText);
          
          // Data can be an array or object
          const items = Array.isArray(data) ? data : [data];
          
          for (const item of items) {
            // Sometimes it's nested in @graph
            const entities = item['@graph'] || [item];
            
            for (const entity of entities) {
              if (entity['@type'] === 'Product' || entity['@type'] === 'ItemPage') {
                let offers = entity.offers;
                // Offers can be an array
                if (Array.isArray(offers) && offers.length > 0) {
                  offers = offers[0];
                }
                
                if (offers && offers.price) {
                  return typeof offers.price === 'string' ? parseFloat(offers.price.replace(/,/g, '')) : offers.price;
                }
              }
            }
          }
        } catch (e) {
          // Ignore parsing errors for individual scripts
        }
      }
      return null;
    });

    if (jsonLdPrice) {
      console.log(`Found price via JSON-LD: £${jsonLdPrice}`);
      return { success: true, price: jsonLdPrice, method: 'json-ld' };
    }

    // Method 2: Generic DOM search for specific retailers or common price patterns
    console.log('JSON-LD not found or didn\'t contain price. Falling back to DOM parsing...');
    const domPrice = await page.evaluate(() => {
      // Check specific classes often used by Jewson, Selco, Buildbase, Magento, Shopify, etc.
      const priceSelectors = [
        '[data-testid="product-price"]',
        '.price',
        '.product-price',
        '.current-price',
        'span[itemprop="price"]',
        'meta[itemprop="price"]',
        '.price-wrapper .price', // Magento
        '.price-box .price', // Magento
        '.price--large', // common
        '.product__price', // Shopify
        '#product-price',
        '.product-info-price .price', // Magento 2
        '.price-including-tax .price', // Trade prices incl VAT
        '.price-excluding-tax .price', // Trade prices excl VAT
        '.saleprice',
        '[data-price-amount]'
      ];

      for (const selector of priceSelectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        for (const el of elements) {
          const text = el.tagName.toLowerCase() === 'meta' ? el.getAttribute('content') : (el.innerText || el.textContent);
          if (text) {
             // Look for £ symbol followed by numbers and optional decimals
             const match = text.match(/£?\s*(\d+[\.,]?\d*)/);
             // Ensure it's a valid parsed float and not just a single digit version of something else if possible, but keep it simple.
             if (match && match[1]) {
               const parsed = parseFloat(match[1].replace(/,/g, ''));
               if (!isNaN(parsed) && parsed > 0) {
                 return parsed;
               }
             }
          }
        }
      }

      // 3. Fallback: find any element with a £ sign that looks like a prominent price
      const elementsWithPound = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && el.textContent.includes('£'));
      
      if (elementsWithPound.length > 0) {
        // Sort by font size descending to find the "main" price on the page
        elementsWithPound.sort((a, b) => {
          const sizeA = parseFloat(window.getComputedStyle(a).fontSize) || 0;
          const sizeB = parseFloat(window.getComputedStyle(b).fontSize) || 0;
          return sizeB - sizeA;
        });

        const text = elementsWithPound[0].textContent;
        const match = text.match(/£\s*(\d+[\.,]?\d*)/);
        if (match && match[1]) {
          return parseFloat(match[1].replace(/,/g, ''));
        }
      }

      return null;
    });

    if (domPrice) {
      console.log(`Found price via DOM parsing: £${domPrice}`);
      return { success: true, price: domPrice, method: 'dom' };
    }

    throw new Error("Could not locate price on page.");

  } catch (error) {
    console.error('Scraping error:', error.message);
    return { success: false, error: error.message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { scrapePrice };
