/* Vokabeltrainer service worker.
   Bump VERSION whenever you change index.html so installed phones pick up the new build. */
var VERSION = "v3";
var SHELL = "vokabeltrainer-shell-" + VERSION;
var RUNTIME = "vokabeltrainer-runtime-" + VERSION;

var SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(SHELL)
      .then(function(c){ return c.addAll(SHELL_FILES); })
      .catch(function(){ /* e.g. Access login not done yet: cache on next visit */ })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k !== SHELL && k !== RUNTIME) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

function cacheable(res){
  return res && res.ok && res.type === "basic" && !res.redirected;
}

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;

  // Never cache the API or Cloudflare Access endpoints: data comes from the network or localStorage.
  if(sameOrigin && (url.pathname.indexOf("/api/") > -1 || url.pathname.indexOf("/cdn-cgi/") === 0)) return;

  // The page itself: fresh when online, cached when not.
  if(req.mode === "navigate"){
    e.respondWith(
      fetch(req).then(function(res){
        if(cacheable(res)){
          var copy = res.clone();
          caches.open(SHELL).then(function(c){ c.put("./index.html", copy); });
        }
        return res;
      }).catch(function(){
        return caches.match("./index.html");
      })
    );
    return;
  }

  var isFont = url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com";
  if(!sameOrigin && !isFont) return;

  e.respondWith(
    caches.match(req).then(function(hit){
      if(hit) return hit;
      return fetch(req).then(function(res){
        if(cacheable(res) || (isFont && res && (res.ok || res.type === "opaque"))){
          var copy = res.clone();
          caches.open(RUNTIME).then(function(c){ c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
