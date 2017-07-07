/**
 * @file action.js
 * @author harttle<yangjun14@baidu.com>
 */

define(function (require) {
    /**
     * A Service Management Singleton
     * Accepts service registration and provides service switch,
     * which is triggered by the Router
     * @module action
     */

    var cache = require('utils/cache');
    var Promise = require('lang/promise');
    var assert = require('lang/assert');
    var Map = require('lang/map');
    var _ = require('lang/underscore');
    var URL = require('utils/url');

    function actionFactory(router, location, history, doc, logger, Emitter) {
        var exports = new Emitter();
        var services;
        var pages;
        var backManually;
        var indexPageUrl;
        var isIndexPage;
        var root;
        var pageId;

        // The state data JUST for the next dispatch
        var stageData = {};
        var dispatchQueue = mkDispatchQueue();

        /**
         * This is provided to reset closure variables which defines the inner state.
         *
         * @private
         */
        exports.init = function () {
            exports.services = services = new Map();
            exports.pages = pages = cache.create('pages', {
                onRemove: function (page, url, evicted) {
                    if (_.isFunction(page.onRemove)) {
                        page.onRemove(url, evicted);
                    }
                },
                limit: 32
            });
            backManually = false;
            root = '/';
            indexPageUrl = '/';
            isIndexPage = true;
            pageId = 0;
        };

        /**
         * Get the stage data being passed to next dispatch
         *
         * @private
         * @return {Object} current state
         */
        exports.getState = function () {
            return stageData;
        };

        /**
         *  Register a service instance to action
         *
         *  @static
         *  @param {string|RestFul|RegExp} url The path of the service
         *  @param {Object} service The service object to be registered
         *  @example
         *  action.regist('/person', new Service());
         *  action.regist('/person/:id', new Service());
         *  action.regist(/^person\/\d+/, new Service());
         * */
        exports.regist = function (url, service) {
            assert(url, 'invalid url pattern');
            assert(isService(service), 'invalid service, make sure to extend sfr/service');
            assert(!services.has(url), 'url already registerd');
            router.add(url, this.dispatch);
            services.set(url, service);
            logger.log('service registered to: ' + url);
            exports.emit('registered', url, service);
        };

        /**
         * Un-register a service by path
         *
         * @param {string|RestFul|RegExp} url The path of the service
         */
        exports.unregist = function (url) {
            assert(url, 'invalid url pattern');
            assert(services.has(url), 'url not registered');
            router.remove(url);
            var svc = services.get(url);
            services.delete(url);
            logger.log('service unregistered from: ' + url);
            exports.emit('unregistered', url, svc);
        };

        /**
         *  Check if value is a valid service instance
         *
         *  @param {any} value The value to check.
         *  @return {boolean} Returns true if value is a service, else false.
         * */
        function isService(value) {
            // duck test...
            return _.isObject(value)
                && value.create
                && value.attach
                && value.detach
                && value.destroy
                && value.update;
        }

        /**
         *  Switch from the previous service to the current one.
         *  Call `prev.detach`, `prev.destroy`,
         *  `current.create`, `current.attach` in serial.
         *  Typically called by the Router,
         *  you may not want to call dispatch manually.
         *
         *  If any of these callbacks returns a `Thenable`, it'll be await.
         *  If the promise is rejected, the latter callbacks will **NOT** be called.
         *
         *  Returns a promise that
         *  resolves if all callbacks executed without throw (or reject),
         *  rejects if any of the callbacks throwed or rejected.
         *
         *  Note: If current and prev is the same service,
         *  the `prev.destroy` will **NOT** be called.
         *
         *  @static
         *  @param {Object} current The current scope
         *  @param {Object} prev The previous scope
         *  @return {Promise}
         * */
        exports.dispatch = function (current, prev) {
            assert(current, 'cannot dispatch with options:' + current);

            logger.log('action dispatching to: ' + current.url);

            var currentService = services.get(current.pathPattern);
            current.service = currentService;

            if (!pages.contains(current.url)) {
                pages.set(current.url, {
                    id: pageId,
                    isIndex: isIndexPage
                });
            }
            current.page = pages.get(current.url);

            var prevService = services.get(prev.pathPattern);
            prev.service = prevService;

            var data = stageData;
            stageData = {};

            if (backManually) {
                backManually = false;
                current.options.src = 'back';
            }

            // mark initial page
            if (current.options && current.options.src === 'sync') {
                indexPageUrl = current.url || '/';
            }
            else {
                isIndexPage = false;
            }

            doc.ensureAttached();
            // Abort currently the running dispatch queue,
            // and initiate a new one.
            return dispatchQueue.reset([
                function prevDetach() {
                    if (!prevService) {
                        return;
                    }
                    return prevService.detach(current, prev, data);
                },
                function currCreate() {
                    if (!currentService) {
                        return;
                    }
                    return currentService.create(current, prev, data);
                },
                function prevDestroy() {
                    if (!prevService) {
                        return;
                    }
                    return prevService.destroy(current, prev, data);
                },
                function currAttach() {
                    if (!currentService) {
                        return;
                    }
                    return currentService.attach(current, prev, data);
                }
            ]).exec();
        };

        /**
         * Check if currently in initial page
         *
         * @return {boolean} whether current page is the index page
         */
        exports.isIndexPage = function () {
            return isIndexPage;
        };

        /**
         * Execute a queue of functions in serial, and previous execution will be stopped.
         * This is a singleton closure containing current execution queue and threadID.
         *
         * A thread (implemented by mapSeries) will be initiated for each execution.
         * And anytime there's a new thread initiating, the previous threads will stop running.
         *
         * @return {Object} DispatchQueue interfaces: {reset, exec}
         * @private
         */
        function mkDispatchQueue() {
            // Since we cannot quit a promise, there can be multiple threads running, actually.
            var MAX_THREAD_COUNT = 10000;
            // This is the ID of the currently running thread
            var threadID = 0;
            var queue = [];
            var exports = {
                reset: reset,
                exec: exec
            };

            /**
             * When reset called, a thread containing a queue of functions is initialized,
             * and latter functions in last thread will be ommited.
             *
             * @param {Array} q the tasks to be queued
             * @return {Object} The DispatchQueue object
             */
            function reset(q) {
                queue = q;
                threadID = (threadID + 1) % MAX_THREAD_COUNT;
                return exports;
            }

            /**
             * When exec called, current queue is executed in serial,
             * and a promise for the results of the functions is returned.
             *
             * @return {Promise} The promise to be resolved when all tasks completed
             */
            function exec() {
                // Record the thread ID for current thread
                // To ensure there's ONLY ONE thread running.
                var thisThreadID = threadID;
                return Promise.mapSeries(queue, function (cb) {
                    if (typeof cb !== 'function') {
                        return;
                    }
                    // Just stop running
                    if (thisThreadID !== threadID) {
                        return;
                    }
                    logger.log('calling lifecycle', cb.name);
                    return cb();
                }).catch(function (e) {
                    // throw asyncly rather than console.error(e.stack)
                    // to enable browser console's error tracing.
                    setTimeout(function () {
                        throw e;
                    });
                });
            }

            return exports;
        }

        /**
         *  Remove a registered service
         *
         *  @static
         *  @param {string} name The path of the service
         *  @return {any} the return value of Map#delete
         * */
        exports.remove = function (name) {
            return services.delete(name);
        };

        /**
         *  Check if the specified service has been registered
         *
         *  @static
         *  @param {string} name The path of the service
         *  @return {boolean} Returns true if it has been registered, else false.
         * */
        exports.exist = function (name) {
            return services.has(name);
        };

        /**
         *  config the action, called by action.start
         *
         *  @param {Object} options key/value pairs to config the action
         *  @static
         * */
        exports.config = function (options) {
            if (options && options.root) {
                root = options.root;
            }
            router.config(options);
        };

        /**
         * Redirect to another page, and change to next state
         *
         * @static
         * @param {string} url The URL to redirect
         * @param {string} query The query string to redirect
         * @param {Object} options The router options to redirect
         * @param {string} options.title Optional, 页面的title
         * @param {boolean} options.force Optional, 是否强制跳转
         * @param {boolean} options.silent Optional, 是否静默跳转（不改变URL）
         * @param {Object} data extended data being passed to `current.options`
         * */
        exports.redirect = function (url, query, options, data) {
            logger.log('action redirecting to: ' + url);
            url = resolveUrl(url);
            _.assign(stageData, data);
            options = _.assign({}, options, {
                id: pageId++
            });
            try {
                router.redirect(url, query, options);
            }
            catch (e) {
                url = URL.resolve(root, url);
                location.replace(url);
                exports.emit('redirect failed', url);
                throw e;
            }
            exports.emit('redirected', url);
        };

        function resolveUrl(url) {
            var urlObj = URL.parse(url);

            // Superframe protocol, eg. sfr://root
            if (urlObj.scheme === 'sfr') {
                if (urlObj.host === 'index') {
                    return indexPageUrl;
                }
            }

            // fallback to url
            return url;
        }

        /**
         *  Back to last state
         *
         *  @static
         * */
        exports.back = function () {
            backManually = true;
            history.back();
        };

        /**
         * Reset/replace current state
         *
         * @static
         * @param {string} url The URL to reset
         * @param {string} query The query string to reset
         * @param {Object} options The router options
         * @param {string} options.title Optional, 页面的title
         * @param {boolean} options.force Optional, 是否强制跳转
         * @param {boolean} options.silent Optional, 是否静默跳转（不改变URL）
         * @param {Object} data extended data being passed to `current.options`
         * */
        exports.reset = function (url, query, options, data) {
            if (isIndexPage) {
                indexPageUrl = url;
            }
            _.assign(stageData, data);
            router.reset(url, query, options);
        };

        /**
         *  hijack global link href
         *
         *  @private
         *  @param {Event} event The click event object
         * */
        function onAnchorClick(event) {
            event = event || window.event;
            var targetEl = closest(event.target || event.srcElement, 'A');

            if (!targetEl) {
                return;
            }

            // link href only support url like pathname,e.g:/sf?params=
            var link = targetEl.getAttribute('data-sf-href');
            var options = targetEl.getAttribute('data-sf-options');

            if (link) {
                event.preventDefault();
                try {
                    options = JSON.parse(options) || {};
                }
                catch (err) {
                    options = {};
                }
                options.src = 'hijack';
                var extra = {
                    event: event,
                    anchor: targetEl
                };
                exports.redirect(link, null, options, extra);
            }
        }

        /**
         * Find the closes ancestor matching the tagName
         *
         * @private
         * @param {DOMElement} element The element from which to find
         * @param {string} tagName The tagName to find
         * @return {DOMElement} The closest ancester matching the tagName
         */
        function closest(element, tagName) {
            var parent = element;
            while (parent !== null && parent.tagName !== tagName.toUpperCase()) {
                parent = parent.parentNode;
            }
            return parent;
        }

        /**
         *  Action init, call this to start the action
         *
         *  @param {Object} options key/value pairs to config the action, calling action.config() internally
         *  @static
         * */
        exports.start = function (options) {
            if (arguments.length) {
                exports.config(options);
            }
            document.body.addEventListener('click', onAnchorClick);
            router.start();
        };

        /**
         * Stop superframe redirects
         */
        exports.stop = function () {
            document.body.removeEventListener('click', onAnchorClick);
            router.stop();
            router.clear();
        };

        /**
         * Destroy the action, eliminate side effects:
         * DOM event listeners, cache namespaces, external states
         */
        exports.destroy = function () {
            exports.stop();
            cache.destroy('pages');
            exports.pages = pages = undefined;
            services.clear();
        };

        /**
         *  Update page, reset or replace current state accordingly
         *
         *  @static
         *  @param {string} url The URL to update
         *  @param {string} query The query string to update
         *  @param {Object} options The router options to update
         *  @param {Object} data The extended data to update, typically contains `container`, `page`, and `view`
         *  @return {Object} the action object
         * */
        exports.update = function (url, query, options, data) {
            options = options ? options : {};

            // use silent mode
            if (!options.hasOwnProperty('silent')) {
                options.silent = true;
            }

            var prevUrl = router.ignoreRoot(location.pathname + location.search);
            var currentUrl = router.ignoreRoot(url);
            var currentPath = (currentUrl || '').replace(/\?.*/, '');
            var routerOptions = router.getState();

            var transition = {
                from: {
                    url: prevUrl
                },
                to: {
                    url: currentUrl,
                    path: currentPath
                },
                extra: data
            };
            router.reset(url, query, options);

            return exports.partialUpdate(url, {
                replace: true,
                state: routerOptions,
                transition: transition
            });
        };

        /**
         * Update partial content
         *
         * @param {string} [url=null] The url to update to, do not change url if null
         * @param {string} [options=] Update options
         * @param {string} [options.fromSel=] The selector of the container element in the DOM of the retrieved HTML
         * @param {string} [options.toSel=] The selector of the container element in the current DOM
         * @param {string} [options.fromUrl=url] The url of the HTML to be retrieved
         * @param {boolean} [options.replace=false] Whether or not to replace the contents of container element
         * @return {Promise} A promise resolves when update finished successfully, rejected otherwise
         */
        exports.partialUpdate = function (url, options) {
            options = _.assign({}, {
                fromUrl: url,
                replace: false,
                page: pages.get(url)
            }, options);

            var prevUrl = router.ignoreRoot(location.pathname + location.search);
            pages.rename(prevUrl, url);

            var service = getServiceByUrl(url);
            var pending = service.partialUpdate(url, options);
            // postpone URL change until fetch request is sent
            router.reset(url || location.href, null, {silent: true});
            return Promise.resolve(pending);
        };

        function getServiceByUrl(url) {
            var pathPattern = router.pathPattern(url);
            if (!services.has(pathPattern)) {
                throw new Error('service not found for:' + url);
            }
            return services.get(pathPattern);
        }

        exports.init();

        return exports;
    }
    return actionFactory;
});
