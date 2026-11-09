/*
 * Four in a Row: service worker (offline support + safe updates).
 *
 * The game is one self-contained page (fonts, pictures and code are inside index.html), so there is
 * nothing to load later and an old page can never mix with new files.
 *
 *  - Install:   the page, the manifest and the icons are stored in a cache named after VERSION.
 *  - Launch:    the page is asked from the network first (revalidated, so an unchanged page costs almost
 *               nothing). If the network fails or takes longer than NETWORK_TIMEOUT_MS, the stored copy is
 *               used, so the game also starts with no connection. A fresh copy replaces the stored one.
 *  - Update:    deploy new files and raise VERSION below. The next time the app is opened with a connection
 *               it gets the new page, and the old cache is deleted. The game is never reloaded while a
 *               match is being played; a running match keeps the version it started with.
 *
 * Saved data (settings, results, FOUR Pay) lives in the page's localStorage. This file never reads,
 * writes or deletes it.
 */
'use strict';

var VERSION = '1.0.0';                      // raise on every release
var CACHE_PREFIX = 'fiar-pwa-';
var CACHE = CACHE_PREFIX + VERSION;
var NETWORK_TIMEOUT_MS = 3000;

var ROOT = new URL('./', self.registration.scope).href;   // the game page: the scope's "directory" address
var PRECACHE = [
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
].map(function (p) { return new URL(p, self.registration.scope).href; });

/* A response that came through a redirect cannot be used to answer a page load in Safari, so store a clean copy. */
function clean(response) {
  if (!response.redirected) return Promise.resolve(response);
  return response.blob().then(function (body) {
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  });
}

function isPage(response) {
  var type = response.headers.get('content-type') || '';
  return response.ok && response.type === 'basic' && type.indexOf('text/html') !== -1;
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      var page = fetch(new Request(ROOT, { cache: 'reload' })).then(function (res) {
        if (!isPage(res)) throw new Error('Game page not available: ' + res.status);
        return clean(res).then(function (copy) { return cache.put(ROOT, copy); });
      });
      var files = Promise.all(PRECACHE.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' })).then(function (res) {
          if (res.ok) return cache.put(url, res);
        }).catch(function () { /* an icon that cannot be fetched must not block the game */ });
      }));
      return Promise.all([page, files]);
    }).then(function () { return self.skipWaiting(); })
  );
});

/* Deletes the caches of older versions. Also run after each page load, because an old worker that was
   still finishing a download can re-create its cache just after the new version has removed it. */
function deleteOldCaches() {
  return caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE;
    }).map(function (k) { return caches.delete(k); }));
  });
}

self.addEventListener('activate', function (event) {
  event.waitUntil(deleteOldCaches().then(function () { return self.clients.claim(); }));
});

/* Page loads: network first (with a timeout), stored copy as the fallback. */
function handleNavigation(event) {
  var request = event.request;

  var storing = null;
  var network = fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    if (!isPage(res)) throw new Error('Unusable response: ' + res.status);
    return clean(res).then(function (copy) {
      storing = caches.open(CACHE).then(function (cache) { return cache.put(ROOT, copy.clone()); }).catch(function () {});
      return copy;
    });
  });
  // Keep the worker alive until the fresh copy is stored, even when the stored copy was already served (timeout).
  event.waitUntil(network.then(function () { return storing; }).then(deleteOldCaches).catch(function () { /* offline */ }));

  var stored = function () {
    return caches.open(CACHE).then(function (cache) { return cache.match(ROOT); });
  };

  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, NETWORK_TIMEOUT_MS);
  });

  // Slow network: answer from the stored copy (if there is one) and let the download carry on in the background.
  var first = Promise.race([network.catch(function () { return undefined; }), timeout]).then(function (res) {
    if (res) return res;
    return stored().then(function (copy) { return copy || network; });
  });

  return first.catch(function () {
    return stored().then(function (copy) { return copy || Response.error(); });
  });
}

/* Everything else (icons, manifest): stored copy first, then the network, which is remembered. */
function handleAsset(event) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(event.request).then(function (hit) {
      if (hit) return hit;
      return fetch(event.request).then(function (res) {
        if (res.ok && res.type === 'basic') cache.put(event.request, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;               // never touch other websites
  if (url.href.indexOf(ROOT) !== 0) return;                      // outside this app's folder
  if (request.mode === 'navigate') event.respondWith(handleNavigation(event));
  else event.respondWith(handleAsset(event));
});
