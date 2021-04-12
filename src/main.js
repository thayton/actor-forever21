const Apify = require('apify');

const { log } = Apify.utils;

const {
    enqueueSubcategories,
    extractSubcatPage,
    enqueueNextPages,
    extractProductPage,
    extractProductVariants,
} = require('./extractors');

const {
    validateInput,
    getProxyUrls,
    checkAndCreateUrlSource,
    maxItemsCheck,
    checkAndEval,
    applyFunction,
} = require('./utils');

const { BASE_URL } = require('./constants');


Apify.main(async () => {
    const input = await Apify.getInput();
    validateInput(input);

    const {
        startUrls,
        maxItems = null,
        extendOutputFunction = null,
        proxyConfiguration,
    } = input;

    // create proxy url(s) to be used in crawler configuration
    const proxyUrls = getProxyUrls(proxyConfiguration);

    // initialize request list from url sources
    const sources = checkAndCreateUrlSource(startUrls);
    const requestList = await Apify.openRequestList('start-list', sources);

    // open request queue
    const requestQueue = await Apify.openRequestQueue();

    // open dataset and get itemCount
    const dataset = await Apify.openDataset();
    let { itemCount } = await dataset.getInfo();

    // if exists, evaluate extendOutputFunction
    let evaledFunc;
    if (extendOutputFunction) evaledFunc = checkAndEval(extendOutputFunction);

    // crawler config
    const crawler = new Apify.CheerioCrawler({
        requestList,
        requestQueue,
        maxRequestRetries: 3,
        handlePageTimeoutSecs: 240,
        requestTimeoutSecs: 120,
        proxyUrls,
        additionalMimeTypes: [ 'application/json' ], // So we can process JSON responses

        handlePageFunction: async ({ request, body, $, json }) => {
            // if exists, check items limit. If limit is reached crawler will exit.
            if (maxItems) maxItemsCheck(maxItems, itemCount);

            log.info('Processing:', request.url);
            const { label } = request.userData;

            if (label === 'HOMEPAGE') {
                const totalEnqueued = await enqueueSubcategories($, requestQueue);

                log.info(`Enqueued ${totalEnqueued} subcategories from the homepage.`);
            }

            if (label === 'MAINCAT') {
                const cat = request.url.replace(BASE_URL, '');
                const totalEnqueued = await enqueueSubcategories($, requestQueue, cat);

                log.info(`Enqueued ${totalEnqueued} subcategories from ${request.url}`);
            }

            if (label === 'SUBCAT') {
                const { urls, totalPages } = await extractSubcatPage($);

                const url = new URL(request.url);
                const isPageOne = url.searchParams.query === undefined || url.searchParams.get('start') === 0

                //if (isPageOne && totalPages > 1) {
                //    await enqueueNextPages($, requestQueue, totalPages);
                //}
 
                for (const url of urls) {
                    if (url) {
                        await requestQueue.addRequest({
                            url,
                            userData: { label: 'PRODUCT' },
                        });
                        break; // XXX
                    }
                }

                log.info(`Enqueued ${urls.length} products from ${request.url}`);
            }

            if (label === 'PRODUCT') {
                let product = await extractProductPage($, request);
                let product_id = request.url.match(/(\d+)\.html/)[1];

                // Send out XHR request to get the images for variants
                const variant_url = new URL('https://www.forever21.com/on/demandware.store/Sites-forever21-Site/en_US/Product-Variation');
                variant_url.search = new URLSearchParams({ pid: product_id });

                await requestQueue.addRequest({
                    method: 'GET',
                    url: variant_url.href,
                    headers: {
                        'x-requested-with': 'XMLHttpRequest',
                        Accept: 'application/json' 
                    },
                    userData: { 
                        label: 'PRODUCT-VARIANTS',
                        product: product
                    }
                });

                log.info(`Enqueued product variant from ${request.url}`);
            }

            if (label === 'PRODUCT-VARIANTS') {                
                let items = await extractProductVariants(json, request);

                if (extendOutputFunction) items = await applyFunction($, evaledFunc, items);

                await dataset.pushData(items);
                items.forEach((item) => {
                    // increase itemCount for each pushed item
                    itemCount++;

                    log.info('Product pushed:', item.itemId, item.color);
                });
            }
        },

        handleFailedRequestFunction: async ({ request }) => {
            log.warning(`Request ${request.url} failed too many times`);

            await dataset.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    log.info('Starting crawler.');
    await crawler.run();

    log.info('Crawler Finished.');
});
