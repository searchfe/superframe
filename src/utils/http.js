define(['./promise', './underscore', './url'], function(Promise, _, Url) {
    var exports = {};

    /*
     * Perform an asynchronous HTTP (Ajax) request.
     * @param {String} url A string containing the URL to which the request is sent.
     * @param {Object} settings A set of key/value pairs that configure the Ajax request. All settings are optional.
     * @param {String} settings.method The method to open the Ajax request.
     * @param {Any} settings.data The data to send, could be a string, a FormData, or a plain object. The 'Content-type' header is guessed accordingly, ie. 'application/x-www-form-urlencoded', 'multipart/form-data'.
     * @param {Object} settings.headers A set of key/value pairs that configure the Ajax request headers. If set to 'application/json', the settings.data will be JSON.stringified; If set to 'x-www-form-urlencoded', which is by default, the settings.data will be url-encoded.
     * @param {Boolean} settings.jsonp [NOT implemented yet] Whether or not to use JSONP, default to `false`.
     * @param {String} settings.jsonpCallback [NOT implemented yet] Specify the callback function name for a JSONP request. This value will be used instead of the random name automatically generated by default.
     * @param {xhrFields} settings.xhrFields A set of key/value pairs that configure the fields of the xhr object. Note: onreadystatechange not supported, make use of the returned promise instead.
     * @return {Promise} A promise resolves/rejects with the xhr
     * @example
     * ajax('/foo', {
     *         method: 'POST',
     *         headers: {
     *             "content-type": "application/json"
     *         },
     *         xhrFields: {
     *             withCredentials: true
     *         }
     *     })
     *     .then(function(xhr) {
     *         xhr.status == 200;
     *         xhr.responseHeaders['Content-Type'] == 'application/json';
     *         xhr.responseText == '{"foo": "bar"}';
     *         // xhr.data is parsed from responseText according to Content-Type
     *         xhr.data === {foo: 'bar'};
     *     });
     *     .catch(function(xhr|errorThrown ) {});
     *     .finally(function(xhr|errorThrown ) { });
     */
    exports.ajax = function(url, settings) {
        //console.log('ajax with', url, settings);
        if (typeof url === 'object') {
            settings = url;
            url = "";
        }
        // normalize settings
        settings = _.defaultsDeep(settings, {
            url: url,
            method: settings && settings.type || 'GET',
            headers: {},
            data: null,
            jsonp: false,
            jsonpCallback: 'sf_http_' + Math.random().toString(36).substr(2)
        });
        _.forOwn(settings.headers, function(v, k) {
            settings.headers[k] = v.toLowerCase(v);
        });

        settings.headers['content-type'] = settings.headers['content-type'] ||
            _guessContentType(settings.data);

        //console.log('before parse data', settings);
        if (/application\/json/.test(settings.headers['content-type'])) {
            settings.data = JSON.stringify(settings.data);
        } else if (/form-urlencoded/.test(settings.headers['content-type'])) {
            settings.data = Url.param(settings.data);
        }
        //console.log('after parse data', settings);
        return _doAjax(settings);
    };

    /*
     * Try guess the content-type of given data.
     */
    function _guessContentType(data) {
        if (data instanceof FormData) {
            return 'multipart/form-data';
        }
        return 'application/x-www-form-urlencoded; charset=UTF-8';
    }

    /*
     * Load data from the server using a HTTP GET request.
     * @param {String} url A string containing the URL to which the request is sent.
     * @param {Object} data A plain object or string that is sent to the server with the request.
     * @return {Promise} A promise resolves/rejects with the xhr
     */
    exports.get = function(url, data) {
        return exports.ajax(url, {
            data: data
        });
    };

    /*
     * Load data from the server using a HTTP POST request.
     * @param {String} url A string containing the URL to which the request is sent.
     * @param {Object} data A plain object or string that is sent to the server with the request.
     * @return {Promise} A promise resolves/rejects with the xhr
     */
    exports.post = function(url, data) {
        return exports.ajax(url, {
            method: 'POST',
            data: data
        });
    };

    /*
     * Load data from the server using a HTTP PUT request.
     * @param {String} url A string containing the URL to which the request is sent.
     * @param {Object} data A plain object or string that is sent to the server with the request.
     * @return {Promise} A promise resolves/rejects with the xhr
     */
    exports.put = function(url, data) {
        return exports.ajax(url, {
            method: 'PUT',
            data: data
        });
    };

    /*
     * Load data from the server using a HTTP DELETE request.
     * @param {String} url A string containing the URL to which the request is sent.
     * @param {Object} data A plain object or string that is sent to the server with the request.
     * @return {Promise} A promise resolves/rejects with the xhr
     */
    exports.delete = function(url, data) {
        return exports.ajax(url, {
            method: 'DELETE',
            data: data
        });
    };

    function _doAjax(settings) {
        //console.log('_doAjax with', settings);
        var xhr;
        try {
            xhr = exports.createXHR();
        } catch (e) {
            return Promise.reject(e);
        }
        //console.log('open xhr');
        xhr.open(settings.method, settings.url, true);

        _.forOwn(settings.headers, function(v, k) {
            xhr.setRequestHeader(k, v);
        });
        _.assign(xhr, settings.xhrFields);

        return new Promise(function(resolve, reject) {
            xhr.onreadystatechange = function() {
                //console.log('onreadystatechange', xhr.readyState, xhr.status);
                if (xhr.readyState == 4) {
                    xhr = _resolveXHR(xhr);
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(xhr);
                    } else {
                        reject(xhr);
                    }
                }
            };
            //console.log('doajax sending:', settings.data);
            xhr.send(settings.data);
        });
    }

    function _resolveXHR(xhr) {
        /*
         * parse response headers
         */
        var headers = xhr.getAllResponseHeaders()
            // Spec: https://developer.mozilla.org/en-US/docs/Glossary/CRLF
            .split('\r\n')
            .filter(_.negate(_.isEmpty))
            .map(function(str) {
                return _.split(str, /\s*:\s*/);
            });
        xhr.responseHeaders = _.fromPairs(headers);

        /*
         * parse response body
         */
        xhr.data = xhr.responseText;
        if (xhr.responseHeaders['Content-Type'] === 'application/json') {
            try {
                xhr.data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.warn('Invalid JSON content with Content-Type: application/json');
            }
        }
        return xhr;
    }

    exports.createXHR = function () {
        var xhr = false;

        if (window.XMLHttpRequest) { // Mozilla, Safari,...
            xhr = new XMLHttpRequest();
        } else if (window.ActiveXObject) { // IE
            xhr = new ActiveXObject("Microsoft.XMLHTTP");
        }
        if (!xhr) {
            throw new Error('Cannot create an XHR instance');
        }
        return xhr;
    }

    return exports;
});
