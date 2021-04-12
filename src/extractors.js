const Apify = require('apify');

const { log } = Apify.utils;
const { URL } = require('url');
const cheerio = require('cheerio');
const fetch = require("node-fetch");
const { BASE_URL } = require('./constants');

async function enqueueSubcategories($, requestQueue, cat = null) {
    let menuCats = $('ul[role="menu"] > li[role="menuitem"]').toArray();
    let totalEnqueued = 0;

    // if this function is used to extract subcategories from single main cat,
    // keep only the single relevant div
    if (cat) {
        log.info(`Only keeping subcategories from category ${cat}.`);
        menuCats = menuCats.filter(menuLi => $(menuLi).children().first().attr('href') === cat);
    }

    for (const li of menuCats) {
        const hrefs = $(li).find('a').toArray().map(a => a.attribs.href);

        // filter out unsupported categories
        const supportedHrefs = hrefs.filter((href) => {
            if (/-main|_main/.test(href)) return false;
            if (!href.includes('catalog/category/')) return false;

            return true;
        });

        totalEnqueued += supportedHrefs.length;

        for (const href of supportedHrefs) {
            await requestQueue.addRequest({
                url: new URL(href, BASE_URL).href,
                userData: { label: 'SUBCAT' },
            });
            break; //XXX
        }
    }

    if (cat) {
        log.info(`Added all subcategories from main category ${cat}.`);
    } else {
        log.info('Added all subcategories from all main categories of the home page.');
    }

    return totalEnqueued;
}

async function extractSubcatPage($) {
    const totalRecordsText = $('span[data-search-component="product-search-count"]').text().trim();
    const totalRecords = Number( totalRecordsText.match(/(\d+)\s+Products/)[1] );
    
    const jsonLD = $('script[type="application/ld+json"]');
    const items = JSON.parse(jsonLD.html());

    const urls = items.itemListElement.map(e => e.url);
    const totalPages = Math.ceil(totalRecords / 60);

    return { urls, totalPages };
}

async function enqueueNextPages($, requestQueue, totalPages) {
    const nextPageUrl = $('button[aria-label="View Page 2"]').attr('data-url');

    // Eg. https://www.forever21.com/us/shop/catalog/category/21men/mens-tops?cgid=mens_tops&start=60&sz=60
    const urlParts = new URL(nextPageUrl);
    const nextPageStart = () => ( Number(urlParts.searchParams.get('start')) + 
                                  Number(urlParts.searchParams.get('sz')) ).toString();

    // add all successive pages for this subcat
    for (let i = 2; i <= totalPages; i++) {
        const info = await requestQueue.addRequest({
            url: urlParts.href,
            userData: { label: 'SUBCAT' },
        });

        log.info('Added', info.request.url);

        urlParts.searchParams.set('start', nextPageStart() );
    }
}

async function extractProductPage($, request) {
    const jsonLD = $('script[type="application/ld+json"]')
    const schema = JSON.parse(jsonLD.html());

    const scriptContent = $('script:contains("e_product_detail_loaded")').html();
    if (!scriptContent) throw new Error('Web page missing critical data source');
    const productDetailRe = /dataLayer\.push\((.+)\);/s;
    const productDetailText = scriptContent.match(productDetailRe)[1];
    const productDetail = eval(`(${productDetailText})`).product;
    const item = Object.create(null);

    item.source = 'forever21';
    item.itemId = productDetail.id;
    item.url = request.url;
    item.scrapedAt = new Date().toISOString();
    item.brand = productDetail.brand;
    item.title = productDetail.name;
    item.categories = schema.breadcrumb.map(bc => bc.name.toLowerCase()).filter(bc => bc !== item.title.toLowerCase());
    item.price = productDetail.originalPrice;
    item.salePrice = productDetail.price;
    item.currency = schema.offers.priceCurrency;

    if (productDetail.variants.length === 1) {
        item.color = productDetail.variants[0].colorName.toLowerCase();
        item.sizes = productDetail.variants[0].sizes.map(obj => obj.sizeName);
        item.availableSizes = productDetail.variants[0].sizes.filter(obj => obj.available === 'true').map(obj => obj.sizeName);
        item.images = schema.image.map(url => ({ url: url.split('?')[0] }) );
    } 

    return item;
}

async function extractProductVariants(json, request) {
    const { product } = request.userData;
    const variationAttributes = json.product.variationAttributes;
    const variants = json.product.variants;
    const colors = {};
    const sizes = {};

    for (const va of variationAttributes) {
        if (va.attributeId === 'color') {
            for (const v of va.values) {
                colors[v.id] = { 
                    name: v.displayValue,
                    images: v.images.swatch.map(obj => ({ url: obj.url.split('?')[0] }) )
                };
            }
        } else if (va.attributeId === 'size') {
            for (const v of va.values) {
                sizes[v.id] = v.displayValue;
            }
        }
    }

    const items = [];
    const parsedDesc = cheerio.load(json.product.longDescription);

    // create an item for each color
    for (const c of Object.keys(variants)) {
        const item = JSON.parse(JSON.stringify(product));

        item.description = parsedDesc.text().replace(/^Details/, '');;
        const descChip = item.description.substring(item.description.indexOf('Content + Care-')).replace('Content + Care- ', '');
        item.composition = descChip.substring(0, descChip.indexOf('-'));
        item.color = colors[c].name.toLowerCase();
        item.sizes = Object.keys(variants[c]).map(k => sizes[k]);
        item.availableSizes = Object.keys(variants[c]).filter(k => variants[c][k].available).map(k => sizes[k]);
        item.images = colors[c].images;

        items.push(item);
    }

    return items;
}

module.exports = {
    enqueueSubcategories,
    extractSubcatPage,
    enqueueNextPages,
    extractProductPage,
    extractProductVariants,
};
